# Status

As of 2026-11-07. Getting ready to open source: first-run folder picker, state in `~/.amox`, runnable with `npx`, first Windows support.

## Works

- Board with five columns (Backlog, Ready, In progress, Review, Done). Moving a card to In progress runs a task agent in that project's folder. Reply resumes the same session, Stop kills it. One running card per project; the rest queue.
- Chat pane: Main tab plus one tab per project, always visible on desktop (resizable, collapsible), Chat/Board toggle on phones. The active tab filters the board.
- Main runs in `~/code` and manages cards through `cli.js`.
- Project tabs manage their own project's cards through `cli.js` with a per-project token (refused for anything else). Project agents can't read Amox's `data/`, `projects.json`, `.env`.
- Agents (cards, project chats, Main) skip permissions by default. Deny rules and hooks still apply. Per project, `acceptEdits` plus `sandbox` locks one down.
- Projects are discovered from the root folder (↻ picks up new folders); `projects.json` only overrides.
- Tab dots show activity per project (chat or card running, unread, cards in Review or failed). The ⌄ after the tabs lists all projects with a short summary; the strip fades where more tabs are hidden.
- First start asks for the projects folder (a folder browser served by Amox); ⚙ on Main changes it. New installs keep `.env`, `projects.json` and `data/` in `~/.amox`; this install still keeps them in the repo. `package.json` has a `bin`, so `npx amox` works (tested from a packed tarball); not published yet.
- Windows: home folder, Stop (taskkill) and deny-rule paths handled, agents spawn without a console window. Untested, labeled experimental.
- Review: Approve, Reject (git revert, back to Ready), Redo (revert and rerun). Tested on a scratch repo: exact restore, refuses after a push.
- Archive / unarchive a project (moves its folder and its Claude Code memory).
- Token auth (cookie after `?token=` once), so it can be exposed.

## Tested

Only locally, against a throwaway project: task run, resume, sandbox blocking writes outside the folder, Main creating cards, a project chat loading its own `CLAUDE.md`, skipped permissions with a deny rule still blocking. Project tab card access (2026-11-04), with and without sandbox: own cards work, other projects' cards, refresh and moving a card to another project are refused, reading `data/board.json` is denied. The tab dots, ⌄ project list and edge fade were checked in headless Chrome at 390px and 1200px on a scratch instance (2026-11-07), without a running card. The rest of the UI has not been checked in a browser by an agent.

## Open

- Isolation: agents skip permissions on the user's own Mac for now. Plan is to move the board somewhere isolated.
- Not hosted. Phone access planned through Tailscale first (see README).
- Repo: github.com/maurovz/amox (private for now), folder `~/code/amox`. The project id stays `board` (set in `projects.json`) so existing cards stay attached.
- Project KBs that live outside their repo (`knowledge/projects/<slug>/`, for client and open source repos) aren't passed to agents yet.
- A project chat and a running card in the same folder don't wait for each other.
- No tests.
- Open source: still to do. Pick a license, publish to npm, make `lead/brief.md` work without the user's `knowledge/` folder, safer default than skipping permissions for new users, a screenshot in the README (it now leads with requirements, quick start and first run).
