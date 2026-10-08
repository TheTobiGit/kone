import { describe, expect, test } from "bun:test";

import { GatewayToolError, type GatewayRecord } from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";
import type { StoredThreadMeta } from "../../types.js";
import { createAppSnoozeTools } from "./snooze.js";

// The snooze and manual-resume gateway tools, against a fake store.

const NOW = 1_800_000_000_000;
const RESET = NOW + 3_600_000;

function harness(overrides: { limited?: boolean; reset?: number | null } = {}) {
  const snoozed: Array<{ threadId: string; until: number | null }> = [];
  const resumed: string[] = [];
  const meta: StoredThreadMeta = {
    threadId: "t-1",
    projectPath: "/p",
    provider: "codex",
    createdAt: 0,
    updatedAt: 0,
    limitedAt: overrides.limited ? NOW : null,
    limitResetAt: overrides.reset ?? null,
  };
  const entries = createAppSnoozeTools({
    store: { threadMeta: (threadId) => (threadId === "t-1" ? meta : null) },
    setSnooze: (threadId, until) => snoozed.push({ threadId, until }),
    snoozeUntilReset: () => overrides.reset ?? null,
    resumeLimited: async (threadId) => {
      resumed.push(threadId);
    },
  });
  return {
    entry: (name) => {
      const found = entries.find((tool) => tool.name === name);
      if (!found) throw new Error(`no tool ${name}`);
      return found;
    },
    snoozed,
    resumed,
  };
}

// SAFETY: these tools read nothing from the context.
const ctx = {} as GatewayToolContext;

async function call(entry: ToolEntry, input: GatewayRecord): Promise<GatewayToolResult> {
  return entry.handler(ctx, input);
}

describe("app_snooze_thread", () => {
  test("snoozes until an explicit time", async () => {
    const h = harness();
    const result = await call(h.entry("app_snooze_thread"), { threadId: "t-1", until: RESET });
    expect(h.snoozed).toEqual([{ threadId: "t-1", until: RESET }]);
    expect(result.structuredContent).toMatchObject({ threadId: "t-1", snoozedUntil: RESET });
  });

  test("snoozes until the thread's limit reset", async () => {
    const h = harness({ limited: true, reset: RESET });
    await call(h.entry("app_snooze_thread"), { threadId: "t-1", untilReset: true });
    expect(h.snoozed).toEqual([{ threadId: "t-1", until: RESET }]);
  });

  test("with no reset it clears rather than guessing a deadline", async () => {
    const h = harness({ limited: true, reset: null });
    const result = await call(h.entry("app_snooze_thread"), { threadId: "t-1", untilReset: true });
    expect(h.snoozed).toEqual([{ threadId: "t-1", until: null }]);
    expect(result.structuredContent?.snoozedUntil).toBeNull();
  });

  test("refuses an unknown thread", async () => {
    const h = harness();
    await expect(call(h.entry("app_snooze_thread"), { threadId: "nope" })).rejects.toBeInstanceOf(
      GatewayToolError,
    );
  });
});

describe("app_resume_thread", () => {
  test("resumes a limited thread", async () => {
    const h = harness({ limited: true, reset: RESET });
    const result = await call(h.entry("app_resume_thread"), { threadId: "t-1" });
    expect(h.resumed).toEqual(["t-1"]);
    expect(result.structuredContent).toMatchObject({ threadId: "t-1", resumed: true });
  });

  test("refuses a thread that is not limited", async () => {
    const h = harness({ limited: false });
    await expect(call(h.entry("app_resume_thread"), { threadId: "t-1" })).rejects.toBeInstanceOf(
      GatewayToolError,
    );
    expect(h.resumed).toEqual([]);
  });
});
