// stdio→HTTP MCP proxy behavior (docs/mcp-gateway-design.md §4).
//
// The real script (stdioProxy.mjs) is spawned under the test runtime with
// KONE_GATEWAY_URL / KONE_GATEWAY_TOKEN pointing at a local mock HTTP gateway;
// JSON-RPC is driven over NDJSON stdin/stdout exactly as cursor-agent / droid

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { createServer, type Server, type ServerResponse } from "node:http";

import { STDIO_PROXY_PATH } from "./injection.js";

type MockRequestParams = { protocolVersion?: number; requestId?: number };
type MockRequest = { jsonrpc: string; id?: unknown; method: string; params?: MockRequestParams };

let gateway: Server;
let baseUrl = "";
let requests: MockRequest[] = [];
let auths: string[] = [];
let slowAborted = false;

function jsonResult(res: ServerResponse, msg: MockRequest): void {
  if (msg.method === "initialize") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? 1,
          capabilities: { tools: {} },
          serverInfo: { name: "mock-gateway", version: "0.0.1" },
        },
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result: { ok: true, method: msg.method } }));
}

beforeAll(async () => {
  gateway = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let msg: MockRequest;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "bad" } }));
        return;
      }
      requests.push(msg);
      auths.push(req.headers.authorization ?? "");
      if (msg.method === "slow") {
        // Hold the request open; a cancellation should abort this connection.
        req.on("close", () => {
          if (!res.writableEnded) slowAborted = true;
        });
        setTimeout(() => {
          if (!res.writableEnded) jsonResult(res, msg);
        }, 500);
        return;
      }
      if (msg.method === "reject") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "caller_session_inactive: bad token." },
          }),
        );
        return;
      }
      jsonResult(res, msg);
    });
  });
  await new Promise<void>((resolve) => {
    gateway.listen(0, "127.0.0.1", () => {
      const address = gateway.address();
      baseUrl = `http://127.0.0.1:${address && "port" in address ? address.port : 0}/mcp`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
});

type ProxyRun = { child: ChildProcess; lines: Interface };

function spawnProxy(env: Record<string, string>): ProxyRun {
  const child = spawn(process.execPath, [STDIO_PROXY_PATH], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, lines: createInterface({ input: child.stdout }) };
}

function nextLine(run: ProxyRun, timeoutMs = 2_000): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    run.lines.once("line", (line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
}

function send(run: ProxyRun, message: MockRequest | MockRequest[]): void {
  run.child.stdin!.write(`${JSON.stringify(message)}\n`);
}

function stop(run: ProxyRun): void {
  run.lines.close();
  run.child.kill();
}

describe("stdio proxy", () => {
  beforeEach(() => {
    requests = [];
    auths = [];
    slowAborted = false;
  });

  test("forwards requests to the gateway with the bearer token and echoes the result", async () => {
    const run = spawnProxy({ KONE_GATEWAY_URL: baseUrl, KONE_GATEWAY_TOKEN: "token-abc" });
    try {
      send(run, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
      const line = await nextLine(run);
      expect(JSON.parse(line!)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: 1, capabilities: { tools: {} }, serverInfo: { name: "mock-gateway", version: "0.0.1" } },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe("initialize");
      expect(auths[0]).toBe("Bearer token-abc");
    } finally {
      stop(run);
    }
  });

  test("round-trips ping", async () => {
    const run = spawnProxy({ KONE_GATEWAY_URL: baseUrl, KONE_GATEWAY_TOKEN: "token-abc" });
    try {
      send(run, { jsonrpc: "2.0", id: 2, method: "ping" });
      const line = await nextLine(run);
      expect(JSON.parse(line!)).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true, method: "ping" } });
    } finally {
      stop(run);
    }
  });

  test("a batch is forwarded per message and answered as one array line", async () => {
    const run = spawnProxy({ KONE_GATEWAY_URL: baseUrl, KONE_GATEWAY_TOKEN: "token-abc" });
    try {
      send(run, [
        { jsonrpc: "2.0", id: 10, method: "ping" },
        { jsonrpc: "2.0", id: 11, method: "tools/list" },
      ]);
      const line = await nextLine(run);
      const parsed = JSON.parse(line!);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.map((r) => r.id)).toEqual([10, 11]);
      expect(requests).toHaveLength(2);
    } finally {
      stop(run);
    }
  });

  test("a notification is forwarded and produces no response line", async () => {
    const run = spawnProxy({ KONE_GATEWAY_URL: baseUrl, KONE_GATEWAY_TOKEN: "token-abc" });
    try {
      send(run, { jsonrpc: "2.0", method: "notifications/initialized" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(requests.map((r) => r.method)).toContain("notifications/initialized");
      expect(await nextLine(run, 200)).toBeNull();
    } finally {
      stop(run);
    }
  });

  test("a gateway 401 (revoked token) is passed through as the error body", async () => {
    const run = spawnProxy({ KONE_GATEWAY_URL: baseUrl, KONE_GATEWAY_TOKEN: "stale-token" });
    try {
      send(run, { jsonrpc: "2.0", id: 5, method: "reject" });
      const line = await nextLine(run);
      expect(JSON.parse(line!)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "caller_session_inactive: bad token." },
      });
    } finally {
      stop(run);
    }
  });

  test("a parse error answers -32700 without touching the gateway", async () => {
    const run = spawnProxy({ KONE_GATEWAY_URL: baseUrl, KONE_GATEWAY_TOKEN: "token-abc" });
    try {
      run.child.stdin!.write("not-json\n");
      const line = await nextLine(run);
      expect(JSON.parse(line!)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      expect(requests).toHaveLength(0);
    } finally {
      stop(run);
    }
  });

  test("notifications/cancelled aborts the in-flight gateway request", async () => {
    const run = spawnProxy({ KONE_GATEWAY_URL: baseUrl, KONE_GATEWAY_TOKEN: "token-abc" });
    try {
      send(run, { jsonrpc: "2.0", id: 42, method: "slow" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      send(run, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 42 } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(slowAborted).toBe(true);
      // The cancelled request must produce no response line.
      expect(await nextLine(run, 300)).toBeNull();
    } finally {
      stop(run);
    }
  });

  test("without credentials it answers as a valid empty MCP server", async () => {
    const run = spawnProxy({});
    try {
      send(run, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
      const initLine = await nextLine(run);
      expect(JSON.parse(initLine!)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          capabilities: { tools: {} },
          serverInfo: { name: "kone", version: "0.1.0" },
        },
      });
      send(run, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const listLine = await nextLine(run);
      expect(JSON.parse(listLine!)).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
      send(run, { jsonrpc: "2.0", id: 3, method: "tools/call", params: {} });
      const callLine = await nextLine(run);
      expect(JSON.parse(callLine!)?.error?.code).toBe(-32601);
      expect(requests).toHaveLength(0);
    } finally {
      stop(run);
    }
  });
});
