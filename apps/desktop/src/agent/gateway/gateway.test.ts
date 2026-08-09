import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

// The store imports node:sqlite, an Electron-runtime built-in this bun can't
// load — stand it in for bun:sqlite, whose API surface (exec / prepare().get /
// run / all) matches the store's usage. electron's app.getPath is pointed at
// a throwaway temp dir per test. ConversationStore is imported *dynamically*
// below so the stub is in place first (static imports hoist above mock.module,
// defeating it — the same pattern sidechat.test.ts uses).
mock.module("node:sqlite", () => ({
  DatabaseSync: Database,
}));
mock.module("electron", () => ({
  app: { getPath: () => testUserDataDir },
}));

import type { RuntimeEvent } from "../types.js";

let testUserDataDir = mkdtempSync(path.join(tmpdir(), "kone-gateway-test-"));

type ConversationStoreType = import("../ConversationStore.js").ConversationStore;
type GatewayHandleType = import("./index.js").GatewayHandle;
let ConversationStoreCtor: typeof import("../ConversationStore.js").ConversationStore;
let createGateway: typeof import("./index.js").createGateway;

function freshStore(): ConversationStoreType {
  testUserDataDir = mkdtempSync(path.join(tmpdir(), "kone-gateway-test-"));
  return new ConversationStoreCtor();
}

function makeGateway(store: ConversationStoreType) {
  const events: RuntimeEvent[] = [];
  let turnListener: ((event: RuntimeEvent) => void) | null = null;
  const gateway = createGateway({
    store,
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
  return { gateway, events, turn: (event: RuntimeEvent) => turnListener?.(event) };
}

async function mcpPost(url: string, token: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown> | Record<string, unknown>[];
  return { status: res.status, json };
}

beforeAll(async () => {
  const storeModule = await import("../ConversationStore.js");
  const gatewayModule = await import("./index.js");
  ConversationStoreCtor = storeModule.ConversationStore;
  createGateway = gatewayModule.createGateway;
});

describe("gateway integration (real store + HTTP)", () => {
  test("migration lands v15: revision column + gateway_ops, legacy pads read revision 1", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-gw-migrate-"));
    const legacy = new Database(path.join(dir, "conversations.sqlite"));
    legacy.exec(`
      PRAGMA user_version = 14;
      CREATE TABLE threads (
        thread_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT, conversation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        branch TEXT, added INTEGER, removed INTEGER, tokens INTEGER, archived INTEGER, title TEXT,
        base_tree TEXT, source_thread_id TEXT, fork_context_json TEXT, lineage_json TEXT, request_id TEXT
      );
      CREATE TABLE blocks (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, block_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
        role TEXT NOT NULL, turn_id TEXT, text TEXT, state TEXT, error TEXT, at INTEGER NOT NULL,
        ended_at INTEGER, attachments_json TEXT, source TEXT NOT NULL DEFAULT 'native'
      );
      CREATE TABLE items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL,
        name TEXT, detail TEXT, tasks_json TEXT, subagent_tool_use_id TEXT,
        UNIQUE (thread_id, turn_id, item_id)
      );
      CREATE TABLE subagents (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tool_use_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL, task_id TEXT, parent_item_id TEXT, agent_type TEXT,
        description TEXT, prompt TEXT, model TEXT, effort TEXT, background INTEGER,
        status TEXT NOT NULL, summary TEXT, last_tool_name TEXT, tokens INTEGER,
        tool_uses INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER,
        UNIQUE (thread_id, turn_id, tool_use_id)
      );
      CREATE TABLE attachments (
        attachment_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, type TEXT NOT NULL,
        name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        rel_path TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE project_boards (
        project_path TEXT PRIMARY KEY, layout TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE scratchpads (
        id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT, body TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sort_index INTEGER NOT NULL
      );
      INSERT INTO scratchpads (id, project_path, title, body, created_at, updated_at, sort_index)
        VALUES ('pad-legacy', '/tmp/proj', 'Scratchpad', 'legacy body', 1, 2, 0);
    `);
    legacy.close();

    // Old userData path → new store migrates it on open.
    testUserDataDir = dir;
    const store = new ConversationStoreCtor();
    const pad = store.getScratchpad("pad-legacy");
    expect(pad).not.toBeNull();
    expect(pad!.body).toBe("legacy body");
    expect(pad!.revision).toBe(1);

    const saved = store.saveScratchpad({
      padId: "pad-legacy",
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
      kind: "scratchpad.write",
      fingerprint: "fp",
    });
    expect(reserve).toEqual({ kind: "reserved" });
    store.setGatewayOpResult({ threadId: "t", turnId: "turn-1", requestId: "r", resultJson: '{"ok":true}' });
    expect(store.reserveGatewayOp({
      threadId: "t",
      turnId: "turn-1",
      requestId: "r",
      kind: "scratchpad.write",
      fingerprint: "fp",
    })).toEqual({ kind: "replay", result: { ok: true } });
    expect(store.reserveGatewayOp({
      threadId: "t",
      turnId: "turn-1",
      requestId: "r",
      kind: "scratchpad.write",
      fingerprint: "other",
    })).toEqual({ kind: "conflict" });
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
    const names = (res.json as any).result.tools.map((t: any) => t.name);
    expect(names).toEqual([
      "kone_scratchpad_read",
      "kone_scratchpad_write",
      "kone_spawn_targets",
      "kone_spawn_thread",
      "kone_wait_for_threads",
      "kone_read_thread",
    ]);

    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "kone_scratchpad_read", arguments: {} } });
    expect((res.json as any).result.isError).toBe(true);
    expect((res.json as any).result.structuredContent.error.code).toBe("not_found");

    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "turnless write" } } });
    expect((res.json as any).result.structuredContent.error.code).toBe("capability_denied");

    // Turn starts → write binds authority.
    turn({ type: "turn.started", threadId: "thread-1", provider: "claudeAgent", at: 1, source: "claude.sdk.message", turnId: "turn-1" } as RuntimeEvent);

    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "agent note one" } } });
    expect((res.json as any).result.isError).toBeUndefined();
    expect((res.json as any).result.structuredContent).toMatchObject({
      revision: 1,
      writer: { model: "sonnet", provider: "claudeAgent" },
    });

    // The event reached the broadcast path with full payload.
    expect(events).toHaveLength(1);
    const event = events[0] as RuntimeEvent & { type: "scratchpad.updated" };
    expect(event).toMatchObject({
      type: "scratchpad.updated",
      projectPath: "/tmp/proj",
      revision: 1,
      writer: { model: "sonnet", provider: "claudeAgent" },
    });

    // The pad persisted in the real store.
    expect(store.getScratchpad(event.padId)!.body).toBe("agent note one");

    // Append merges server-side.
    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "agent note two", append: true } } });
    expect((res.json as any).result.structuredContent).toMatchObject({ revision: 2 });
    expect((res.json as any).result.structuredContent.pad.body).toBe("agent note one\n\nagent note two");

    // Stale expectedRevision → revision_conflict with current revision.
    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "stale", expectedRevision: 1 } } });
    expect((res.json as any).result.structuredContent.error).toMatchObject({
      code: "revision_conflict",
      details: { currentRevision: 2 },
    });

    // Idempotency: first op-1 write saves (revision 3); the identical retry
    // replays the stored post-write result instead of re-applying.
    const first = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "agent note one", clientRequestId: "op-1" } } });
    expect((first.json as any).result.structuredContent).toMatchObject({ revision: 3 });
    const replay = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "agent note one", clientRequestId: "op-1" } } });
    expect((replay.json as any).result.content[0].text).toContain("Replayed");
    expect((replay.json as any).result.structuredContent).toEqual((first.json as any).result.structuredContent);

    // Turn completes → write authority retired; writes denied again, reads fine.
    turn({ type: "turn.completed", threadId: "thread-1", provider: "claudeAgent", at: 2, source: "claude.sdk.message", turnId: "turn-1" } as RuntimeEvent);
    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "kone_scratchpad_write", arguments: { title: "Scratchpad", body: "after turn" } } });
    expect((res.json as any).result.structuredContent.error.code).toBe("capability_denied");
    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "kone_scratchpad_read", arguments: {} } });
    // The op-1 write was a full replacement — the pad holds its content.
    expect((res.json as any).result.structuredContent.pad.body).toBe("agent note one");
    expect((res.json as any).result.structuredContent.pad.revision).toBe(3);

    // stopSession revokes the token outright.
    gateway.revokeThread("thread-1");
    res = await mcpPost(url, conn.bearerToken, { jsonrpc: "2.0", id: 11, method: "ping" });
    expect(res.status).toBe(401);

    await gateway.shutdown();
  });
});
