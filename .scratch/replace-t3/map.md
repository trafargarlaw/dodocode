# Replace T3 Code with dodocode

## Notes

- Goal: do daily work in dodocode instead of T3 Code. After fixing something, get a build I can use straight away.
- Reference implementation: the t3code repo, cloned next to this one (`../t3code`).
- T3 usage, Aug 20 – Nov 11 2026, from a read-only copy of the T3 database:
  - Opus 5.5 at xhigh effort ran 93% of 1,508 turns.
  - Every thread ran in full-access mode.
  - Codex was used only by delegating to it (18 runs).
  - 306 threads over 21 projects; one project has 74% of turns.
- T3's agent-driven preview is an Electron `<webview>` controlled over the Chrome DevTools Protocol (`apps/desktop/src/preview/Manager.ts`).
- Many must-have features are tools the app gives the agent through its own MCP server, as T3 does: browser preview, inline charts and mockups, handing over a secret, PR linking, background task tracking, and delegation.

## Decisions so far

- **Platforms:** macOS, Windows and Linux, all from the start.
- **Must have** (each was used in T3):
  - the agent drives a browser preview
  - subagent child threads
  - PR linking
  - pasted screenshots
  - background task tracking
  - queue or steer a message while a run is going
  - inline charts and mockups from the agent
  - interrupt a run
  - a terminal
  - delegate to another agent
  - worktree threads
  - answer the agent's questions
  - side chat (fork)
  - roll back a turn
  - hand over a secret
- **Also core** (from the original brief): projects with many threads, Open in VS Code, reviewing diffs.
- **Should exist, low priority:**
  - plan mode
  - approving commands
  - switching provider mid-thread
  - scheduled tasks and workflows (likely to be used later)
- **Dropped for now:** the PR review screen, pin/snooze/archive, project scripts.
- **Repo:** a Turborepo with pnpm workspaces. The Electron app is `apps/desktop`; shared code goes in `packages/`. Lint and format stay oxlint and oxfmt, run once from the root.
- **Desktop shell: Electron.** It gives Chromium and the DevTools Protocol on all three systems, so the agent can drive an in-app preview. See `docs/adr/0001-electron-desktop-shell.md`. Scaffolded with electron-vite and electron-builder; `pnpm package` gives an unpacked app in about 20 seconds.

## Fog

- **Backend language:** still under discussion. TypeScript is the current leaning.
  - The Claude Agent SDK exists only for TypeScript and Python, so a Rust backend means speaking the `claude` CLI's JSON stream by hand.
  - Keeping the backend a separate server that the UI reaches over a WebSocket keeps the shell thin.
- **Builds:** how a stable build stays usable while dodocode is being edited.
- **Build order** (draft):
  1. One Claude thread: streaming, interrupt, queue/steer, screenshots, answering questions, effort level, Open in VS Code.
  2. Projects and many threads, saved and resumable, with subagent child threads and background task tracking.
  3. dodocode's own MCP server: inline charts, handing over a secret, PR linking.
  4. Review: per-turn checkpoints, a diff panel, rollback.
  5. Terminal.
  6. Side chat and worktrees.
  7. Agent-driven browser preview.
  8. Delegation to other agents (Codex), then switching provider mid-thread.
  9. Plan mode, command approvals, scheduled tasks and workflows.
