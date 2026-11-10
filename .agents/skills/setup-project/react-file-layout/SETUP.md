# React file layout: setup

Part B of `setup-project`. Installs the layout rules, the doc behind them and the check that enforces them into a React + Vite TypeScript repo.

## Explore

Fill the check's config from what the repo holds; the shipped config is only a starting shape.

- **Source root**: the folder holding `main.tsx`, almost always `src`.
- **Aliases**: `paths` in `tsconfig.json` and `tsconfig.app.json`, and `resolve.alias` in `vite.config.ts`. `"@/*": ["./src/*"]` becomes `"@/": "src/"`.
- **App layer**: the files that wire the app together and that nothing else imports.
  - TanStack Router file routes: `src/routes/`, `src/routeTree.gen`, `src/main`.
  - React Router: its routes folder or route config module, `src/main`, `src/App`.
  - No router: `src/main`, `src/App`.
- **Generated code**, which the check never reads: an API client folder written by a generator such as orval or openapi-typescript. `*.gen.ts` and `*.d.ts` files are skipped already.
- **Vendored code**, which keeps its upstream layout: shadcn's folder (the `ui` alias in `components.json`, usually `src/components/ui/`) and any file it imports by path, such as `src/lib/utils.ts`.
- **Base branch**: `git symbolic-ref --short refs/remotes/origin/HEAD` without the `origin/`, else whichever of `main` or `master` exists, else the current branch.
- **Existing files**: how far the tree is from the layout. The file rules flag only new or moved files, so the check can go in before any migration; the import rules read every file and can fail from the first run.

Done when every config field has a value taken from the repo.

## Files to draft

- `scripts/layout-check.mjs`: [layout-check.mjs](layout-check.mjs), copied unchanged.
- `scripts/layout-check.config.json`: [layout-check.config.json](layout-check.config.json) with the values found above. In `app`, an entry ending in `/` is a folder and any other entry is one module named without its extension. `exempt` holds vendored folders and `generated` holds generated ones.
- `docs/agents/file-layout.md`: from [file-layout.md](file-layout.md), with its target tree showing this repo's app layer, generated and vendored folders.
- `### File layout` for the instruction file's `## Agent skills` block: from [claude-md-section.md](claude-md-section.md), with its exceptions line naming this repo's app layer, generated and vendored paths.
- `.claude/settings.json`: this Stop hook, merged into any hooks already there:

  ```json
  {
  	"hooks": {
  		"Stop": [
  			{
  				"hooks": [
  					{
  						"type": "command",
  						"command": "node scripts/layout-check.mjs",
  						"timeout": 30,
  						"statusMessage": "Checking file layout"
  					}
  				]
  			}
  		]
  	}
  }
  ```

- `package.json`: `"layout": "node scripts/layout-check.mjs"` in `scripts`, so the check runs without Claude.

## After writing

Run `node scripts/layout-check.mjs < /dev/null`; it reads the hook's input from stdin and waits without the redirect. It prints nothing when the tree passes.

Done when it prints nothing, or each finding it prints is in front of the user with the move that fixes it. On a repo with many files out of place, leave the moves for later: propose a migration of one feature per PR, each PR listing its renames.
