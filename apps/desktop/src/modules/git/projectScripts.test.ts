import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PROJECT_SCRIPT_TAIL_CHARS,
  runProjectScript,
  tailOutput,
} from "./projectScripts.js";

const cwd = mkdtempSync(path.join(tmpdir(), "kone-project-script-test-"));

describe("tailOutput", () => {
  test("passes short output through", () => {
    expect(tailOutput("hello", 100)).toBe("hello");
  });

  test("keeps the tail and marks the cut", () => {
    const out = tailOutput("a".repeat(50) + "END", 10);
    expect(out.endsWith("END")).toBe(true);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThanOrEqual(10 + "…[earlier output truncated]\n".length);
  });
});

describe("runProjectScript", () => {
  test("runs a command and returns its output", async () => {
    const result = await runProjectScript({ cwd, command: "printf hello" });
    expect(result.code).toBe(0);
    expect(result.output).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  test("reports a non-zero exit as data", async () => {
    const result = await runProjectScript({ cwd, command: "exit 3" });
    expect(result.code).toBe(3);
  });

  test("captures stderr too", async () => {
    const result = await runProjectScript({ cwd, command: "printf oops >&2" });
    expect(result.output).toContain("oops");
  });

  test("kills a command that overruns its timeout", async () => {
    const result = await runProjectScript({ cwd, command: "sleep 5", timeoutMs: 150 });
    expect(result.timedOut).toBe(true);
  });

  test("treats a blank command as a no-op", async () => {
    const result = await runProjectScript({ cwd, command: "   " });
    expect(result).toEqual({ code: 0, signal: null, output: "", timedOut: false });
  });

  test("clips very long output to the tail", async () => {
    const result = await runProjectScript({
      cwd,
      command: `yes x | head -c ${(PROJECT_SCRIPT_TAIL_CHARS + 500) * 2}`,
    });
    expect(result.output.length).toBeLessThanOrEqual(PROJECT_SCRIPT_TAIL_CHARS + 64);
  });
});
