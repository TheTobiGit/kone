import { describe, expect, test } from "bun:test";
import { totalTokens } from "../transcripts/transcripts.js";
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

  test("folds reasoning into output so totals match opencode's own accounting", () => {
    // Shaped after a real opencode assistant row: `tokens.reasoning` is counted
    // outside `tokens.output`, so a message's own total is
    // input + output + reasoning + cache.read + cache.write.
    const raw = JSON.stringify({
      id: "msg-reasoning",
      sessionID: "sess-1",
      role: "assistant",
      modelID: "gemini-3-pro-preview",
      providerID: "google",
      time: { created: Date.parse("2026-08-01T10:00:00.000Z") },
      tokens: {
        input: 7486,
        output: 13,
        reasoning: 97,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
    });
    const record = parseOpenCodeMessageJson(raw, {
      messageId: "msg-reasoning",
      sessionId: "sess-1",
    });
    expect(record).not.toBeNull();
    expect(record?.totals.reasoningTokens).toBe(97);
    expect(record?.totals.outputTokens).toBe(13 + 97);
    expect(totalTokens(record!.totals)).toBe(7486 + 13 + 97);
  });

  test("totals reconcile when cache reads dwarf fresh input", () => {
    const raw = JSON.stringify({
      id: "msg-cached",
      sessionID: "sess-1",
      role: "assistant",
      modelID: "gemini-3-flash-preview",
      providerID: "google",
      time: { created: Date.parse("2026-08-02T10:00:00.000Z") },
      tokens: {
        input: 689,
        output: 243,
        reasoning: 0,
        cache: { read: 15789, write: 0 },
      },
      cost: 0,
    });
    const record = parseOpenCodeMessageJson(raw, {
      messageId: "msg-cached",
      sessionId: "sess-1",
    });
    expect(record).not.toBeNull();
    expect(totalTokens(record!.totals)).toBe(689 + 243 + 15789);
  });
});
