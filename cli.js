#!/usr/bin/env node
// Board CLI. Used by the lead agent (and by you) to manage cards.
// Talks to the running server at BOARD_URL (default http://127.0.0.1:4700).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const BASE = process.env.BOARD_URL || `http://127.0.0.1:${process.env.PORT || 4700}`;
const TOKEN = process.env.BOARD_TOKEN || '';

const USAGE = `Usage: node cli.js <command>
  projects                                   List project ids
  list [--project p] [--status s]            List cards (hides done unless --status done)
  show <id> [--log n]                        Card details and last n transcript lines (default 30)
  add --project p --title t [--details d] [--status backlog|ready]
  edit <id> [--title t] [--details d] [--project p]
  move <id> <backlog|ready|in_progress|review|done> [--message m]
                                             in_progress starts (or resumes) the task agent
  reply <id> <text>                          Send a follow-up to the card's agent
  stop <id>                                  Stop a running or queued card`;

function parse(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      opts[k] = v !== undefined ? v : argv[++i];
    } else pos.push(a);
  }
  return { pos, opts };
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

const runState = (c) => c.run?.state || (c.lastRun && c.status === 'review' ? `last: ${c.lastRun.state}` : '');
const line = (c) => `${c.id}\t${c.project}\t${c.status}${runState(c) ? ` (${runState(c)})` : ''}\t${c.title}`;

async function main() {
  const { pos, opts } = parse(process.argv.slice(2));
  const [cmd, ...rest] = pos;
  switch (cmd) {
    case 'projects': {
      const s = await api('GET', '/api/state');
      for (const p of s.projects) console.log(`${p.id}\t${p.name}${p.archived ? '\t(archived)' : ''}`);
      break;
    }
    case 'list': {
      const s = await api('GET', '/api/state');
      const cards = s.cards
        .filter((c) => !opts.project || c.project === opts.project)
        .filter((c) => (opts.status ? c.status === opts.status : c.status !== 'done'))
        .sort((a, b) => s.statuses.indexOf(a.status) - s.statuses.indexOf(b.status));
      console.log(cards.length ? cards.map(line).join('\n') : 'No cards.');
      break;
    }
    case 'show': {
      const s = await api('GET', '/api/state');
      const c = s.cards.find((x) => x.id === rest[0]);
      if (!c) throw new Error('Card not found');
      console.log(line(c));
      if (c.details) console.log(`\n${c.details}`);
      const log = await api('GET', `/api/cards/${c.id}/log?limit=${opts.log || 30}`);
      if (log.length) console.log('\n--- transcript ---');
      for (const e of log) console.log(`[${e.kind}] ${e.text}`);
      break;
    }
    case 'add': {
      const c = await api('POST', '/api/cards', {
        project: opts.project, title: opts.title, details: opts.details, status: opts.status,
      });
      console.log(line(c));
      break;
    }
    case 'edit': {
      const body = {};
      for (const k of ['title', 'details', 'project']) if (opts[k] !== undefined) body[k] = opts[k];
      console.log(line(await api('PATCH', `/api/cards/${rest[0]}`, body)));
      break;
    }
    case 'move':
      console.log(line(await api('PATCH', `/api/cards/${rest[0]}`, { status: rest[1], message: opts.message })));
      break;
    case 'reply':
      console.log(line(await api('POST', `/api/cards/${rest[0]}/reply`, { text: rest.slice(1).join(' ') })));
      break;
    case 'stop':
      await api('POST', `/api/cards/${rest[0]}/stop`);
      console.log('Stopped.');
      break;
    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
