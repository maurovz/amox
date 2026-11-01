# Board

A kanban board for all projects. Cards run Claude Code task agents, and a lead agent you chat with turns ideas into cards. No dependencies, just Node 22+ and the `claude` CLI logged in.

## Run

```
cd ~/code/board
npm start
```

Open http://127.0.0.1:4700.

## How it works

- **Chat pane, always visible.** Tabs: **Main** (the lead, sees every project and the board) and one tab per project (Claude Code running in that folder, like a terminal there). The active tab also filters the board. On a phone, switch between Chat and Board at the top.
- **Columns:** Backlog, Ready, In progress, Review, Done.
- **In progress = go.** Moving a card there runs `claude -p` inside that project's folder, so it loads only that project's `CLAUDE.md` and memory, as if you opened Claude Code there. When it ends, the card moves to Review.
- **Reply** on a card to continue the same session. **Stop** kills it.
- One running card per project at a time, since they share the working tree. Others wait as Queued.
- **Main** is a Claude session in the root projects folder (`lead.cwd` in `projects.json`, default: the folder that holds this repo). It reads every project and the portfolio KB, and manages cards with `cli.js`. It only starts cards when you tell it to. Its brief is `lead/brief.md`.
- **The board is a project too** (`board` tab). Its agents can't touch `data/`, `projects.json` or `.env`, and code changes need a restart (`npm start` again).

## Projects

**Archive.** A project that is not active now can be archived from its tab (**Archive** button, asks first). Its folder moves into an `archive` folder next to it (`~/code/my-app` → `~/code/archive/my-app`), together with Claude Code's memory and sessions for that path (`~/.claude/projects/`), and `projects.json` gets the new path. In the board it goes into the **Archive** folder at the end of the tabs, and its cards leave Main. **Unarchive** moves everything back. Close the project in editors and terminals before archiving.

**Discovered, not listed.** Every folder in the root (`lead.cwd`, default `~/code`) is a project, and folders in `archive/` are archived ones. New, renamed or removed folders show up within a few seconds, no restart. Hidden folders and `knowledge` are skipped (`ignore` in `projects.json` to change that).

`projects.json` (optional, not committed, see `projects.example.json`) only holds overrides, re-read automatically. An entry matches a folder by name and can set `id` (keeps existing cards attached), `name`, and:

- `permissionMode`: default `bypassPermissions`, the same as `--dangerously-skip-permissions`. Agents never ask. Use `acceptEdits` for a project you want locked down. Main takes the same option under `lead`.
- `sandbox`: default `false`. `true` runs Bash in the OS sandbox: writes only inside the project folder, network limited to allowed domains.
- `allowedTools`: extra rules, e.g. `["Bash(npm install:*)"]`.

Deny rules in a project's `.claude/settings.json` and your hooks still apply when permissions are skipped. In a project that isn't on `bypassPermissions`, anything that would need a prompt is denied and shows as "Not allowed: …".

Skipping permissions means agents can do anything your user can on this machine. Run the board somewhere isolated before giving it anything you can't lose.

## Phone access

Set a token in `.env` before exposing it:

```
BOARD_TOKEN=<long random string>
HOST=0.0.0.0
```

Easiest is [Tailscale](https://tailscale.com) on the Mac and the phone: open `http://<mac-name>:4700/?token=<token>` once, then "Add to Home Screen". The token is stored as a cookie.

## Hosting later

The board runs agents on the machine it lives on, so a server needs the repos cloned, Node, and `claude` logged in there. Point `projects.json` at those paths, set `BOARD_TOKEN`, and put it behind HTTPS (Coolify, Caddy, or `tailscale serve`). Env: `PORT`, `HOST`, `BOARD_TOKEN`, `DATA_DIR`, `PROJECTS_FILE`, `CLAUDE_BIN`.

## Files

- `server.js`: API, agent runner, live updates (SSE).
- `cli.js`: card commands, used by the lead and by you.
- `public/`: the UI.
- `data/`: cards and transcripts (`logs/<id>.jsonl`, raw stream in `<id>.raw.jsonl`).
