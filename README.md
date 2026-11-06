# Amox

A kanban board for all projects. The name is from Nahuatl *amoxtli*, the codex where the Mexica kept their records. Cards run Claude Code task agents, and a lead agent you chat with turns ideas into cards. No dependencies, just Node 22+ and the `claude` CLI logged in.

## Run

```
cd ~/code/amox
npm start
```

Open http://127.0.0.1:4700.

## How it works

- **Chat pane, always visible.** Tabs: **Main** (the lead, sees every project and the board) and one tab per project (Claude Code running in that folder, like a terminal there). The active tab also filters the board. On a phone, switch between Chat and Board at the top.
- **Tab order:** drag project tabs to reorder them (on a phone, hold a tab, then drag). Main stays first. Saved as `order` in `projects.json`.
- **Columns:** Backlog, Ready, In progress, Review, Done. **Clear** in the Done header deletes the Done cards shown (every project on Main, only that project on its tab) and their transcripts, after asking.
- **In progress = go.** Moving a card there runs `claude -p` inside that project's folder, so it loads only that project's `CLAUDE.md` and memory, as if you opened Claude Code there. When it ends, the card moves to Review. If it fails (or Amox restarts mid-run), it goes back to Ready with a **Failed** (or **Interrupted**) badge instead; **Resume** continues the same session, and the review buttons stay available to revert or redo it.
- **Reply** on a card to ask or add something in the same session. A card is one Claude Code session and a reply is the next message, exactly like a terminal. The card stays in its column while it's answered. How long and how the agents answer comes from your `CLAUDE.md` files (global `~/.claude/CLAUDE.md` and the project's), as in the terminal. **Stop** (it replaces Send while the agent works, or press Esc in the message box) kills the run, like Esc in the terminal.
- **Review buttons** (fixed actions, the agent isn't asked anything):
  - **Approve**: keep the changes, move to Done.
  - **Reject**: revert the card's changes, back to Ready with a fresh session.
  - **Redo**: revert, then run the card again from scratch.

  Revert uses git. Before a card first runs, Amox records each repo in the project folder (the folder itself, or its direct subfolders for multi-repo folders): HEAD, branch, and your uncommitted work, saved as a hidden commit under `refs/board/` without touching your files. Revert puts it all back exactly. It refuses, changing nothing, if the card's commits were pushed or the branch changed. Changes made meanwhile from the project chat are reverted too.
- One running card per project at a time, since they share the working tree. Others wait as Queued.
- **Project tabs manage their own cards.** Ask a project tab to list, add, edit, move, start or reply to cards and it uses `cli.js`, but only for that project: it gets its own token, and the server refuses its requests for other projects' cards, chats and settings. Main still manages everything. The limit only holds with `AMOX_TOKEN` set (without one, any local request gets full access). Project agents (tabs and cards) also can't read or change Amox's `data/`, `projects.json` or `.env`; with `sandbox` on, that holds for every Bash command too.
- **Main** is a Claude session in the root projects folder (`lead.cwd` in `projects.json`, default: the folder that holds this repo). It reads every project and the portfolio KB, and manages cards with `cli.js`. It only starts cards when you tell it to. When a card Main started or replied to ends, Amox sends Main the card's last reply and Main tells you in its tab (Main only runs when it gets a message, so it couldn't report back otherwise). Cards you start yourself don't do this. Its brief is `lead/brief.md`.
- **Amox is a project too** (its own tab). Its agents can't touch `data/`, `projects.json` or `.env`, and code changes need a restart (`npm start` again).

## Projects

**Archive.** A project that is not active now can be archived from its tab (**Archive** button, asks first). Its folder moves into an `archive` folder next to it (`~/code/my-app` → `~/code/archive/my-app`), together with Claude Code's memory and sessions for that path (`~/.claude/projects/`), and `projects.json` gets the new path. In the board it goes into the **Archive** folder at the end of the tabs, and its cards leave Main. **Unarchive** moves everything back. Close the project in editors and terminals before archiving.

**Discovered, not listed.** Every folder in the root (`lead.cwd`, default `~/code`) is a project, and folders in `archive/` are archived ones. New, renamed or removed folders show up when you tap **↻** (top bar), no restart. Hidden folders and `knowledge` are skipped (`ignore` in `projects.json` to change that).

`projects.json` (optional, not committed, see `projects.example.json`) only holds overrides, re-read automatically. An entry matches a folder by name and can set `id` (keeps existing cards attached), `name`, and:

- `permissionMode`: default `bypassPermissions`, the same as `--dangerously-skip-permissions`. Agents never ask. Use `acceptEdits` for a project you want locked down. Main takes the same option under `lead`.
- `model` and `effort`: default `opus` (the latest Opus) and `high`. Set them from **⚙** in the chat pane, per tab: Main's go under `lead`, a project's apply to its chat and its cards, from the next message on.
- `sandbox`: default `false`. `true` runs Bash in the OS sandbox: writes only inside the project folder, network limited to allowed domains.
- `allowedTools`: extra rules, e.g. `["Bash(npm install:*)"]`.

Deny rules in a project's `.claude/settings.json` and your hooks still apply when permissions are skipped. In a project that isn't on `bypassPermissions`, anything that would need a prompt is denied and shows as "Not allowed: …".

Skipping permissions means agents can do anything your user can on this machine. Run Amox somewhere isolated before giving it anything you can't lose.

## Phone access

Set a token in `.env` before exposing it:

```
AMOX_TOKEN=<long random string>
HOST=0.0.0.0
```

Easiest is [Tailscale](https://tailscale.com) on the Mac and the phone: open `http://<mac-name>:4700/?token=<token>` once, then "Add to Home Screen". The token is stored as a cookie.

## Hosting later

Amox runs agents on the machine it lives on, so a server needs the repos cloned, Node, and `claude` logged in there. Point `projects.json` at those paths, set `AMOX_TOKEN`, and put it behind HTTPS (Coolify, Caddy, or `tailscale serve`). Env: `PORT`, `HOST`, `AMOX_TOKEN` (the old `BOARD_TOKEN` still works), `DATA_DIR`, `PROJECTS_FILE`, `CLAUDE_BIN`.

## Files

- `server.js`: API, agent runner, live updates (SSE).
- `cli.js`: card commands, used by the lead and by you.
- `public/`: the UI.
- `data/`: cards and transcripts (`logs/<id>.jsonl`, raw stream in `<id>.raw.jsonl`).
