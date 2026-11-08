# Amox

A kanban board for all your projects, where cards run [Claude Code](https://claude.com/claude-code) agents. The name is from Nahuatl *amoxtli*, the codex where the Mexica kept their records.

Every folder in your projects folder becomes a project. Move a card to **In progress** and Amox runs Claude Code inside that project's folder; when it's done the card lands in **Review**, where you approve it or revert it with one tap. A chat pane next to the board has a **Main** agent that sees every project and turns ideas into cards, plus a tab per project that works like a terminal in that folder. It works from the laptop and the phone.

No dependencies, no build step: just Node and the `claude` CLI.

> **Heads up.** By default agents run with permissions skipped (like `claude --dangerously-skip-permissions`), so they can do anything your user can on this machine. Read [Permissions and safety](#permissions-and-safety) before pointing Amox at anything you can't lose.

## Requirements

- [Node.js](https://nodejs.org) 22 or newer.
- [Claude Code](https://claude.com/claude-code) installed and logged in: run `claude` once in a terminal and sign in. It must be on your `PATH`, or set `CLAUDE_BIN` to its full path.
- Git, for the Review buttons (Reject and Redo revert a card's changes with git).
- A folder that holds your projects, one subfolder per project (for example `~/code`).

## Quick start

```
git clone https://github.com/maurovz/amox
cd amox
npm start
```

Open http://127.0.0.1:4700.

`npx amox` will do the same once it's published to npm.

## First run

1. Amox asks where your projects are. Browse to the folder that holds them and pick **Use this folder**. Each subfolder becomes a project tab. You can change it later from **⚙** on the Main tab.
2. Pick a project tab and add a card with a title and what you want done.
3. Move it to **In progress**. The agent's transcript streams into the card.
4. When it finishes, the card moves to **Review**: **Approve** keeps the changes, **Reject** reverts them, **Redo** reverts and runs it again.

To stop Amox, press Ctrl+C in its terminal. Running cards are marked **Interrupted** on the next start and can be resumed.

## Where Amox keeps its state

Each projects folder has its own board, kept in a hidden `.amox` folder inside it. Switch the projects folder (⚙ on Main) and the tabs, cards and chats switch with it; switch back and yours are where you left them.

- `<projects folder>/.amox/board.json`: cards and chat state.
- `<projects folder>/.amox/logs/`: transcripts.
- `<projects folder>/.amox/projects.json`: per-project overrides, tab order and Main's settings (see [Projects](#projects)).
- `<projects folder>/.amox/backups/`: a copy of `board.json` per day, last 7 days. To undo a mistake, stop Amox and copy one back over `board.json`.

`.amox` has its own `.gitignore`, so it's never committed if the projects folder is a repo.

The server's own settings live in `~/.amox`, outside the repo, so updating Amox never touches them:

- `.env`: port, host and token (see [Configuration](#configuration)).
- `folders.json`: which projects folder is open, and recent ones.

Set `AMOX_HOME` to keep them somewhere else. A clone that already has `.env` in the repo folder keeps using that. Older versions kept one board for everything next to `.env` (`data/`, `projects.json`); the first start of this version copies it into the projects folder's `.amox` and leaves the old files as a backup.

## Configuration

Set these in `~/.amox/.env` or in the environment:

- `PORT`: default `4700`.
- `HOST`: default `127.0.0.1`. Anything else (like `0.0.0.0`) requires `AMOX_TOKEN`; Amox refuses to start without it.
- `AMOX_TOKEN`: a long random string. When set, every request needs it (see [Phone access](#phone-access)), and project agents only get access to their own project's cards. Generate one with `openssl rand -hex 32`.
- `AMOX_HOME`: where Amox keeps `.env` and `folders.json`, default `~/.amox`.
- `CLAUDE_BIN`: path to the `claude` executable, default `claude`.

Model, effort and permissions per project are set from **⚙** in the chat pane or in `projects.json`.

## Platforms

macOS is what it's used on daily. Linux should work but is untested. Windows is experimental: use WSL, or run it natively with Claude Code's native installer (`claude.exe` on the `PATH`). The `sandbox` option doesn't work on native Windows.

## How it works

- **Chat pane, always visible.** Tabs: **Main** (the lead, sees every project and the board) and one tab per project (Claude Code running in that folder, like a terminal there). The active tab also filters the board. On a phone, switch between Chat and Board at the top.
- **Activity dots and the project list.** Each tab's dot shows what that project is doing: green pulsing while its chat or one of its cards is running, solid for a reply you haven't read, amber when cards wait in Review or failed. Main's dot only follows Main's chat. The ⌄ at the end of the tabs lists every project (archived ones last) with a one-line summary such as "1 running · 2 to review · 3 open", and tapping one opens its tab. The tab strip fades at an edge when more tabs are hidden there.
- **Tab order:** drag project tabs to reorder them (on a phone, hold a tab, then drag). Main stays first. Saved as `order` in `projects.json`.
- **Columns:** Backlog, Ready, In progress, Review, Done. **Clear** in the Done header deletes the Done cards shown (every project on Main, only that project on its tab) and their transcripts, after asking.
- **In progress = go.** Moving a card there runs `claude -p` inside that project's folder, so it loads only that project's `CLAUDE.md` and memory, as if you opened Claude Code there. When it ends, the card moves to Review. If it fails (or Amox restarts mid-run), it goes back to Ready with a **Failed** (or **Interrupted**) badge instead; **Resume** continues the same session, and the review buttons stay available to revert or redo it.
- **Reply** on a card to ask or add something in the same session. A card is one Claude Code session and a reply is the next message, exactly like a terminal. The card stays in its column while it's answered. How long and how the agents answer comes from your `CLAUDE.md` files (global `~/.claude/CLAUDE.md` and the project's), as in the terminal. **Stop** (it replaces Send while the agent works, or press Esc in the message box) kills the run, like Esc in the terminal.
- **Review buttons** (fixed actions, the agent isn't asked anything):
  - **Approve**: keep the changes, move to Done.
  - **Reject**: revert the card's changes, back to Ready with a fresh session.
  - **Redo**: revert, then run the card again from scratch.

  Revert uses git. Before a card first runs, Amox records each repo in the project folder (the folder itself, or its direct subfolders for folders that hold several repos): HEAD, branch, and your uncommitted work, saved as a hidden commit under `refs/board/` without touching your files. Revert puts it all back exactly. It refuses, changing nothing, if the card's commits were pushed or the branch changed. Changes made meanwhile from the project chat are reverted too.
- One running card per project at a time, since they share the working tree. Others wait as Queued.
- **Project tabs manage their own cards.** Ask a project tab to list, add, edit, move, start or reply to cards and it uses `cli.js`, but only for that project: it gets its own token, and the server refuses its requests for other projects' cards, chats and settings. Main still manages everything. The limit only holds with `AMOX_TOKEN` set (without one, any local request gets full access). Project agents (tabs and cards) also can't read or change the board's `.amox` folder or Amox's `.env`; with `sandbox` on, that holds for every Bash command too.
- **Main** is a Claude session in the root projects folder (picked on first start, changed from ⚙ on Main). It can read every project and manages cards with `cli.js`. It only starts cards when you tell it to. When a card Main started or replied to ends, Amox sends Main the card's last reply and Main tells you in its tab (Main only runs when it gets a message, so it couldn't report back otherwise). Cards you start yourself don't do this. Its brief is `lead/brief.md`.
- **If you clone Amox inside your projects folder** it becomes a project too, with its own tab. Its agents can't touch Amox's `.env`, and code changes need a restart (`npm start` again).

## Projects

**Archive.** A project that is not active now can be archived from its tab (**Archive** button, asks first). Its folder moves into an `archive` folder next to it (`~/code/my-app` → `~/code/archive/my-app`), together with Claude Code's memory and sessions for that path (`~/.claude/projects/`), and `projects.json` gets the new path. In the board it goes into the **Archive** folder at the end of the tabs, and its cards leave Main. **Unarchive** moves everything back. Close the project in editors and terminals before archiving.

**Discovered, not listed.** Every folder in the projects folder is a project, and folders in `archive/` are archived ones. New, renamed or removed folders show up when you tap **↻** (top bar), no restart. Hidden folders and `knowledge` are skipped (`ignore` in `projects.json` to change that).

`.amox/projects.json` in the projects folder (optional, see `projects.example.json`) only holds overrides, re-read automatically. An entry matches a folder by name and can set `id` (keeps existing cards attached), `name`, and:

- `permissionMode`: default `bypassPermissions`, the same as `--dangerously-skip-permissions`. Agents never ask. Use `acceptEdits` for a project you want locked down. Main takes the same option under `lead`.
- `model` and `effort`: default `opus` (the latest Opus) and `high`. Set them from **⚙** in the chat pane, per tab: Main's go under `lead`, a project's apply to its chat and its cards, from the next message on.
- `sandbox`: default `false`. `true` runs Bash in the OS sandbox: writes only inside the project folder, network limited to allowed domains.
- `allowedTools`: extra rules, e.g. `["Bash(npm install:*)"]`.

## Permissions and safety

Nobody is around to answer a permission prompt on a running card, so agents skip permissions by default. That means they can do anything your user can on this machine. Run Amox somewhere isolated (a VM, a spare machine, a container) before giving it anything you can't lose.

To lock a project down, set in its `projects.json` entry:

- `"permissionMode": "acceptEdits"`: agents can edit files, and anything that would need a prompt is denied and shows in the transcript as a failed tool call. Add what you trust to `allowedTools`.
- `"sandbox": true`: Bash runs in the OS sandbox, writes only inside the project folder, network limited to allowed domains.

Deny rules in a project's `.claude/settings.json` and your Claude Code hooks still apply when permissions are skipped. Project agents can't read or change Amox's own `.env` or the board's `.amox` folder. Set `AMOX_TOKEN` even locally if you want project agents limited to their own project's cards.

## Phone access

Set a token in `~/.amox/.env` before exposing it:

```
AMOX_TOKEN=<long random string>
HOST=0.0.0.0
```

Easiest is [Tailscale](https://tailscale.com) on the computer and the phone: open `http://<computer-name>:4700/?token=<token>` once, then "Add to Home Screen". The token is stored as a cookie.

## Running on a server

Amox runs agents on the machine it lives on, so a server needs the repos cloned there, Node, and `claude` logged in. Pick the projects folder on first start, set `AMOX_TOKEN` and `HOST`, and put it behind HTTPS (Caddy, Coolify, or `tailscale serve`). An isolated machine or VM is also the safest place to let agents skip permissions.

## Card CLI

`cli.js` manages cards from a terminal. Main and the project tabs use it too. It talks to the running server and reads the same `.env`.

```
node cli.js projects
node cli.js list --project my-app
node cli.js add --project my-app --title "Add a dark mode" --status ready
node cli.js move <id> in_progress
node cli.js reply <id> "Also cover the settings page"
```

Run `node cli.js` for every command. Set `AMOX_URL` if the server isn't on `http://127.0.0.1:4700`.

## Development

```
npm start                # run it
node --check server.js   # quick syntax check; there are no tests yet
```

To try changes without touching your real board, run a second instance with its own state:

```
AMOX_HOME=/tmp/amox-dev PORT=4799 node server.js
```

Files:

- `server.js`: HTTP API, agent runner (`claude -p --output-format stream-json`), live updates over SSE, token auth, archive.
- `cli.js`: card commands.
- `public/`: the UI, plain HTML, CSS and JS modules.
- `lead/brief.md`: Main's instructions, passed as a system prompt.

Keep it dependency-free, and make UI changes work at phone width with touch (no hover-only or drag-only interactions).

## License

Not chosen yet.
