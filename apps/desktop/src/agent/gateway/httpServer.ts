// Loopback HTTP server for the gateway's MCP endpoint
// (docs/mcp-gateway-design.md §3/§4).
//
// Streamable-HTTP MCP on 127.0.0.1:0 — a dynamic port so the gateway can serve
// every concurrently-open provider session without colliding with other
// loopback listeners. Only POST /mcp answers; GET/DELETE are explicit
// non-endpoints (405) per the spec's allowance for servers with no
// server-initiated stream. Every response is a single application/json body —
// the stateless subset of streamable HTTP the Claude SDK accepts natively.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { JSON_RPC_INVALID_REQUEST, JSON_RPC_PARSE_ERROR, type McpTransport } from "./mcpTransport.js";
import { extractBearerToken } from "./mcpTransport.js";
import type { GatewayCredentials } from "./credentials.js";

export const AGENT_GATEWAY_MCP_PATH = "/mcp";
export const AGENT_GATEWAY_BOOTSTRAP_PATH = "/bootstrap";
const MCP_MAX_BODY_BYTES = 1024 * 1024;

export interface GatewayHttpServer {
  /** Resolves once the server is listening with its dynamic port. */
  readonly ready: Promise<void>;
  /** Stop accepting connections. */
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: JSON_RPC_INVALID_REQUEST,
      message:
        "caller_session_inactive: Missing, revoked, or invalid provider-session credential.",
    },
  });
}

export function startGatewayHttpServer(input: {
  credentials: GatewayCredentials;
  transport: McpTransport;
}): GatewayHttpServer {
  const server: Server = createServer((req, res) => {
    void handleRequest(input.credentials, input.transport, req, res);
  });

  const ready = new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      input.credentials.setListeningPort(port);
      resolve();
    });
  });

  return {
    ready,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(
  credentials: GatewayCredentials,
  transport: McpTransport,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === AGENT_GATEWAY_BOOTSTRAP_PATH) {
      // proxy spawned by a provider whose plugin config must be secret-free on
      // disk (Antigravity) redeems its env-carried single-use token here for the
      // real session bearer. The session token itself never enters the provider
      // process env, and the bootstrap dies after one exchange.
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      const bootstrap = extractBearerToken(req.headers.authorization);
      const sessionToken =
        bootstrap === null ? null : credentials.exchangeStdioBootstrapToken(bootstrap);
      if (sessionToken === null) {
        unauthorized(res);
        return;
      }
      sendJson(res, 200, { bearerToken: sessionToken });
      return;
    }

    if (url.pathname !== AGENT_GATEWAY_MCP_PATH) {
      sendJson(res, 404, {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSON_RPC_INVALID_REQUEST, message: "Not found." },
      });
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      // Stateless JSON-only server: no server-initiated stream (GET), and no
      // session to tear down (DELETE).
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }

    const token = extractBearerToken(req.headers.authorization);
    if (!token || credentials.verifySessionToken(token) === null) {
      unauthorized(res);
      return;
    }

    const body = await readBody(req);
    if (body.kind === "too-large") {
      sendJson(res, 413, {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSON_RPC_INVALID_REQUEST, message: "Request body exceeds the 1 MiB limit." },
      });
      return;
    }
    if (body.kind === "invalid") {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSON_RPC_PARSE_ERROR, message: "Invalid JSON body." },
      });
      return;
    }

    const result = await transport.handlePost({
      authorizationHeader: req.headers.authorization,
      body: body.body,
    });
    if (result.body === undefined) {
      res.writeHead(result.status);
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
  } catch (err) {
    console.error("!!! GATEWAY ERROR !!!", err);
    res.writeHead(500);
    res.end("Internal Server Error");
  }
}

async function readBody(
  req: IncomingMessage,
): Promise<{ kind: "ok"; body: unknown } | { kind: "invalid" } | { kind: "too-large" }> {
  const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > MCP_MAX_BODY_BYTES) {
    return { kind: "too-large" };
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MCP_MAX_BODY_BYTES) {
        req.destroy();
        resolve({ kind: "too-large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve({
          kind: "ok",
          body: JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown,
        });
      } catch {
        resolve({ kind: "invalid" });
      }
    });
    req.on("error", () => resolve({ kind: "invalid" }));
  });
}
