import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
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
    // Keep a descendant holding the shell's pipes open well beyond the test
    // deadline. Killing only the shell cannot settle this promise promptly.
    const startedAt = Date.now();
    const result = await runProjectScript({ cwd, command: "sleep 30 & wait", timeoutMs: 150 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("escalates when the shell and its descendant ignore SIGTERM", async () => {
    const startedAt = Date.now();
    const result = await runProjectScript({
      cwd,
      // The login shell is host-specific and may treat an ignored TERM as
      // "wait is done", exiting before the escalation can run; exec sh so the
      // group under the timeout really does ignore TERM.
      command: "exec /bin/sh -c 'trap \"\" TERM; sleep 30 & wait'",
      timeoutMs: 150,
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(Date.now() - startedAt).toBeLessThan(8_000);
  }, 10_000);

  test("cleans up TERM-ignoring descendants whose output is redirected", async () => {
    const heartbeat = path.join(cwd, "redirected-child-heartbeat");
    let descendantPid: number | null = null;
    try {
      const result = await runProjectScript({
        cwd,
        command: `sh -c 'trap "" TERM; while :; do printf x >> "$KONE_SCRIPT_HEARTBEAT"; sleep 0.02; done' >/dev/null 2>&1 & echo $!; wait`,
        env: { ...process.env, KONE_SCRIPT_HEARTBEAT: heartbeat },
        timeoutMs: 150,
      });
      descendantPid = Number(result.output.trim());
      expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
      expect(result.timedOut).toBe(true);
      // Probe actual work, rather than PID existence: an orphaned zombie may
      // still answer kill(pid, 0) on containers whose init delays reaping it.
      const stoppedAt = readFileSync(heartbeat, "utf8");
      expect(stoppedAt.length).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(readFileSync(heartbeat, "utf8")).toBe(stoppedAt);
    } finally {
      if (descendantPid !== null && Number.isInteger(descendantPid) && descendantPid > 0) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });

  test("settles when a descendant in its own session keeps the pipes open", async () => {
    let descendantPid: number | null = null;
    try {
      const startedAt = Date.now();
      const result = await runProjectScript({
        cwd,
        command: `perl -e 'use POSIX; setsid(); exec @ARGV' sleep 30 & echo $!; wait`,
        timeoutMs: 150,
      });
      descendantPid = Number(result.output.trim());
      expect(result.timedOut).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(8_000);
    } finally {
      if (descendantPid !== null && Number.isInteger(descendantPid) && descendantPid > 0) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  }, 10_000);

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
