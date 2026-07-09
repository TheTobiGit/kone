import { describe, expect, test } from "bun:test";

import {
  PERMISSION_REQUEST_TTL_MS,
  parseBridgeClientMessage,
  parseBridgeServerMessage,
} from "./index";

describe("parseBridgeClientMessage", () => {
  test("accepts prompt.submit", () => {
    const message = parseBridgeClientMessage(
      JSON.stringify({
        type: "prompt.submit",
        turnId: "turn-1",
        prompt: "hello",
        modelId: "claude-opus-4-8",
        reasoningEffort: "medium",
      }),
    );

    expect(message).toEqual({
      type: "prompt.submit",
      turnId: "turn-1",
      prompt: "hello",
      modelId: "claude-opus-4-8",
      reasoningEffort: "medium",
    });
  });

  test("accepts turn.cancel", () => {
    const message = parseBridgeClientMessage(
      JSON.stringify({
        type: "turn.cancel",
        turnId: "turn-1",
      }),
    );

    expect(message).toEqual({
      type: "turn.cancel",
      turnId: "turn-1",
    });
  });

  test("rejects malformed client payloads", () => {
    expect(parseBridgeClientMessage("not-json")).toBeNull();
    expect(parseBridgeClientMessage(JSON.stringify({ type: "prompt.submit" }))).toBeNull();
    expect(parseBridgeClientMessage(JSON.stringify({ type: "turn.cancel" }))).toBeNull();
  });
});

describe("parseBridgeServerMessage", () => {
  test("accepts structured turn.tool events", () => {
    const message = parseBridgeServerMessage(
      JSON.stringify({
        type: "turn.tool",
        turnId: "turn-1",
        name: "Read",
        phase: "start",
        toolCallId: "tool-123",
        kind: "read",
        inputSummary: "src/index.ts",
        paths: ["src/index.ts"],
        startedAt: "2026-07-09T00:00:00.000Z",
      }),
    );

    expect(message).toMatchObject({
      type: "turn.tool",
      toolCallId: "tool-123",
      kind: "read",
      phase: "start",
    });
  });

  test("falls back to tool name when toolCallId is missing", () => {
    const message = parseBridgeServerMessage(
      JSON.stringify({
        type: "turn.tool",
        turnId: "turn-1",
        name: "Bash",
        phase: "end",
        isError: true,
      }),
    );

    expect(message).toMatchObject({
      type: "turn.tool",
      toolCallId: "Bash",
      phase: "end",
      isError: true,
    });
  });

  test("accepts typed permission.request payloads", () => {
    const message = parseBridgeServerMessage(
      JSON.stringify({
        type: "permission.request",
        requestId: "perm-1",
        detail: "Allow: Bash",
        requestKind: "command",
        expiresAt: "2026-07-09T00:02:00.000Z",
        turnId: "turn-1",
        toolCallId: "tool-1",
        command: "bun test",
      }),
    );

    expect(message).toMatchObject({
      type: "permission.request",
      requestKind: "command",
      command: "bun test",
      expiresAt: "2026-07-09T00:02:00.000Z",
    });
  });

  test("defaults permission request kind and expiry for legacy payloads", () => {
    const message = parseBridgeServerMessage(
      JSON.stringify({
        type: "permission.request",
        requestId: "perm-1",
        detail: "Allow tool execution?",
      }),
    );

    expect(message?.type).toBe("permission.request");
    if (message?.type !== "permission.request") return;

    expect(message.requestKind).toBe("unknown");
    expect(message.expiresAt).toEqual(expect.any(String));
  });

  test("accepts turn.cancelled", () => {
    const message = parseBridgeServerMessage(
      JSON.stringify({
        type: "turn.cancelled",
        turnId: "turn-1",
        reason: "user",
      }),
    );

    expect(message).toEqual({
      type: "turn.cancelled",
      turnId: "turn-1",
      reason: "user",
    });
  });

  test("rejects malformed server payloads", () => {
    expect(parseBridgeServerMessage(JSON.stringify({ type: "turn.delta" }))).toBeNull();
    expect(
      parseBridgeServerMessage(
        JSON.stringify({
          type: "turn.cancelled",
          turnId: "turn-1",
          reason: "invalid",
        }),
      ),
    ).toBeNull();
  });
});

describe("constants", () => {
  test("permission ttl matches two minutes", () => {
    expect(PERMISSION_REQUEST_TTL_MS).toBe(120_000);
  });
});
