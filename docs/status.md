# Status

As of 2026-11-01.

## Works

- Board with five columns (Backlog, Ready, In progress, Review, Done). Moving a card to In progress runs a task agent in that project's folder. Reply resumes the same session, Stop kills it. One running card per project; the rest queue.
- Chat pane: Main tab plus one tab per project, always visible on desktop (resizable, collapsible), Chat/Board toggle on phones. The active tab filters the board.
- Main runs in `~/code` and manages cards through `cli.js`.
- Task agents and project chats run sandboxed: writes only inside their folder, anything needing a permission prompt is denied and shown on the card.
- Archive / unarchive a project (moves its folder and its Claude Code memory).
- Token auth (cookie after `?token=` once), so it can be exposed.

## Tested

Only locally, against a throwaway project: task run, resume, sandbox blocking writes outside the folder, Main creating cards, a project chat loading its own `CLAUDE.md`. The UI has not been checked in a browser by an agent.

## Open

- Not hosted. Phone access planned through Tailscale first (see README).
- No git remote yet.
- Project KBs that live outside their repo (`knowledge/projects/<slug>/`, for client and open source repos) aren't passed to agents yet.
- A project chat and a running card in the same folder don't wait for each other.
- No tests.
