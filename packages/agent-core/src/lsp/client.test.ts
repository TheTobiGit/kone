import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  LspAbortError,
  LspClient,
  LspNotRunningError,
  LspRequestError,
  LspTimeoutError,
} from "./client.js";
import type { LspClientStartOptions } from "./client.js";
import type { LspJsonObject, LspJsonValue } from "./types.js";
import { countLogLines, fakeServerScript, readLogLines } from "./fakeLspServer.js";
import type { FakeLspScenario } from "./fakeLspServer.js";

// The client talks to a fake server script over real pipes: every behavior
// here runs against real Content-Length bytes, never a real language server.

// One scratch directory plus the method-log path inside it. Named so the
// helper keeps its return contract.
interface LspTestWorkspace {
  dir: string;
  log: string;
}

function freshWorkspace(): LspTestWorkspace {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-lsp-client-"));
  return { dir, log: path.join(dir, "methods.log") };
}

async function startClient(
  dir: string,
  log: string,
  scenario: FakeLspScenario,
  init?: LspClientStartOptions,
): Promise<LspClient> {
  const client = new LspClient({ serverName: "fake" });
  await client.start(process.execPath, ["-e", fakeServerScript(log, scenario)], dir, init);
  return client;
}

async function rejectionOf(call: Promise<LspJsonValue>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("lsp rejection was not an Error");
  }
  throw new Error("expected the lsp call to reject, but it resolved");
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) throw new Error("timed out waiting for the fake server");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function asRecord(value: LspJsonValue | undefined): LspJsonObject | null {
  if (value instanceof Object && !Array.isArray(value)) return value;
  return null;
}

function textField(record: LspJsonObject, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null || value === true || value === false) return null;
  if (value instanceof Object || Array.isArray(value) || Number.isFinite(value)) return null;
  return value;
}

describe("LspClient handshake", () => {
  test("start performs initialize then initialized", async () => {
    const { dir, log } = freshWorkspace();
    const client = await startClient(dir, log, "basic");
    try {
      expect(client.isRunning()).toBe(true);
      expect(client.rootPath).toBe(dir);
      // The server logs each frame as it reads it; the initialized
      // notification trails its request by a turn, so wait for both lines.
      await waitFor(() => readLogLines(log).length === 2);
      expect(readLogLines(log)).toEqual(["in:initialize", "in:initialized"]);
      const capabilities = asRecord(client.serverCapabilities?.capabilities);
      expect(capabilities !== null && capabilities.hoverProvider).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("hover round-trips through real framed bytes", async () => {
    const { dir, log } = freshWorkspace();
    const client = await startClient(dir, log, "basic");
    try {
      const result = await client.request(
        "textDocument/hover",
        { textDocument: { uri: "file:///fake/a.ts" }, position: { line: 0, character: 1 } },
        5000,
      );
      const contents = asRecord(result)?.contents;
      expect(textField(asRecord(contents) ?? {}, "value")).toBe("**fake-hover**");
    } finally {
      await client.close();
    }
  });

  test("error responses surface as LspRequestError", async () => {
    const { dir, log } = freshWorkspace();
    const client = await startClient(dir, log, "basic");
    try {
      const failure = await rejectionOf(client.request("test/fail", null, 5000));
      expect(failure).toBeInstanceOf(LspRequestError);
      if (!(failure instanceof LspRequestError)) throw new Error("expected an LspRequestError");
      expect(failure.code).toBe(-32000);
      expect(failure.message).toContain("boom");
    } finally {
      await client.close();
    }
  });
});

describe("LspClient diagnostics cache", () => {
  test("a pushed publishDiagnostics lands in getDiagnostics", async () => {
    const { dir, log } = freshWorkspace();
    const client = await startClient(dir, log, "basic");
    try {
      const uri = "file:///fake/doc.ts";
      expect(client.getDiagnostics(uri)).toEqual([]);
      client.openDocument(uri, "fakets", "hello\n");
      await waitFor(() => client.getDiagnostics(uri).length === 1);
      const diagnostics = client.getDiagnostics(uri);
      expect(diagnostics[0]?.message).toBe("fake diag");
      expect(diagnostics[0]?.severity).toBe(1);
      // A uri the server never reported stays empty, not missing.
      expect(client.getDiagnostics("file:///fake/other.ts")).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe("LspClient abort and timeout", () => {
  test("abort rejects the pending call and sends $/cancelRequest", async () => {
    const { dir, log } = freshWorkspace();
    const client = await startClient(dir, log, "basic");
    try {
      const controller = new AbortController();
      const pending = client.request("test/hang", null, { timeoutMs: 5000, signal: controller.signal });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      controller.abort();
      const failure = await rejectionOf(pending);
      expect(failure).toBeInstanceOf(LspAbortError);
      // The rejection carries the transport's cancellation name straight from
      // its definition, so the gateway passthrough recognizes it unwrapped.
      if (!(failure instanceof LspAbortError)) throw new Error("expected an LspAbortError");
      expect(failure.name).toBe("AbortError");
      // The rejection fires the moment the signal does; the server logs the
      // cancellation a turn later, so wait for its evidence.
      await waitFor(() => countLogLines(readLogLines(log), "in:$/cancelRequest") === 1);
    } finally {
      await client.close();
    }
  });

  test("an already-aborted signal rejects without sending", async () => {
    const { dir, log } = freshWorkspace();
    const client = await startClient(dir, log, "basic");
    try {
      const controller = new AbortController();
      controller.abort();
      const failure = await rejectionOf(
        client.request("test/hang", null, { timeoutMs: 5000, signal: controller.signal }),
      );
      expect(failure).toBeInstanceOf(LspAbortError);
      expect(countLogLines(readLogLines(log), "test/hang")).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("a silent server rejects with LspTimeoutError", async () => {
    const { dir, log } = freshWorkspace();
    const client = await startClient(dir, log, "basic");
    try {
      const failure = await rejectionOf(client.request("test/hang", null, 150));
      expect(failure).toBeInstanceOf(LspTimeoutError);
      if (!(failure instanceof LspTimeoutError)) throw new Error("expected an LspTimeoutError");
      expect(failure.method).toBe("test/hang");
      expect(failure.timeoutMs).toBe(150);
    } finally {
      await client.close();
    }
  });
});

describe("LspClient reader resilience", () => {
  test("malformed frames and stale responses never kill the reader", async () => {
    const { dir, log } = freshWorkspace();
    const client = await startClient(dir, log, "malformed");
    try {
      const result = await client.request(
        "textDocument/hover",
        { textDocument: { uri: "file:///fake/a.ts" }, position: { line: 0, character: 1 } },
        5000,
      );
      const contents = asRecord(result)?.contents;
      expect(textField(asRecord(contents) ?? {}, "value")).toBe("**fake-hover**");
      // The headerless frame and the unparseable body each counted as
      // dropped; the stale unknown-id response was ignored, not dropped.
      expect(client.droppedFrameCount).toBeGreaterThanOrEqual(2);
    } finally {
      await client.close();
    }
  });
});

describe("LspClient server-to-client requests", () => {
  test("configuration answers per stored settings, edits are refused", async () => {
    const { dir, log } = freshWorkspace();
    const client = await startClient(dir, log, "basic", { settings: { fake: true } });
    try {
      await expect(client.request("test/probe", { kind: "configuration" }, 5000)).resolves.toBe("ok");
      const lines = readLogLines(log);
      const configuration = lines.find((line) => line.startsWith("probe:"));
      expect(configuration).toContain('"fake":true');

      await expect(client.request("test/probe", { kind: "applyEdit" }, 5000)).resolves.toBe("ok");
      const refusal = readLogLines(log).filter((line) => line.startsWith("probe:")).pop();
      expect(refusal).toContain("-32601");

      await expect(client.request("test/probe", { kind: "register" }, 5000)).resolves.toBe("ok");
      expect(client.serverRegisteredMethods).toContain("textDocument/didOpen");
    } finally {
      await client.close();
    }
  });

  test("unknown server methods answer method-not-found", async () => {
    const { dir, log } = freshWorkspace();
    const client = await startClient(dir, log, "basic");
    try {
      await expect(client.request("test/probe", { kind: "mystery" }, 5000)).resolves.toBe("ok");
      const answer = readLogLines(log).filter((line) => line.startsWith("probe:")).pop();
      expect(answer).toContain("-32601");
    } finally {
      await client.close();
    }
  });
});

describe("LspClient close", () => {
  test("close handshakes shutdown+exit and stays closed", async () => {
    const { dir, log } = freshWorkspace();
    const client = await startClient(dir, log, "basic");
    expect(client.isRunning()).toBe(true);
    await client.close();
    expect(client.isRunning()).toBe(false);
    const lines = readLogLines(log);
    expect(lines).toContain("in:shutdown");
    expect(lines).toContain("in:exit");
    // Idempotent: a second close resolves without another handshake.
    await client.close();
    expect(countLogLines(readLogLines(log), "in:shutdown")).toBe(1);
    const failure = await rejectionOf(client.request("textDocument/hover", null, 500));
    expect(failure).toBeInstanceOf(LspNotRunningError);
  });
});
