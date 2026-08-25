import { describe, expect, test } from "bun:test";

import { GatewayCredentials } from "./credentials.js";
import { makeInFlightRequestRegistry } from "./inFlightRequests.js";
import { createRegistry } from "./registry.js";
import {
  extractBearerToken,
  makeMcpTransport,
  negotiateMcpProtocolVersion,
  parseMcpMessage,
  type GatewayTransportStore,
} from "./mcpTransport.js";
import { z } from "zod";
import type { JsonValue } from "@kone/agent-core/lib-jsonValue.js";
import type { GatewayRecord } from "./schemas.js";
import {
  SPAWN_BATCH_JSON_SCHEMA,
  IRC_SEND_JSON_SCHEMA,
  IRC_INBOX_JSON_SCHEMA,
} from "./schemas.js";
import { createIrcTools, IrcMailbox } from "./tools/irc.js";
import { createSpawnTools } from "./tools/spawn.js";
import { initSpawnEngine } from "../threadSpawn.js";

const PROJECT = "/tmp/proj";

function fixture() {
  const credentials = new GatewayCredentials();
  const store: GatewayTransportStore = {
    threadProjectPath: (threadId: string) => (threadId === "thread-1" ? PROJECT : null),
  };
  const registry = createRegistry([
    {
      name: "echo",
      description: "echoes",
      inputSchema: z.object({ text: z.string() }),
      jsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      permission: "allow",
      requiresActiveTurn: false,
      handler: async (_ctx, input: { text: string }) => ({
        content: [{ type: "text", text: input.text }],
      }),
    },
    {
      name: "write_only",
      description: "needs a turn",
      inputSchema: z.object({}),
      jsonSchema: { type: "object" },
      permission: "allow",
      requiresActiveTurn: true,
      handler: async () => ({ content: [{ type: "text", text: "wrote" }] }),
    },
    {
      name: "denied",
      description: "nope",
      inputSchema: z.object({}),
      jsonSchema: { type: "object" },
      permission: "deny",
      requiresActiveTurn: false,
      handler: async () => ({ content: [{ type: "text", text: "nope" }] }),
    },
  ]);
  const turnState = new Map<string, { turnId: string; running: boolean }>();
  const transport = makeMcpTransport({
    credentials,
    registry,
    store,
    turnState,
    serverVersion: "0.1.0",
    instructions: "test instructions",
  });
  return { credentials, store, registry, turnState, transport };
}

function post(transport: ReturnType<typeof fixture>["transport"], auth: string | undefined, body: JsonValue | string) {
  return transport.handlePost({ authorizationHeader: auth, body });
}

describe("parseMcpMessage", () => {
  test("classifies requests, notifications, responses, invalid", () => {
    expect(parseMcpMessage({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }).kind).toBe(
      "request",
    );
    expect(parseMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).kind).toBe(
      "notification",
    );
    expect(parseMcpMessage({ jsonrpc: "2.0", id: 1, result: {} }).kind).toBe("response");
    expect(parseMcpMessage("garbage").kind).toBe("invalid");
    expect(parseMcpMessage({ jsonrpc: "1.0", id: 1, method: "ping" }).kind).toBe("invalid");
  });
});

describe("negotiateMcpProtocolVersion", () => {
  test("accepts supported versions, defaults otherwise", () => {
    expect(negotiateMcpProtocolVersion("2025-06-18")).toBe("2025-06-18");
    expect(negotiateMcpProtocolVersion("2024-11-05")).toBe("2024-11-05");
    expect(negotiateMcpProtocolVersion("2099-01-01")).toBe("2025-06-18");
    expect(negotiateMcpProtocolVersion(undefined)).toBe("2025-06-18");
  });
});

describe("extractBearerToken", () => {
  test("parses the Bearer scheme", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken("bearer abc")).toBe("abc");
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
  });
});

describe("gateway transport auth", () => {
  test("missing or invalid token → 401", async () => {
    const { transport } = fixture();
    const missing = await post(transport, undefined, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(missing.status).toBe(401);
    const bogus = await post(transport, "Bearer nope", { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(bogus.status).toBe(401);
  });

  test("revoked token → 401", async () => {
    const { transport, credentials } = fixture();
    const token = credentials.issueSessionToken("thread-1", "claudeAgent");
    credentials.revokeSessionToken(token);
    const res = await post(transport, `Bearer ${token}`, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(401);
  });

  test("token for a vanished thread → 401", async () => {
    const { transport, credentials } = fixture();
    const token = credentials.issueSessionToken("ghost", "claudeAgent");
    const res = await post(transport, `Bearer ${token}`, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(401);
  });
});

describe("gateway transport methods", () => {
  function authed() {
    const f = fixture();
    const token = f.credentials.issueSessionToken("thread-1", "claudeAgent", "sonnet");
    return { ...f, auth: `Bearer ${token}` };
  }

  test("initialize returns capabilities + negotiated version", async () => {
    const { transport, auth } = authed();
    const res = await post(transport, auth, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "kone" },
      },
    });
  });

  test("ping → {}", async () => {
    const { transport, auth } = authed();
    const res = await post(transport, auth, { jsonrpc: "2.0", id: 2, method: "ping" });
    expect(res.body).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
  });

  test("tools/list omits denied tools", async () => {
    const { transport, auth } = authed();
    const res = await post(transport, auth, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(res.body).toMatchObject({
      result: { tools: [{ name: "echo" }, { name: "write_only" }] },
    });
  });

  test("tools/call round-trips a result", async () => {
    const { transport, auth } = authed();
    const res = await post(transport, auth, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hello" } },
    });
    expect(res.body).toMatchObject({
      jsonrpc: "2.0",
      id: 4,
      result: { content: [{ type: "text", text: "hello" }] },
    });
  });

  test("unknown tool → successful JSON-RPC with isError result", async () => {
    const { transport, auth } = authed();
    const res = await post(transport, auth, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "ghost", arguments: {} },
    });
    expect(res.status).toBe(200);
    expect(res.body!.result.isError).toBe(true);
  });

  test("unknown method → JSON-RPC method-not-found error", async () => {
    const { transport, auth } = authed();
    const res = await post(transport, auth, {
      jsonrpc: "2.0",
      id: 6,
      method: "resources/list",
    });
    expect(res.body!.error.code).toBe(-32601);
  });

  test("write tool without a live turn → capability_denied", async () => {
    const { transport, auth } = authed();
    const res = await post(transport, auth, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "write_only", arguments: {} },
    });
    expect(res.body!.result.isError).toBe(true);
    expect(res.body!.result.structuredContent.error.code).toBe("capability_denied");
  });

  test("write tool with a live turn binds authority and succeeds", async () => {
    const { transport, auth, turnState } = authed();
    turnState.set("thread-1", { turnId: "turn-9", running: true });
    const res = await post(transport, auth, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "write_only", arguments: {} },
    });
    expect(res.body!.result.isError).toBeUndefined();
    expect(res.body!.result.content[0].text).toBe("wrote");
  });

  test("read tools work with no turn running", async () => {
    const { transport, auth } = authed();
    const res = await post(transport, auth, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "quiet" } },
    });
    expect(res.body!.result.content[0].text).toBe("quiet");
  });

  test("notifications (initialized/cancelled) produce no response → 202", async () => {
    const { transport, auth } = authed();
    const res = await post(transport, auth, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(res.status).toBe(202);
  });

  test("a request cancelled by an earlier batch slot is skipped", async () => {
    const { transport, auth } = authed();
    const res = await post(transport, auth, [
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 42 } },
      { jsonrpc: "2.0", id: 42, method: "ping" },
      { jsonrpc: "2.0", id: 43, method: "ping" },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject([{ id: 43 }]);
  });

  test("batch returns an array response; single returns a single response", async () => {
    const { transport, auth } = authed();
    const batch = await post(transport, auth, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect(Array.isArray(batch.body)).toBe(true);
    expect(batch.body).toMatchObject([{ id: 1 }, { id: 2 }]);
    const single = await post(transport, auth, { jsonrpc: "2.0", id: 3, method: "ping" });
    expect(Array.isArray(single.body)).toBe(false);
  });

  test("empty batch → 400; oversized batch → 400", async () => {
    const { transport, auth } = authed();
    expect((await post(transport, auth, [])).status).toBe(400);
    const big = Array.from({ length: 51 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "ping",
    }));
    expect((await post(transport, auth, big)).status).toBe(400);
  });

  test("invalid JSON-RPC message in a batch → error response for that slot", async () => {
    const { transport, auth } = authed();
    const res = await post(transport, auth, [{ jsonrpc: "2.0", id: 1, method: "ping" }, "junk"]);
    if (!Array.isArray(res.body)) {
      throw new Error("a batch request must answer with an array");
    }
    expect(res.body).toHaveLength(2);
    expect(res.body[1]).toMatchObject({ error: { code: -32600 } });
  });
});

describe("in-flight MCP cancellation (cross-POST)", () => {
  test(
    "a later POST of notifications/cancelled aborts an in-flight tools/call",
    { timeout: 2000 },
    async () => {
    const credentials = new GatewayCredentials();
    const store: GatewayTransportStore = {
      threadProjectPath: (threadId: string) => (threadId === "thread-1" ? PROJECT : null),
    };
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    let sawAbort = false;
    const registry = createRegistry([
      {
        name: "hang",
        description: "blocks until aborted",
        inputSchema: z.object({}),
        jsonSchema: { type: "object" },
        permission: "allow",
        requiresActiveTurn: false,
        handler: async (ctx) => {
          started();
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 8_000);
            const onAbort = () => {
              sawAbort = true;
              clearTimeout(timer);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            };
            if (ctx.signal?.aborted) {
              onAbort();
              return;
            }
            ctx.signal?.addEventListener("abort", onAbort, { once: true });
          });
          return { content: [{ type: "text", text: "should-not-land" }] };
        },
      },
    ]);
    const transport = makeMcpTransport({
      credentials,
      registry,
      store,
      turnState: new Map(),
      serverVersion: "0.1.0",
      instructions: "test",
    });
    const token = credentials.issueSessionToken("thread-1", "claudeAgent");
    const auth = `Bearer ${token}`;

    const callP = post(transport, auth, {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "hang", arguments: {} },
    });
    await startedP;
    const cancelRes = await post(transport, auth, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 42 },
    });
    expect(cancelRes.status).toBe(202);
    const callRes = await callP;
    expect(callRes.status).toBe(202);
    expect(callRes.body).toBeUndefined();
    expect(sawAbort).toBe(true);
  });

  test("cancelling one thread's request id leaves another thread's same-id call alone", async () => {
    const credentials = new GatewayCredentials();
    const store: GatewayTransportStore = {
      threadProjectPath: (threadId: string) =>
        threadId === "thread-1" || threadId === "thread-2" ? PROJECT : null,
    };
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const releaseP = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sawAbort = false;
    const registry = createRegistry([
      {
        name: "hang",
        description: "blocks until released or aborted",
        inputSchema: z.object({}),
        jsonSchema: { type: "object" },
        permission: "allow",
        requiresActiveTurn: false,
        handler: async (ctx) => {
          started();
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              sawAbort = true;
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            };
            if (ctx.signal?.aborted) {
              onAbort();
              return;
            }
            ctx.signal?.addEventListener("abort", onAbort, { once: true });
            void releaseP.then(resolve);
          });
          return { content: [{ type: "text", text: "landed" }] };
        },
      },
    ]);
    const transport = makeMcpTransport({
      credentials,
      registry,
      store,
      turnState: new Map(),
      serverVersion: "0.1.0",
      instructions: "test",
    });
    const auth2 = `Bearer ${credentials.issueSessionToken("thread-2", "claudeAgent")}`;
    const auth1 = `Bearer ${credentials.issueSessionToken("thread-1", "claudeAgent")}`;

    const callP = post(transport, auth2, {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "hang", arguments: {} },
    });
    await startedP;
    const cancelRes = await post(transport, auth1, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 42 },
    });
    expect(cancelRes.status).toBe(202);
    release();
    const callRes = await callP;
    expect(callRes.status).toBe(200);
    expect(callRes.body).toMatchObject({
      id: 42,
      result: { content: [{ type: "text", text: "landed" }] },
    });
    expect(sawAbort).toBe(false);
  });

  test("cancelTurn on the injected registry aborts a call bound to that turn", async () => {
    const credentials = new GatewayCredentials();
    const store: GatewayTransportStore = {
      threadProjectPath: (threadId: string) => (threadId === "thread-1" ? PROJECT : null),
    };
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    let sawAbort = false;
    const registry = createRegistry([
      {
        name: "hang",
        description: "blocks until aborted",
        inputSchema: z.object({}),
        jsonSchema: { type: "object" },
        permission: "allow",
        requiresActiveTurn: false,
        handler: async (ctx) => {
          started();
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 8_000);
            const onAbort = () => {
              sawAbort = true;
              clearTimeout(timer);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            };
            if (ctx.signal?.aborted) {
              onAbort();
              return;
            }
            ctx.signal?.addEventListener("abort", onAbort, { once: true });
          });
          return { content: [{ type: "text", text: "should-not-land" }] };
        },
      },
    ]);
    const inFlight = makeInFlightRequestRegistry();
    const turnState = new Map<string, { turnId: string; running: boolean }>();
    turnState.set("thread-1", { turnId: "turn-9", running: true });
    const transport = makeMcpTransport({
      credentials,
      registry,
      store,
      turnState,
      serverVersion: "0.1.0",
      instructions: "test",
      inFlight,
    });
    const auth = `Bearer ${credentials.issueSessionToken("thread-1", "claudeAgent")}`;

    const callP = post(transport, auth, {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "hang", arguments: {} },
    });
    await startedP;
    inFlight.cancelTurn("thread-1", "turn-9");
    const callRes = await callP;
    expect(callRes.status).toBe(202);
    expect(callRes.body).toBeUndefined();
    expect(sawAbort).toBe(true);
  });
});

describe("mcp transport: new tools (kone_spawn_batch, kone_irc_send, kone_irc_inbox)", () => {
  function newToolsFixture() {
    const credentials = new GatewayCredentials();
    const store: GatewayTransportStore = {
      threadProjectPath: (threadId: string) =>
        threadId === "thread-1" || threadId === "thread-2" ? PROJECT : null,
    };
    const mailbox = new IrcMailbox();
    const fakeSpawnStore = {
      loadThread: () => null,
      listSubagentPresets: () => [],
      getSubagentPreset: () => null,
      listProjectAgents: () => [],
    };

    initSpawnEngine({
      store: {
        threadMeta: (threadId: string) => ({
          threadId,
          projectPath: PROJECT,
          provider: "claudeAgent" as const,
          createdAt: 100,
          updatedAt: 100,
          title: "Parent",
        }),
        writeSpawnedThread: () => true,
        threadLineage: () => null,
        bindThreadAgent: () => {},
        spawnedChildren: () => [],
        spawnDepth: () => 0,
        liveSpawnedThreadIds: () => [],
        latestAssistantText: () => null,
        threadTurnSpan: () => null,
        reserveGatewayOp: () => ({ kind: "reserved" as const }),
        setGatewayOpResult: () => {},
        markGatewayOpDispatched: () => {},
      },
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
            threadId: "thread-1",
            provider: "claudeAgent" as const,
            cwd: PROJECT,
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
          threadId: "child-1",
          provider: "claudeAgent" as const,
          cwd: PROJECT,
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

    const registry = createRegistry([
      ...createSpawnTools({ store: fakeSpawnStore }),
      ...createIrcTools({ mailbox }),
    ]);

    const turnState = new Map<string, { turnId: string; running: boolean }>();
    const inFlight = makeInFlightRequestRegistry();
    const transport = makeMcpTransport({
      credentials,
      registry,
      store,
      turnState,
      serverVersion: "0.1.0",
      instructions: "test",
      inFlight,
    });

    const auth1 = `Bearer ${credentials.issueSessionToken("thread-1", "claudeAgent", "sonnet")}`;
    const auth2 = `Bearer ${credentials.issueSessionToken("thread-2", "claudeAgent", "sonnet")}`;

    return { credentials, store, mailbox, registry, turnState, inFlight, transport, auth1, auth2 };
  }

  test("tools/list returns kone_spawn_batch, kone_irc_send, kone_irc_inbox with valid JSON Schemas", async () => {
    const { transport, auth1 } = newToolsFixture();
    const res = await post(transport, auth1, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);

    // SAFETY: tools/list response body contains JSON-RPC result with tools array.
    const body = res.body as { result?: { tools?: Array<{ name: string; description: string; inputSchema: GatewayRecord }> } };
    const tools = body?.result?.tools ?? [];
    const toolMap = new Map(tools.map((t) => [t.name, t]));

    expect(toolMap.has("kone_spawn_batch")).toBe(true);
    expect(toolMap.has("kone_irc_send")).toBe(true);
    expect(toolMap.has("kone_irc_inbox")).toBe(true);

    expect(toolMap.get("kone_spawn_batch")!.inputSchema).toEqual(SPAWN_BATCH_JSON_SCHEMA);
    expect(toolMap.get("kone_irc_send")!.inputSchema).toEqual(IRC_SEND_JSON_SCHEMA);
    expect(toolMap.get("kone_irc_inbox")!.inputSchema).toEqual(IRC_INBOX_JSON_SCHEMA);

    const batchSchema = toolMap.get("kone_spawn_batch")!.inputSchema;
    expect(batchSchema.type).toBe("object");
    expect(batchSchema.required).toEqual(["items"]);
    // SAFETY: JSON Schema object has properties record.
    expect((batchSchema.properties as GatewayRecord).items).toBeDefined();

    const ircSendSchema = toolMap.get("kone_irc_send")!.inputSchema;
    expect(ircSendSchema.type).toBe("object");
    expect(ircSendSchema.required).toEqual(["to", "message"]);

    const ircInboxSchema = toolMap.get("kone_irc_inbox")!.inputSchema;
    expect(ircInboxSchema.type).toBe("object");
  });

  test("kone_irc_send and kone_irc_inbox execution and active turn security", async () => {
    const { transport, auth1, auth2, turnState } = newToolsFixture();

    // Turnless send fails with capability_denied
    const sendTurnless = await post(transport, auth1, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "kone_irc_send", arguments: { to: "thread-2", message: "Turnless msg" } },
    });
    expect(sendTurnless.status).toBe(200);
    // SAFETY: Turnless call returns JSON-RPC result with error envelope.
    const sendTurnlessBody = sendTurnless.body as { result: { isError: boolean; structuredContent: { error: { code: string } } } };
    expect(sendTurnlessBody.result.isError).toBe(true);
    expect(sendTurnlessBody.result.structuredContent.error.code).toBe("capability_denied");

    // Turnless inbox read succeeds
    const inboxTurnless = await post(transport, auth1, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "kone_irc_inbox", arguments: {} },
    });
    expect(inboxTurnless.status).toBe(200);
    // SAFETY: Turnless inbox returns JSON-RPC result with structured count.
    const inboxTurnlessBody = inboxTurnless.body as { result: { isError?: boolean; structuredContent: { count: number } } };
    expect(inboxTurnlessBody.result.isError).toBeUndefined();
    expect(inboxTurnlessBody.result.structuredContent.count).toBe(0);

    // Validation error on invalid send input
    turnState.set("thread-1", { turnId: "turn-101", running: true });
    const invalidSend = await post(transport, auth1, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "kone_irc_send", arguments: { to: "", message: "" } },
    });
    expect(invalidSend.status).toBe(200);
    // SAFETY: Schema validation failure returns JSON-RPC isError result.
    const invalidSendBody = invalidSend.body as { result: { isError: boolean; structuredContent: { error: { code: string } } } };
    expect(invalidSendBody.result.isError).toBe(true);
    expect(invalidSendBody.result.structuredContent.error.code).toBe("invalid_input");

    // Validation error on invalid inbox input
    const invalidInbox = await post(transport, auth1, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "kone_irc_inbox", arguments: { limit: 0 } },
    });
    expect(invalidInbox.status).toBe(200);
    // SAFETY: Invalid inbox arguments return JSON-RPC isError result.
    const invalidInboxBody = invalidInbox.body as { result: { isError: boolean; structuredContent: { error: { code: string } } } };
    expect(invalidInboxBody.result.isError).toBe(true);
    expect(invalidInboxBody.result.structuredContent.error.code).toBe("invalid_input");

    // Active turn send succeeds
    const sendRes = await post(transport, auth1, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "kone_irc_send", arguments: { to: "thread-2", message: "Hello peer 2" } },
    });
    expect(sendRes.status).toBe(200);
    // SAFETY: Successful IRC send returns delivery receipt payload.
    const sendBody = sendRes.body as {
      result: {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
        structuredContent: {
          messageId: string;
          from: string;
          to: string;
          delivered: boolean;
          recipients: string[];
        };
      };
    };
    expect(sendBody.result.isError).toBeUndefined();
    expect(sendBody.result.structuredContent.from).toBe("thread-1");
    expect(sendBody.result.structuredContent.to).toBe("thread-2");
    expect(sendBody.result.structuredContent.delivered).toBe(true);
    expect(sendBody.result.structuredContent.recipients).toEqual(["thread-2"]);
    const msgId = sendBody.result.structuredContent.messageId;

    // Thread 2 reads inbox with peek: true
    const peekRes = await post(transport, auth2, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "kone_irc_inbox", arguments: { peek: true } },
    });
    expect(peekRes.status).toBe(200);
    // SAFETY: Peek inbox returns message list and unread count.
    const peekBody = peekRes.body as {
      result: {
        structuredContent: {
          count: number;
          unreadRemaining: number;
          messages: Array<{ id: string; from: string; message: string }>;
        };
      };
    };
    expect(peekBody.result.structuredContent.count).toBe(1);
    expect(peekBody.result.structuredContent.unreadRemaining).toBe(1);
    expect(peekBody.result.structuredContent.messages[0]?.id).toBe(msgId);
    expect(peekBody.result.structuredContent.messages[0]?.message).toBe("Hello peer 2");

    // Thread 2 drains inbox
    const drainRes = await post(transport, auth2, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "kone_irc_inbox", arguments: {} },
    });
    // SAFETY: Drain inbox returns consumed message count.
    const drainBody = drainRes.body as {
      result: { structuredContent: { count: number; unreadRemaining: number } };
    };
    expect(drainBody.result.structuredContent.count).toBe(1);
    expect(drainBody.result.structuredContent.unreadRemaining).toBe(0);

    // Subsequent read is empty
    const emptyRes = await post(transport, auth2, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "kone_irc_inbox", arguments: {} },
    });
    // SAFETY: Empty inbox returns 0 counts.
    const emptyBody = emptyRes.body as {
      result: { structuredContent: { count: number; unreadRemaining: number } };
    };
    expect(emptyBody.result.structuredContent.count).toBe(0);
    expect(emptyBody.result.structuredContent.unreadRemaining).toBe(0);

    // Thread 2 replies to Thread 1 referencing msgId
    turnState.set("thread-2", { turnId: "turn-201", running: true });
    const replyRes = await post(transport, auth2, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "kone_irc_send",
        arguments: { to: "thread-1", message: "Acknowledged peer 1", replyTo: msgId },
      },
    });
    expect(replyRes.status).toBe(200);
    // SAFETY: Reply returns structuredContent with replyTo.
    const replyBody = replyRes.body as {
      result: { structuredContent: { replyTo: string } };
    };
    expect(replyBody.result.structuredContent.replyTo).toBe(msgId);

    // Thread 1 receives reply
    const t1InboxRes = await post(transport, auth1, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "kone_irc_inbox", arguments: {} },
    });
    // SAFETY: Inbox retrieval returns message array.
    const t1InboxBody = t1InboxRes.body as {
      result: {
        structuredContent: {
          count: number;
          messages: Array<{ id: string; from: string; message: string; replyTo: string | null }>;
        };
      };
    };
    expect(t1InboxBody.result.structuredContent.count).toBe(1);
    expect(t1InboxBody.result.structuredContent.messages[0]?.from).toBe("thread-2");
    expect(t1InboxBody.result.structuredContent.messages[0]?.replyTo).toBe(msgId);
  });

  test("kone_spawn_batch execution, active turn security, and validation", async () => {
    const { transport, auth1, turnState } = newToolsFixture();

    // Turnless spawn batch fails with capability_denied
    const turnlessRes = await post(transport, auth1, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "kone_spawn_batch",
        arguments: {
          items: [
            {
              requestId: "req-1",
              prompt: "Do task 1",
              target: { provider: "codex" },
            },
          ],
        },
      },
    });
    expect(turnlessRes.status).toBe(200);
    // SAFETY: Turnless spawn batch call returns capability_denied result.
    const turnlessBody = turnlessRes.body as {
      result: { isError: boolean; structuredContent: { error: { code: string } } };
    };
    expect(turnlessBody.result.isError).toBe(true);
    expect(turnlessBody.result.structuredContent.error.code).toBe("capability_denied");

    // Active turn starts
    turnState.set("thread-1", { turnId: "turn-spawn-1", running: true });

    // Empty items array fails schema validation
    const emptyItemsRes = await post(transport, auth1, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "kone_spawn_batch", arguments: { items: [] } },
    });
    expect(emptyItemsRes.status).toBe(200);
    // SAFETY: Empty batch items input returns invalid_input result.
    const emptyItemsBody = emptyItemsRes.body as {
      result: { isError: boolean; structuredContent: { error: { code: string } } };
    };
    expect(emptyItemsBody.result.isError).toBe(true);
    expect(emptyItemsBody.result.structuredContent.error.code).toBe("invalid_input");

    // Missing required item field (prompt) fails validation
    const missingPromptRes = await post(transport, auth1, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "kone_spawn_batch",
        arguments: { items: [{ requestId: "req-1" }] },
      },
    });
    expect(missingPromptRes.status).toBe(200);
    // SAFETY: Missing item prompt returns invalid_input result.
    const missingPromptBody = missingPromptRes.body as {
      result: { isError: boolean; structuredContent: { error: { code: string } } };
    };
    expect(missingPromptBody.result.isError).toBe(true);
    expect(missingPromptBody.result.structuredContent.error.code).toBe("invalid_input");

    // Valid batch spawn executes successfully
    const validBatchRes = await post(transport, auth1, {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: {
        name: "kone_spawn_batch",
        arguments: {
          items: [
            {
              requestId: "req-101",
              prompt: "Implement worker A",
              title: "Worker A",
              target: { provider: "codex", model: "gpt-5" },
            },
            {
              requestId: "req-102",
              prompt: "Implement worker B",
              title: "Worker B",
              target: { provider: "claudeAgent", model: "sonnet" },
            },
          ],
        },
      },
    });
    expect(validBatchRes.status).toBe(200);
    // SAFETY: Successful spawn batch returns summary content and threads array.
    const validBatchBody = validBatchRes.body as {
      result: {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
        structuredContent: {
          batch: {
            total: number;
            succeeded: number;
            failed: number;
            threads: Array<{
              index: number;
              ok: boolean;
              threadId?: string;
              title?: string;
              provider?: string;
              kind?: string;
            }>;
          };
        };
      };
    };
    expect(validBatchBody.result.isError).toBe(false);
    expect(validBatchBody.result.content[0]?.text).toContain("Spawned 2 threads");
    expect(validBatchBody.result.structuredContent.batch.total).toBe(2);
    expect(validBatchBody.result.structuredContent.batch.succeeded).toBe(2);
    expect(validBatchBody.result.structuredContent.batch.failed).toBe(0);
    expect(validBatchBody.result.structuredContent.batch.threads).toHaveLength(2);
    expect(validBatchBody.result.structuredContent.batch.threads[0]?.ok).toBe(true);
    expect(validBatchBody.result.structuredContent.batch.threads[0]?.title).toBe("Worker A");
    expect(validBatchBody.result.structuredContent.batch.threads[1]?.ok).toBe(true);
    expect(validBatchBody.result.structuredContent.batch.threads[1]?.title).toBe("Worker B");
  });

  test("JSON-RPC batch POST with multiple tool calls", async () => {
    const { transport, auth1, turnState } = newToolsFixture();
    turnState.set("thread-1", { turnId: "turn-batch-1", running: true });

    const batchRes = await post(transport, auth1, [
      {
        jsonrpc: "2.0",
        id: 51,
        method: "tools/call",
        params: {
          name: "kone_irc_send",
          arguments: { to: "thread-2", message: "Batch item 1" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 52,
        method: "tools/call",
        params: {
          name: "kone_irc_inbox",
          arguments: { peek: true },
        },
      },
    ]);

    expect(batchRes.status).toBe(200);
    expect(Array.isArray(batchRes.body)).toBe(true);
    // SAFETY: Batch JSON-RPC response is an array of result objects.
    const responses = batchRes.body as Array<{
      jsonrpc: string;
      id: number;
      result: { structuredContent: GatewayRecord };
    }>;
    expect(responses).toHaveLength(2);
    expect(responses[0]?.id).toBe(51);
    expect(responses[0]?.result.structuredContent.delivered).toBe(true);
    expect(responses[1]?.id).toBe(52);
    expect(responses[1]?.result.structuredContent.count).toBe(0);
  });
});
