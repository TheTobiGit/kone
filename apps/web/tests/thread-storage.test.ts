import { describe, expect, test } from "bun:test";

import { normalizeThreadStorage } from "../app/composables/useThreadStore";

describe("thread storage migration boundary", () => {
  test("rejects unknown versions without throwing", () => {
    expect(normalizeThreadStorage({ version: 99, threads: [{}] })).toEqual({
      version: 1,
      activeThreadId: null,
      threads: [],
    });
  });

  test("filters corrupt records and keeps valid threads", () => {
    const valid = {
      id: "thread-1",
      title: "Calm workspace",
      turns: [],
      draft: "",
      provider: "droid",
      modelId: "model",
      reasoningEffort: "medium",
      fastMode: false,
      thinking: true,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
      scrollTop: 0,
    };
    const normalized = normalizeThreadStorage({
      version: 1,
      activeThreadId: "thread-1",
      threads: [null, { id: 2 }, valid],
    });

    expect(normalized.activeThreadId).toBe("thread-1");
    expect(normalized.threads).toEqual([valid]);
  });
});
