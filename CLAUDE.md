# Amox

Amox (Nahuatl *amoxtli*, "codex") is the user's personal kanban board for all their projects. Cards run Claude Code task agents inside each project's folder. A chat pane has a **Main** tab (an agent in the root projects folder that sees everything and manages cards) and one tab per project (Claude Code in that folder). Used from the laptop and the phone. Personal tool, owned by the user.

How to use it: `README.md`. Where it stands: `docs/status.md`. Why it is the way it is: `docs/decisions.md`.

## Stack

- Node 22+, **no dependencies**. Keep it that way unless there's a strong reason.
- `server.js`: HTTP API, agent runner (`claude -p --output-format stream-json`), live updates over SSE, token auth, archive.
- `cli.js`: card commands. Main uses it; so can the user.
- `public/`: plain HTML, CSS and JS modules. No build step.
- `lead/brief.md`: Main's instructions, passed as a system prompt. Not a `CLAUDE.md` on purpose (see decisions).
- State: each projects folder has its own board in `<folder>/.amox/` (`board.json`, `logs/`, `projects.json`, `backups/`). The server's `.env` and `folders.json` (open folder) live in `~/.amox` or, for this install, the repo. None of these are committed. The repo's old `data/` and `projects.json` stay as a backup of the pre-`.amox` board.

## Run

```
npm start              # http://127.0.0.1:4700
node --check server.js # quick syntax check; there are no tests yet
```

To test without touching real projects, run a second instance with its own config and data:

```
AMOX_HOME=/tmp/x PORT=4799 node server.js   # then pick a scratch projects folder in the UI
```

## Rules

- **Never touch `.env`, `folders.json`, `data/`, `projects.json`, or the `.amox` folder in the projects folder.** They are the live board you may be running inside. Change behavior in code instead.
- **Never restart or kill the Amox server.** It's what runs you; restarting it interrupts every running agent. When a change needs a restart, say so at the end.
- Phone first: every UI change must work at phone width and with touch (no hover-only, no drag-only).
- Keep `README.md` in sync when behavior a user sees changes.
- When a change settles a decision or moves the state, update `docs/decisions.md` or `docs/status.md` in the same commit.
- Answers and UI copy in English.
