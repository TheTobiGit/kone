import { describe, expect, test } from "bun:test";

import { threadLine, threadPayload, type ThreadReading } from "./appThreadsFormatting.js";
import type { StoredThreadMeta } from "../../types.js";
import { textOnlyResult } from "../../gateway/registry.js";

// A thread's snooze is a computed boolean on the reading (the inbox reads it
// rather than reimplementing the wake-early rule) plus its raw deadline.

function reading(snoozed: boolean): ThreadReading {
  const meta: StoredThreadMeta = {
    threadId: "t-1",
    projectPath: "/p",
    provider: "codex",
    createdAt: 0,
    updatedAt: 0,
    title: "Hi",
    snoozedUntil: snoozed ? Date.now() + 60_000 : null,
  };
  return { meta, project: null, agentName: null, status: "idle", snoozed };
}

describe("snooze in the thread view", () => {
  test("assistant-projected thread text retains known reset and snooze deadlines", () => {
    const resetAt = Date.now() + 120_000;
    const snoozedUntil = Date.now() + 180_000;
    const row = reading(true);
    row.meta.limitedAt = Date.now();
    row.meta.limitResetAt = resetAt;
    row.meta.snoozedUntil = snoozedUntil;
    const projected = textOnlyResult({
      content: [{ type: "text", text: threadLine(row, false) }],
      structuredContent: { limitResetAt: new Date(resetAt).toISOString(), snoozedUntil: new Date(snoozedUntil).toISOString() },
    });
    const text = projected.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    expect(text).toContain(new Date(resetAt).toISOString());
    expect(text).toContain(new Date(snoozedUntil).toISOString());
    expect(projected.structuredContent).toBeUndefined();
  });

  test("a snoozed thread's payload carries the boolean and its deadline", () => {
    const row = threadPayload(reading(true), false);
    expect(row.snoozed).toBe(true);
    expect(row.snoozedUntil).toEqual(expect.any(String));
  });

  test("a woken thread carries neither", () => {
    const row = threadPayload(reading(false), false);
    expect(row.snoozed).toBeUndefined();
    expect(row.snoozedUntil).toBeUndefined();
  });

  test("the line marks a snoozed thread and not a woken one", () => {
    expect(threadLine(reading(true), false)).toContain("snoozed");
    expect(threadLine(reading(false), false)).not.toContain("snoozed");
  });
});
