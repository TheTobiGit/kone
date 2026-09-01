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
  /**
   * One line naming what this tool is for, in the host-context block the agent
   * reads before its first turn. A tool without one is not announced there —
   * which is how a tool the session did not get can never be promised to it.
   *
   * Deliberately short: `description` above is the full account, and MCP
   * delivers it through tools/list to the same model. Repeating it here would
   * buy nothing and cost the tokens twice.
   */
  promptSnippet?: string;
  /**
   * Standing rules this tool imposes that its own description cannot carry —
   * how it sits against the others, what the agent owes the user for using it.
   * Only ship a rule here when it would still need saying with the tool's
   * description already in front of the model.
   */
  promptGuidelines?: readonly string[];
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

// ── worker/teammate dispatch tool inputs (docs/thread-spawning-design.md) ────
// Schemas for the worker- and teammate-dispatching tools. The zod `inputSchema`
// validates args; the hand-written JSON schemas are what tools/list advertises,
// so the enum literals are repeated there — the client never sees zod.

/** The six provider kinds as a literal tuple — ProviderKind is a plain union,
 *  and zod needs a runtime value for its enum. */
const PROVIDER_KINDS = ["codex", "claudeAgent", "opencode", "cursor", "droid", "antigravity"] as const;

/** The three interaction modes, same deal. */
const INTERACTION_MODES = ["ask", "accept-edits", "full-access"] as const;

export const SpawnTargetsInputSchema = z.object({});

export const SpawnWorkerInputSchema = z.object({
  /** The child's first turn — the brief it wakes up to. */
  prompt: z.string().min(1),
  /** Agent-supplied idempotency key scoped to (caller thread, caller turn). */
  requestId: z.string().min(1).max(200),
  /** Overrides the prompt-derived working title. */
  title: z.string().min(1).optional(),
  /** Where to run. Omitted, the worker inherits this thread's provider and
   *  model — a custom spawn with no model of its own. */
  target: z
    .object({
      provider: z.enum(PROVIDER_KINDS),
      model: z.string().min(1).optional(),
      effort: z.string().min(1).optional(),
    })
    .optional(),
  /** Clamped to the caller's mode — privilege never escalates across a spawn. */
  mode: z.enum(INTERACTION_MODES).optional(),
});

export const SpawnWorkerPresetInputSchema = z.object({
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
  /** A model named for this spawn only — the user asking for this piece of
   *  work to run somewhere specific. Beats the preset's own chain. */
  model: z
    .object({
      provider: z.enum(PROVIDER_KINDS),
      model: z.string().min(1),
      label: z.string().min(1).optional(),
    })
    .optional(),
});

export const DelegateToTeammateInputSchema = z.object({
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
  /** A model named for this delegation only — beats the teammate's own chain. */
  model: z
    .object({
      provider: z.enum(PROVIDER_KINDS),
      model: z.string().min(1),
      label: z.string().min(1).optional(),
    })
    .optional(),
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
  /** A model named for this item only — beats a preset's or teammate's chain. */
  model: z
    .object({
      provider: z.enum(PROVIDER_KINDS),
      model: z.string().min(1),
      label: z.string().min(1).optional(),
    })
    .optional(),
});

export const SpawnBatchInputSchema = z.object({
  /** Batch of tasks to spawn concurrently (up to 16). */
  items: z.array(SpawnBatchItemSchema).min(1).max(16),
});

export const WaitForResponsesInputSchema = z.object({
  threadIds: z.array(z.string().min(1)).min(1).max(12),
  /** Positionally paired with `threadIds`: the exact turn of that child to wait
   *  on, so a human typing into the child mid-wait can't hand the parent a
   *  different turn's outcome. Omit to wait on the child's latest turn. */
  turnIds: z.array(z.string().min(1)).max(12).optional(),
  /** Engine default when omitted; the engine clamps to its own max. */
  timeoutMs: z.number().int().nonnegative().optional(),
});

export const ReadResponseInputSchema = z.object({
  threadId: z.string().min(1),
  /** Blocks to return, newest last. Default 20. */
  limit: z.number().int().min(1).max(100).optional(),
  /** Per-message text cap; truncated with a visible marker. Default 1500. */
  maxTextChars: z.number().int().min(200).optional(),
});

export const ContinueThreadInputSchema = z.object({
  /** The child thread to post the follow-up into — one kone_continue_thread
   *  returned earlier. Must be in the caller's own spawned subtree. */
  threadId: z.string().min(1),
  /** The follow-up: a complete, self-contained ask that continues the thread's
   *  existing conversation. */
  message: z.string().min(1),
  /** Agent-supplied idempotency key scoped to (caller thread, caller turn). */
  requestId: z.string().min(1).max(200).optional(),
});

export const SPAWN_TARGETS_JSON_SCHEMA = {
  type: "object",
  properties: {},
} satisfies GatewayRecord;

export const SPAWN_WORKER_JSON_SCHEMA = {
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
  required: ["prompt", "requestId"],
} satisfies GatewayRecord;

export const SPAWN_WORKER_PRESET_JSON_SCHEMA = {
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
    model: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...PROVIDER_KINDS] },
        model: { type: "string" },
        label: { type: "string" },
      },
      required: ["provider", "model"],
    },
  },
  required: ["preset", "task", "requestId"],
} satisfies GatewayRecord;

export const DELEGATE_TO_TEAMMATE_JSON_SCHEMA = {
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
    model: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...PROVIDER_KINDS] },
        model: { type: "string" },
        label: { type: "string" },
      },
      required: ["provider", "model"],
    },
  },
  required: ["agent", "task", "requestId"],
} satisfies GatewayRecord;

export const WAIT_FOR_RESPONSES_JSON_SCHEMA = {
  type: "object",
  properties: {
    threadIds: { type: "array", items: { type: "string" } },
    turnIds: { type: "array", items: { type: "string" } },
    timeoutMs: { type: "integer" },
  },
  required: ["threadIds"],
} satisfies GatewayRecord;

export const READ_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    threadId: { type: "string" },
    limit: { type: "integer" },
    maxTextChars: { type: "integer" },
  },
  required: ["threadId"],
} satisfies GatewayRecord;

export const CONTINUE_THREAD_JSON_SCHEMA = {
  type: "object",
  properties: {
    threadId: {
      type: "string",
      description:
        "The spawned child thread to post the follow-up into — a threadId an earlier spawn, delegation or batch returned. It must be in your own spawned subtree.",
    },
    message: {
      type: "string",
      description:
        "The follow-up: a complete, self-contained ask. It continues the thread's existing conversation — the child still has everything it did.",
    },
    requestId: {
      type: "string",
      description:
        "Stable idempotency key for this follow-up, so a retry returns the same result instead of running the child twice.",
    },
  },
  required: ["threadId", "message"],
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
          model: {
            type: "object",
            properties: {
              provider: { type: "string", enum: [...PROVIDER_KINDS] },
              model: { type: "string" },
              label: { type: "string" },
            },
            required: ["provider", "model"],
          },
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

export const IrcListInputSchema = z.object({});

export const IRC_LIST_JSON_SCHEMA = {
  type: "object",
  properties: {},
} satisfies GatewayRecord;

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
export type IrcListInput = z.infer<typeof IrcListInputSchema>;

export type IrcMessagePayload = {
  id: string;
  from: string;
  to: string;
  message: string;
  replyTo?: string;
  createdAt: number;
};

// ── process supervisor (launch) tools ──────────────────────────────────────

export const LaunchInputSchema = z.object({
  op: z.enum(["start", "stop", "restart", "logs", "send", "status", "list"]),
  name: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  ready: z
    .object({
      port: z.number().int().positive().optional(),
      log: z.string().optional(),
      timeout: z.number().positive().optional(),
    })
    .optional(),
  lines: z.number().int().positive().optional(),
  cursor: z.number().int().nonnegative().optional(),
  grep: z.string().optional(),
  follow: z.boolean().optional(),
  text: z.string().optional(),
  enter: z.boolean().optional(),
  signal: z.enum(["SIGTERM", "SIGKILL"]).optional(),
  timeout: z.number().positive().optional(),
});

export const LAUNCH_JSON_SCHEMA = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: ["start", "stop", "restart", "logs", "send", "status", "list"],
      description: "Supervisor action to perform.",
    },
    name: {
      type: "string",
      description: "Identifier for the supervised process.",
    },
    command: {
      type: "string",
      description: "Command or executable binary to run (for 'start').",
    },
    args: {
      type: "array",
      items: { type: "string" },
      description: "Command-line arguments for the executable.",
    },
    cwd: {
      type: "string",
      description: "Working directory for the process.",
    },
    env: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Environment variables for the process.",
    },
    ready: {
      type: "object",
      properties: {
        port: { type: "integer", description: "TCP port that must accept connections for readiness." },
        log: { type: "string", description: "Regex pattern in stdout/stderr indicating readiness." },
        timeout: { type: "number", description: "Readiness timeout in seconds." },
      },
      description: "Readiness criteria to wait on before returning from start.",
    },
    lines: {
      type: "integer",
      description: "Number of log lines to return (default 100).",
    },
    cursor: {
      type: "integer",
      description: "Log line offset cursor for paginating logs.",
    },
    grep: {
      type: "string",
      description: "Regex pattern to filter logs.",
    },
    follow: {
      type: "boolean",
      description: "Whether to wait for new log lines after cursor.",
    },
    text: {
      type: "string",
      description: "Text to send to process stdin.",
    },
    enter: {
      type: "boolean",
      description: "Whether to append a newline to stdin text (default true).",
    },
    signal: {
      type: "string",
      enum: ["SIGTERM", "SIGKILL"],
      description: "Signal to terminate the process tree (SIGTERM for graceful stop, SIGKILL for hard kill).",
    },
    timeout: {
      type: "number",
      description: "Timeout in seconds for operations that wait.",
    },
  },
  required: ["op"],
} satisfies GatewayRecord;

export type LaunchInput = z.infer<typeof LaunchInputSchema>;

// ── theming and visual steering tools ──────────────────────────────────────

export const GetThemeStateInputSchema = z.object({});

export const GET_THEME_STATE_JSON_SCHEMA = {
  type: "object",
  properties: {},
} satisfies GatewayRecord;

export const ListAvailableThemesInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Optional search query matched against theme names, descriptions and accent colours (e.g. 'dark', 'green', 'warm', 'imported')."),
  kind: z
    .enum(["system", "adaptive", "fixed"])
    .optional()
    .describe("Filter by theme behavior kind ('system' | 'adaptive' | 'fixed')."),
  appearance: z
    .enum(["light", "dark"])
    .optional()
    .describe("Filter by visual appearance ('light' | 'dark')."),
});

export const LIST_AVAILABLE_THEMES_JSON_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Optional search query matched against theme names, descriptions and accent colours (e.g. 'dark', 'green', 'warm', 'imported').",
    },
    kind: {
      type: "string",
      enum: ["system", "adaptive", "fixed"],
      description: "Filter by theme behavior kind ('system' | 'adaptive' | 'fixed').",
    },
    appearance: {
      type: "string",
      enum: ["light", "dark"],
      description: "Filter by visual appearance ('light' | 'dark').",
    },
  },
} satisfies GatewayRecord;

export const SetThemeInputSchema = z
  .object({
    themeId: z
      .string()
      .min(1)
      .optional()
      .describe("Theme identifier or name as app_list_available_themes reports it. A description ('the green one') resolves too, but only against themes this install holds."),
    theme: z
      .string()
      .min(1)
      .optional()
      .describe("Alternative parameter alias for themeId."),
    name: z
      .string()
      .min(1)
      .optional()
      .describe("Alternative parameter alias for themeId."),
    mode: z
      .enum(["dark", "light", "system"])
      .optional()
      .describe("Appearance mode: 'dark', 'light', or 'system' (follow OS)."),
  })
  .refine(
    (data) =>
      data.themeId !== undefined ||
      data.theme !== undefined ||
      data.name !== undefined ||
      data.mode !== undefined,
    {
      message: "At least one of 'themeId', 'theme', 'name', or 'mode' must be provided.",
    },
  );

export const SET_THEME_JSON_SCHEMA = {
  type: "object",
  properties: {
    themeId: {
      type: "string",
      description: "Theme identifier or name as app_list_available_themes reports it. A description ('the green one') resolves too, but only against themes this install holds.",
    },
    theme: {
      type: "string",
      description: "Alternative parameter alias for themeId.",
    },
    name: {
      type: "string",
      description: "Alternative parameter alias for themeId.",
    },
    mode: {
      type: "string",
      enum: ["dark", "light", "system"],
      description: "Appearance mode: 'dark', 'light', or 'system' (follow OS).",
    },
  },
} satisfies GatewayRecord;

export const PreviewThemeOverrideInputSchema = z.object({
  themeId: z
    .string()
    .min(1)
    .optional()
    .describe("Theme identifier to preview."),
  theme: z
    .string()
    .min(1)
    .optional()
    .describe("Alternative parameter alias for themeId."),
  mode: z
    .enum(["dark", "light", "system"])
    .optional()
    .describe("Appearance mode to preview."),
  colors: z
    .record(z.string(), z.string())
    .optional()
    .describe("Key-value mapping of semantic token roles to hex/rgb colors to temporarily preview on the interface."),
  cancel: z
    .boolean()
    .optional()
    .describe("Set true to cancel/dismiss any active preview and restore the saved theme."),
});

export const PREVIEW_THEME_OVERRIDE_JSON_SCHEMA = {
  type: "object",
  properties: {
    themeId: {
      type: "string",
      description: "Theme identifier to preview.",
    },
    theme: {
      type: "string",
      description: "Alternative parameter alias for themeId.",
    },
    mode: {
      type: "string",
      enum: ["dark", "light", "system"],
      description: "Appearance mode to preview.",
    },
    colors: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Key-value mapping of semantic token roles to hex/rgb colors to temporarily preview on the interface.",
    },
    cancel: {
      type: "boolean",
      description: "Set true to cancel/dismiss any active preview and restore the saved theme.",
    },
  },
} satisfies GatewayRecord;

export const CreateCustomThemeInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-_]+$/, "ID must contain only lowercase alphanumeric characters, dashes, and underscores.")
    .describe("Unique slug identifier for the custom theme (e.g. 'brand-indigo', 'midnight-cyber')."),
  label: z
    .string()
    .min(1)
    .max(100)
    .describe("Human-readable display name for the theme."),
  blurb: z
    .string()
    .max(300)
    .optional()
    .describe("Short description of the theme's aesthetic."),
  appearance: z
    .enum(["light", "dark", "adaptive"])
    .default("dark")
    .describe("Target appearance: 'dark', 'light', or 'adaptive'."),
  accent: z
    .string()
    .min(1)
    .describe("Primary brand/accent hex color (e.g. '#6366f1')."),
  ground: z
    .string()
    .optional()
    .describe("Base background/canvas hex color (e.g. '#0f172a'). Optional; defaults to standard dark/light surface."),
  roles: z
    .record(z.string(), z.string())
    .optional()
    .describe("Optional granular role token overrides (e.g. { panel: '#1e293b', chip: '#334155' })."),
});

export const CREATE_CUSTOM_THEME_JSON_SCHEMA = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: "Unique slug identifier for the custom theme (e.g. 'brand-indigo', 'midnight-cyber').",
    },
    label: {
      type: "string",
      description: "Human-readable display name for the theme.",
    },
    blurb: {
      type: "string",
      description: "Short description of the theme's aesthetic.",
    },
    appearance: {
      type: "string",
      enum: ["light", "dark", "adaptive"],
      description: "Target appearance: 'dark', 'light', or 'adaptive'.",
    },
    accent: {
      type: "string",
      description: "Primary brand/accent hex color (e.g. '#6366f1').",
    },
    ground: {
      type: "string",
      description: "Base background/canvas hex color (e.g. '#0f172a'). Optional; defaults to standard dark/light surface.",
    },
    roles: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Optional granular role token overrides (e.g. { panel: '#1e293b', chip: '#334155' }).",
    },
  },
  required: ["id", "label", "accent"],
} satisfies GatewayRecord;

export type GetThemeStateInput = z.infer<typeof GetThemeStateInputSchema>;
export type ListAvailableThemesInput = z.infer<typeof ListAvailableThemesInputSchema>;
export type SetThemeInput = z.infer<typeof SetThemeInputSchema>;
export type PreviewThemeOverrideInput = z.infer<typeof PreviewThemeOverrideInputSchema>;
export type CreateCustomThemeInput = z.infer<typeof CreateCustomThemeInputSchema>;


// ── the app's own agents, its preset sub-agents, and the thread strip ───────
//
// The same shape as the theme tools above: a hand-written JSON Schema beside
// every zod schema, because tools/list advertises the former and only the
// handler sees the latter.
//
// One convention runs through all of these and is worth stating once. A field
// left out of a patch is left alone, and a field is *cleared* by naming it in
// `clear` rather than by sending null. Null across JSON-RPC is
// indistinguishable from a client that helpfully filled in the blanks, and on a
// built-in agent a clear is not a delete but a hand-back — the field returns to
// the shipped preset. Making that an explicit list means an agent has to mean it.

/** A model an agent or preset runs on. `label` is display text and rides along
 *  the way the app's own model refs carry one. */
export const AgentModelRefSchema = z.object({
  provider: z
    .enum(["codex", "claudeAgent", "opencode", "cursor", "droid", "antigravity"])
    .describe("The provider CLI the model belongs to."),
  model: z.string().min(1).max(200).describe("The model id within that provider."),
  label: z.string().min(1).max(200).optional().describe("Optional display label for the model."),
});

const AGENT_MODEL_REF_JSON_SCHEMA = {
  type: "object",
  properties: {
    provider: {
      type: "string",
      enum: ["codex", "claudeAgent", "opencode", "cursor", "droid", "antigravity"],
      description: "The provider CLI the model belongs to.",
    },
    model: { type: "string", description: "The model id within that provider." },
    label: { type: "string", description: "Optional display label for the model." },
  },
  required: ["provider", "model"],
} satisfies GatewayRecord;

/** How many fallbacks may sit behind a primary. Long enough for a real chain
 *  across providers, short enough that a spawn cannot walk an unbounded list. */
const MODEL_FALLBACKS_MAX = 8;

const AGENT_MODEL_FALLBACKS_JSON_SCHEMA = {
  type: "array",
  items: AGENT_MODEL_REF_JSON_SCHEMA,
  description:
    "Ordered fallbacks tried after the primary on a 429, spent quota, or unavailable provider. Ignored when no primary model is set.",
} satisfies GatewayRecord;

const AgentModelFallbacksSchema = z
  .array(AgentModelRefSchema)
  .max(MODEL_FALLBACKS_MAX)
  .describe(
    "Ordered fallbacks tried after the primary on a 429, spent quota, or unavailable provider. Ignored when no primary model is set.",
  );

/** The two opaque colours a drawn face is painted with. Both move together: a
 *  repainted body with last week's ink on it is how a face goes unreadable. */
export const AgentFacePaintSchema = z.object({
  body: z.string().min(1).max(64).describe("The face's fill colour (hex, e.g. '#6366f1')."),
  ink: z.string().min(1).max(64).describe("The colour the eyes are drawn in (hex, e.g. '#0b1020')."),
});

const AGENT_FACE_PAINT_JSON_SCHEMA = {
  type: "object",
  properties: {
    body: { type: "string", description: "The face's fill colour (hex, e.g. '#6366f1')." },
    ink: {
      type: "string",
      description: "The colour the eyes are drawn in (hex, e.g. '#0b1020').",
    },
  },
  required: ["body", "ink"],
} satisfies GatewayRecord;

export const ListAppAgentsInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Optional search matched against an agent's name, role and instructions."),
});

export const LIST_APP_AGENTS_JSON_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Optional search matched against an agent's name, role and instructions.",
    },
  },
} satisfies GatewayRecord;

export const CreateAppAgentInputSchema = z.object({
  name: z.string().min(1).max(64).describe("What the agent is called. The one required field."),
  role: z
    .string()
    .max(120)
    .optional()
    .describe("One line under the name saying what the agent is for. Shown in the roster only."),
  instructions: z
    .string()
    .max(4000)
    .optional()
    .describe("The agent's standing orders, in its own words — this is what reaches the model when a thread is handed to it."),
  face: AgentFacePaintSchema.optional().describe(
    "The colours the agent's face is drawn in. Omitted, kone paints one from the name.",
  ),
  model: AgentModelRefSchema.optional().describe(
    "The model this agent runs on first. Omitted, the agent inherits — each turn (or a spawned child) rides the caller.",
  ),
  modelFallbacks: AgentModelFallbacksSchema.optional().describe(
    "Ordered fallbacks behind `model`. Ignored when no primary is set.",
  ),
  addToActiveProject: z
    .boolean()
    .optional()
    .describe("Also put the new agent on the calling thread's project team, so it can work within that project."),
});

export const CREATE_APP_AGENT_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "What the agent is called. The one required field." },
    role: {
      type: "string",
      description: "One line under the name saying what the agent is for. Shown in the roster only.",
    },
    instructions: {
      type: "string",
      description:
        "The agent's standing orders, in its own words — this is what reaches the model when a thread is handed to it.",
    },
    face: {
      ...AGENT_FACE_PAINT_JSON_SCHEMA,
      description: "The colours the agent's face is drawn in. Omitted, kone paints one from the name.",
    },
    model: {
      ...AGENT_MODEL_REF_JSON_SCHEMA,
      description:
        "The model this agent runs on first. Omitted, the agent inherits — each turn (or a spawned child) rides the caller.",
    },
    modelFallbacks: AGENT_MODEL_FALLBACKS_JSON_SCHEMA,
    addToActiveProject: {
      type: "boolean",
      description:
        "Also put the new agent on the calling thread's project team, so it can work within that project.",
    },
  },
  required: ["name"],
} satisfies GatewayRecord;

/** The fields an update may hand back. `name` is absent on purpose: an agent
 *  with no name has nothing to be called, and on a user-made agent there is no
 *  preset underneath to hand it back to. */
const APP_AGENT_CLEARABLE = ["role", "instructions", "face", "model"] as const;

export const UpdateAppAgentInputSchema = z
  .object({
    agent: z
      .string()
      .min(1)
      .describe("The agent's id or name, as app_list_agents reports it."),
    name: z.string().min(1).max(64).optional().describe("Rename the agent."),
    role: z.string().max(120).optional().describe("Replace the line under the name."),
    instructions: z
      .string()
      .max(4000)
      .optional()
      .describe("Replace the agent's standing orders."),
    face: AgentFacePaintSchema.optional().describe("Repaint the agent's face."),
    model: AgentModelRefSchema.optional().describe("Pin the agent to this model."),
    modelFallbacks: AgentModelFallbacksSchema.optional().describe(
      "Replace the ordered fallbacks behind the agent's primary model.",
    ),
    clear: z
      .array(z.enum(APP_AGENT_CLEARABLE))
      .optional()
      .describe("Fields to clear. On a built-in agent a cleared field returns to the value kone ships; on a user-made one it is unset. Use this rather than sending an empty value."),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.role !== undefined ||
      data.instructions !== undefined ||
      data.face !== undefined ||
      data.model !== undefined ||
      data.modelFallbacks !== undefined ||
      (data.clear?.length ?? 0) > 0,
    { message: "Name at least one field to change, or one to clear." },
  );

export const UPDATE_APP_AGENT_JSON_SCHEMA = {
  type: "object",
  properties: {
    agent: { type: "string", description: "The agent's id or name, as app_list_agents reports it." },
    name: { type: "string", description: "Rename the agent." },
    role: { type: "string", description: "Replace the line under the name." },
    instructions: { type: "string", description: "Replace the agent's standing orders." },
    face: { ...AGENT_FACE_PAINT_JSON_SCHEMA, description: "Repaint the agent's face." },
    model: { ...AGENT_MODEL_REF_JSON_SCHEMA, description: "Pin the agent to this model." },
    modelFallbacks: AGENT_MODEL_FALLBACKS_JSON_SCHEMA,
    clear: {
      type: "array",
      items: { type: "string", enum: [...APP_AGENT_CLEARABLE] },
      description:
        "Fields to clear. On a built-in agent a cleared field returns to the value kone ships; on a user-made one it is unset. Use this rather than sending an empty value.",
    },
  },
  required: ["agent"],
} satisfies GatewayRecord;

export const DeleteAppAgentInputSchema = z.object({
  agent: z.string().min(1).describe("The agent's id or name."),
  confirm: z
    .literal(true)
    .describe("Must be true. Set it only when the user has asked for this agent to go; the threads it worked keep its name, but it leaves the roster."),
});

export const DELETE_APP_AGENT_JSON_SCHEMA = {
  type: "object",
  properties: {
    agent: { type: "string", description: "The agent's id or name." },
    confirm: {
      type: "boolean",
      enum: [true],
      description:
        "Must be true. Set it only when the user has asked for this agent to go; the threads it worked keep its name, but it leaves the roster.",
    },
  },
  required: ["agent", "confirm"],
} satisfies GatewayRecord;

export const SetActiveAgentInputSchema = z
  .object({
    agent: z
      .string()
      .min(1)
      .optional()
      .describe("The agent's id or name — who the user's next turn is handed to."),
    guest: z
      .boolean()
      .optional()
      .describe("Set true to hand the next turn to nobody in particular, which is kone's shipped default."),
  })
  .refine((data) => data.agent !== undefined || data.guest === true, {
    message: "Name an agent, or set guest: true.",
  });

export const SET_ACTIVE_AGENT_JSON_SCHEMA = {
  type: "object",
  properties: {
    agent: {
      type: "string",
      description: "The agent's id or name — who the user's next turn is handed to.",
    },
    guest: {
      type: "boolean",
      description:
        "Set true to hand the next turn to nobody in particular, which is kone's shipped default.",
    },
  },
} satisfies GatewayRecord;

export const ListSubagentPresetsInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Optional search matched against a preset's name and instructions."),
});

export const LIST_SUBAGENT_PRESETS_JSON_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Optional search matched against a preset's name and instructions.",
    },
  },
} satisfies GatewayRecord;

export const CreateSubagentPresetInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .describe("What the preset is called. This is also how kone_spawn_worker_preset refers to it."),
  instructions: z
    .string()
    .max(4000)
    .optional()
    .describe("What a sub-agent cut from this preset is told before it starts work."),
  model: AgentModelRefSchema.optional().describe(
    "The model a spawn from this preset runs on first. Omitted, the spawn inherits its caller's model.",
  ),
  modelFallbacks: AgentModelFallbacksSchema.optional().describe(
    "Ordered fallbacks behind `model`. Ignored when no primary is set.",
  ),
});

export const CREATE_SUBAGENT_PRESET_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "What the preset is called. This is also how kone_spawn_worker_preset refers to it.",
    },
    instructions: {
      type: "string",
      description: "What a sub-agent cut from this preset is told before it starts work.",
    },
    model: {
      ...AGENT_MODEL_REF_JSON_SCHEMA,
      description:
        "The model a spawn from this preset runs on first. Omitted, the spawn inherits its caller's model.",
    },
    modelFallbacks: AGENT_MODEL_FALLBACKS_JSON_SCHEMA,
  },
  required: ["name"],
} satisfies GatewayRecord;

const SUBAGENT_PRESET_CLEARABLE = ["instructions", "model"] as const;

export const UpdateSubagentPresetInputSchema = z
  .object({
    preset: z
      .string()
      .min(1)
      .describe("The preset's id or name, as app_list_subagent_presets reports it."),
    name: z.string().min(1).max(64).optional().describe("Rename the preset."),
    instructions: z.string().max(4000).optional().describe("Replace the preset's instructions."),
    model: AgentModelRefSchema.optional().describe("Pin spawns from this preset to this model."),
    modelFallbacks: AgentModelFallbacksSchema.optional().describe(
      "Replace the ordered fallbacks behind the preset's primary model.",
    ),
    clear: z
      .array(z.enum(SUBAGENT_PRESET_CLEARABLE))
      .optional()
      .describe("Fields to unset. A preset has nothing above it to inherit from, so a cleared field is simply gone."),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.instructions !== undefined ||
      data.model !== undefined ||
      data.modelFallbacks !== undefined ||
      (data.clear?.length ?? 0) > 0,
    { message: "Name at least one field to change, or one to clear." },
  );

export const UPDATE_SUBAGENT_PRESET_JSON_SCHEMA = {
  type: "object",
  properties: {
    preset: {
      type: "string",
      description: "The preset's id or name, as app_list_subagent_presets reports it.",
    },
    name: { type: "string", description: "Rename the preset." },
    instructions: { type: "string", description: "Replace the preset's instructions." },
    model: {
      ...AGENT_MODEL_REF_JSON_SCHEMA,
      description: "Pin spawns from this preset to this model.",
    },
    modelFallbacks: AGENT_MODEL_FALLBACKS_JSON_SCHEMA,
    clear: {
      type: "array",
      items: { type: "string", enum: [...SUBAGENT_PRESET_CLEARABLE] },
      description:
        "Fields to unset. A preset has nothing above it to inherit from, so a cleared field is simply gone.",
    },
  },
  required: ["preset"],
} satisfies GatewayRecord;

export const DeleteSubagentPresetInputSchema = z.object({
  preset: z.string().min(1).describe("The preset's id or name."),
  confirm: z
    .literal(true)
    .describe("Must be true. A preset keeps no history, so this is a real delete — set it only when the user has asked for it."),
});

export const DELETE_SUBAGENT_PRESET_JSON_SCHEMA = {
  type: "object",
  properties: {
    preset: { type: "string", description: "The preset's id or name." },
    confirm: {
      type: "boolean",
      enum: [true],
      description:
        "Must be true. A preset keeps no history, so this is a real delete — set it only when the user has asked for it.",
    },
  },
  required: ["preset", "confirm"],
} satisfies GatewayRecord;

export const GetStripSettingsInputSchema = z.object({});

export const GET_STRIP_SETTINGS_JSON_SCHEMA = {
  type: "object",
  properties: {},
} satisfies GatewayRecord;

/** The pane kinds that carry an opening width. Named here rather than imported
 *  from the renderer: the gateway validates what an agent sent, and a kind the
 *  renderer adds later is a schema change either way. */
const STRIP_PANE_KINDS = ["thread", "terminal", "scratchpad"] as const;

export const SetStripSettingsInputSchema = z
  .object({
    centering: z
      .enum(["never", "on-overflow", "always"])
      .optional()
      .describe("Where the strip lands when a column takes focus: 'never' holds it still and nudges the column into view, 'on-overflow' centres it only when it has to move, 'always' recentres on every focus change."),
    defaultWidths: z
      // An explicit object rather than a record keyed on the enum: a record's
      // inferred type makes every kind required, which would have the handler
      // read a rung the caller never sent.
      .object({
        thread: z.number().int().min(0).optional(),
        terminal: z.number().int().min(0).optional(),
        scratchpad: z.number().int().min(0).optional(),
      })
      .optional()
      .describe("The rung a newly opened pane of each kind starts at, as an index into the width ladder (0 is narrowest). Existing panes keep the width they already have."),
  })
  .refine(
    (data) =>
      data.centering !== undefined ||
      Object.keys(data.defaultWidths ?? {}).length > 0,
    { message: "Name at least one setting to change." },
  );

export const SET_STRIP_SETTINGS_JSON_SCHEMA = {
  type: "object",
  properties: {
    centering: {
      type: "string",
      enum: ["never", "on-overflow", "always"],
      description:
        "Where the strip lands when a column takes focus: 'never' holds it still and nudges the column into view, 'on-overflow' centres it only when it has to move, 'always' recentres on every focus change.",
    },
    defaultWidths: {
      type: "object",
      properties: Object.fromEntries(
        STRIP_PANE_KINDS.map((kind) => [
          kind,
          { type: "number", description: `Opening rung for a new ${kind} pane.` },
        ]),
      ),
      additionalProperties: false,
      description:
        "The rung a newly opened pane of each kind starts at, as an index into the width ladder (0 is narrowest). Existing panes keep the width they already have.",
    },
  },
} satisfies GatewayRecord;

export type AgentModelRefInput = z.infer<typeof AgentModelRefSchema>;
export type AgentFacePaintInput = z.infer<typeof AgentFacePaintSchema>;
export type ListAppAgentsInput = z.infer<typeof ListAppAgentsInputSchema>;
export type CreateAppAgentInput = z.infer<typeof CreateAppAgentInputSchema>;
export type UpdateAppAgentInput = z.infer<typeof UpdateAppAgentInputSchema>;
export type DeleteAppAgentInput = z.infer<typeof DeleteAppAgentInputSchema>;
export type SetActiveAgentInput = z.infer<typeof SetActiveAgentInputSchema>;
export type ListSubagentPresetsInput = z.infer<typeof ListSubagentPresetsInputSchema>;
export type CreateSubagentPresetInput = z.infer<typeof CreateSubagentPresetInputSchema>;
export type UpdateSubagentPresetInput = z.infer<typeof UpdateSubagentPresetInputSchema>;
export type DeleteSubagentPresetInput = z.infer<typeof DeleteSubagentPresetInputSchema>;
export type GetStripSettingsInput = z.infer<typeof GetStripSettingsInputSchema>;
export type SetStripSettingsInput = z.infer<typeof SetStripSettingsInputSchema>;
