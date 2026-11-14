import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { testApp, type TestApp } from "./test-app";
import { readTitle } from "./titles";
import { deferred } from "./util";

describe("readTitle", () => {
  test.each([
    [
      "an answer as JSON text",
      '{"title":"Dark Mode Toggle","needsRefinement":false}',
      "Dark Mode Toggle",
      false,
    ],
    [
      "quotes and a full stop",
      { title: ' "Fix Login Redirect." ', needsRefinement: true },
      "Fix Login Redirect",
      true,
    ],
    [
      "one too long for a title",
      { title: "Word ".repeat(20), needsRefinement: false },
      `${"Word ".repeat(11)}Wo…`,
      false,
    ],
  ])("cleans up %s", (_, output, title, needsRefinement) => {
    expect(readTitle(output)).toEqual({ title, needsRefinement });
  });

  test.each([
    ["no title", { needsRefinement: false }],
    ["an empty title", { title: ' "" ', needsRefinement: false }],
    ["text that isn't JSON", "Dark Mode Toggle"],
  ])("gives nothing for %s", (_, output) => {
    expect(readTitle(output)).toBeUndefined();
    // The same answer with a title reads.
    expect(readTitle({ title: "Dark Mode Toggle" })?.title).toBe("Dark Mode Toggle");
  });
});

function eventually<T>(check: () => Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: 5000, interval: 25 });
}

describe("a chat's title", () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await testApp();
  });

  afterEach(async () => {
    await t.close();
  });

  async function chat(text: string): Promise<string> {
    const thread = await t.call("thread.create", { projectId: t.project.id });
    await t.call("thread.send", { threadId: thread.id, message: { text, images: [] } });
    return thread.id;
  }

  test("is the one the model writes from the first message", async () => {
    t.agent.writer = () => ({ title: "Sidebar Scroll Jank", needsRefinement: false });
    const id = await chat("the sidebar stutters when I scroll it, can you look?");
    await eventually(async () => expect((await t.thread(id)).title).toBe("Sidebar Scroll Jank"));
    expect(t.agent.textRequests[0]!.prompt).toContain("the sidebar stutters when I scroll it");
  });

  test("stays the first line when no model can write one", async () => {
    const id = await chat("Fix the flaky upload test\n\nIt fails one run in ten.");
    await eventually(async () => expect(t.agent.textRequests).toHaveLength(1));
    expect((await t.thread(id)).title).toBe("Fix the flaky upload test");
  });

  test("keeps the name the person gave while the model was writing", async () => {
    const answer = deferred<unknown>();
    t.agent.writer = () => answer.promise;
    const id = await chat("look at this");
    await t.call("thread.update", { threadId: id, title: "Upload bug" });
    answer.resolve({ title: "Unknown Request", needsRefinement: false });
    await eventually(async () => expect(t.agent.textRequests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await t.thread(id)).title).toBe("Upload bug");
  });

  test("is written again from the agent's reply when the first message was vague", async () => {
    t.agent.worker = (host) => {
      host.items.add({
        type: "assistant",
        text: "The upload test times out on CI.",
        streaming: false,
      });
    };
    t.agent.writer = (request) =>
      request.prompt.includes("ASSISTANT:")
        ? { title: "Upload Test Timeout", needsRefinement: false }
        : { title: "Fix This", needsRefinement: true };
    const id = await chat("fix this");
    await eventually(async () => expect((await t.thread(id)).title).toBe("Upload Test Timeout"));
    expect(t.agent.textRequests[1]!.prompt).toContain("The upload test times out on CI.");
  });
});
