import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { installMainLog } from "./mainLog.js";

let dir = "";
/** A console that remembers what it printed instead of printing it. */
let printed: string[] = [];
const quiet = {
  log: (...args: unknown[]) => void printed.push(`log ${args.join(" ")}`),
  info: (...args: unknown[]) => void printed.push(`info ${args.join(" ")}`),
  warn: (...args: unknown[]) => void printed.push(`warn ${args.join(" ")}`),
  error: (...args: unknown[]) => void printed.push(`error ${args.join(" ")}`),
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "kone-main-log-test-"));
  printed = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function logLines(file = "main.log"): string[] {
  return readFileSync(path.join(dir, "logs", file), "utf8").trimEnd().split("\n");
}

describe("the main process log", () => {
  test("every console line lands in the file, stamped with its level, and still prints", () => {
    const target = { ...quiet };
    const undo = installMainLog({ dir: path.join(dir, "logs"), target });

    target.warn("[agent] codex session for t-1 ended on its own; the next send restarts it");
    target.error("[agent] send failed:", new Error("No agent session for thread t-1"));
    undo();

    const lines = logLines();
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[warn\] \[agent\] codex session for t-1 ended/);
    expect(lines[1]).toContain("[error] [agent] send failed: Error: No agent session for thread t-1");
    expect(printed).toHaveLength(2);
  });

  test("a full log moves aside and starts over", () => {
    const target = { ...quiet };
    const undo = installMainLog({ dir: path.join(dir, "logs"), target, maxBytes: 120 });

    target.info("first line, long enough to fill most of the budget on its own....");
    target.info("second line, which does not fit beside it");
    undo();

    expect(logLines("main.log.1")).toHaveLength(1);
    expect(logLines()).toEqual([expect.stringContaining("second line")]);
  });

  test("a log that can't be written leaves the console working", () => {
    // A file where the directory should be: nothing can be made under it.
    const blocked = path.join(dir, "blocked");
    writeFileSync(blocked, "");
    const target = { ...quiet };
    const undo = installMainLog({ dir: path.join(blocked, "logs"), target });

    expect(() => target.error("still printed")).not.toThrow();
    undo();

    expect(printed).toEqual(["error still printed"]);
    expect(existsSync(path.join(blocked, "logs"))).toBe(false);
  });

  test("the undo puts the console back", () => {
    const target = { ...quiet };
    const before = target.log;
    installMainLog({ dir: path.join(dir, "logs"), target })();
    expect(target.log).toBe(before);
  });
});
