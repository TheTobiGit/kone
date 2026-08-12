import { describe, expect, test } from "bun:test";
import { parseOpenCodeMessageJson } from "./openCodeMessage.js";

describe("parseOpenCodeMessageJson", () => {
  test("maps tokens and uses provider-scoped model id", () => {
    const raw = JSON.stringify({
      id: "msg-1",
      sessionID: "sess-1",
      modelID: "claude-sonnet-4.5",
      providerID: "anthropic",
      time: { created: Date.parse("2026-01-02T00:00:00.000Z") },
      tokens: {
        input: 100,
        output: 10,
        cache: { read: 50, write: 25 },
      },
      cost: 0,
    });
    const record = parseOpenCodeMessageJson(raw, { messageId: "msg-1", sessionId: "sess-1" });
    expect(record).not.toBeNull();
    expect(record?.provider).toBe("opencode");
    expect(record?.totals.uncachedInputTokens).toBe(100);
    expect(record?.totals.cachedInputTokens).toBe(50);
    expect(record?.totals.cacheCreationTokens).toBe(25);
    expect(record?.totals.outputTokens).toBe(10);
    expect(record?.model).toContain("/");
  });
});
