import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "../userDataDir.js";

import { Database } from "bun:sqlite";

// The store imports node:sqlite, an Electron-runtime built-in this bun can't
// load — stand it in for bun:sqlite, whose API surface (exec / prepare().get /
// run / all) matches the store's usage. The agent layer's state dir is pointed
// at a throwaway temp dir per test. ConversationStore is imported *dynamically*
// below so the stub is in place first (static imports hoist above mock.module,
// defeating it — the same pattern sidechat.test.ts uses).
mock.module("../sqlite.js", () => ({
  DatabaseSync: Database,
}));

import type { RuntimeEvent } from "../types.js";
import type { JsonValue } from "@kone/agent-core/lib-jsonValue.js";
import type { ConversationStore } from "../ConversationStore.js";
import type { createGateway as createGatewayType } from "./index.js";
import type { initSpawnEngine as initSpawnEngineType } from "../threadSpawn.js";
import type { GatewayRecord, GatewayValue } from "./schemas.js";
import {
  SPAWN_BATCH_JSON_SCHEMA,
  CONTINUE_THREAD_JSON_SCHEMA,
  READ_RESPONSE_JSON_SCHEMA,
} from "./schemas.js";

/** Point the agent layer at a fresh temp state dir (see userDataDir.ts). */
function useUserDataDir(dir: string): string {
  setUserDataDir(dir);
  return dir;
}
useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-gateway-test-")));

type ConversationStoreType = ConversationStore;
let ConversationStoreCtor: typeof ConversationStore;
let createGateway: typeof createGatewayType;
let initSpawnEngine: typeof initSpawnEngineType;
function freshStore(): ConversationStoreType {
  useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-gateway-test-")));
  return new ConversationStoreCtor();
}

function makeGateway(store: ConversationStoreType, approve: (() => Promise<boolean>) | undefined = async () => true) {
  const events: RuntimeEvent[] = [];
  let turnListener: ((event: RuntimeEvent) => void) | null = null;
  const gateway = createGateway({
    store,
    approve,
    emit: (event) => {
      events.push(event);
    },
    onEvents: (listener) => {
      turnListener = listener;
      return () => {
        turnListener = null;
      };
    },
  });
  // SAFETY: these tests hand over complete event literals; the listener
  // consumes exactly the RuntimeEvent they spell out.
  const turn = <T>(event: T) => turnListener?.(event as RuntimeEvent);
  return { gateway, events, turn };
}

type RpcToolItem = {
  name: string;
  description?: string;
  inputSchema?: GatewayRecord;
};

type RpcStructuredContent = {
  error?: { code: string; message?: string; details?: GatewayValue };
  revision?: number;
  writer?: { model?: string; provider?: string };
  pad?: { id?: string; title?: string; body?: string; revision?: number };
  batch?: {
    total: number;
    succeeded: number;
    failed: number;
    threads: Array<{
      index: number;
      ok: boolean;
      threadId?: string;
      title?: string;
      provider?: string;
      model?: string;
      agent?: string;
      preset?: string;
      kind?: string;
      error?: string;
    }>;
  };
  messages?: Array<{
    id: string;
    from: string;
    to: string;
    message: string;
    replyTo?: string | null;
    createdAt: number;
  }>;
  messageId?: string;
  from?: string;
  to?: string;
  delivered?: boolean;
  recipients?: string[];
  replyTo?: string | null;
  count?: number;
  unreadRemaining?: number;
};

type RpcResultPayload = {
  tools?: RpcToolItem[];
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: RpcStructuredContent;
};

/** The JSON-RPC envelope's `result` member — the only part these tests read. */
function rpcResult(res: { json: RpcEnvelope | RpcEnvelope[] | undefined }): RpcResultPayload {
  // SAFETY: every MCP reply below is a JSON-RPC response whose payload sits
  // under `result`; tests read typed result fields from RpcResultPayload.
  const envelope = res.json as { result?: RpcResultPayload } | undefined;
  return envelope?.result ?? {};
}

/** One JSON-RPC 2.0 response envelope as the gateway answers — `result` on a
 *  success, `error` on a protocol failure; tests read `result` via rpcResult. */
type RpcEnvelope = {
  jsonrpc?: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: unknown;
};

async function mcpPost(url: string, token: string, body: JsonValue | string) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  // SAFETY: the endpoint answers JSON-RPC — one envelope (or a batch array)
  // parsed from the body.
  const json = (await res.json()) as RpcEnvelope | RpcEnvelope[] | undefined;
  return { status: res.status, json };
}

beforeAll(async () => {
  // ConversationStore, createGateway, and initSpawnEngine are loaded dynamically so the sqlite.js mock is hoisted first.
  const storeModule = await import("../ConversationStore.js");
  const gatewayModule = await import("./index.js");
  const spawnModule = await import("../threadSpawn.js");
  ConversationStoreCtor = storeModule.ConversationStore;
  createGateway = gatewayModule.createGateway;
  initSpawnEngine = spawnModule.initSpawnEngine;
});

describe("gateway integration (real store + HTTP)", () => {
  test("scratchpads revision and gateway_ops persist in baseline schema", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-gw-baseline-"));
    useUserDataDir(dir);
    const store = new ConversationStoreCtor();
    store.ensureThread({ threadId: "t", projectPath: "/tmp/proj", provider: "opencode" });

    store.saveScratchpad({
      padId: "pad-1",
      projectPath: "/tmp/proj",
      title: "Scratchpad",
      body: "initial body",
    });
    const pad = store.getScratchpad("pad-1");
    expect(pad).not.toBeNull();
    expect(pad!.body).toBe("initial body");
    expect(pad!.revision).toBe(1);

    const saved = store.saveScratchpad({
      padId: "pad-1",
      projectPath: "/tmp/proj",
      title: "Scratchpad",
      body: "updated",
    });
    expect(saved).toMatchObject({ revision: 2 });

    // gateway_ops exists and reserves/replays.
    const reserve = store.reserveGatewayOp({
      threadId: "t",
      turnId: "turn-1",
      requestId: "r",
      kind: "spawn.thread",
      fingerprint: "fp",
    });
    expect(reserve).toEqual({ kind: "reserved" });
    store.setGatewayOpResult({ threadId: "t", turnId: "turn-1", requestId: "r", resultJson: '{"ok":true}' });
    expect(
      store.reserveGatewayOp({
        threadId: "t",
        turnId: "turn-1",
        requestId: "r",
        kind: "spawn.thread",
        fingerprint: "fp",
      }),
    ).toEqual({ kind: "replay", result: { ok: true } });
    expect(
      store.reserveGatewayOp({
        threadId: "t",
        turnId: "turn-1",
        requestId: "r",
        kind: "spawn.thread",
        fingerprint: "other",
      }),
    ).toEqual({ kind: "conflict" });
  });

  test("fresh install migrates to v15 and the full store still works", () => {
    const store = freshStore();
    expect(store.saveScratchpad({ padId: "p", projectPath: "/tmp/proj", title: "S", body: "b" }))
      .toMatchObject({ revision: 1 });
    expect(store.saveScratchpad({ padId: "p", projectPath: "/tmp/proj", title: "S", body: "b2" }))
      .toMatchObject({ revision: 2 });
    expect(store.saveScratchpad({
      padId: "p", projectPath: "/tmp/proj", title: "S", body: "stale", expectedRevision: 1,
    })).toEqual({ conflict: 2 });
    const appended = store.saveScratchpad({
      padId: "p", projectPath: "/tmp/proj", title: "S", body: "more", append: true,
    });
    expect(appended).toMatchObject({ revision: 3 });
    expect(store.getScratchpad("p")!.body).toBe("b2\n\nmore");
  });

  test("a request carrying an Origin is refused before the token is even read", async () => {
    const store = freshStore();
    const { gateway } = makeGateway(store);
    await gateway.ready;
    const conn = gateway.connectionForThread("thread-origin", "claudeAgent", "sonnet");
    store.ensureThread({
      threadId: "thread-origin",
      projectPath: "/tmp/proj",
      provider: "claudeAgent",
      model: "sonnet",
    });

    // A page that guessed the dynamic port, holding a VALID token: the loopback
    // server is reachable from any browser tab, so Origin — which only a
    // browser sends — is refused outright rather than served.
    const rebound = await fetch(conn.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${conn.bearerToken}`,
        origin: "http://evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(rebound.status).toBe(403);

    // The same call from a real client (no Origin) still works.
    const ok = await mcpPost(conn.url, conn.bearerToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    expect(ok.status).toBe(200);

    await gateway.shutdown();
  });

  test("full round-trip: auth → tools/list → write → read → append → replay", async () => {
    const store = freshStore();
    const { gateway, events, turn } = makeGateway(store);
    await gateway.ready;

    // No token → 401.
    const unauthorized = await fetch(gateway.mcpEndpointUrl(), { method: "POST" });
    expect(unauthorized.status).toBe(401);

    const conn = gateway.connectionForThread("thread-1", "claudeAgent", "sonnet");
    const url = conn.url;
    expect(url).toBe(gateway.mcpEndpointUrl());

    // The app registers the thread row at start-session (ipc.ts
    // agent:start-session → store.ensureThread) before any turn or MCP call.
    store.ensureThread({
      threadId: "thread-1",
      projectPath: "/tmp/proj",
      provider: "claudeAgent",
      model: "sonnet",
    });

    // No live turn yet → write denied, read still works (not_found).
    let res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (rpcResult(res).tools ?? []).map((t) => t.name);
    expect(names).toEqual([
      "kone_scratchpad_read",
      "kone_scratchpad_write",
      "kone_spawn_targets",
      "kone_spawn_worker",
      "kone_spawn_worker_preset",
      "kone_spawn_batch",
      "kone_continue_thread",
      "kone_wait_for_responses",
      "kone_read_response",
      "kone_irc_send",
      "kone_irc_list",
      "kone_irc_inbox",
      "kone_launch",
      "app_get_theme_state",
      "app_list_available_themes",
      "app_set_theme",
      "app_preview_theme_override",
      "app_create_custom_theme",
      "app_list_subagent_presets",
      "app_create_subagent_preset",
      "app_update_subagent_preset",
      "app_delete_subagent_preset",
      "app_get_strip_settings",
      "app_set_strip_settings",
    ]);
    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "kone_scratchpad_read", arguments: {} } });
    expect(rpcResult(res).isError).toBe(true);
    expect(rpcResult(res).structuredContent.error.code).toBe("not_found");

    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "turnless write" } } });
    expect(rpcResult(res).structuredContent.error.code).toBe("capability_denied");

    // Turn starts → write binds authority.
    turn({ type: "turn.started", threadId: "thread-1", provider: "claudeAgent", at: 1, source: "claude.sdk.message", turnId: "turn-1" });

    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "agent note one" } } });
    expect(rpcResult(res).isError).toBeUndefined();
    expect(rpcResult(res).structuredContent).toMatchObject({
      revision: 1,
      writer: { model: "sonnet", provider: "claudeAgent" },
    });

    // The event reached the broadcast path with full payload.
    expect(events).toHaveLength(1);
    // SAFETY: the single broadcast above is the scratchpad write's own event.
    const event = events[0] as RuntimeEvent & { type: "scratchpad.updated" };
    expect(event).toMatchObject({
      type: "scratchpad.updated",
      projectPath: "/tmp/proj",
      revision: 1,
      writer: { model: "sonnet", provider: "claudeAgent" },
    });

    // The pad persisted in the real store.
    expect(store.getScratchpad(event.scratchpadId)!.body).toBe("agent note one");

    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "agent note two", append: true } } });
    expect(rpcResult(res).structuredContent).toMatchObject({ revision: 2 });
    expect(rpcResult(res).structuredContent.pad.body).toBe("agent note one\n\nagent note two");

    // Stale expectedRevision → revision_conflict with current revision.
    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "stale", expectedRevision: 1 } } });
    expect(rpcResult(res).structuredContent.error).toMatchObject({
      code: "revision_conflict",
      details: { currentRevision: 2 },
    });

    // Idempotency: first op-1 write saves (revision 3); the identical retry
    // replays the stored post-write result instead of re-applying.
    const first = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "agent note one", clientRequestId: "op-1" } } });
    expect(rpcResult(first).structuredContent).toMatchObject({ revision: 3 });
    const replay = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "agent note one", clientRequestId: "op-1" } } });
    expect(rpcResult(replay).content[0].text).toContain("Replayed");
    expect(rpcResult(replay).structuredContent).toEqual(rpcResult(first).structuredContent);

    // Turn completes → write authority retired; writes denied again, reads fine.
    turn({ type: "turn.completed", threadId: "thread-1", provider: "claudeAgent", at: 2, source: "claude.sdk.message", turnId: "turn-1" });
    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "after turn" } } });
    expect(rpcResult(res).structuredContent.error.code).toBe("capability_denied");
    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "kone_scratchpad_read", arguments: {} } });
    // The op-1 write was a full replacement — the pad holds its content.
    expect(rpcResult(res).structuredContent.pad.body).toBe("agent note one");
    expect(rpcResult(res).structuredContent.pad.revision).toBe(3);

    // stopSession revokes the token outright.
    gateway.revokeThread("thread-1");
    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 11, method: "ping" });
    expect(res.status).toBe(401);

    await gateway.shutdown();
  });

  test("turn.aborted retires write authority for the thread's tokens", async () => {
    const store = freshStore();
    const { gateway, turn } = makeGateway(store);
    await gateway.ready;

    const conn = gateway.connectionForThread("thread-abort", "claudeAgent", "sonnet");
    store.ensureThread({
      threadId: "thread-abort",
      projectPath: "/tmp/proj",
      provider: "claudeAgent",
      model: "sonnet",
    });

    // A running turn binds write authority.
    turn({ type: "turn.started", threadId: "thread-abort", provider: "claudeAgent", at: 1, source: "claude.sdk.message", turnId: "turn-1" });
    let res = await mcpPost(conn.url, conn.bearerToken, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "in turn" } } });
    expect(rpcResult(res).structuredContent).toMatchObject({ revision: 1 });

    // The abort terminal event retires the exact turn, so the next write is
    // refused — the same branch that sweeps the turn's in-flight work.
    turn({ type: "turn.aborted", threadId: "thread-abort", provider: "claudeAgent", at: 2, source: "claude.sdk.message", turnId: "turn-1", reason: "interrupted" });
    res = await mcpPost(conn.url, conn.bearerToken, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "after abort" } } });
    expect(rpcResult(res).structuredContent.error.code).toBe("capability_denied");

    await gateway.shutdown();
  });

  test("security & authorization: active turn checks, turnless reads, and bearer token thread isolation across new tools", async () => {
    const store = freshStore();
    const { gateway, turn } = makeGateway(store);
    await gateway.ready;
    const url = gateway.mcpEndpointUrl();

    const connAlice = gateway.connectionForThread("thread-alice", "claudeAgent", "sonnet");
    const connBob = gateway.connectionForThread("thread-bob", "claudeAgent", "sonnet");

    store.ensureThread({
      threadId: "thread-alice",
      projectPath: "/tmp/proj",
      provider: "claudeAgent",
      model: "sonnet",
    });
    store.ensureThread({
      threadId: "thread-bob",
      projectPath: "/tmp/proj",
      provider: "claudeAgent",
      model: "sonnet",
    });

    // 1. tools/list advertises dispatch tools with valid schemas
    const listRes = await mcpPost(url, connAlice.bearerToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const toolList = rpcResult(listRes).tools ?? [];
    const toolNames = toolList.map((t) => t.name);
    expect(toolNames).toContain("kone_spawn_batch");
    expect(toolNames).toContain("kone_continue_thread");
    expect(toolNames).toContain("kone_read_response");

    const toolMap = new Map(toolList.map((t) => [t.name, t]));
    expect(toolMap.get("kone_spawn_batch")?.inputSchema).toEqual(SPAWN_BATCH_JSON_SCHEMA);
    expect(toolMap.get("kone_continue_thread")?.inputSchema).toEqual(CONTINUE_THREAD_JSON_SCHEMA);
    expect(toolMap.get("kone_read_response")?.inputSchema).toEqual(READ_RESPONSE_JSON_SCHEMA);

    initSpawnEngine({
      store,
      providers: {
        cachedSurface: () => ({
          statuses: [
            { provider: "codex" as const, available: true, label: "Codex" },
            { provider: "claudeAgent" as const, available: true, label: "Claude Agent" },
          ],
          models: {
            codex: [{ id: "gpt-5", label: "GPT-5" }],
            claudeAgent: [{ id: "sonnet", label: "Sonnet" }],
          },
        }),
        listSessions: async () => [],
        stopSession: async () => {},
        hasLiveSession: () => false,
      },
      dispatcher: {
        startThread: async () => ({
          threadId: "unused",
          provider: "claudeAgent" as const,
          cwd: "/tmp/proj",
          status: "running" as const,
          mode: "full-access" as const,
          startedAt: 100,
          updatedAt: 100,
        }),
        sendThreadTurn: async () => ({ turnId: "turn-child-1" }),
      },
      emit: () => {},
      onEvents: () => () => {},
    });

    store.writeSpawnedThread({
      threadId: "child-of-alice",
      projectPath: "/tmp/proj",
      provider: "claudeAgent",
      createdAt: 100,
      title: "Alice worker",
      lineage: {
        parentThreadId: "thread-alice",
        relationshipToParent: "subagent",
        rootThreadId: "thread-alice",
      },
    });
    store.writeSpawnedThread({
      threadId: "child-of-bob",
      projectPath: "/tmp/proj",
      provider: "claudeAgent",
      createdAt: 100,
      title: "Bob worker",
      lineage: {
        parentThreadId: "thread-bob",
        relationshipToParent: "subagent",
        rootThreadId: "thread-bob",
      },
    });

    // 2. Active turn check: turnless writes are rejected with capability_denied
    const turnlessSpawnBatch = await mcpPost(url, connAlice.bearerToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "kone_spawn_batch",
        arguments: {
          items: [
            {
              requestId: "req-1",
              prompt: "Do something in background",
              target: { provider: "codex" },
            },
          ],
        },
      },
    });
    expect(rpcResult(turnlessSpawnBatch).isError).toBe(true);
    expect(rpcResult(turnlessSpawnBatch).structuredContent.error.code).toBe("capability_denied");

    const turnlessContinue = await mcpPost(url, connAlice.bearerToken, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "kone_continue_thread",
        arguments: { threadId: "child-of-alice", message: "Turnless follow-up" },
      },
    });
    expect(rpcResult(turnlessContinue).isError).toBe(true);
    expect(rpcResult(turnlessContinue).structuredContent.error.code).toBe("capability_denied");

    // 3. Turnless read: kone_read_response works without an active turn
    const aliceReadsOwnChild = await mcpPost(url, connAlice.bearerToken, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "kone_read_response", arguments: { threadId: "child-of-alice" } },
    });
    expect(rpcResult(aliceReadsOwnChild).isError).toBeUndefined();

    // 4. Subtree isolation: peers cannot read or continue each other's workers
    const bobReadsAliceChild = await mcpPost(url, connBob.bearerToken, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "kone_read_response", arguments: { threadId: "child-of-alice" } },
    });
    expect(rpcResult(bobReadsAliceChild).isError).toBe(true);
    expect(rpcResult(bobReadsAliceChild).structuredContent.error.code).toBe("not_found");

    turn({
      type: "turn.started",
      threadId: "thread-bob",
      provider: "claudeAgent",
      at: 1,
      source: "claude.sdk.message",
      turnId: "turn-bob-1",
    });

    const bobContinuesAliceChild = await mcpPost(url, connBob.bearerToken, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "kone_continue_thread",
        arguments: {
          threadId: "child-of-alice",
          message: "Unauthorized follow-up from Bob",
          requestId: "req-bob-1",
        },
      },
    });
    expect(rpcResult(bobContinuesAliceChild).isError).toBe(true);
    expect(rpcResult(bobContinuesAliceChild).structuredContent.error.code).toBe("not_found");

    // 5. Write authority is bound to the active turn
    turn({
      type: "turn.completed",
      threadId: "thread-bob",
      provider: "claudeAgent",
      at: 2,
      source: "claude.sdk.message",
      turnId: "turn-bob-1",
    });

    const bobPostTurnContinue = await mcpPost(url, connBob.bearerToken, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "kone_continue_thread",
        arguments: {
          threadId: "child-of-bob",
          message: "Post-turn follow-up attempt",
          requestId: "req-bob-2",
        },
      },
    });
    expect(rpcResult(bobPostTurnContinue).isError).toBe(true);
    expect(rpcResult(bobPostTurnContinue).structuredContent.error.code).toBe("capability_denied");

    // 6. Revocation isolation: Revoking Alice's thread drops Alice's token; Bob's token is untouched
    gateway.revokeThread("thread-alice");
    const aliceAfterRevoke = await mcpPost(url, connAlice.bearerToken, {
      jsonrpc: "2.0",
      id: 14,
      method: "ping",
    });
    expect(aliceAfterRevoke.status).toBe(401);

    const bobAfterAliceRevoke = await mcpPost(url, connBob.bearerToken, {
      jsonrpc: "2.0",
      id: 15,
      method: "ping",
    });
    expect(bobAfterAliceRevoke.status).toBe(200);

    await gateway.shutdown();
  });

  test("kone_spawn_batch end-to-end execution, active turn gating, and validation over HTTP gateway", async () => {
    const store = freshStore();
    const { gateway, turn } = makeGateway(store);
    await gateway.ready;
    const url = gateway.mcpEndpointUrl();

    const conn = gateway.connectionForThread("thread-batch-caller", "claudeAgent", "sonnet");
    store.ensureThread({
      threadId: "thread-batch-caller",
      projectPath: "/tmp/proj",
      provider: "claudeAgent",
      model: "sonnet",
    });

    initSpawnEngine({
      store,
      providers: {
        cachedSurface: () => ({
          statuses: [
            { provider: "codex" as const, available: true, label: "Codex" },
            { provider: "claudeAgent" as const, available: true, label: "Claude Agent" },
          ],
          models: {
            codex: [{ id: "gpt-5", label: "GPT-5" }],
            claudeAgent: [{ id: "sonnet", label: "Sonnet" }],
          },
        }),
        listSessions: async () => [
          {
            threadId: "thread-batch-caller",
            provider: "claudeAgent" as const,
            cwd: "/tmp/proj",
            status: "running" as const,
            mode: "full-access" as const,
            startedAt: 100,
            updatedAt: 100,
          },
        ],
        stopSession: async () => {},
      },
      dispatcher: {
        startThread: async () => ({
          threadId: "child-temp",
          provider: "claudeAgent" as const,
          cwd: "/tmp/proj",
          status: "running" as const,
          mode: "full-access" as const,
          startedAt: 100,
          updatedAt: 100,
        }),
        sendThreadTurn: async () => ({
          turnId: "turn-child-1",
        }),
      },
      emit: () => {},
      onEvents: () => () => {},
    });

    // 1. Without active turn -> capability_denied
    let res = await mcpPost(url, conn.bearerToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "kone_spawn_batch",
        arguments: {
          items: [
            {
              requestId: "req-batch-1",
              prompt: "Build task 1",
              target: { provider: "codex" },
            },
          ],
        },
      },
    });
    expect(rpcResult(res).isError).toBe(true);
    expect(rpcResult(res).structuredContent?.error?.code).toBe("capability_denied");

    // 2. Start active turn
    turn({
      type: "turn.started",
      threadId: "thread-batch-caller",
      provider: "claudeAgent",
      at: 10,
      source: "claude.sdk.message",
      turnId: "turn-batch-1",
    });

    // 3. Invalid arguments -> invalid_input
    const emptyItemsRes = await mcpPost(url, conn.bearerToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "kone_spawn_batch", arguments: { items: [] } },
    });
    expect(rpcResult(emptyItemsRes).isError).toBe(true);
    expect(rpcResult(emptyItemsRes).structuredContent?.error?.code).toBe("invalid_input");

    const missingPromptRes = await mcpPost(url, conn.bearerToken, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "kone_spawn_batch",
        arguments: { items: [{ requestId: "req-1" }] },
      },
    });
    expect(rpcResult(missingPromptRes).isError).toBe(true);
    expect(rpcResult(missingPromptRes).structuredContent?.error?.code).toBe("invalid_input");

    // 4. Valid batch execution over HTTP
    res = await mcpPost(url, conn.bearerToken, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "kone_spawn_batch",
        arguments: {
          items: [
            {
              requestId: "req-gw-batch-1",
              prompt: "Execute sub-task alpha",
              title: "Alpha Worker",
              target: { provider: "codex", model: "gpt-5" },
            },
            {
              requestId: "req-gw-batch-2",
              prompt: "Execute sub-task beta",
              title: "Beta Worker",
              target: { provider: "claudeAgent", model: "sonnet" },
            },
          ],
        },
      },
    });
    expect(rpcResult(res).isError).toBe(false);
    expect(rpcResult(res).content?.[0]?.text).toContain("Spawned 2 threads");
    const batchData = rpcResult(res).structuredContent?.batch;
    expect(batchData?.total).toBe(2);
    expect(batchData?.succeeded).toBe(2);
    expect(batchData?.failed).toBe(0);
    expect(batchData?.threads).toHaveLength(2);
    expect(batchData?.threads[0]?.ok).toBe(true);
    expect(batchData?.threads[0]?.title).toBe("Alpha Worker");
    expect(batchData?.threads[1]?.ok).toBe(true);
    expect(batchData?.threads[1]?.title).toBe("Beta Worker");

    // Check that children threads persisted in real store
    const child0Id = batchData?.threads[0]?.threadId;
    const child1Id = batchData?.threads[1]?.threadId;
    expect(child0Id).toBeDefined();
    expect(child1Id).toBeDefined();
    expect(store.threadMeta(child0Id!)).not.toBeNull();
    expect(store.threadMeta(child1Id!)).not.toBeNull();

    await gateway.shutdown();
  });

  test("kone_launch execution and process cleanup on gateway shutdown", async () => {
    const store = freshStore();
    store.ensureThread({
      threadId: "thread-launch-caller",
      projectPath: process.cwd(),
      provider: "claudeAgent",
      createdAt: 1,
    });
    const { gateway, turn } = makeGateway(store);
    await gateway.ready;
    const url = gateway.mcpEndpointUrl();

    const conn = gateway.connectionForThread("thread-launch-caller", "claudeAgent");

    turn({
      type: "turn.started",
      threadId: "thread-launch-caller",
      provider: "claudeAgent",
      at: 10,
      source: "claude.sdk.message",
      turnId: "turn-launch-1",
    });

    const startRes = await mcpPost(url, conn.bearerToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "kone_launch",
        arguments: {
          op: "start",
          name: "gw-proc",
          command: "node",
          args: ["-e", "console.log('GW READY'); setInterval(() => {}, 1000);"],
          ready: { log: "GW READY", timeout: 5 },
        },
      },
    });

    expect(rpcResult(startRes).isError).toBeFalsy();
    expect(rpcResult(startRes).content?.[0]?.text).toContain("Started process");
    // SAFETY: Process launch response includes structuredContent with pid
    const pid = rpcResult(startRes).structuredContent?.pid as number;
    expect(Number.isFinite(pid)).toBe(true);

    // Shutdown gateway, which must stop the supervised process
    await gateway.shutdown();

    // Verify process is actually dead (kill with signal 0 throws ESRCH)
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
