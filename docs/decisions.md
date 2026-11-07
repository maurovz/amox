# Decisions

Newest first.

## 2026-11-07. Project overview lives in the tab strip, not a new view

The user wanted to see at a glance which projects are active, without bloating the product. Trello doesn't have a cross-board status view in the base product either: boards are listed, and closing a board is how you mark it inactive (Amox's Archive does that). So no dashboard. Each tab's dot now also lights up for a running card (before, only for the chat) and turns amber for cards in Review or failed. It was also unclear that the tabs scroll. The usual fix (Chrome, VS Code, Material tabs) is an edge fade plus an overflow button that lists every tab. That list also gives each project a one-line summary, so it doubles as the overview.

## 2026-11-04. Project tabs manage their own cards, with a scoped token

From a project tab the user couldn't touch the board. Running project tabs from the root folder instead was rejected: they'd lose the project's `CLAUDE.md`, settings and git context. And adding a config file to each repo was out, since some repos are strict about what gets committed. Now a project tab stays in its folder and gets `cli.js` plus a token made for that project, fresh on every server start. The server only lets that token reach the project's own cards (a header could be faked, a token can't). Main keeps the master token and sees everything. Project agents are denied Amox's `data/`, `projects.json` and `.env` through `--settings` deny rules, so they can't read other projects' cards or the master token from disk. In sandboxed projects `cli.js` runs outside the sandbox, which blocks localhost. A chained command stays fully sandboxed. This only holds with `AMOX_TOKEN` set. It's a guard against agents wandering, not a wall: an unsandboxed agent running as the same user could still dig the token out another way.

## 2026-11-02. Failed runs go back to Ready

Failed and interrupted cards landed in Review, mixed with finished work that needs a look. Now they return to Ready with a red Failed or Interrupted badge (shown in Ready and Review). The session is kept, so Resume continues it instead of starting over; Reject is still there to revert. Stopped runs still go to Review, since stopping is the user's own choice.

## 2026-11-02. Renamed to Amox

"Board" was too generic. Amox is short for Nahuatl *amoxtli*, the codex where the Mexica kept their records. The GitHub repo and folder were renamed too. The `board` project id, `data/board.json`, `refs/board/` snapshots, browser storage keys, the login cookie and the `x-board-from` header keep their old names (`projects.json` maps the `amox` folder to id `board`) so the live install, saved settings and existing card snapshots keep working. Env vars are now `AMOX_*`, with `BOARD_*` still read as a fallback.

## 2026-11-01. Cards report back to Main

Main said "I'll show you the commit when c1 finishes" and never did: it only runs when it gets a message. Now, when a run that Main started or replied to ends (finished or failed, not stopped), the board sends Main a `[Board]` message with the card's last reply, queued if Main is busy, and Main tells the user. `cli.js` marks Main's calls with `x-board-from: main`. Runs the user starts from the UI don't notify, so Main isn't woken for nothing.

## 2026-11-01. Review is decided by buttons, not by the agent

Asking "summary" on a card made the agent check the repo and report again, because every reply resent "end with what changed". A card is now plainly one Claude Code session: the same two-line context on every message, replies passed as written, and answer style left to the user's `CLAUDE.md` files (a first attempt with separate reply prompts and injected style notes was dropped as over-engineered). Approve / Reject / Redo are fixed actions. Reject and Redo revert through git snapshots taken before the card's first run, and refuse when the work was pushed.

## 2026-11-01. Projects are discovered from the root folder

A fixed list in `projects.json` missed new folders. Now every folder in Main's root is a project and `archive/` holds archived ones, rescanned when the user taps ↻ (or Main runs `cli.js refresh`), not on a timer. `projects.json` is only overrides, matched by folder name, so ids stay stable across archive moves and existing cards keep their project.

## 2026-11-01. Agents skip permissions until the board is isolated

Agents run with `bypassPermissions` (like `--dangerously-skip-permissions`) by default: denying every prompt made them useless, and the user wants Claude Code's normal freedom. Deny rules and hooks still apply (the board protects its own `data/`, `projects.json`, `.env` this way). Real safety will come from isolating where the board runs, not from prompts. Supersedes the "sandbox plus no prompts" default below, which stays available per project.

## 2026-11-01. Main runs in the root projects folder

Main's working folder is `~/code` (configurable as `lead.cwd`), so it sits above every project, the board included, and can read all of them without extra flags. Its instructions are `lead/brief.md`, passed as a system prompt, not a `CLAUDE.md`: Claude Code loads every `CLAUDE.md` from the working folder upward, so a brief inside this repo would leak into sessions that work on the board, and a `CLAUDE.md` at the root would leak into every project.

## 2026-11-01. The board is one of the projects

It has its own tab and cards, and is changed through them like any other project. Its agents must not touch the live state (`data/`, `projects.json`, `.env`) or restart the server.

## 2026-11-01. Build instead of adopting Vibe Kanban

Vibe Kanban and similar tools cover more than needed (diff review, PRs, previews). The core here is small: a board, `claude -p` per card in the project folder, a lead agent. Zero dependencies so it's easy to host and change.

## 2026-11-01. One session per folder, not subagents

Task agents are separate `claude` processes started in the project folder, so they load only that project's `CLAUDE.md` and memory, exactly like opening a terminal there. Subagents would share Main's context and folder.

## 2026-11-01. Headless agents: sandbox plus no prompts

Nobody can answer a permission prompt on a card, so prompts are denied (`--permission-prompts none`). Bash runs in the OS sandbox, auto-allowed, writing only inside the project folder. Extra permissions are per project in `projects.json`.
