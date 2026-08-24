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
  // SAFETY: the copied module is CodexAdapter.ts itself, so its exports match CodexAdapterHelpers.
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

describe("CodexAdapter mode → approval/sandbox mapping", () => {
  test("ask runs untrusted approvals inside a read-only sandbox", () => {
    expect(helpers.mapModeToThreadOverrides("ask")).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
    expect(helpers.mapModeToTurnOverrides("ask")).toEqual({
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly" },
    });
  });

  test("accept-edits auto-runs inside workspace-write but still asks outside it", () => {
    expect(helpers.mapModeToThreadOverrides("accept-edits")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
    expect(helpers.mapModeToTurnOverrides("accept-edits")).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite" },
    });
  });

  test("full-access runs everything without asking in danger-full-access", () => {
    expect(helpers.mapModeToThreadOverrides("full-access")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    expect(helpers.mapModeToTurnOverrides("full-access")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  test("an unknown mode falls back to the accept-edits rung, never something wider", () => {
    // The adapter treats the middle rung as the default everywhere else
    // (startSession/sendTurn both do `?? "accept-edits"`), so a stray value
    // must land there too — thread and turn spellings alike.
    // SAFETY: deliberately out-of-vocabulary inputs; the cast only routes them
    // through the typed parameter so the default branch can be observed.
    expect(helpers.mapModeToThreadOverrides("mystery" as never)).toEqual(helpers.mapModeToThreadOverrides("accept-edits"));
    // SAFETY: deliberately out-of-vocabulary inputs; the cast only routes them
    // through the typed parameter so the default branch can be observed.
    expect(helpers.mapModeToTurnOverrides("mystery" as never)).toEqual(helpers.mapModeToTurnOverrides("accept-edits"));
  });
});

describe("CodexAdapter approval replies", () => {
  const PERMISSION_PARAMS = {
    cwd: "/proj",
    permissions: { fileSystem: { write: ["/proj/out"] }, network: { enabled: true } },
    reason: "needs to export",
  };

  test("command/file asks answer the decision vocabulary", () => {
    expect(helpers.buildApprovalReply("command", "allow-once", {})).toEqual({ decision: "accept" });
    expect(helpers.buildApprovalReply("command", "allow-always", {})).toEqual({ decision: "acceptForSession" });
    expect(helpers.buildApprovalReply("file-change", "reject-once", {})).toEqual({ decision: "decline" });
    expect(helpers.buildApprovalReply("file-read", "reject-and-stop", {})).toEqual({ decision: "cancel" });
  });

  test("permission asks answer permissions+scope — echoing exactly what was granted", () => {
    expect(helpers.buildApprovalReply("permission", "allow-once", PERMISSION_PARAMS)).toEqual({
      permissions: PERMISSION_PARAMS.permissions,
      scope: "turn",
    });
    expect(helpers.buildApprovalReply("permission", "allow-always", PERMISSION_PARAMS)).toEqual({
      permissions: PERMISSION_PARAMS.permissions,
      scope: "session",
    });
  });

  test("a refused permission grant echoes no permissions at all", () => {
    expect(helpers.buildApprovalReply("permission", "reject-once", PERMISSION_PARAMS)).toEqual({
      permissions: {},
      scope: "turn",
    });
    expect(helpers.buildApprovalReply("permission", "reject-and-stop", PERMISSION_PARAMS)).toEqual({
      permissions: {},
      scope: "turn",
    });
  });

  test("fail-closed declines use each kind's own refusal shape", () => {
    expect(helpers.declinedApprovalReply("command")).toEqual({ decision: "decline" });
    expect(helpers.declinedApprovalReply("file-change")).toEqual({ decision: "decline" });
    expect(helpers.declinedApprovalReply("permission")).toEqual({ permissions: {}, scope: "turn" });
  });
});

describe("CodexAdapter permission ask normalization", () => {
  test("describes write/read paths and network from the requested profile", () => {
    expect(
      helpers.describePermissionProfile({
        fileSystem: { write: ["/a"], read: ["/b"] },
        network: { enabled: true },
      }),
    ).toBe("write: /a · read: /b · network");
  });

  test("handles entry-style profiles and returns nothing for an empty one", () => {
    expect(
      helpers.describePermissionProfile({ fileSystem: { entries: [{ access: "write", path: { text: "/c" } }] } }),
    ).toBe("write /c");
    expect(helpers.describePermissionProfile({})).toBeUndefined();
    expect(helpers.describePermissionProfile(undefined)).toBeUndefined();
  });
});
