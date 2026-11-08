#!/usr/bin/env node
// Amox: a kanban board whose cards run Claude Code task agents, one per
// project folder, plus a lead agent you chat with. No dependencies.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const home = (p) => p.replace(/^~(?=[\\/]|$)/, os.homedir());

// Where Amox keeps its own state: .env, projects.json, data/. A clone that
// already keeps them in the repo goes on doing so; new installs (npx, fresh
// clones) use ~/.amox, so updating Amox never touches them. AMOX_HOME overrides.
const LEGACY = !process.env.AMOX_HOME && ['data', 'projects.json', '.env'].some((f) => fs.existsSync(path.join(ROOT, f)));
const STATE_DIR = process.env.AMOX_HOME ? path.resolve(home(process.env.AMOX_HOME))
  : LEGACY ? ROOT : path.join(os.homedir(), '.amox');
fs.mkdirSync(STATE_DIR, { recursive: true });
try { process.loadEnvFile(path.join(STATE_DIR, '.env')); } catch {}

const PORT = Number(process.env.PORT) || 4700;
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.AMOX_TOKEN || process.env.BOARD_TOKEN || ''; // BOARD_TOKEN: pre-rename name
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DATA_DIR = path.resolve(STATE_DIR, process.env.DATA_DIR || 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const DB_FILE = path.join(DATA_DIR, 'board.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const LEAD_BRIEF = path.join(ROOT, 'lead', 'brief.md');
const CLI = path.join(ROOT, 'cli.js');
const STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done'];
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const DEFAULT_PERMISSION_MODE = 'bypassPermissions';
// Per tab settings (⚙ in the chat pane), saved in projects.json. Aliases
// follow the latest model of each family.
const MODELS = ['opus', 'opus[1m]', 'sonnet', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_MODEL = 'opus';
const DEFAULT_EFFORT = 'high';

if (!TOKEN && !LOCAL_HOSTS.includes(HOST)) {
  console.error(`Refusing to listen on ${HOST} without AMOX_TOKEN. Set it in ${path.join(STATE_DIR, '.env')}.`);
  process.exit(1);
}

try { execFileSync(CLAUDE_BIN, ['--version'], { stdio: 'ignore', timeout: 20000, windowsHide: true }); } catch {
  console.warn(`[amox] Can't run "${CLAUDE_BIN}". Install Claude Code (https://claude.com/claude-code) and log in, or set CLAUDE_BIN.`);
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

const PROJECTS_FILE = path.resolve(STATE_DIR, process.env.PROJECTS_FILE || 'projects.json');
const ARCHIVE_DIR = 'archive';
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
const projectDefaults = () => ({
  // Default: skip permissions (like --dangerously-skip-permissions). Nobody
  // can answer a prompt on a card. Safety comes from isolating the machine,
  // plus deny rules and hooks, which still apply. Override per project.
  permissionMode: DEFAULT_PERMISSION_MODE,
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  sandbox: false,
  allowedTools: [],
});

function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`projects.json: ${err.message}`);
  }
}

function saveConfigFile(raw) {
  fs.writeFileSync(PROJECTS_FILE + '.tmp', JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(PROJECTS_FILE + '.tmp', PROJECTS_FILE);
}

function buildConfig(raw) {
  // Main runs in the root folder that holds all projects, so it sees every
  // project. The user picks it in the UI on first start (saved as lead.cwd).
  // Older installs kept Amox inside that folder, so for them the default is
  // the repo's parent.
  const root = raw.lead?.cwd || (LEGACY ? path.dirname(ROOT) : null);
  const lead = {
    cwd: root && path.resolve(home(root)),
    addDirs: (raw.lead?.addDirs || []).map(home),
    permissionMode: raw.lead?.permissionMode || DEFAULT_PERMISSION_MODE,
    model: raw.lead?.model || DEFAULT_MODEL,
    effort: raw.lead?.effort || DEFAULT_EFFORT,
  };
  const ignore = new Set(raw.ignore || ['knowledge']);
  const overrides = (raw.projects || []).map((p) => ({ ...p, path: p.path && path.resolve(home(p.path)) }));
  for (const o of overrides) {
    if (!/^[a-z0-9_-]+$/i.test(o.id || '') || o.id === 'main') {
      throw new Error(`Bad project id "${o.id}": use letters, digits, - or _ (and not "main").`);
    }
  }

  const found = [];
  const roots = lead.cwd ? [[lead.cwd, false], [path.join(lead.cwd, ARCHIVE_DIR), true]] : [];
  for (const [dir, archived] of roots) {
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
  // Tab order chosen by dragging tabs (projects.json "order"). Projects not in
  // it keep their place after the ordered ones.
  const order = Array.isArray(raw.order) ? raw.order : [];
  const rank = (p) => (order.includes(p.id) ? order.indexOf(p.id) : Infinity);
  projects.sort((a, b) => rank(a) - rank(b));
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

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const isArchivedPath = (dir) => path.basename(path.dirname(dir)) === ARCHIVE_DIR;
const encodeDir = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');
const tilde = (dir) => {
  const h = os.homedir();
  return dir === h ? '~' : dir.startsWith(h + path.sep) ? '~' + dir.slice(h.length) : dir;
};

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
    if (fs.existsSync(target)) { console.warn(`[amox] not moving ${name}: ${target} exists`); continue; }
    fs.renameSync(path.join(CLAUDE_PROJECTS, name), target);
  }
}

function moveProject(id, archive) {
  const proj = projectById(id);
  const from = proj.path;
  if (path.resolve(from) === ROOT) throw httpError(409, "Amox can't archive itself while it's running");
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
  console.log(`[amox] ${archive ? 'archived' : 'unarchived'} ${id}: ${tilde(from)} -> ${tilde(to)}`);
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
    if (e.status === 'in_progress') e.status = 'ready';
    appendLog(e.id, { kind: 'system', text: 'Interrupted (Amox restarted)' });
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
    root: config.lead.cwd ? tilde(config.lead.cwd) : null, // null: not picked yet, the UI asks
    projects: config.projects.map(({ id, name, path: dir }) => ({ id, name: name || id, archived: isArchivedPath(dir) })),
    cards: db.cards.map(({ baseline, ...c }) => ({ ...c, canRevert: !!baseline?.repos?.length })),
    chats: Object.fromEntries(['main', ...config.projects.map((p) => p.id)].map((key) => {
      const c = getChat(key);
      return [key, { logId: c.id, busy: !!c.run, sessionId: c.sessionId, lastRun: c.lastRun }];
    })),
    settings: Object.fromEntries([['main', config.lead], ...config.projects.map((p) => [p.id, p])]
      .map(([key, { model, effort }]) => [key, { model, effort }])),
    options: { models: MODELS, efforts: EFFORTS, defaults: { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT } },
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
    console.warn(`[amox] ${err.message}`);
    return;
  }
  if (JSON.stringify(next) === JSON.stringify(config)) return;
  config = next;
  // Main's session belongs to its folder: a new projects folder starts fresh.
  if (db.lead.cwd !== config.lead.cwd) {
    db.lead.sessionId = null;
    db.lead.cwd = config.lead.cwd;
  }
  for (const p of config.projects) db.chats[p.id] ||= { id: `chat-${p.id}`, sessionId: null, run: null, lastRun: null };
  changed();
}

// ---------- agent runs ----------

const procs = new Map(); // entity id -> child process

// ---------- git snapshots for Reject / Redo ----------
// Before a card first runs, every git repo in the project folder (the folder
// itself, or its direct subfolders for multi-repo folders) is
// recorded: HEAD, branch, the untracked file list, and the whole working copy
// (uncommitted edits and untracked files) as a commit built in a temporary
// index, kept alive under refs/board/. The real index and files aren't
// touched. Revert = reset to that HEAD, delete files the card created, put
// the working copy back. It refuses, changing nothing, if the agent pushed,
// switched branch or rewrote history.

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
}).trim();

function gitRepos(dir) {
  try { return [git(dir, 'rev-parse', '--show-toplevel')]; } catch {}
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
  return entries.filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, '.git'))).map((e) => path.join(dir, e.name));
}

const untrackedFiles = (dir) => git(dir, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);

// Commit of the working copy as it is (tracked edits + untracked files), or
// null when it matches HEAD.
function workingCopyCommit(dir) {
  const index = path.join(DATA_DIR, `snapshot-index-${process.pid}-${Date.now()}`);
  const env = {
    ...process.env, GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'amox', GIT_AUTHOR_EMAIL: 'amox@localhost',
    GIT_COMMITTER_NAME: 'amox', GIT_COMMITTER_EMAIL: 'amox@localhost',
  };
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  }).trim();
  try {
    run('read-tree', 'HEAD');
    run('add', '-A');
    const tree = run('write-tree');
    if (tree === run('rev-parse', 'HEAD^{tree}')) return null;
    return run('commit-tree', tree, '-p', 'HEAD', '-m', 'amox: working copy before card');
  } finally {
    fs.rmSync(index, { force: true });
  }
}

function snapshot(card, projectDir) {
  const repos = [];
  for (const dir of gitRepos(projectDir)) {
    let head;
    try { head = git(dir, 'rev-parse', 'HEAD'); } catch { continue; } // no commits yet
    const work = workingCopyCommit(dir);
    const ref = work ? `refs/board/${card.id}-${Date.now()}` : null;
    if (ref) git(dir, 'update-ref', ref, work);
    repos.push({
      rel: path.relative(projectDir, dir) || '.',
      head, branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), work, ref, untracked: untrackedFiles(dir),
    });
  }
  return { takenAt: now(), repos };
}

const repoName = (r, projectDir) => (r.rel === '.' ? path.basename(projectDir) : r.rel);

function revertProblems(baseline, projectDir) {
  const problems = [];
  for (const r of baseline.repos) {
    const dir = path.resolve(projectDir, r.rel);
    const name = repoName(r, projectDir);
    try {
      if (git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') !== r.branch) { problems.push(`${name} is on another branch now`); continue; }
      const head = git(dir, 'rev-parse', 'HEAD');
      if (head === r.head) continue;
      try { git(dir, 'merge-base', '--is-ancestor', r.head, head); } catch { problems.push(`${name}: history was rewritten`); continue; }
      const all = git(dir, 'rev-list', '--count', `${r.head}..${head}`);
      const unpushed = git(dir, 'rev-list', '--count', `${r.head}..${head}`, '--not', '--remotes');
      if (all !== unpushed) problems.push(`${name}: the card's commits were already pushed`);
    } catch (err) {
      problems.push(`${name}: ${err.message.split('\n')[0]}`);
    }
  }
  return problems;
}

function revert(baseline, projectDir) {
  const names = [];
  for (const r of baseline.repos) {
    const dir = path.resolve(projectDir, r.rel);
    git(dir, 'reset', '--hard', r.head);
    const keep = new Set(r.untracked);
    for (const f of untrackedFiles(dir)) if (!keep.has(f)) fs.rmSync(path.join(dir, f), { force: true, recursive: true });
    if (r.work) {
      // Put the working copy back, including untracked files the card may
      // have committed (and the reset then removed), then unstage it all.
      git(dir, 'checkout', r.work, '--', '.');
      const deleted = git(dir, 'diff', '--name-only', '-z', '--diff-filter=D', r.head, r.work).split('\0').filter(Boolean);
      for (const f of deleted) fs.rmSync(path.join(dir, f), { force: true });
      git(dir, 'reset', '-q');
    }
    names.push(repoName(r, projectDir));
  }
  return names;
}

function dropBaseline(card) {
  const project = projectById(card.project);
  for (const r of card.baseline?.repos || []) {
    if (!r.ref || !project) continue;
    try { git(path.resolve(project.path, r.rel), 'update-ref', '-d', r.ref); } catch {}
  }
  card.baseline = null;
}

function taskPrompt(card) {
  return [card.title, card.details].filter(Boolean).join('\n\n');
}

// The same short context on every message. A card is just a Claude Code
// session: replies go through as written, like typing in a terminal. How
// to answer (length, tone) comes from the user's own CLAUDE.md files.
function taskSystemPrompt(card, project) {
  return `You're working on card ${card.id} ("${card.title}") from the user's Amox board, in ${project.path}. `
    + 'Do not push to any remote unless asked.';
}

// work = Start / Resume / Redo: the card moves to In progress. A reply just
// continues the session; the card stays in its column while it's answered.
// fromMain: Main started this run or replied (cli.js sends x-board-from: main).
// When such a run ends, Main is told (see tellMain).
function enqueue(card, prompt, { work = false, fromMain = false } = {}) {
  if (work) card.status = 'in_progress';
  card.run = { state: 'queued', prompt, work, fromMain, queuedAt: now() };
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

function baseArgs({ permissionMode, model, effort }) {
  return ['-p', '--output-format', 'stream-json', '--verbose',
    '--permission-prompts', 'none', '--permission-mode', permissionMode,
    '--model', model, '--effort', effort];
}

// Amox's own state holds every project's cards and the master token, so
// project agents (cards and project chats) can't read or change it. Deny
// rules apply even when permissions are skipped. Bash honors them for plain
// file commands (cat, head); with the project's sandbox on, for everything.
const BOARD_FILES = [path.join(DATA_DIR, '**'), PROJECTS_FILE, path.join(STATE_DIR, '.env'), path.join(ROOT, '.env')];
// Rules take absolute paths as //path; on Windows in POSIX form (C:\x -> //c/x).
const rulePath = (f) => (IS_WIN ? `//${f[0].toLowerCase()}${f.slice(2).replaceAll('\\', '/')}` : `/${f}`);
const BOARD_DENY = ['Read', 'Edit', 'Write'].flatMap((tool) => [...new Set(BOARD_FILES)].map((f) => `${tool}(${rulePath(f)})`));

// A project session: runs in the project folder with that project's rules.
// extra: { env, allowedTools, unsandboxed } added on top (project chats use
// it for cli.js). unsandboxed: commands that may run outside the sandbox,
// since it blocks localhost. A chained command stays fully sandboxed.
function projectRun(entity, project, systemPrompt, prompt, extra = {}) {
  const args = [...baseArgs(project), '--append-system-prompt', systemPrompt];
  const settings = { permissions: { deny: BOARD_DENY } };
  if (project.sandbox) {
    settings.sandbox = { enabled: true, autoAllowBashIfSandboxed: true, excludedCommands: extra.unsandboxed || [] };
  }
  args.push('--settings', JSON.stringify(settings));
  const tools = [...project.allowedTools, ...(extra.allowedTools || [])];
  if (tools.length) args.push('--allowedTools', tools.join(','));
  if (entity.sessionId) args.push('--resume', entity.sessionId);
  const env = { ...process.env };
  for (const k of ['AMOX_TOKEN', 'BOARD_TOKEN', 'AMOX_FROM', 'BOARD_FROM', 'AMOX_URL', 'BOARD_URL']) delete env[k];
  launch(entity, project.path, args, prompt, { ...env, ...extra.env });
}

// Project chats manage their own project's cards through cli.js with a
// token that only works for that project (see authorize). Tokens are made
// fresh on every server start; each run gets the current one.
const projectTokens = new Map();
function projectToken(id) {
  if (!projectTokens.has(id)) projectTokens.set(id, `p_${crypto.randomBytes(24).toString('hex')}`);
  return projectTokens.get(id);
}

function runCard(card) {
  const project = projectById(card.project);
  if (!project) return finish(card, { state: 'failed', error: `Unknown project ${card.project}` });
  // Remember how the repo(s) looked before the card first touched them, so
  // Reject / Redo can put them back.
  if (!card.baseline) {
    try { card.baseline = snapshot(card, project.path); } catch (err) { console.warn(`[amox] snapshot ${card.id}: ${err.message}`); }
  }
  projectRun(card, project, taskSystemPrompt(card, project), card.run.prompt);
}

function runChat(key, text, { notice } = {}) {
  const chat = getChat(key);
  if (chat.run) throw httpError(409, 'This chat is busy');
  chat.run = { state: 'queued', prompt: text, queuedAt: now() };
  appendLog(chat.id, notice ? { kind: 'system', text: notice } : { kind: 'user', text });
  if (key !== 'main') {
    const project = projectById(key);
    const system = `The user is chatting with you from Amox, their project board, in project "${project.name || project.id}". `
      + `Work only inside ${project.path}. Do not push to any remote unless the user asks.\n\n`
      + `You can manage this project's cards on the board (and only this project's) with \`node ${CLI} <command>\`: `
      + '`list [--status s]`, `show <id> [--log n]`, `add --title "..." [--details "..."] [--status backlog|ready]`, '
      + '`edit <id> [--title "..."] [--details "..."]`, `move <id> <backlog|ready|in_progress|review|done> [--message "..."]`, '
      + '`reply <id> "..."`, `stop <id>`. Moving a card to in_progress starts a separate task agent in this folder; '
      + 'do that only when the user asks.';
    return projectRun(chat, project, system, text, {
      env: { AMOX_URL: `http://127.0.0.1:${PORT}`, AMOX_TOKEN: projectToken(project.id) },
      allowedTools: [`Bash(node ${CLI}:*)`],
      unsandboxed: [`node ${CLI}:*`],
    });
  }
  const { cwd } = config.lead;
  if (!cwd) {
    chat.run = null;
    appendLog(chat.id, { kind: 'error', text: 'Pick your projects folder first (⚙ on the Main tab).' });
    return changed();
  }
  const cli = path.relative(cwd, CLI);
  const brief = fs.readFileSync(LEAD_BRIEF, 'utf8').replaceAll('{{CLI}}', cli);
  const tools = [`Bash(node ${CLI}:*)`, `Bash(node ${cli}:*)`, 'Read', 'Glob', 'Grep', 'Edit', 'Write'];
  const args = [...baseArgs(config.lead), '--append-system-prompt', brief, '--allowedTools', tools.join(',')];
  for (const dir of config.lead.addDirs) args.push('--add-dir', dir);
  if (chat.sessionId) args.push('--resume', chat.sessionId);
  const env = { ...process.env, AMOX_URL: `http://127.0.0.1:${PORT}`, AMOX_TOKEN: TOKEN, AMOX_FROM: 'main' };
  launch(chat, cwd, args, text, env);
}

function launch(entity, cwd, args, prompt, env) {
  // Agents always run on the logged-in Claude subscription, never on an API key.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  let child;
  try {
    // detached: its own process group, so Stop can end the whole tree (Unix).
    child = spawn(CLAUDE_BIN, args, { cwd, env, detached: !IS_WIN, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const run = entity.run;
  entity.run = null;
  entity.lastRun = { ...lastRun, endedAt: now() };
  // A failed run has nothing to review: back to Ready with a Failed badge.
  // The session is kept, so Resume picks up where it stopped.
  if (entity.status === 'in_progress') entity.status = lastRun.state === 'failed' ? 'ready' : 'review';
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
  if (run?.fromMain && lastRun.state !== 'stopped') tellMain(entity, lastRun);
  if (entity === db.lead) flushMainInbox();
}

// Main only runs when it gets a message, so a card it started can't report
// back by itself. When one ends, Amox sends Main a notice with the
// card's last reply (queued while Main is busy) and Main tells the user.
function tellMain(card, lastRun) {
  const last = readLog(card.id).reverse().find((e) => e.kind === 'text')?.text || '(no reply)';
  const ended = lastRun.state === 'done' ? 'finished' : 'failed';
  const text = `[Amox] Card ${card.id} "${card.title}" (${card.project}) ${ended}, now in ${card.status}. Its last reply:\n\n`
    + (last.length > 6000 ? last.slice(0, 6000) + '\n[…cut]' : last);
  (db.lead.inbox ||= []).push({ text, notice: `Card ${card.id} ${ended}. Telling Main.` });
  changed();
  flushMainInbox();
}

function flushMainInbox() {
  if (db.lead.run || !db.lead.inbox?.length) return;
  const items = db.lead.inbox.splice(0);
  runChat('main', items.map((i) => i.text).join('\n\n---\n\n'), { notice: items.map((i) => i.notice).join(' ') });
}

function stop(entity) {
  if (entity.run?.state === 'queued') {
    entity.run = null;
    if (entity.status === 'in_progress') entity.status = entity.sessionId ? 'review' : 'ready';
    appendLog(entity.id, { kind: 'system', text: 'Removed from queue' });
    changed();
    return;
  }
  const child = procs.get(entity.id);
  if (!child) return;
  entity.run.stopping = true;
  killTree(child, 'SIGTERM');
  setTimeout(() => { if (procs.get(entity.id) === child) killTree(child, 'SIGKILL'); }, 5000).unref();
}

// Ends an agent and everything it started: its process group on Unix,
// taskkill /T on Windows (no process groups there).
function killTree(child, sig) {
  if (IS_WIN) {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    return;
  }
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
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
  }
  // The result's permission_denials only repeat the denials already shown
  // inline as tool errors, so they aren't shown again.
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
<title>Amox</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;background:#111;color:#eee">
<form method=get style="display:grid;gap:8px;width:min(320px,90vw)"><label>Amox token</label>
<input name=token type=password autofocus style="padding:10px;font-size:16px;border-radius:8px;border:1px solid #444;background:#222;color:#eee">
<button style="padding:10px;font-size:16px;border-radius:8px">Open</button></form>`;

// Returns who is asking: {} for full access (the UI, Main, the user's CLI),
// { project } for a project chat's token, or null (response already sent).
// Without AMOX_TOKEN anything local gets full access, so the project limit
// only holds when a token is set.
function authorize(req, res, url) {
  const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (header.startsWith('p_')) {
    for (const [project, t] of projectTokens) if (safeEqual(header, t)) return { project };
  }
  if (!TOKEN) return {};
  if (header && safeEqual(header, TOKEN)) return {};
  const c = cookie(req, 'board_token');
  if (c && safeEqual(c, TOKEN)) return {};
  const q = url.searchParams.get('token');
  if (req.method === 'GET' && q && safeEqual(q, TOKEN)) {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    url.searchParams.delete('token');
    res.writeHead(302, {
      'set-cookie': `board_token=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
      location: url.pathname + url.search,
    });
    res.end();
    return null;
  }
  if (url.pathname.startsWith('/api/')) send(res, 401, { error: 'Unauthorized' });
  else { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); res.end(LOGIN_PAGE); }
  return null;
}

// What a project token may call: its project's cards, nothing else.
function scopedState(project) {
  const s = publicState();
  return {
    statuses: s.statuses,
    projects: s.projects.filter((p) => p.id === project),
    cards: s.cards.filter((c) => c.project === project),
  };
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
  const auth = authorize(req, res, url);
  if (!auth) return;
  const p = url.pathname;
  const m = req.method;
  const scope = auth.project; // set: a project chat, limited to that project's cards
  const fromMain = !scope && req.headers['x-board-from'] === 'main';

  if (scope) {
    const cardRoute = (m === 'POST' && p === '/api/cards') || /^\/api\/cards\/c\d+(\/[a-z]+)?$/.test(p);
    if (m === 'GET' && p === '/api/state') return send(res, 200, scopedState(scope));
    if (!cardRoute) throw httpError(403, `This token only manages ${scope}'s cards`);
  }

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
    if (scope) {
      b.project ||= scope;
      if (b.project !== scope) throw httpError(403, `This token only manages ${scope}'s cards`);
    }
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
    if (status === 'in_progress') enqueue(card, taskPrompt(card), { work: true, fromMain });
    else changed();
    return send(res, 201, card);
  }

  let r;
  if ((r = p.match(/^\/api\/cards\/(c\d+)(\/[a-z]+)?$/))) {
    const card = getCard(r[1]);
    if (scope && card.project !== scope) throw httpError(404, 'Card not found');
    const action = r[2];

    if (!action && m === 'PATCH') {
      const b = await readBody(req);
      if (scope && b.project !== undefined && b.project !== card.project) {
        throw httpError(403, `This token only manages ${scope}'s cards`);
      }
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
          enqueue(card, prompt, { work: true, fromMain });
          return send(res, 200, card);
        }
        if (card.run?.state === 'running') throw httpError(409, 'Card is running. Stop it first.');
        if (card.run?.state === 'queued') card.run = null;
        if (b.status === 'done') dropBaseline(card); // done = accepted
        card.status = b.status;
      }
      changed();
      return send(res, 200, card);
    }

    if (!action && m === 'DELETE') {
      if (card.run) throw httpError(409, 'Stop the card first');
      dropBaseline(card);
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
      enqueue(card, b.text.trim(), { fromMain });
      return send(res, 200, card);
    }

    if (action === '/stop' && m === 'POST') { stop(card); return send(res, 200, { ok: true }); }

    // Fixed actions for a card in review. They don't ask the agent anything.
    if (action === '/approve' && m === 'POST') {
      if (card.run) throw httpError(409, 'Stop the card first');
      dropBaseline(card);
      card.status = 'done';
      card.updatedAt = now();
      appendLog(card.id, { kind: 'system', text: 'Approved' });
      changed();
      return send(res, 200, { ok: true });
    }

    if ((action === '/reject' || action === '/redo') && m === 'POST') {
      if (card.run) throw httpError(409, 'Stop the card first');
      if (db.chats[card.project]?.run) throw httpError(409, `The ${card.project} chat is running. Wait for it or stop it first.`);
      const project = projectById(card.project);
      let note = 'Nothing to revert: no snapshot for this card.';
      if (card.baseline?.repos.length && project) {
        const problems = revertProblems(card.baseline, project.path);
        if (problems.length) throw httpError(409, `Can't revert, nothing was changed. ${problems.join('. ')}.`);
        note = `Reverted ${revert(card.baseline, project.path).join(', ')} to before this card.`;
      }
      dropBaseline(card);
      card.sessionId = null;
      card.lastRun = null;
      appendLog(card.id, { kind: 'system', text: `${action === '/redo' ? 'Redo' : 'Rejected'}. ${note}` });
      if (action === '/redo') enqueue(card, taskPrompt(card), { work: true });
      else { card.status = 'ready'; card.updatedAt = now(); changed(); }
      return send(res, 200, { ok: true, note });
    }
  }

  // Archive / unarchive a project: moves its folder into (or out of) the
  // archive folder next to it. See moveProject.
  if (p === '/api/projects/order' && m === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.order)) throw httpError(400, 'order must be a list of project ids');
    const ids = config.projects.map((x) => x.id);
    const given = b.order.filter((id, i) => ids.includes(id) && b.order.indexOf(id) === i);
    saveConfigFile({ ...readConfigFile(), order: [...given, ...ids.filter((id) => !given.includes(id))] });
    rescan();
    return send(res, 200, { projects: publicState().projects });
  }

  // Tab settings (model, effort): saved in projects.json, used from the next
  // message or card run on. "main" is Main (lead), anything else a project.
  if ((r = p.match(/^\/api\/settings\/([a-z0-9_-]+)$/i)) && m === 'POST') {
    const key = r[1];
    const b = await readBody(req);
    if (!MODELS.includes(b.model)) throw httpError(400, `model must be one of ${MODELS.join(', ')}`);
    if (!EFFORTS.includes(b.effort)) throw httpError(400, `effort must be one of ${EFFORTS.join(', ')}`);
    const patch = { model: b.model, effort: b.effort };
    const raw = readConfigFile();
    if (key === 'main') {
      raw.lead = { ...raw.lead, ...patch };
    } else {
      const project = projectById(key);
      if (!project) throw httpError(404, 'Unknown project');
      raw.projects ||= [];
      const o = raw.projects.find((x) => x.id === key);
      if (o) Object.assign(o, patch);
      // A discovered project gets an override that keeps its id, name and folder.
      else raw.projects.push({ id: key, name: project.name || key, path: tilde(project.path), ...patch });
    }
    saveConfigFile(raw);
    rescan();
    return send(res, 200, { ok: true });
  }

  // Projects folder picker. A web page can't get a real path from the OS
  // folder dialog, so the server lists folders and the page browses them.
  if (p === '/api/folders' && m === 'GET') {
    const dir = path.resolve(home(url.searchParams.get('path') || os.homedir()));
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) {
      throw httpError(400, `Can't open ${tilde(dir)} (${err.code || err.message})`);
    }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name).sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, path: path.join(dir, name) }));
    const parent = path.dirname(dir);
    return send(res, 200, { path: dir, display: tilde(dir), parent: parent === dir ? null : parent, dirs });
  }

  if (p === '/api/root' && m === 'POST') {
    const b = await readBody(req);
    const dir = b.path && path.resolve(home(String(b.path)));
    if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw httpError(400, 'Not a folder');
    if (db.lead.run) throw httpError(409, 'Main is busy. Stop it first.');
    saveConfigFile({ ...readConfigFile(), lead: { ...readConfigFile().lead, cwd: tilde(dir) } });
    rescan();
    return send(res, 200, { root: tilde(dir) });
  }

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
    for (const child of procs.values()) killTree(child, 'SIGTERM');
    save();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Amox on http://${HOST}:${PORT}${TOKEN ? ' (token required)' : ''}`);
  pump();
  flushMainInbox(); // notices left from before a restart
});
