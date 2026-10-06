import { describe, expect, test } from "bun:test";
import { ToolCallAccumulator } from "./toolCallAccumulator.js";

describe("normalized tool observations", () => {
  test("a late title or output update cannot reopen a failed call or replace its command", () => {
    const call = new ToolCallAccumulator().observe({
      name: { value: "run", authority: "inferred" },
      action: { value: "run", authority: "explicit" },
      target: { value: "cat missing.txt", authority: "explicit" }, status: "failed",
      detail: { value: "no such file", mode: "snapshot" },
    });
    call.observe({ title: "Reading file", target: { value: "Reading file", authority: "inferred" }, status: "in-progress",
      detail: { value: "\nexit 1", mode: "delta" } });
    expect(call.snapshot()).toMatchObject({ text: "cat missing.txt", status: "failed", detail: "no such file\nexit 1" });
    call.observe({ status: "completed", provisional: true });
    expect(call.status).toBe("failed");
  });

  test("completion output is a replacement snapshot; absent fields do not erase input or identity", () => {
    const call = new ToolCallAccumulator().observe({
      name: { value: "tool", authority: "fallback" }, input: '{"command":"ls"}',
      detail: { value: "par", mode: "delta" },
    });
    call.observe({ name: { value: "bash", authority: "explicit" }, detail: { value: "partial\nfinal\n", mode: "snapshot" }, status: "completed" });
    call.observe({ name: { value: "tool", authority: "fallback" } });
    expect(call.snapshot()).toMatchObject({ name: "bash", detail: "partial\nfinal\n", tool: { input: '{"command":"ls"}' } });
  });

  test("a real failure corrects provisional turn-end success", () => {
    const call = new ToolCallAccumulator().observe({ status: "completed", provisional: true });
    call.observe({ status: "in-progress" });
    expect(call.status).toBe("completed");
    call.observe({ status: "failed" });
    expect(call.status).toBe("failed");
  });

  test("explicit semantic corrections replace earlier classifications and target corrections", () => {
    const call = new ToolCallAccumulator().observe({ action: { value: "read", authority: "explicit" }, target: { value: "a", authority: "explicit" } });
    call.observe({ action: { value: "edit", authority: "explicit" }, target: { value: "b", authority: "explicit" } });
    call.observe({ action: { value: "other", authority: "fallback" } });
    expect(call.tool).toMatchObject({ action: "edit", target: "b" });
  });
});
