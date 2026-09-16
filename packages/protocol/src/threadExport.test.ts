import { describe, expect, test } from "bun:test";

import {
  decodeThreadExportJson,
  isThreadExportable,
  parseThreadExportFormat,
  THREAD_EXPORT_JSON_VERSION,
  threadExportBlockedCode,
  threadExportBlockedMessage,
  type ThreadExportJson,
} from "./threadExport.js";

describe("parseThreadExportFormat", () => {
  test("accepts the two real formats", () => {
    expect(parseThreadExportFormat("markdown")).toBe("markdown");
    expect(parseThreadExportFormat("json")).toBe("json");
  });

  test("rejects anything else", () => {
    expect(parseThreadExportFormat("")).toBeNull();
    expect(parseThreadExportFormat("zip")).toBeNull();
    expect(parseThreadExportFormat("Markdown")).toBeNull();
  });
});

describe("threadExportBlockedCode", () => {
  test("a settled thread with a completed turn is exportable", () => {
    const snapshot = { exists: true, completedTurns: 2, runningTurns: 0 };
    expect(threadExportBlockedCode(snapshot)).toBeNull();
    expect(isThreadExportable(snapshot)).toBe(true);
  });

  test("a missing thread is not exportable", () => {
    const snapshot = { exists: false, completedTurns: 0, runningTurns: 0 };
    expect(threadExportBlockedCode(snapshot)).toBe("thread-not-found");
    expect(isThreadExportable(snapshot)).toBe(false);
  });

  test("a running turn blocks the export even when older turns completed", () => {
    const snapshot = { exists: true, completedTurns: 3, runningTurns: 1 };
    expect(threadExportBlockedCode(snapshot)).toBe("thread-running");
    expect(isThreadExportable(snapshot)).toBe(false);
  });

  test("a thread with no completed turns is not exportable", () => {
    const snapshot = { exists: true, completedTurns: 0, runningTurns: 0 };
    expect(threadExportBlockedCode(snapshot)).toBe("no-completed-turns");
    expect(isThreadExportable(snapshot)).toBe(false);
  });

  test("every code has a human message", () => {
    const codes = ["thread-not-found", "thread-running", "no-completed-turns"] as const;
    for (const code of codes) {
      expect(threadExportBlockedMessage(code).length).toBeGreaterThan(0);
    }
  });
});

function sampleExport(): ThreadExportJson {
  return {
    version: THREAD_EXPORT_JSON_VERSION,
    exportedBy: "kone",
    thread: {
      threadId: "thread-1",
      projectPath: "/work/app",
      provider: "codex",
      model: "gpt-5.3",
      createdAt: 1768384800000,
      title: "Sample",
    },
    compactions: [{ at: 1768384810000, beforeTokens: 90000, afterTokens: 12000 }],
    usage: [
      {
        turnId: "turn-1",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        at: 1768384805000,
      },
    ],
    blocks: [
      { id: "u1", role: "user", text: "Hello", at: 1768384800000 },
      {
        id: "a1",
        role: "assistant",
        turnId: "turn-1",
        state: "completed",
        at: 1768384801000,
        endedAt: 1768384805000,
        items: [
          { itemId: "i1", kind: "assistant_text", status: "completed", text: "Hi there" },
          {
            itemId: "i2",
            kind: "tool_call",
            status: "completed",
            text: "exec ls",
            name: "exec",
            detail: "file-a\nfile-b\n",
          },
        ],
      },
    ],
  };
}

describe("decodeThreadExportJson", () => {
  test("a well-formed export decodes to an equivalent structure", () => {
    const sample = sampleExport();
    const decoded = decodeThreadExportJson(JSON.stringify(sample));
    expect(decoded).toEqual(sample);
  });

  test("a nested subagent transcript survives the decode", () => {
    const sample = sampleExport();
    const assistant = sample.blocks[1];
    if (assistant && assistant.role === "assistant") {
      assistant.items.push({
        itemId: "i3",
        kind: "tool_call",
        status: "completed",
        text: "Task explore",
        name: "Task",
        subagent: {
          toolUseId: "toolu-1",
          agentType: "explore",
          description: "Search router",
          status: "completed",
          summary: "Found it",
          startedAt: 1768384802000,
          endedAt: 1768384804000,
          items: [
            { itemId: "c1", kind: "assistant_text", status: "completed", text: "child says hi" },
          ],
        },
      });
    }
    const decoded = decodeThreadExportJson(JSON.stringify(sample));
    expect(decoded).toEqual(sample);
  });

  test("rejects unparseable text, wrong versions, and wrong documents", () => {
    expect(decodeThreadExportJson("not json")).toBeNull();
    const sample = sampleExport();
    // A future version must be refused, not half-trusted.
    expect(decodeThreadExportJson(JSON.stringify({ ...sample, version: 999 }))).toBeNull();
    expect(decodeThreadExportJson(JSON.stringify({ version: 1 }))).toBeNull();
    expect(decodeThreadExportJson(JSON.stringify({ ...sample, blocks: "nope" }))).toBeNull();
  });
});
