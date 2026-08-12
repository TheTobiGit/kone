import { describe, expect, test } from "bun:test";
import { normalizeDroidModelName, parseDroidSettingsFile } from "./droidSettings.js";

describe("droidSettings", () => {
  test("normalizes bracketed model names", () => {
    expect(normalizeDroidModelName("Claude-Sonnet-4-[Anthropic]")).toBe("claude-sonnet-4");
  });

  test("parses cumulative tokenUsage snapshot", () => {
    const raw = JSON.stringify({
      model: "Claude-Sonnet-4-[Anthropic]",
      providerLock: "anthropic",
      providerLockTimestamp: "2026-05-01T01:02:03.000Z",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 20,
        cacheReadTokens: 10,
        thinkingTokens: 5,
      },
    });
    const record = parseDroidSettingsFile("/tmp/session-a.settings.json", raw);
    expect(record).not.toBeNull();
    expect(record?.provider).toBe("droid");
    expect(record?.sessionId).toBe("session-a");
    expect(record?.totals.uncachedInputTokens).toBe(100);
    expect(record?.totals.reasoningTokens).toBe(5);
    expect(record?.totals.outputTokens).toBe(55);
  });
});
