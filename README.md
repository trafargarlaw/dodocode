# dodocode

A desktop app for working with coding agents. Runs on macOS, Windows and Linux.

Built with Electron, React, Vite, Tailwind and shadcn/ui, in a Turborepo with pnpm workspaces.

## Develop

```sh
pnpm install
pnpm dev        # app with hot reload
```

## Build

Run these from the repo root. turbo type checks and builds first, and caches both.

```sh
pnpm build      # type check, then build to apps/desktop/out/
pnpm start      # run the built app
pnpm package    # unpacked app for this OS in apps/desktop/release/ (fastest usable build)
pnpm dist       # installers for this OS in apps/desktop/release/
```

## Check

```sh
pnpm typecheck
pnpm lint       # oxlint
pnpm format     # oxfmt
```

## Layout

- `apps/desktop`: the Electron app
  - `src/main`: main process (windows, system access)
  - `src/preload`: the bridge the UI reaches as `window.dodocode`
  - `src/renderer`: the React UI
- `packages/ui`: shared shadcn components, hooks and theme (`@dodocode/ui`)
- `packages/typescript-config`: shared TypeScript settings
