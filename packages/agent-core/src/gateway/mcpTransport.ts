// Minimal MCP (Model Context Protocol) JSON-RPC handling for the kone gateway.
//
// Implements the stateless subset of the MCP streamable-HTTP transport the
// gateway needs — `initialize`, `ping`, `tools/list`, `tools/call`, plus the
// batching and cancellation mechanics around them.
// Every POST gets a single application/json response (the spec allows servers
// to answer with JSON instead of an SSE stream), so no session or stream state
// is kept server-side. GET/DELETE are explicit non-endpoints (405) at the HTTP
// layer.
//
// Pure request/response shaping lives here so it can be unit tested without
// the HTTP layer.

import type { ConversationStore } from "../ConversationStore.js";
import { isAssistantProjectPath, workingDirFor } from "../assistantWorkspace.js";
import type { ProviderKind } from "../types.js";
import type { GatewayCredentials } from "./credentials.js";
import type { InFlightRequestRegistry } from "./inFlightRequests.js";
import { makeInFlightRequestRegistry } from "./inFlightRequests.js";
import type { GatewayRegistry } from "./registry.js";
import type { GatewayRecord, GatewayValue } from "./schemas.js";

/** The store surface the transport needs — structural, so unit tests can
 *  substitute a stub; the real ConversationStore satisfies it. */
export type GatewayTransportStore = Pick<ConversationStore, "threadProjectPath">;

export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MCP_SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

const MCP_MAX_BATCH_MESSAGES = 50;

export type JsonRpcId = string | number | null;

/** Decoded JSON numbers are always finite, so finiteness separates the number
 *  variant from every other JSON variant without inspecting representations. */
function isJsonNumber(value: GatewayValue | undefined): value is number {
  return Number.isFinite(value);
}

/** Text is the one JSON variant left after every other variant is excluded by
 *  value — booleans by identity, numbers by finiteness, composites by their
 *  constructors. */
function jsonText(value: GatewayValue | undefined): string | null {
  if (value === undefined || value === null || value === true || value === false) return null;
  if (Array.isArray(value) || value instanceof Object || isJsonNumber(value)) return null;
  return value;
}

/** A JSON scalar fit for a JSON-RPC id or cancellation key: text or number. */
function jsonScalar(value: GatewayValue | undefined): string | number | null {
  if (value === undefined || value === null || value === true || value === false) return null;
  if (Array.isArray(value) || value instanceof Object) return null;
  return value;
}

function isGatewayRecord(value: GatewayValue | undefined): value is GatewayRecord {
  return value instanceof Object && !Array.isArray(value);
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params: GatewayRecord;
}

export interface JsonRpcNotification {
  method: string;
  params: GatewayRecord;
}

export type ParsedMcpMessage =
  | { kind: "request"; request: JsonRpcRequest }
  | { kind: "notification"; notification: JsonRpcNotification }
  | { kind: "response" }
  | { kind: "invalid"; id: JsonRpcId };

export function jsonRpcResult(id: JsonRpcId, result: GatewayRecord): GatewayRecord {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
): GatewayRecord {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Classify one raw JSON-RPC message. Responses and notifications require no
 *  reply body; invalid entries produce an error response bound to whatever id
 *  could be recovered. */
export function parseMcpMessage(raw: GatewayValue): ParsedMcpMessage {
  if (!isGatewayRecord(raw)) {
    return { kind: "invalid", id: null };
  }
  const rawId = raw.id;
  const id = jsonScalar(rawId);
  if (raw.jsonrpc !== "2.0") return { kind: "invalid", id };
  const method = jsonText(raw.method);
  if (method === null || method.length === 0) {
    // No method: either a client→server response (has result/error) or garbage.
    if ("result" in raw || "error" in raw) return { kind: "response" };
    return { kind: "invalid", id };
  }
  if (rawId != null && jsonScalar(rawId) === null) {
    return { kind: "invalid", id: null };
  }
  const params = isGatewayRecord(raw.params) ? raw.params : {};
  if (rawId === undefined) {
    return { kind: "notification", notification: { method, params } };
  }
  return { kind: "request", request: { jsonrpc: "2.0", id, method, params } };
}

export function negotiateMcpProtocolVersion(requested: GatewayValue | undefined): string {
  const requestedVersion = jsonText(requested);
  if (requestedVersion !== null && MCP_SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)) {
    return requestedVersion;
  }
  return MCP_DEFAULT_PROTOCOL_VERSION;
}

export function buildMcpInitializeResult(input: {
  requestedProtocolVersion: GatewayValue | undefined;
  serverVersion: string;
  instructions: string;
}): GatewayRecord {
  return {
    protocolVersion: negotiateMcpProtocolVersion(input.requestedProtocolVersion),
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: "kone",
      title: "Kone App Control",
      version: input.serverVersion,
    },
    instructions: input.instructions,
  };
}

/** Parse an HTTP bearer credential without interpreting its opaque value. */
export function extractBearerToken(
  authorizationHeader: string | undefined | null,
): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match?.[1]?.trim() || null;
}

export type GatewayMcpResponse = {
  status: number;
  body?: GatewayRecord | GatewayRecord[];
};

export interface McpTransportInput {
  credentials: GatewayCredentials;
  registry: GatewayRegistry;
  store: GatewayTransportStore;
  /** threadId → live turn state, maintained by the gateway's event listener. */
  turnState: ReadonlyMap<string, { turnId: string; running: boolean }>;
  serverVersion: string;
  instructions: string;
  /** Cross-POST cancellation ownership for in-flight calls; a per-transport
   *  registry is used when the gateway does not inject its own. */
  inFlight?: InFlightRequestRegistry;
}

export interface McpTransport {
  /** Handle one POSTed JSON-RPC message or batch. Never throws. */
  handlePost(input: {
    authorizationHeader: string | undefined;
    body: GatewayValue;
  }): Promise<GatewayMcpResponse>;
}

export function makeMcpTransport(input: McpTransportInput): McpTransport {
  const inFlight = input.inFlight ?? makeInFlightRequestRegistry();

  async function handleRequest(
    request: JsonRpcRequest,
    ctx: {
      threadId: string;
      provider: ProviderKind;
      model?: string;
      cwd: string;
      turnId: string | null;
      signal?: AbortSignal;
      isAssistant?: boolean;
    },
  ): Promise<GatewayRecord> {
    switch (request.method) {
      case "initialize":
        return jsonRpcResult(
          request.id,
          buildMcpInitializeResult({
            requestedProtocolVersion: request.params.protocolVersion,
            serverVersion: input.serverVersion,
            instructions: input.instructions,
          }),
        );
      case "ping":
        return jsonRpcResult(request.id, {});
      case "tools/list": {
        const scope = ctx.isAssistant ? "assistant" : "worker";
        // SAFETY: a tool's input schema is plain JSON by construction — the
        // registry types it as a record of unknown values only because tool
        // declarations arrive from many modules; here it crosses into the
        // JSON-RPC envelope that is serialized verbatim, where the concrete
        // gateway value type applies.
        const tools = input.registry.listTools(scope) as ReadonlyArray<{
          name: string;
          description: string;
          inputSchema: GatewayRecord;
        }>;
        return jsonRpcResult(request.id, { tools });
      }
      case "tools/call": {
        const name = jsonText(request.params.name);
        if (name === null) {
          return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, "Missing tool name.");
        }
        const toolCtx = {
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          provider: ctx.provider,
          model: ctx.model,
          cwd: ctx.cwd,
          requestId: request.id,
          signal: ctx.signal,
        };
        const scope = ctx.isAssistant ? "assistant" : "worker";
        const result = await input.registry.call(toolCtx, name, request.params.arguments, scope);
        return jsonRpcResult(request.id, result);
      }
      default:
        return jsonRpcError(
          request.id,
          JSON_RPC_METHOD_NOT_FOUND,
          `Method "${request.method}" is not supported.`,
        );
    }
  }

  return {
    async handlePost({ authorizationHeader, body }): Promise<GatewayMcpResponse> {
      const token = extractBearerToken(authorizationHeader);
      const identity = token ? input.credentials.verifySessionToken(token) : null;
      if (!token || !identity) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "caller_session_inactive: Missing, revoked, or invalid provider-session credential.",
          ),
        };
      }
      const { threadId, provider, model } = identity;
      const projectPath = input.store.threadProjectPath(threadId);
      if (!projectPath) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "Bearer token refers to a thread that no longer exists.",
          ),
        };
      }
      // The assistant's project path is a sentinel, not a place, so the cwd a
      // tool call runs against is resolved the same way a session's own spawn
      // resolves it — one answer for both, or a tool and the CLI it belongs to
      // would disagree about where the thread is.
      const isAssistant = isAssistantProjectPath(projectPath);
      const cwd = workingDirFor(projectPath);

      // The security boundary: a write tool's authority is the exact turn
      // running when the request arrives. Bind at ingress — the first bind
      // sticks, so a request racing a turn boundary can never inherit the
      // next turn's authority.
      const live = input.turnState.get(threadId);
      let turnId: string | null = null;
      if (live?.running && input.credentials.bindWriteAuthority(token, live.turnId)) {
        turnId = live.turnId;
      }

      const rawMessages: readonly GatewayValue[] = Array.isArray(body) ? body : [body];
      if (rawMessages.length === 0) {
        return { status: 400, body: jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Empty JSON-RPC batch.") };
      }
      if (rawMessages.length > MCP_MAX_BATCH_MESSAGES) {
        return {
          status: 400,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            `JSON-RPC batches may contain at most ${MCP_MAX_BATCH_MESSAGES} messages.`,
          ),
        };
      }

      const parsed = rawMessages.map(parseMcpMessage);
      // First pass: collect cancellation notifications so a request cancelled
      // by an earlier slot in the same batch never starts at all.
      const cancelledIds = new Set<string | number>();
      for (const message of parsed) {
        if (
          message.kind === "notification" &&
          message.notification.method === "notifications/cancelled"
        ) {
          const requestId = jsonScalar(message.notification.params.requestId);
          if (requestId !== null) cancelledIds.add(requestId);
        }
      }

      const responses: Array<GatewayRecord | null> = [];
      for (const message of parsed) {
        switch (message.kind) {
          case "request": {
            if (message.request.id !== null && cancelledIds.has(message.request.id)) {
              responses.push(null);
              break;
            }
            const controller = new AbortController();
            const unregister = inFlight.register({
              sessionKey: threadId,
              turnId,
              requestId: message.request.id,
              cancel: async () => {
                controller.abort();
              },
            });
            let response: GatewayRecord | null;
            try {
              const result = await handleRequest(
                message.request,
                { threadId, provider, model, cwd, turnId, signal: controller.signal, isAssistant },
              );
              response = controller.signal.aborted ? null : result;
            } catch {
              if (controller.signal.aborted) {
                response = null;
              } else {
                console.error("[gateway] request handler failed:", message.request.method);
                response = jsonRpcError(
                  message.request.id,
                  JSON_RPC_INTERNAL_ERROR,
                  "Internal error.",
                );
              }
            } finally {
              unregister();
            }
            responses.push(response);
            break;
          }
          case "notification": {
            if (message.notification.method === "notifications/cancelled") {
              const requestId = jsonScalar(message.notification.params.requestId);
              if (requestId !== null) {
                inFlight.cancel({ sessionKey: threadId, requestId });
              }
            }
            responses.push(null);
            break;
          }
          case "response":
            responses.push(null);
            break;
          case "invalid":
            responses.push(
              jsonRpcError(message.id, JSON_RPC_INVALID_REQUEST, "Invalid JSON-RPC message."),
            );
            break;
        }
      }

      const settled = responses.filter(
        (response): response is GatewayRecord => response !== null,
      );
      if (settled.length === 0) return { status: 202 };
      return { status: 200, body: Array.isArray(body) ? settled : settled[0] };
    },
  };
}
