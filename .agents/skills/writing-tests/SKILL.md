---
name: writing-tests
description: "Tests: read before you write, change or delete a test, or decide whether code needs one. Says which tests earn their run time, where they go, and what they assert."
---

# Writing tests

A test earns its place when it fails for a real defect and costs little to run. Every test runs on every change, so a test that cannot fail, or that repeats another, is pure cost.

## 1. Decide whether the code needs a test

Write a test when the code:

- **decides** something: a branch, a parse, a calculation, a date or money rule, a limit, a state change;
- **fixes a bug**: write the test first and watch it go _red_ on the bug, then fix the code;
- **keeps a contract** that other code relies on and that breaks silently: what is saved and read back, what is sent to the server, a file or wire format.

Leave untested:

- wiring that decides nothing: passing props through, calling one function, configuration;
- what the type checker already proves;
- looks: check layout and styling by looking at the screen;
- a behavior another test already observes.

When no case above applies, write no test and say so in your summary.

## 2. Pick the seam and the level

Test at a _seam_: the public interface the callers use. Import what they import and call it the way they do.

Choose the cheapest level that still observes the behavior: a plain function with plain values, then a hook or a store, then a rendered component, then the whole app. One behavior gets one test, at one level.

Mock only what the test cannot run for real: the network and the server, the clock, randomness, the operating system. Your own modules run for real.

## 3. Write the assertion

Call the code under test inside the test body with one concrete input. Assert the literal output, or the effect a caller observes: `expect(slugify("Hello, World!")).toBe("hello-world")`. The expected value comes from outside the code: a known literal, a worked example, the spec.

Then ask: would this test still pass if every function it imports returned `undefined`? If yes, it observes nothing and cannot fail for a defect. These shapes fail that question:

- **Weak assertion**: no `expect`, or only `toBeDefined`, `toBeTruthy`, `not.toThrow`, `toBeInstanceOf`, `toBeGreaterThan(0)`.
- **Mock or absence only**: only `toHaveBeenCalled`, `not.toHaveBeenCalled`, `toBeUndefined`, `toEqual([])`, `toHaveLength(0)`, `not.toBe(wrongValue)`.
- **Self-referential**: the expected value comes from the code under test, or is computed the same way it computes it: `expect(total(items)).toBe(items.reduce(add))`.
- **Constant pin**: the assertion restates a hand-kept constant, config default, table row or prompt string, so a correct edit of that value breaks the test.
- **Fixture asserts fixture**: the assertion reads what the test itself built, and the code under test never runs in the test body.

To fix one:

- An absence check also asserts, in the same test, the presence for another input.
- Instead of pinning a constant, test the code that reads it, with one input.
- Instead of checking that a mock was called, assert the payload it received or the state after the call.

When no such assertion exists, delete the test. Two kinds stay although they fail the question: a check of a relation across table rows (a key that must be in two tables, a parent row that must exist), and a compile-time check in a `*.test-d.ts` file.

## 4. Keep the count and the run time down

- One behavior per test. Several assertions about that behavior go in the same test and share its setup.
- The same behavior across inputs is one table (`test.each`) with one row per _boundary_: empty, one, at the limit, over it. Two rows of the same case are one row too many.
- Fake the clock instead of waiting for real time, and stub the network instead of calling it.
- Name the test after the behavior, in the words of `CONTEXT.md` when the repo has one.

## 5. Before you finish

Done when, for each test you added or changed, you can name the defect that turns it _red_. A bug fix shows it with the red run before the fix. When you cannot name one, break the code once (return a wrong value), run the test, and restore the file from a copy you made before the change: `git checkout` would also throw away uncommitted work.

When you delete or rewrite an existing test, name it and say why in your summary.
