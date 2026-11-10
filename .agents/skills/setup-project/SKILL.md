---
name: setup-project
description: Set up a repo for this skill stack - CONTEXT.md, ADRs, CLAUDE.md pointers to them and to writing-tests, plus an opt-in React file layout with its check. Rerun to add what is missing.
disable-model-invocation: true
---

# Setup project

Scaffold what the skills in this stack expect from a repo:

- **A. Domain docs**: `CONTEXT.md`, `docs/adr/`, and `docs/agents/domain.md`, the rules every skill follows when reading them. `domain-modeling` keeps them current.
- **B. React file layout** (opt-in, React + Vite only): where a file goes, written in the instruction file and `docs/agents/file-layout.md`, and enforced by a Stop hook.
- **C. Test pointer**: one line in the instruction file that sends the agent to `writing-tests` before it touches a test. Its description alone seldom loads it, and the instruction file is always read.

A part the repo already has is skipped, so a rerun only offers what is missing. Explore, present what you found, confirm with the user, then write.

## 1. Explore

Read what exists:

- `CLAUDE.md` and `AGENTS.md` at the root: which exists, and whether it has an `## Agent skills` section holding `### Domain docs`, `### File layout` or `### Tests`.
- `CONTEXT.md` and `CONTEXT-MAP.md`, and the same files under the name `GLOSSARY`.
- `docs/adr/`, any `src/*/docs/adr/`, and `docs/agents/`.
- Monorepo signals: `pnpm-workspace.yaml`, a `workspaces` field in `package.json`, a populated `packages/*` with its own `src/`. Almost every repo has none, which means single-context.
- `package.json`: part B exists only when it depends on both `react` and `vite`.
- `scripts/layout-check.mjs` with a Stop hook running it in `.claude/settings.json`: part B is already installed.

Done when you can say, for each part, whether it is missing, partial or present.

## 2. Ask

Summarise what is present and what is missing, then take the parts in order: one question, one answer, then the next. Lead each with the recommended answer so the user can accept it in a word, and skip a part exploration already settled.

**A. Domain docs.** Plan single-context (one `CONTEXT.md` and `docs/adr/` at the root) without asking. Offer multi-context (a root `CONTEXT-MAP.md` pointing at one `CONTEXT.md` per context) only when exploration found monorepo signals.

- A `GLOSSARY` file exists: offer to `git mv` it to its `CONTEXT` name, since every skill in this stack reads `CONTEXT.md`.
- No `CONTEXT.md`: ask for one or two sentences on what the project is and who it is for. They open the file; terms come later through `domain-modeling`.

**B. React file layout.** Ask: "Add the React file layout and its check? (recommended: yes)". On yes, read [react-file-layout/SETUP.md](react-file-layout/SETUP.md) and do its exploration now, because its findings fill the drafts in step 3.

**C. Test pointer.** Plan it without asking; the user sees it in the draft.

## 3. Draft

Show the user a draft of every file you will write or change, and let them edit:

- The `## Agent skills` block for the instruction file (step 4 says which file), holding `### Domain docs` and `### Tests`, plus `### File layout` when part B runs.
- `docs/agents/domain.md`, from [domain.md](domain.md). For multi-context, reword its first section so the map is read first.
- `CONTEXT.md`, when it is new: `# <Project name>`, the user's sentences, then an empty `## Language` heading.
- Part B's files, listed in its SETUP.md.

Done when the user has approved every draft.

## 4. Write

Edit `CLAUDE.md` if it exists, else `AGENTS.md`. When neither exists, ask the user which one to create. Edit the file that is already there and leave the other uncreated.

The block:

```markdown
## Agent skills

### Domain docs

[Single-context or multi-context, in one line]. See `docs/agents/domain.md`.

### Tests

Before you write, change or delete a test, load the `writing-tests` skill.
```

When `## Agent skills` already exists, update its sub-blocks in place and keep the user's other sections as they are. `docs/adr/` appears with the first ADR, which `domain-modeling` writes; leave it uncreated here.

## 5. Done

List the files written. Tell the user that `domain-modeling` adds terms to `CONTEXT.md` as they settle, that `docs/agents/*.md` can be edited by hand, and that a rerun only adds what is missing.
