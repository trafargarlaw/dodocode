## Monorepo

A Turborepo with pnpm workspaces: apps in `apps/`, shared packages in `packages/`.

- **Tasks:** run them from the root (`pnpm build`, `pnpm package`). turbo runs `typecheck` and `build` first; an app's own `package` script run alone ships a stale `out/`.
- **Turborepo:** before changing `turbo.json` or turbo commands, read the docs bundled with the installed version, starting at `node_modules/turbo/docs/README.md`.
- **Lint and format:** oxlint and oxfmt, run once over the whole repo from the root (`pnpm lint`, `pnpm format`). They replace eslint and prettier, so remove any eslint or prettier setup a generator adds.

## Packages

Use pnpm, and add a package to the workspace package that imports it. Root `devDependencies` hold only repo-wide tools.

- **`apps/desktop`:** `devDependencies` by default (`pnpm add -D <pkg> --filter @dodocode/desktop`), workspace packages included, because Vite bundles everything the renderer and preload import. Use `dependencies` only for a package the Electron main process imports at runtime: electron-vite leaves those imports unbundled, and electron-builder ships `dependencies` inside the packaged app.
- **`packages/*`:** what a package's source imports goes in its `dependencies`. The app still bundles it all, because it lists the workspace package in `devDependencies`.

## UI components

`packages/ui` (`@dodocode/ui`) holds the shadcn components, hooks and theme that apps share. Import them as `@dodocode/ui/components/<name>`. Run the shadcn CLI in `packages/ui` (`pnpm exec shadcn add <name>`). Run from `apps/desktop`, it still writes the component to `packages/ui`, but it puts the component's dependencies in the desktop's `dependencies`, which ships them unbundled.

## Performance

Before making anything faster, or claiming a change did, measure it with `pnpm trace` and `pnpm perfq`, as `docs/agents/perf.md` describes.

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues on `trafargarlaw/dodocode` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
