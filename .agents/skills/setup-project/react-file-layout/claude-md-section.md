### File layout

A path answers three questions in order: which part of the app (the feature), what kind of code (the folder inside the feature), what it is about (the file name). Target tree and worked examples: `docs/agents/file-layout.md`.

- A feature is something the user can name and you could remove whole. A part that only runs inside one feature stays in that feature, even when it looks like a feature of its own.
- Inside a feature, every file sits in a kind folder. A feature has only the folders it needs; when one gets crowded, group by part inside it (`components/chips/`).
  - `components/`: React components, `<name>.tsx`.
  - `hooks/`: React hooks, `use-<name>.ts`.
  - `stores/`: state the UI reads and subscribes to, `<name>-store.ts`. A store's own `use<Name>` lives in the store file.
  - `actions/`: code that changes something: the server, this device, the session, the screen. Usually one user operation from start to end.
  - `api/`: one call to the server that returns data, `<name>-api.ts`.
  - `lib/`: pure logic with no side effects.
  - `types/`: files that hold only types.
- A file name tells someone who has not opened the file what is inside. A broad word gets a qualifier: `invoice-filters-store.ts`, not `filters-store.ts`.
- One module per file: every export fits the file name's phrase. An export of another kind, or that needs a second phrase, is another file.
- A type lives in the file that owns the concept. The app layer and components import types; they do not define shared ones.
- Shared code (`src/lib`) is sorted by concept: a folder is a `CONTEXT.md` word or an infrastructure name (`api`, `log`, `time`).
- Import a name from the file that defines it. A feature has no entry file and no barrel (`index.ts`). Inside a feature, import siblings by relative path.
- Imports flow one way: shared code → features → the app (<app layer>). Features may import each other but not in a loop; a part two features both need becomes its own concept.
- At about 400 lines, or when a file grows a second concept, split it. A long file with one small interface may stay long; say why in the PR.

Before creating a file, ask: which feature is it in, what kind of code is it, and would its name tell a stranger what is inside? Before adding to a file, ask: does this export fit the file's phrase and kind?

Exceptions: <app layer, generated and vendored paths> keep their layout. `src/components` is the shared chrome folder: a file lives there when two or more features use it.

`scripts/layout-check.mjs` checks these rules as a Stop hook; run it by hand with `pnpm layout`.
