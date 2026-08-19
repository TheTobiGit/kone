import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "../userDataDir.js";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Database } from "bun:sqlite";

// Two hazards to dodge. First, the import chain reaches AttachmentStore →
// ConversationStore → node:sqlite (an Electron-runtime built-in this bun can't
// load), so the established repo pattern applies: stand node:sqlite in for
// bun:sqlite and point the agent layer's state dir at a throwaway dir. Second, bun
// keeps one mock.module registry per worker process, so suites like
// agentService.test.ts (which stubs CodexAdapter.js) can shadow this file —
// importing CodexAdapter.js here would return their stub, not the adapter.
// So the adapter is loaded from a temp copy of its source with every relative
// import rewritten to an absolute file URL: a resolved path no mock can
// intercept, evaluated by the same bun compiler as the real thing.
mock.module("../sqlite.js", () => ({
  DatabaseSync: Database,
}));
setUserDataDir("/tmp/kone-codex-adapter-test");

const CODEX_ADAPTER_SOURCE = fileURLToPath(new URL("./CodexAdapter.ts", import.meta.url));

async function loadRealCodexAdapter(): Promise<CodexAdapterHelpers> {
  const source = readFileSync(CODEX_ADAPTER_SOURCE, "utf8").replace(
    /from "(\.[^"]+?)\.js"/g,
    (_match, spec: string) => `from ${JSON.stringify(new URL(`${spec}.ts`, import.meta.url).href)}`,
  );
  const dir = mkdtempSync(path.join(tmpdir(), "kone-codex-adapter-real-"));
  const copy = path.join(dir, "CodexAdapter.ts");
  writeFileSync(copy, source);
  return (await import(pathToFileURL(copy).href)) as CodexAdapterHelpers;
}

type CodexAdapterHelpers = typeof import("./CodexAdapter.js");
let helpers: CodexAdapterHelpers;

beforeAll(async () => {
  helpers = await loadRealCodexAdapter();
});

describe("CodexAdapter item detail scavenging", () => {
  test("joins multi-part summary/content arrays", () => {
    expect(helpers.joinedText(["part one", "part two"])).toBe("part one\n\npart two");
    expect(helpers.joinedText([" a ", "", " b "])).toBe("a\n\nb");
    expect(helpers.joinedText("not an array")).toBeUndefined();
    expect(helpers.joinedText(["   ", " "])).toBeUndefined();
  });

  test("itemDetail falls back to joined arrays when summary/content is an array", () => {
    expect(helpers.itemDetail({ summary: ["first", "second"] })).toBe("first\n\nsecond");
    expect(helpers.itemDetail({ content: ["hello", "world"] })).toBe("hello\n\nworld");
    expect(helpers.itemDetail({ command: "ls", content: ["ignored"] })).toBe("ls");
    expect(helpers.itemDetail({ result: { command: "npm test" } })).toBe("npm test");
    expect(helpers.itemDetail(undefined)).toBeUndefined();
  });
});

describe("CodexAdapter item status mapping", () => {
  test("maps declined completions to failed (kone has no declined state)", () => {
    expect(helpers.mapCodexItemStatus("completed", false)).toBe("completed");
    expect(helpers.mapCodexItemStatus("failed", false)).toBe("failed");
    expect(helpers.mapCodexItemStatus("declined", false)).toBe("failed");
    expect(helpers.mapCodexItemStatus(undefined, true)).toBe("failed");
    expect(helpers.mapCodexItemStatus(undefined, false)).toBe("completed");
  });
});

describe("CodexAdapter resume error formatting", () => {
  test("explains how to resolve an active-writer conflict", () => {
    const formatted = helpers.formatCodexThreadResumeError(
      new Error("thread/resume failed: thread external-thread already has an active writer"),
      "external-thread",
    );
    expect(formatted.message).toContain("external-thread");
    expect(formatted.message).toContain("another Codex client");
    expect(formatted.cause).toBeInstanceOf(Error);
  });

  test("passes non-active-writer errors through unchanged", () => {
    const original = new Error("thread/resume failed: thread not found");
    expect(helpers.formatCodexThreadResumeError(original, "t-1")).toBe(original);
    expect(helpers.formatCodexThreadResumeError("raw string", "t-1").message).toBe("raw string");
  });
});
