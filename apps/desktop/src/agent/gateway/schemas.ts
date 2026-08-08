// Shared schemas + types for the agent-facing MCP gateway
// (docs/mcp-gateway-design.md). Plain-TS, Zod for tool input validation.
// When packages/contracts lands (spawn-design Phase 0) these lift into
// packages/contracts/src/gateway.ts — the registry imports schemas, never the
// reverse, so the move is mechanical.

import { z } from "zod";

import type { ProviderKind } from "../types.js";

// ── tool surface ─────────────────────────────────────────────────────────────

export type GatewayPermission = "allow" | "ask" | "deny";

export type GatewayErrorCode =
  | "permission_denied"
  | "capability_denied"
  | "idempotency_conflict"
  | "revision_conflict"
  | "not_found"
  | "invalid_input"
  | "provider_unavailable"
  | "internal";

/** Who wrote a pad: an agent session, when known. `model` is the session's
 *  model id (may be unknown); `provider` is the driving CLI. */
export type ScratchpadWriter = { model?: string; provider: ProviderKind };

/** The pad payload tools return and the scratchpad.updated event carries. */
export type ScratchpadPayload = {
  id: string;
  title: string;
  body: string;
  revision: number;
  savedAt: number;
};

export type GatewayToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export interface GatewayToolContext {
  /** The caller's kone thread id (the session token binds to it). */
  threadId: string;
  /** The running turn this request is bound to, or null when no turn is live
   *  (read tools work turn-less; write tools are refused without one). */
  turnId: string | null;
  provider: ProviderKind;
  /** The caller session's model id, when known — used for write attribution. */
  model?: string;
  /** The caller thread's project path (store.threadProjectPath). */
  cwd: string;
  /** The MCP jsonrpc request id — cancellation mapping. */
  requestId: string | number | null;
}

/** A registered gateway tool. `inputSchema` validates args (zod); the
 *  hand-written `jsonSchema` is what tools/list advertises, so the client
 *  never sees zod. */
export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  jsonSchema: Record<string, unknown>;
  permission: GatewayPermission;
  /** Write tools are only callable while the caller's bound turn is live. */
  requiresActiveTurn: boolean;
  handler(ctx: GatewayToolContext, input: unknown): Promise<GatewayToolResult>;
}

export class GatewayToolError extends Error {
  readonly code: GatewayErrorCode;
  readonly details?: unknown;

  constructor(code: GatewayErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "GatewayToolError";
    this.code = code;
    this.details = details;
  }
}

// ── scratchpad tool inputs ───────────────────────────────────────────────────

export const ScratchpadReadInputSchema = z.object({
  padId: z.string().min(1).optional(),
});

export const ScratchpadWriteInputSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  /** True → server-side atomic append ("\n\n" + body). Default: full replace. */
  append: z.boolean().optional(),
  /** Optimistic lock: when given and stale, the write is refused with a
   *  revision_conflict carrying the current revision. Omit to overwrite. */
  expectedRevision: z.number().int().nonnegative().optional(),
  /** Idempotency key: same (thread, turn, clientRequestId) + same content
   *  replays the stored result instead of re-applying. */
  clientRequestId: z.string().min(1).max(200).optional(),
});

export const SCRATCHPAD_READ_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { padId: { type: "string" } },
};

export const SCRATCHPAD_WRITE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    append: { type: "boolean" },
    expectedRevision: { type: "integer" },
    clientRequestId: { type: "string" },
  },
  required: ["title", "body"],
};
