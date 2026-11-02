# Status

As of 2026-11-02. Renamed from Board to Amox.

## Works

- Board with five columns (Backlog, Ready, In progress, Review, Done). Moving a card to In progress runs a task agent in that project's folder. Reply resumes the same session, Stop kills it. One running card per project; the rest queue.
- Chat pane: Main tab plus one tab per project, always visible on desktop (resizable, collapsible), Chat/Board toggle on phones. The active tab filters the board.
- Main runs in `~/code` and manages cards through `cli.js`.
- Agents (cards, project chats, Main) skip permissions by default. Deny rules and hooks still apply. Per project, `acceptEdits` plus `sandbox` locks one down.
- Projects are discovered from the root folder (↻ picks up new folders); `projects.json` only overrides.
- Review: Approve, Reject (git revert, back to Ready), Redo (revert and rerun). Tested on a scratch repo: exact restore, refuses after a push.
- Archive / unarchive a project (moves its folder and its Claude Code memory).
- Token auth (cookie after `?token=` once), so it can be exposed.

## Tested

Only locally, against a throwaway project: task run, resume, sandbox blocking writes outside the folder, Main creating cards, a project chat loading its own `CLAUDE.md`, skipped permissions with a deny rule still blocking. The UI has not been checked in a browser by an agent.

## Open

- Isolation: agents skip permissions on the user's own Mac for now. Plan is to move the board somewhere isolated.
- Not hosted. Phone access planned through Tailscale first (see README).
- Repo: github.com/maurovz/amox (private), folder `~/code/amox`. The project id stays `board` (set in `projects.json`) so existing cards stay attached.
- Project KBs that live outside their repo (`knowledge/projects/<slug>/`, for client and open source repos) aren't passed to agents yet.
- A project chat and a running card in the same folder don't wait for each other.
- No tests.
