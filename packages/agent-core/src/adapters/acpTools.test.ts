import { describe, expect, test } from "bun:test";
import { diffStats } from "@kone/protocol/unified-diff";
import { ToolCallAccumulator } from "../toolCallAccumulator.js";
import { acpObservation, acpToolDetail, foldAcpToolCall, parseAcpPlan } from "./acpTools.js";

// Shapes marked "live" are verbatim from `cursor-agent acp` (2026.07.23) and
// `droid exec` (0.186.0) sessions; the rest are ACP-spec shapes. Cline and
// Antigravity's ACP server send the same vocabulary.

const target = (update: Parameters<typeof acpObservation>[0]) => acpObservation(update, undefined, "").target?.value;

describe("ACP tool targets", () => {
  test("prefers the command, then the path, then the query, then the title", () => {
    expect(target({ kind: "execute", rawInput: { command: "bun test" }, title: "Shell" })).toBe("bun test");
    expect(target({ kind: "read", rawInput: { path: "src/app.ts" } })).toBe("src/app.ts");
    expect(target({ kind: "search", rawInput: { query: "TODO" } })).toBe("TODO");
    expect(target({ title: "Thinking" })).toBe("Thinking");
    expect(target({})).toBeUndefined();
  });

  test("reads each server's own spellings", () => {
    expect(target({ rawInput: { CommandLine: "ls -la" } })).toBe("ls -la"); // Antigravity
    expect(target({ rawInput: { TargetFile: "/a/b.ts" } })).toBe("/a/b.ts"); // Antigravity
    expect(target({ rawInput: { filePath: "src/a.ts" } })).toBe("src/a.ts"); // Cline
  });

  test("a multi-location call names its first file and counts the rest", () => {
    expect(target({ kind: "edit", locations: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }] })).toBe("a.ts +2 more");
    expect(target({ kind: "edit", locations: [{ path: "a.ts" }] })).toBe("a.ts");
  });

  test("droid's Write puts its path in rawInput.file_path, ahead of locations (live)", () => {
    expect(
      target({
        sessionUpdate: "tool_call",
        toolCallId: "call_00_zUHvVe9cM1FkDYSq1Hs53194",
        title: "Create /tmp/droid-probe/PROBE.txt",
        kind: "edit",
        status: "pending",
        rawInput: { file_path: "/tmp/droid-probe/PROBE.txt", content: "pwned\n" },
        content: [{ type: "diff", path: "/tmp/droid-probe/PROBE.txt", oldText: null, newText: "pwned\n" }],
        locations: [{ path: "/tmp/droid-probe/PROBE.txt" }],
      }),
    ).toBe("/tmp/droid-probe/PROBE.txt");
  });
});

describe("ACP tool actions", () => {
  const action = (kind: string) => acpObservation({ kind }, undefined, "").action?.value;

  test("each kind reads as what it did", () => {
    expect(["read", "edit", "delete", "move", "search", "execute", "fetch"].map(action)).toEqual([
      "read", "edit", "delete", "edit", "search", "run", "fetch",
    ]);
  });

  test("a fetch is not a web search, and a delete is not an edit", () => {
    expect(action("fetch")).not.toBe("web-search");
    expect(action("delete")).not.toBe("edit");
  });
});

describe("ACP tool detail", () => {
  test("collects text blocks and structured output", () => {
    expect(
      acpToolDetail({
        content: [{ type: "content", content: { type: "text", text: "line one" } }, { text: "line two" }],
        rawOutput: { output: "done" },
      }),
    ).toBe("line one\nline two\ndone");
    expect(acpToolDetail({ rawOutput: { combinedOutput: "built" } })).toBe("built");
    expect(acpToolDetail({ rawOutput: "plain" })).toBe("plain");
    expect(acpToolDetail({})).toBe("");
  });

  test("droid's rawOutput.text is the output, not a record to dump (live)", () => {
    expect(
      acpToolDetail({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_00_ET_aJsMzt23x8jAcmr8DX7n1842",
        status: "completed",
        rawOutput: { text: "HELLO_DROID\n\n\n[Process exited with code 0]" },
      }),
    ).toBe("HELLO_DROID\n\n\n[Process exited with code 0]");
  });

  test("an unknown output shape is shown as JSON, never dropped", () => {
    expect(acpToolDetail({ rawOutput: { exitCode: 0 } })).toBe(JSON.stringify({ exitCode: 0 }, null, 2));
  });

  test("output is kept whole; the IPC projection bounds the renderer's copy", () => {
    expect(acpToolDetail({ rawOutput: "x".repeat(100_000) })).toBe("x".repeat(100_000));
  });
});

describe("ACP file changes", () => {
  test("a created file's null oldText is a creation with a real diff (live)", () => {
    const [change] = acpObservation(
      {
        kind: "edit",
        status: "completed",
        rawInput: { file_path: "/tmp/droid-probe/PROBE.txt", content: "pwned\n" },
        content: [{ type: "diff", path: "/tmp/droid-probe/PROBE.txt", oldText: null, newText: "pwned\n" }],
      },
      "edit_file",
      "",
    ).fileChanges!;
    expect(change).toMatchObject({ path: "/tmp/droid-probe/PROBE.txt", kind: "created", applied: true });
    expect(diffStats(change!.diff)).toEqual({ added: 1, removed: 0 });
  });

  test("a completion that restates no diff still confirms the earlier one as applied", () => {
    const state = new ToolCallAccumulator();
    foldAcpToolCall(state, {
      toolCallId: "c1",
      kind: "edit",
      status: "pending",
      content: [{ type: "diff", path: "a.ts", oldText: "a\n", newText: "b\n" }],
    });
    expect(state.fileChanges?.[0]?.applied).toBe(false);
    expect(foldAcpToolCall(state, { toolCallId: "c1", status: "completed" })).toBe("completed");
    expect(state.fileChanges?.[0]).toMatchObject({ path: "a.ts", applied: true });
  });
});

describe("ACP tool status", () => {
  test("only completed and failed close a call", () => {
    const fold = (status?: string) => foldAcpToolCall(new ToolCallAccumulator(), status ? { status } : {});
    expect(["pending", "in_progress", undefined, "completed", "failed"].map(fold)).toEqual([
      "in-progress", "in-progress", "in-progress", "completed", "failed",
    ]);
  });

  test("an update without a status leaves a settled call settled", () => {
    const state = new ToolCallAccumulator();
    foldAcpToolCall(state, { status: "failed" });
    expect(foldAcpToolCall(state, { title: "later" })).toBe("failed");
  });
});

describe("ACP plans", () => {
  test("re-spells ACP's in_progress and drops empty entries (live)", () => {
    expect(
      parseAcpPlan({
        entries: [
          { content: "Read the adapter", status: "completed" },
          { content: "Wire the events", status: "in_progress" },
          { content: "Ship", status: "pending" },
          { content: "   ", status: "pending" },
        ],
      }),
    ).toEqual([
      { content: "Read the adapter", status: "completed" },
      { content: "Wire the events", status: "in-progress" },
      { content: "Ship", status: "pending" },
    ]);
  });

  test("an empty plan is no plan at all", () => {
    expect(parseAcpPlan({ entries: [] })).toBeUndefined();
    expect(parseAcpPlan({})).toBeUndefined();
  });
});
