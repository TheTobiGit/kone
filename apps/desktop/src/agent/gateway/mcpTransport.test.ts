import { describe, expect, test } from "bun:test";

import { GatewayCredentials } from "./credentials.js";
import { createRegistry, gatewayToolErrorResult } from "./registry.js";
import { GatewayToolError } from "./schemas.js";
import {
  extractBearerToken,
  makeMcpTransport,
  negotiateMcpProtocolVersion,
  parseMcpMessage,
  type GatewayTransportStore,
} from "./mcpTransport.js";
import { z } from "zod";

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

function post(transport: ReturnType<typeof fixture>["transport"], auth: string | undefined, body: unknown) {
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
    const names = (res.body as any).result.tools.map((t: any) => t.name);
    expect(names).toEqual(["echo", "write_only"]);
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
    const ids = (res.body as any[]).map((r) => r.id);
    expect(ids).toEqual([43]);
  });

  test("batch returns an array response; single returns a single response", async () => {
    const { transport, auth } = authed();
    const batch = await post(transport, auth, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect(Array.isArray(batch.body)).toBe(true);
    expect((batch.body as any[]).map((r) => r.id)).toEqual([1, 2]);
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
    expect((res.body as any[]).length).toBe(2);
    expect((res.body as any[])[1].error.code).toBe(-32600);
  });
});
