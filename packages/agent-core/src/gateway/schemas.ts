// Shared schemas + types for the agent-facing MCP gateway
// (docs/mcp-gateway-design.md). Plain-TS, Zod for tool input validation.
// When packages/contracts lands (spawn-design Phase 0) these lift into
// packages/contracts/src/gateway.ts — the registry imports schemas, never the
// reverse, so the move is mechanical.

import { z } from "zod";

import type { ProviderKind } from "../types.js";

/** One decoded gateway payload — validated tool arguments, structured tool
 *  results, and error detail are all plain JSON data, so consumers branch on
 *  these variants instead of interrogating a representation. Arrays are
 *  readonly because decoded payloads are treated as immutable data; records
 *  stay writable so handlers can assemble results field by field. */
export type GatewayValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayValue[]
  | { [key: string]: GatewayValue };

export type GatewayRecord = { [key: string]: GatewayValue };

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
  structuredContent?: GatewayRecord;
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
  /** Present on in-flight MCP calls so a later cancel can abort the handler. */
  signal?: AbortSignal;
}

/** A registered gateway tool. `inputSchema` validates args (zod); the
 *  hand-written `jsonSchema` is what tools/list advertises, so the client
 *  never sees zod. */
export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  jsonSchema: GatewayRecord;
  permission: GatewayPermission;
  /** Write tools are only callable while the caller's bound turn is live. */
  requiresActiveTurn: boolean;
  handler(ctx: GatewayToolContext, input: GatewayRecord): Promise<GatewayToolResult>;
}

export class GatewayToolError extends Error {
  readonly code: GatewayErrorCode;
  readonly details?: GatewayValue;

  constructor(code: GatewayErrorCode, message: string, details?: GatewayValue) {
    super(message);
    this.name = "GatewayToolError";
    this.code = code;
    this.details = details;
  }
}

// ── scratchpad tool inputs ───────────────────────────────────────────────────

export const ScratchpadReadInputSchema = z.object({
  scratchpadId: z.string().min(1).optional(),
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

export const SCRATCHPAD_READ_JSON_SCHEMA = {
  type: "object",
  properties: { scratchpadId: { type: "string" } },
} satisfies GatewayRecord;

export const SCRATCHPAD_WRITE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    append: { type: "boolean" },
    expectedRevision: { type: "integer" },
    clientRequestId: { type: "string" },
  },
  required: ["title", "body"],
} satisfies GatewayRecord;

// ── spawn tool inputs (docs/thread-spawning-design.md) ───────────────────────
// Schemas for the four thread-spawning tools. The zod `inputSchema` validates
// args; the hand-written JSON schemas are what tools/list advertises, so the
// enum literals are repeated there — the client never sees zod.

/** The six provider kinds as a literal tuple — ProviderKind is a plain union,
 *  and zod needs a runtime value for its enum. */
const PROVIDER_KINDS = ["codex", "claudeAgent", "opencode", "cursor", "droid", "antigravity"] as const;

/** The three interaction modes, same deal. */
const INTERACTION_MODES = ["ask", "accept-edits", "full-access"] as const;

export const SpawnTargetsInputSchema = z.object({});

export const SpawnThreadInputSchema = z.object({
  /** The child's first turn — the brief it wakes up to. */
  prompt: z.string().min(1),
  /** Agent-supplied idempotency key scoped to (caller thread, caller turn). */
  requestId: z.string().min(1).max(200),
  /** Overrides the prompt-derived working title. */
  title: z.string().min(1).optional(),
  target: z.object({
    provider: z.enum(PROVIDER_KINDS),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  }),
  /** Clamped to the caller's mode — privilege never escalates across a spawn. */
  mode: z.enum(INTERACTION_MODES).optional(),
});

export const SpawnFromPresetInputSchema = z.object({
  /** The preset sub-agent to cut this spawn from — its name or its id. */
  preset: z.string().min(1).max(200),
  /** The specific work for this spawn, laid under the preset's standing
   *  instructions to form the child's opening brief. */
  task: z.string().min(1),
  /** Agent-supplied idempotency key scoped to (caller thread, caller turn). */
  requestId: z.string().min(1).max(200),
  /** Overrides the task-derived working title. */
  title: z.string().min(1).optional(),
  /** Clamped to the caller's mode — privilege never escalates across a spawn. */
  mode: z.enum(INTERACTION_MODES).optional(),
});

export const DelegateInputSchema = z.object({
  /** The project-team agent to hand this work to — its name or its id. */
  agent: z.string().min(1).max(200),
  /** The specific work being delegated — the child's opening brief. The agent's
   *  own standing instructions reach it separately (it runs as that agent), so
   *  this is just the ask, not a re-statement of who it is. */
  task: z.string().min(1),
  /** Agent-supplied idempotency key scoped to (caller thread, caller turn). */
  requestId: z.string().min(1).max(200),
  /** Overrides the task-derived working title. */
  title: z.string().min(1).optional(),
  /** Clamped to the caller's mode — privilege never escalates across a spawn. */
  mode: z.enum(INTERACTION_MODES).optional(),
});
export const SpawnBatchItemSchema = z.object({
  /** Agent-supplied idempotency key scoped to (caller thread, caller turn, item index). */
  requestId: z.string().min(1).max(200),
  /** The task prompt or opening brief. */
  prompt: z.string().min(1),
  /** Optional working title. */
  title: z.string().min(1).optional(),
  /** Direct target provider and model. */
  target: z
    .object({
      provider: z.enum(PROVIDER_KINDS),
      model: z.string().min(1).optional(),
      effort: z.string().min(1).optional(),
    })
    .optional(),
  /** Preset sub-agent name or id. */
  preset: z.string().min(1).max(200).optional(),
  /** Project teammate name or id. */
  agent: z.string().min(1).max(200).optional(),
  /** Clamped to caller mode. */
  mode: z.enum(INTERACTION_MODES).optional(),
});

export const SpawnBatchInputSchema = z.object({
  /** Batch of tasks to spawn concurrently (up to 16). */
  items: z.array(SpawnBatchItemSchema).min(1).max(16),
});

export const WaitForThreadsInputSchema = z.object({
  threadIds: z.array(z.string().min(1)).min(1).max(12),
  /** Positionally paired with `threadIds`: the exact turn of that child to wait
   *  on, so a human typing into the child mid-wait can't hand the parent a
   *  different turn's outcome. Omit to wait on the child's latest turn. */
  turnIds: z.array(z.string().min(1)).max(12).optional(),
  /** Engine default when omitted; the engine clamps to its own max. */
  timeoutMs: z.number().int().nonnegative().optional(),
});

export const ReadThreadInputSchema = z.object({
  threadId: z.string().min(1),
  /** Blocks to return, newest last. Default 20. */
  limit: z.number().int().min(1).max(100).optional(),
  /** Per-message text cap; truncated with a visible marker. Default 1500. */
  maxTextChars: z.number().int().min(200).optional(),
});

export const SPAWN_TARGETS_JSON_SCHEMA = {
  type: "object",
  properties: {},
} satisfies GatewayRecord;

export const SPAWN_THREAD_JSON_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    requestId: { type: "string" },
    title: { type: "string" },
    target: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...PROVIDER_KINDS] },
        model: { type: "string" },
        effort: { type: "string" },
      },
      required: ["provider"],
    },
    mode: { type: "string", enum: [...INTERACTION_MODES] },
  },
  required: ["prompt", "requestId", "target"],
} satisfies GatewayRecord;

export const SPAWN_FROM_PRESET_JSON_SCHEMA = {
  type: "object",
  properties: {
    preset: {
      type: "string",
      description:
        "The preset sub-agent to spawn, by name (e.g. \"Explorer\") or id. Call kone_spawn_targets for the presets that actually exist and what each is for; a name that matches none is refused rather than guessed at.",
    },
    task: { type: "string" },
    requestId: { type: "string" },
    title: { type: "string" },
    mode: { type: "string", enum: [...INTERACTION_MODES] },
  },
  required: ["preset", "task", "requestId"],
} satisfies GatewayRecord;

export const DELEGATE_JSON_SCHEMA = {
  type: "object",
  properties: {
    agent: {
      type: "string",
      description:
        "The teammate to hand the work to, by name or id. It must be on THIS project's team — call kone_spawn_targets for who is, and their roles; a name that is not on the team is refused exactly like a nonexistent one.",
    },
    task: { type: "string" },
    requestId: { type: "string" },
    title: { type: "string" },
    mode: { type: "string", enum: [...INTERACTION_MODES] },
  },
  required: ["agent", "task", "requestId"],
} satisfies GatewayRecord;

export const WAIT_FOR_THREADS_JSON_SCHEMA = {
  type: "object",
  properties: {
    threadIds: { type: "array", items: { type: "string" } },
    turnIds: { type: "array", items: { type: "string" } },
    timeoutMs: { type: "integer" },
  },
  required: ["threadIds"],
} satisfies GatewayRecord;

export const READ_THREAD_JSON_SCHEMA = {
  type: "object",
  properties: {
    threadId: { type: "string" },
    limit: { type: "integer" },
    maxTextChars: { type: "integer" },
  },
  required: ["threadId"],
} satisfies GatewayRecord;
export const SPAWN_BATCH_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          prompt: { type: "string" },
          title: { type: "string" },
          target: {
            type: "object",
            properties: {
              provider: { type: "string", enum: [...PROVIDER_KINDS] },
              model: { type: "string" },
              effort: { type: "string" },
            },
            required: ["provider"],
          },
          preset: { type: "string" },
          agent: { type: "string" },
          mode: { type: "string", enum: [...INTERACTION_MODES] },
        },
        required: ["requestId", "prompt"],
      },
    },
  },
  required: ["items"],
} satisfies GatewayRecord;

// ── irc inter-agent communication tools ──────────────────────────────────────

export const IrcSendInputSchema = z.object({
  to: z.string().min(1, "Recipient is required"),
  message: z.string().min(1, "Message cannot be empty"),
  replyTo: z.string().min(1).optional(),
});

export const IrcSendMessageInputSchema = IrcSendInputSchema;
export const IrcMessageInputSchema = IrcSendInputSchema;

export const IrcInboxInputSchema = z.object({
  peek: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});

export const IRC_SEND_JSON_SCHEMA = {
  type: "object",
  properties: {
    to: {
      type: "string",
      description: "Recipient thread ID, agent name, 'parent', or 'all' to broadcast.",
    },
    message: {
      type: "string",
      description: "Text content of the direct message to send.",
    },
    replyTo: {
      type: "string",
      description: "Optional message ID being replied to.",
    },
  },
  required: ["to", "message"],
} satisfies GatewayRecord;

export const IRC_SEND_MESSAGE_JSON_SCHEMA = IRC_SEND_JSON_SCHEMA;
export const IRC_MESSAGE_JSON_SCHEMA = IRC_SEND_JSON_SCHEMA;

export const IRC_INBOX_JSON_SCHEMA = {
  type: "object",
  properties: {
    peek: {
      type: "boolean",
      description: "If true, reads messages without consuming/clearing them from the inbox.",
    },
    limit: {
      type: "integer",
      description: "Maximum number of messages to retrieve.",
    },
  },
} satisfies GatewayRecord;

export type IrcSendInput = z.infer<typeof IrcSendInputSchema>;
export type IrcSendMessageInput = IrcSendInput;
export type IrcMessageInput = IrcSendInput;
export type IrcInboxInput = z.infer<typeof IrcInboxInputSchema>;

export type IrcMessagePayload = {
  id: string;
  from: string;
  to: string;
  message: string;
  replyTo?: string;
  createdAt: number;
};
