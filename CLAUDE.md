## Monorepo

A Turborepo with pnpm workspaces: apps in `apps/`, shared packages in `packages/`.

- **Tasks:** run them from the root (`pnpm build`, `pnpm package`). turbo runs `typecheck` and `build` first; an app's own `package` script run alone ships a stale `out/`.
- **Turborepo:** before changing `turbo.json` or turbo commands, read the docs bundled with the installed version, starting at `node_modules/turbo/docs/README.md`.
- **Lint and format:** oxlint and oxfmt, run once over the whole repo from the root (`pnpm lint`, `pnpm format`). They replace eslint and prettier, so remove any eslint or prettier setup a generator adds.

## Packages

Use pnpm. Add a package to the workspace package that imports it, in `devDependencies` by default: `pnpm add -D <pkg> --filter @dodocode/desktop`. Vite bundles everything the desktop renderer and preload import. In `apps/desktop`, put a package in `dependencies` only when the Electron main process imports it at runtime; electron-vite leaves those imports unbundled, and electron-builder ships `dependencies` inside the packaged app. Root `devDependencies` hold only repo-wide tools.

## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
