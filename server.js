#!/usr/bin/env node
// Board: a kanban board whose cards run Claude Code task agents, one per
// project folder, plus a lead agent you chat with. No dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const PORT = Number(process.env.PORT) || 4700;
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.BOARD_TOKEN || '';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const DB_FILE = path.join(DATA_DIR, 'board.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const LEAD_BRIEF = path.join(ROOT, 'lead', 'brief.md');
const CLI = path.join(ROOT, 'cli.js');
const STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done'];
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

if (!TOKEN && !LOCAL_HOSTS.includes(HOST)) {
  console.error(`Refusing to listen on ${HOST} without BOARD_TOKEN. Set it in .env.`);
  process.exit(1);
}

const now = () => new Date().toISOString();
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- config ----------

// Projects are discovered: every folder in the root (Main's folder) is a
// project, and folders in root/archive are archived projects. projects.json
// only overrides: names, permissions, ids kept stable for existing cards,
// extra projects outside the root, folders to ignore. It's re-read on every
// rescan, so edits apply without a restart.

const PROJECTS_FILE = path.resolve(ROOT, process.env.PROJECTS_FILE || 'projects.json');
const ARCHIVE_DIR = 'archive';
const home = (p) => p.replace(/^~(?=\/|$)/, process.env.HOME);
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
const projectDefaults = () => ({
  // Default: skip permissions (like --dangerously-skip-permissions). Nobody
  // can answer a prompt on a card. Safety comes from isolating the machine,
  // plus deny rules and hooks, which still apply. Override per project.
  permissionMode: DEFAULT_PERMISSION_MODE,
  sandbox: false,
  allowedTools: [],
});

function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`projects.json: ${err.message}`);
  }
}

function buildConfig(raw) {
  // Main runs in the root folder that holds all projects (by default the
  // parent of this repo), so it sees every project, including the board.
  const lead = {
    cwd: path.resolve(home(raw.lead?.cwd || path.dirname(ROOT))),
    addDirs: (raw.lead?.addDirs || []).map(home),
    permissionMode: raw.lead?.permissionMode || DEFAULT_PERMISSION_MODE,
  };
  const ignore = new Set(raw.ignore || ['knowledge']);
  const overrides = (raw.projects || []).map((p) => ({ ...p, path: p.path && path.resolve(home(p.path)) }));
  for (const o of overrides) {
    if (!/^[a-z0-9_-]+$/i.test(o.id || '') || o.id === 'main') {
      throw new Error(`Bad project id "${o.id}": use letters, digits, - or _ (and not "main").`);
    }
  }

  const found = [];
  for (const [dir, archived] of [[lead.cwd, false], [path.join(lead.cwd, ARCHIVE_DIR), true]]) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || ignore.has(e.name)) continue;
      if (!archived && e.name === ARCHIVE_DIR) continue;
      found.push(path.join(dir, e.name));
    }
  }

  // Overrides match a discovered folder by folder name (wherever it is now,
  // root or archive), so archiving doesn't change the project's id.
  const projects = [];
  const taken = new Set();
  for (const o of overrides) {
    const match = found.find((f) => !taken.has(f) && path.basename(f) === path.basename(o.path || o.id));
    const dir = match || o.path;
    if (!dir || !fs.existsSync(dir) || projects.some((p) => p.id === o.id)) continue;
    projects.push({ ...projectDefaults(), ...o, path: dir });
    taken.add(dir);
  }
  for (const dir of found.sort((a, b) => path.basename(a).localeCompare(path.basename(b)))) {
    if (taken.has(dir)) continue;
    let id = slug(path.basename(dir));
    if (id === 'main') id = 'main-project';
    while (projects.some((p) => p.id === id)) id += '-2';
    projects.push({ ...projectDefaults(), id, name: path.basename(dir), path: dir });
  }
  return { lead, projects };
}

let config;
try { config = buildConfig(readConfigFile()); } catch (err) {
  console.error(err.message);
  process.exit(1);
}
const projectById = (id) => config.projects.find((p) => p.id === id);

// ---------- archive ----------
// Archiving moves the project folder into an `archive` folder next to it
// (~/code/my-app -> ~/code/archive/my-app), moves
// Claude Code's memory/sessions folders for that path along with it, and
// the project keeps its id (matched by folder name). Unarchive moves it all back.

const CLAUDE_PROJECTS = path.join(process.env.HOME, '.claude', 'projects');
const isArchivedPath = (dir) => path.basename(path.dirname(dir)) === ARCHIVE_DIR;
const encodeDir = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');
const tilde = (dir) => (dir.startsWith(process.env.HOME + '/') ? '~' + dir.slice(process.env.HOME.length) : dir);

function moveClaudeDirs(from, to) {
  let entries;
  try { entries = fs.readdirSync(CLAUDE_PROJECTS); } catch { return; }
  const oldKey = encodeDir(from);
  const newKey = encodeDir(to);
  // Subfolder sessions (e.g. my-app/backend) share the prefix. Only follow them
  // when no sibling folder could own that prefix too (e.g. my-app-old).
  const parent = path.dirname(from);
  const base = path.basename(from);
  let siblings = [];
  try { siblings = fs.readdirSync(parent).filter((n) => n !== base && encodeDir(n).startsWith(encodeDir(base) + '-')); } catch {}
  for (const name of entries) {
    const exact = name === oldKey;
    if (!exact && !(name.startsWith(oldKey + '-') && !siblings.length)) continue;
    const target = path.join(CLAUDE_PROJECTS, newKey + name.slice(oldKey.length));
    if (fs.existsSync(target)) { console.warn(`[board] not moving ${name}: ${target} exists`); continue; }
    fs.renameSync(path.join(CLAUDE_PROJECTS, name), target);
  }
}

function moveProject(id, archive) {
  const proj = projectById(id);
  const from = proj.path;
  if (path.resolve(from) === ROOT) throw httpError(409, "The board can't archive itself while it's running");
  if (archive === isArchivedPath(from)) return;
  const to = archive
    ? path.join(path.dirname(from), ARCHIVE_DIR, path.basename(from))
    : path.join(path.dirname(path.dirname(from)), path.basename(from));
  if (!fs.existsSync(from)) throw httpError(404, `Folder not found: ${tilde(from)}`);
  if (fs.existsSync(to)) throw httpError(409, `${tilde(to)} already exists`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  moveClaudeDirs(from, to);
  rescan();
  console.log(`[board] ${archive ? 'archived' : 'unarchived'} ${id}: ${tilde(from)} -> ${tilde(to)}`);
}

// ---------- storage ----------

fs.mkdirSync(LOG_DIR, { recursive: true });

function loadDb() {
  const chat = (id) => ({ id, sessionId: null, run: null, lastRun: null });
  let d = { seq: 0, cards: [], lead: chat('lead'), chats: {} };
  try { d = { ...d, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
  d.chats ||= {};
  for (const p of config.projects) d.chats[p.id] ||= chat(`chat-${p.id}`);
  // Sessions belong to a folder: if Main's folder changed, start fresh.
  if (d.lead.cwd !== config.lead.cwd) {
    if (d.lead.sessionId) d.lead.sessionId = null;
    d.lead.cwd = config.lead.cwd;
  }
  return d;
}

const db = loadDb();

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const logFile = (id) => path.join(LOG_DIR, `${id}.jsonl`);

function appendLog(id, ev) {
  const event = { t: now(), ...ev };
  fs.appendFileSync(logFile(id), JSON.stringify(event) + '\n');
  broadcast({ type: 'log', id, event });
}

function readLog(id, limit) {
  try {
    const lines = fs.readFileSync(logFile(id), 'utf8').split('\n').filter(Boolean);
    return (limit ? lines.slice(-limit) : lines).map((l) => JSON.parse(l));
  } catch { return []; }
}

const getCard = (id) => {
  const card = db.cards.find((c) => c.id === id);
  if (!card) throw httpError(404, 'Card not found');
  return card;
};

// Runs that were alive when the server died can't be reattached.
for (const e of [db.lead, ...Object.values(db.chats), ...db.cards]) {
  if (e.run?.state === 'running') {
    e.run = null;
    e.lastRun = { state: 'interrupted', endedAt: now() };
    if (e.status === 'in_progress') e.status = 'review';
    appendLog(e.id, { kind: 'system', text: 'Interrupted (board restarted)' });
  }
}
save();

// ---------- live updates ----------

const clients = new Set();

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}

function publicState() {
  return {
    statuses: STATUSES,
    projects: config.projects.map(({ id, name, path: dir }) => ({ id, name: name || id, archived: isArchivedPath(dir) })),
    cards: db.cards,
    chats: Object.fromEntries(['main', ...config.projects.map((p) => p.id)].map((key) => {
      const c = getChat(key);
      return [key, { logId: c.id, busy: !!c.run, sessionId: c.sessionId, lastRun: c.lastRun }];
    })),
  };
}

// "main" is the lead; every project also has its own chat session in its folder.
function getChat(key) {
  if (key === 'main') return db.lead;
  if (!projectById(key)) throw httpError(404, 'Unknown chat');
  return db.chats[key];
}

let stateTimer;
function changed() {
  save();
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => broadcast({ type: 'state', state: publicState() }), 50);
}

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// Picks up new, renamed, archived or removed folders and edits to
// projects.json without a restart. Runs on the Refresh button (or
// `cli.js refresh`) and after archiving; there's no timer on purpose.
function rescan() {
  let next;
  try { next = buildConfig(readConfigFile()); } catch (err) {
    console.warn(`[board] ${err.message}`);
    return;
  }
  if (JSON.stringify(next) === JSON.stringify(config)) return;
  config = next;
  for (const p of config.projects) db.chats[p.id] ||= { id: `chat-${p.id}`, sessionId: null, run: null, lastRun: null };
  changed();
}

// ---------- agent runs ----------

const procs = new Map(); // entity id -> child process

function taskPrompt(card) {
  return [card.title, card.details].filter(Boolean).join('\n\n');
}

function taskSystemPrompt(card, project) {
  return [
    `You are a task agent started from the user's kanban board for card ${card.id} ("${card.title}") in project "${project.name || project.id}".`,
    `Work only inside ${project.path}.`,
    'If you need a decision from the user, ask it clearly as your final message and stop. They will reply on the card.',
    'Do not push to any remote unless the card asks you to.',
    'End with a short summary: what changed and how to check it.',
  ].join(' ');
}

function enqueue(card, prompt) {
  card.status = 'in_progress';
  card.run = { state: 'queued', prompt, queuedAt: now() };
  card.updatedAt = now();
  appendLog(card.id, { kind: 'user', text: prompt });
  changed();
  pump();
}

// One running task per project, since they share the same working tree.
function pump() {
  const busy = new Set(db.cards.filter((c) => c.run?.state === 'running').map((c) => c.project));
  const queued = db.cards
    .filter((c) => c.run?.state === 'queued')
    .sort((a, b) => a.run.queuedAt.localeCompare(b.run.queuedAt));
  for (const card of queued) {
    if (busy.has(card.project)) continue;
    busy.add(card.project);
    runCard(card);
  }
}

function baseArgs(permissionMode) {
  return ['-p', '--output-format', 'stream-json', '--verbose',
    '--permission-prompts', 'none', '--permission-mode', permissionMode];
}

// A project session: runs in the project folder with that project's rules.
function projectRun(entity, project, systemPrompt, prompt) {
  const args = [...baseArgs(project.permissionMode), '--append-system-prompt', systemPrompt];
  if (project.sandbox) {
    args.push('--settings', JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }));
  }
  if (project.allowedTools.length) args.push('--allowedTools', project.allowedTools.join(','));
  if (entity.sessionId) args.push('--resume', entity.sessionId);
  const env = { ...process.env };
  delete env.BOARD_TOKEN;
  launch(entity, project.path, args, prompt, env);
}

function runCard(card) {
  const project = projectById(card.project);
  if (!project) return finish(card, { state: 'failed', error: `Unknown project ${card.project}` });
  projectRun(card, project, taskSystemPrompt(card, project), card.run.prompt);
}

function runChat(key, text) {
  const chat = getChat(key);
  if (chat.run) throw httpError(409, 'This chat is busy');
  chat.run = { state: 'queued', prompt: text, queuedAt: now() };
  appendLog(chat.id, { kind: 'user', text });
  if (key !== 'main') {
    const project = projectById(key);
    const system = `The user is chatting with you from their board, in project "${project.name || project.id}". `
      + `Work only inside ${project.path}. Do not push to any remote unless the user asks.`;
    return projectRun(chat, project, system, text);
  }
  const { cwd } = config.lead;
  const cli = path.relative(cwd, CLI);
  const brief = fs.readFileSync(LEAD_BRIEF, 'utf8').replaceAll('{{CLI}}', cli);
  const tools = [`Bash(node ${CLI}:*)`, `Bash(node ${cli}:*)`, 'Read', 'Glob', 'Grep', 'Edit', 'Write'];
  const args = [...baseArgs(config.lead.permissionMode), '--append-system-prompt', brief, '--allowedTools', tools.join(',')];
  for (const dir of config.lead.addDirs) args.push('--add-dir', dir);
  if (chat.sessionId) args.push('--resume', chat.sessionId);
  const env = { ...process.env, BOARD_URL: `http://127.0.0.1:${PORT}`, BOARD_TOKEN: TOKEN };
  launch(chat, cwd, args, text, env);
}

function launch(entity, cwd, args, prompt, env) {
  // Agents always run on the logged-in Claude subscription, never on an API key.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  let child;
  try {
    child = spawn(CLAUDE_BIN, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    return finish(entity, { state: 'failed', error: err.message });
  }
  procs.set(entity.id, child);
  entity.run = { ...entity.run, state: 'running', pid: child.pid, startedAt: now() };
  changed();

  const raw = fs.createWriteStream(path.join(LOG_DIR, `${entity.id}.raw.jsonl`), { flags: 'a' });
  let buf = '';
  let stderr = '';
  let result = null;
  let done = false;

  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      raw.write(line + '\n');
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        entity.sessionId = msg.session_id;
        changed();
      }
      if (msg.type === 'result') result = msg;
      for (const ev of simplify(msg)) appendLog(entity.id, ev);
    }
  });
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });

  const end = (code, signal, err) => {
    if (done) return;
    done = true;
    procs.delete(entity.id);
    raw.end();
    if (result?.session_id) entity.sessionId = result.session_id;
    const stopped = entity.run?.stopping;
    const ok = code === 0 && !result?.is_error;
    finish(entity, {
      state: stopped ? 'stopped' : ok ? 'done' : 'failed',
      exitCode: code,
      signal: signal || undefined,
      error: !ok && !stopped ? (err?.message || stderr.trim().slice(-1000) || result?.subtype) : undefined,
    });
  };
  child.on('error', (err) => end(null, null, err));
  child.on('close', (code, signal) => end(code, signal));
}

function finish(entity, lastRun) {
  entity.run = null;
  entity.lastRun = { ...lastRun, endedAt: now() };
  if (entity.status === 'in_progress') entity.status = 'review';
  if (entity.status) entity.updatedAt = now();
  // No cost shown: on a Claude subscription total_cost_usd is only an API-price
  // estimate, nothing is billed per run.
  const text = {
    done: 'Finished',
    stopped: 'Stopped',
    failed: `Failed${lastRun.exitCode != null ? ` (exit ${lastRun.exitCode})` : ''}${lastRun.error ? `: ${lastRun.error}` : ''}`,
  }[lastRun.state];
  appendLog(entity.id, { kind: lastRun.state === 'failed' ? 'error' : 'system', text });
  changed();
  pump();
}

function stop(entity) {
  if (entity.run?.state === 'queued') {
    entity.run = null;
    entity.status = entity.sessionId ? 'review' : 'ready';
    appendLog(entity.id, { kind: 'system', text: 'Removed from queue' });
    changed();
    return;
  }
  const child = procs.get(entity.id);
  if (!child) return;
  entity.run.stopping = true;
  const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
  kill('SIGTERM');
  setTimeout(() => { if (procs.get(entity.id) === child) kill('SIGKILL'); }, 5000).unref();
}

// stream-json message -> transcript events the UI shows.
function simplify(msg) {
  const out = [];
  if (msg.parent_tool_use_id) return out; // subagent chatter
  if (msg.type === 'assistant') {
    for (const b of msg.message?.content || []) {
      if (b.type === 'text' && b.text.trim()) out.push({ kind: 'text', text: b.text });
      else if (b.type === 'tool_use') out.push({ kind: 'tool', text: `${b.name} ${toolSummary(b.input)}`.trim() });
    }
  } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) {
      if (b.type === 'tool_result' && b.is_error) out.push({ kind: 'tool_error', text: clip(contentText(b.content), 400) });
    }
  } else if (msg.type === 'result') {
    const denied = (msg.permission_denials || []).map((d) => `${d.tool_name} ${toolSummary(d.tool_input)}`.trim());
    if (denied.length) out.push({ kind: 'tool_error', text: `Not allowed: ${[...new Set(denied)].join(' | ')}` });
  }
  return out;
}

function toolSummary(input = {}) {
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url
    ?? input.query ?? input.description ?? input.prompt;
  return clip(typeof v === 'string' ? v : JSON.stringify(input), 200);
}

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => x.text || '').join('\n');
  return JSON.stringify(c);
}

// ---------- HTTP ----------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1e6) throw httpError(413, 'Body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'Invalid JSON'); }
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

const LOGIN_PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Board</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;background:#111;color:#eee">
<form method=get style="display:grid;gap:8px;width:min(320px,90vw)"><label>Board token</label>
<input name=token type=password autofocus style="padding:10px;font-size:16px;border-radius:8px;border:1px solid #444;background:#222;color:#eee">
<button style="padding:10px;font-size:16px;border-radius:8px">Open</button></form>`;

function authorize(req, res, url) {
  if (!TOKEN) return true;
  const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (header && safeEqual(header, TOKEN)) return true;
  const c = cookie(req, 'board_token');
  if (c && safeEqual(c, TOKEN)) return true;
  const q = url.searchParams.get('token');
  if (req.method === 'GET' && q && safeEqual(q, TOKEN)) {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    url.searchParams.delete('token');
    res.writeHead(302, {
      'set-cookie': `board_token=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
      location: url.pathname + url.search,
    });
    res.end();
    return false;
  }
  if (url.pathname.startsWith('/api/')) send(res, 401, { error: 'Unauthorized' });
  else { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); res.end(LOGIN_PAGE); }
  return false;
}

const STATIC = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://board');
  if (!authorize(req, res, url)) return;
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache' });
    res.end(fs.readFileSync(path.join(PUBLIC_DIR, file)));
    return;
  }

  if (m === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`data: ${JSON.stringify({ type: 'state', state: publicState() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (m === 'GET' && p === '/api/state') return send(res, 200, publicState());

  if (m === 'POST' && p === '/api/cards') {
    const b = await readBody(req);
    if (!projectById(b.project)) throw httpError(400, 'Unknown project');
    if (!b.title?.trim()) throw httpError(400, 'Title required');
    const status = b.status || 'backlog';
    if (!STATUSES.includes(status)) throw httpError(400, 'Bad status');
    const card = {
      id: `c${++db.seq}`, project: b.project, title: b.title.trim(), details: (b.details || '').trim(),
      status: status === 'in_progress' ? 'ready' : status, sessionId: null, run: null, lastRun: null,
      createdAt: now(), updatedAt: now(),
    };
    db.cards.push(card);
    if (status === 'in_progress') enqueue(card, taskPrompt(card));
    else changed();
    return send(res, 201, card);
  }

  let r;
  if ((r = p.match(/^\/api\/cards\/(c\d+)(\/[a-z]+)?$/))) {
    const card = getCard(r[1]);
    const action = r[2];

    if (!action && m === 'PATCH') {
      const b = await readBody(req);
      if (b.title !== undefined) {
        if (!String(b.title).trim()) throw httpError(400, 'Title required');
        card.title = String(b.title).trim();
      }
      if (b.details !== undefined) card.details = String(b.details);
      if (b.project !== undefined && b.project !== card.project) {
        if (card.run) throw httpError(409, 'Stop the card before changing its project');
        if (!projectById(b.project)) throw httpError(400, 'Unknown project');
        card.project = b.project;
        card.sessionId = null; // a session belongs to one folder
      }
      card.updatedAt = now();
      if (b.status !== undefined && b.status !== card.status) {
        if (!STATUSES.includes(b.status)) throw httpError(400, 'Bad status');
        if (b.status === 'in_progress') {
          const prompt = b.message?.trim()
            || (card.sessionId ? `Continue. Current card:\n\n${taskPrompt(card)}` : taskPrompt(card));
          enqueue(card, prompt);
          return send(res, 200, card);
        }
        if (card.run?.state === 'running') throw httpError(409, 'Card is running. Stop it first.');
        if (card.run?.state === 'queued') card.run = null;
        card.status = b.status;
      }
      changed();
      return send(res, 200, card);
    }

    if (!action && m === 'DELETE') {
      if (card.run) throw httpError(409, 'Stop the card first');
      db.cards = db.cards.filter((c) => c !== card);
      for (const f of [logFile(card.id), path.join(LOG_DIR, `${card.id}.raw.jsonl`)]) fs.rmSync(f, { force: true });
      changed();
      return send(res, 200, { ok: true });
    }

    if (action === '/log' && m === 'GET') return send(res, 200, readLog(card.id, Number(url.searchParams.get('limit')) || 0));

    if (action === '/reply' && m === 'POST') {
      const b = await readBody(req);
      if (!b.text?.trim()) throw httpError(400, 'Text required');
      if (card.run) throw httpError(409, 'Card is already running');
      enqueue(card, b.text.trim());
      return send(res, 200, card);
    }

    if (action === '/stop' && m === 'POST') { stop(card); return send(res, 200, { ok: true }); }
  }

  // Archive / unarchive a project: moves its folder into (or out of) the
  // archive folder next to it. See moveProject.
  if (p === '/api/projects/refresh' && m === 'POST') {
    rescan();
    return send(res, 200, { projects: publicState().projects });
  }

  if ((r = p.match(/^\/api\/projects\/([a-z0-9_-]+)\/(archive|unarchive)$/i)) && m === 'POST') {
    const id = r[1];
    if (!projectById(id)) throw httpError(404, 'Unknown project');
    if (getChat(id).run || db.cards.some((c) => c.project === id && c.run)) {
      throw httpError(409, 'This project has something running. Stop it first.');
    }
    moveProject(id, r[2] === 'archive');
    changed();
    return send(res, 200, { ok: true, path: tilde(projectById(id).path) });
  }

  if ((r = p.match(/^\/api\/chats\/([a-z0-9_-]+)(\/[a-z]+)?$/i))) {
    const key = r[1];
    const chat = getChat(key);
    const action = r[2];
    if (action === '/log' && m === 'GET') return send(res, 200, readLog(chat.id, Number(url.searchParams.get('limit')) || 0));
    if (!action && m === 'POST') {
      const b = await readBody(req);
      if (!b.text?.trim()) throw httpError(400, 'Text required');
      runChat(key, b.text.trim());
      return send(res, 200, { ok: true });
    }
    if (action === '/stop' && m === 'POST') { stop(chat); return send(res, 200, { ok: true }); }
    if (action === '/reset' && m === 'POST') {
      if (chat.run) throw httpError(409, 'This chat is busy');
      chat.sessionId = null;
      // Clear = archive the transcript (kept on disk) and start an empty one.
      try { fs.renameSync(logFile(chat.id), path.join(LOG_DIR, `${chat.id}.${Date.now()}.archived.jsonl`)); } catch {}
      broadcast({ type: 'clear', id: chat.id });
      changed();
      return send(res, 200, { ok: true });
    }
  }

  throw httpError(404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.message });
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const child of procs.values()) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    save();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Board on http://${HOST}:${PORT}${TOKEN ? ' (token required)' : ''}`);
  pump();
});
