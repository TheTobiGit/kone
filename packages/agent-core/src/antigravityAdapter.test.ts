import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AntigravityAdapter } from "./adapters/AntigravityAdapter.js";
import { FakeAntigravityRpc } from "./antigravityAcpTestServer.js";
import type { RuntimeEvent } from "./types.js";

// The facade routes per thread: ACP when the server resolves, print mode
// otherwise. The scripted fake stands in for a real ACP install; the print
// path needs no `agy` binary here because startSession never spawns one that
// can throw (the capture-plugin install failure is caught and logged).

async function waitFor(events: RuntimeEvent[], predicate: (event: RuntimeEvent) => boolean, timeoutMs = 15_000): Promise<RuntimeEvent> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for event.");
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kone-antigravity-facade-"));
}

describe("AntigravityAdapter routing", () => {
  test("serves ACP when the server resolves", async () => {
    const rpcs: FakeAntigravityRpc[] = [];
    const events: RuntimeEvent[] = [];
    const adapter = new AntigravityAdapter((event) => events.push(event), undefined, {
      homeDir: tempHome(),
      resolveBinary: () => ({
        executablePath: "/mock/agy_acp_server",
        harnessPath: "/mock/harness",
        source: "override",
      }),
      createRpc: () => {
        const rpc = new FakeAntigravityRpc("basic");
        rpcs.push(rpc);
        return rpc;
      },
    });
    try {
      expect(adapter.acpAvailable()).toBe(true);
      const session = await adapter.startSession({
        threadId: "thread-acp",
        provider: "antigravity",
        cwd: "/mock/work",
        mode: "accept-edits",
      });
      expect(session.conversationId).toBe("mock-session-1");
      const { turnId } = await adapter.sendTurn({ threadId: "thread-acp", input: "Hello" });
      await waitFor(
        events,
        (event) => event.type === "turn.completed" && event.turnId === turnId,
      );
      expect(await adapter.hasSession("thread-acp")).toBe(true);
      expect(rpcs.length).toBe(1);
      await adapter.stopSession("thread-acp");
      expect(await adapter.hasSession("thread-acp")).toBe(false);
    } finally {
      await adapter.stopAll().catch(() => {});
    }
  });

  test("falls back to print mode when no server resolves", async () => {
    const events: RuntimeEvent[] = [];
    const adapter = new AntigravityAdapter((event) => events.push(event), undefined, {
      homeDir: tempHome(),
      resolveBinary: () => null,
    });
    try {
      expect(adapter.acpAvailable()).toBe(false);
      const session = await adapter.startSession({
        threadId: "thread-print",
        provider: "antigravity",
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), "kone-antigravity-cwd-")),
        mode: "full-access",
      });
      // Print mode learns the conversation id mid-turn, never at open.
      expect(session.conversationId).toBeUndefined();
      expect(await adapter.hasSession("thread-print")).toBe(true);
      await adapter.stopSession("thread-print");
    } finally {
      await adapter.stopAll().catch(() => {});
    }
  });

  test("merges sessions across both transports", async () => {
    const rpcs: FakeAntigravityRpc[] = [];
    let resolveAcp = true;
    const events: RuntimeEvent[] = [];
    const adapter = new AntigravityAdapter((event) => events.push(event), undefined, {
      homeDir: tempHome(),
      resolveBinary: () =>
        resolveAcp
          ? { executablePath: "/mock/agy_acp_server", harnessPath: "/mock/harness", source: "override" }
          : null,
      createRpc: () => {
        const rpc = new FakeAntigravityRpc("basic");
        rpcs.push(rpc);
        return rpc;
      },
    });
    try {
      await adapter.startSession({
        threadId: "thread-acp",
        provider: "antigravity",
        cwd: "/mock/work",
        mode: "accept-edits",
      });
      resolveAcp = false;
      await adapter.startSession({
        threadId: "thread-print",
        provider: "antigravity",
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), "kone-antigravity-cwd-")),
        mode: "full-access",
      });
      const sessions = await adapter.listSessions();
      expect(sessions.map((session) => session.threadId).sort()).toEqual([
        "thread-acp",
        "thread-print",
      ]);
      expect(rpcs.length).toBe(1);
      expect(rpcs[0]?.inbound.length).toBeGreaterThan(0);
    } finally {
      await adapter.stopAll().catch(() => {});
    }
  });
});
