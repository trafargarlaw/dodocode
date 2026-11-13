<img src="apps/desktop/build/logo.svg" alt="" width="64" />

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

## Icons

`apps/desktop/build/logo.svg` is the logo, and `apps/desktop/build/tray.svg` is its one-colour
version for a tray icon, which the app does not show yet. After changing either, make the icons
again:

```sh
pnpm --filter @dodocode/desktop icons
```

## Layout

- `apps/desktop`: the Electron app
  - `src/main`: main process (windows, system access)
  - `src/preload`: the bridge the UI reaches as `window.dodocode`
  - `src/renderer`: the React UI
  - `build`: the logo and the app icons made from it
  - `resources`: the tray icons, made ahead of a tray; the app does not ship them yet
- `packages/ui`: shared shadcn components, hooks and theme (`@dodocode/ui`)
- `packages/typescript-config`: shared TypeScript settings
