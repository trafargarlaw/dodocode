# File layout

Where a file goes and what it may contain. The rules are the **File layout** section of the instruction file (`CLAUDE.md` or `AGENTS.md`); this page is the picture behind them.

## Why this shape

Someone walking the code should be able to guess a file's path before searching, and know what a file holds before opening it. A path answers three questions:

1. **Which part of the app?** The top folder: `features/<feature>` for a part the user can name, `lib` and `components` for shared code, the app layer for what wires it together.
2. **What kind of code?** Inside a feature, the kind folder: a component, a hook, a store, an action, an API call, pure logic, or types.
3. **What is it about?** The file name, read by someone who has not opened the file.

Sorting features by concept alone puts related code together, but a name like `plan-limit.ts` does not say whether the file holds state, logic or actions, and such files drift into holding all three. Kind folders inside a feature give that signal back, the way bulletproof-react does.

## What a feature is

A feature is something the user can name and you could remove whole: accounts, search, checkout, settings. A part that only runs inside one feature stays in that feature, even when it looks like a feature of its own: a filter bar used only by the invoice list lives in `invoices`. Splitting every such part into its own feature turns the folder into a list of fragments.

## Target tree

```
src/
├── main.tsx, App.tsx                           the app layer: wires features together <!-- add this repo's routes -->
├── components/                                 shared chrome, used by two or more features; ui/ stays shadcn
├── lib/
│   └── <concept>/                              one folder per CONTEXT.md word or infrastructure name (api, log, time)
└── features/<feature>/
    ├── components/   <name>.tsx
    ├── hooks/        use-<name>.ts
    ├── stores/       <name>-store.ts
    ├── actions/      <operation>.ts
    ├── api/          <name>-api.ts
    ├── lib/          <concept>.ts
    └── types/        <concept>.ts
```

A feature has only the kind folders it needs. When a kind folder gets crowded, group by part inside it (`components/chips/`, `lib/parser/`); the kind stays the first folder, so every feature opens the same way.

What each kind holds:

- **components**: React components. One component per file, plus the small private parts only it draws.
- **hooks**: React hooks that combine stores, effects or other hooks. A store's own `use<Name>` stays in the store.
- **stores**: state the UI reads and subscribes to, in memory or in localStorage, with the functions that change it.
- **actions**: code that changes something outside itself: the server, this device, the session, the screen (toasts, navigation). Usually one user operation from start to end, such as `send-invoice.ts`.
- **api**: one call to the server that returns data and does nothing else.
- **lib**: pure logic: parsing, formatting, deciding. Testable with plain values.
- **types**: files that hold only types. Most types live with the code that owns them; this folder is for the few that have no other home.

## Worked example: invoices

```
features/invoices/
  components/   invoice-list.tsx, invoice-row.tsx, send-invoice-dialog.tsx
  stores/       send-invoice-dialog-store.ts, invoice-filters-store.ts
  actions/      send-invoice.ts, void-invoice.ts
  api/          invoices-api.ts
  lib/          invoice-total.ts, overdue-invoices.ts
```

`send-invoice-dialog-store.ts` is whether the send dialog is open and for which invoice. `send-invoice.ts` sends it, updates the list and shows the toast. `invoices-api.ts` fetches invoices and does nothing else. `overdue-invoices.ts` decides which invoices are overdue from plain values.

## Reading a file name

The name is the interface. Read it as a stranger would: `invoice-filters-store.ts` says "the store of the filters on the invoice list"; `filters-store.ts` says only "some filters". A broad word (store, list, state, location, copy) gets a qualifier that says which one. When an export needs a different phrase or a different kind, it is a different file.

## Imports

An import names the file that defines the name, so the import line shows where the code lives. Features have no entry file: re-exporting a feature through `<feature>.ts` or `index.ts` makes importing one name load the whole feature and everything it imports, which slows tests, fails tests on code they never use, and joins features into import cycles.

Imports flow one way: shared code (`lib`, `components`) imports no feature, and neither shared code nor features import the app layer. A type-only import may cross, since it is erased from the build. Features may import each other, but not in a loop: features in a loop cannot be read, tested or moved one at a time. The part they share becomes its own concept, or the app passes it in.

## The check

`scripts/layout-check.mjs` runs as a Stop hook (`.claude/settings.json`) and as `pnpm layout`. Its paths come from `scripts/layout-check.config.json`. It compares the working tree with the branch base and, for each new or moved file, flags:

- a file under a feature that is not in a kind folder, or whose name does not match its folder: `components` hold `.tsx`, `hooks` start with `use-`, `stores` end in `-store`, `api` files end in `-api`;
- a file in shared code under a folder named `components`, `hooks`, `utils`, `helpers` or `types` (outside `src/components`, which is shared chrome).

Files that stay where they are pass, so code that has not moved yet is not flagged until its turn. The app layer, the `exempt` and `generated` folders, tests and generated files are skipped.

A file over 400 lines that is new or grew gets a warning shown to the user. The warning does not block the stop, because length alone is no reason to split. A file is reported again only when it is longer than at the last stop; the last lengths are kept in `layout-check-long-files.json` in the git directory.

It also reads every file in the source root and flags:

- an `index.ts` outside the app layer: a barrel;
- an import of its own feature through an alias, where siblings come by relative path;
- a runtime import against the layer order;
- features that import each other in a loop.

The layer and loop rules skip tests, which never load in the app.

The hook blocks the first stop with the list; the session fixes the files or explains them to the user, and the second stop goes through.

## Migration

Move one feature per PR, each listing its renames for review. Shared code moves after the features that use it.
