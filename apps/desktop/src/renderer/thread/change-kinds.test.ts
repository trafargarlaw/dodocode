import { expect, test } from "vitest";
import type { FileChange } from "@dodocode/protocol";
import { breakdown, roleOf } from "./change-kinds";

test.each([
  ["apps/server/src/app.ts", "code"],
  ["src/lock.ts", "code"],
  ["apps/desktop/src/renderer/task-list.test.ts", "tests"],
  ["server/tests/helpers.ts", "tests"],
  ["pkg/parse_test.go", "tests"],
  ["tests/notes.md", "tests"],
  ["docs/agents/perf.md", "docs"],
  ["README", "docs"],
  ["GLOSSARY.md", "docs"],
  ["pnpm-lock.yaml", "config"],
  ["requirements.txt", "config"],
  ["apps/desktop/vite.config.ts", "config"],
  [".github/workflows/ci.yml", "config"],
  [".gitignore", "config"],
])("%s is %s", (path, role) => {
  expect(roleOf(path)).toBe(role);
});

function file(change: FileChange, added: number, removed: number) {
  return { change, added, removed };
}

test("splits changed files by what they're for, counting their lines, and the new, gone and moved", () => {
  expect(
    breakdown([
      file({ path: "src/a.ts", kind: "update" }, 10, 2),
      file({ path: "src/b.ts", kind: "add" }, 5, 0),
      file({ path: "src/a.test.ts", kind: "add" }, 30, 0),
      file({ path: "old.md", kind: "move", movedTo: "src/c.ts" }, 0, 0),
      file({ path: "NOTES.md", kind: "delete" }, 0, 4),
    ]),
  ).toEqual({
    roles: {
      code: { files: 3, added: 15, removed: 2 },
      tests: { files: 1, added: 30, removed: 0 },
      docs: { files: 1, added: 0, removed: 4 },
      config: { files: 0, added: 0, removed: 0 },
    },
    added: 2,
    deleted: 1,
    moved: 1,
  });
});
