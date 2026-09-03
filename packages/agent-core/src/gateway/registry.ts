// Tool registry + dispatch (docs/mcp-gateway-design.md §5).
//
// Dispatch order: unknown tool → invalid_input; `deny` → permission_denied
// (and omitted from tools/list); `requiresActiveTurn` without a live bound
// turn → capability_denied; zod parse → invalid_input; handler throw → its
// GatewayToolError code or internal. Every tool-level failure is returned as
// a *successful* JSON-RPC result with isError: true + text +
// structuredContent — transport failures (auth, framing) stay JSON-RPC errors.

import type {
  GatewayErrorCode,
  GatewayRecord,
  GatewayToolContext,
  GatewayToolResult,
  GatewayValue,
  ToolEntry,
} from "./schemas.js";
import { GatewayToolError } from "./schemas.js";
import type { GatewayToolPrompt } from "../types.js";

export type { GatewayToolContext, GatewayToolResult, ToolEntry } from "./schemas.js";

export function mcpToolResultText(text: string): GatewayToolResult {
  return { content: [{ type: "text", text }] };
}

/** A tool-level failure: successful JSON-RPC, isError: true, machine-readable
 *  code in structuredContent. */
export function gatewayToolErrorResult(error: GatewayToolError): GatewayToolResult {
  const errorContent: GatewayRecord = { code: error.code, message: error.message };
  if (error.details !== undefined) errorContent.details = error.details;
  return {
    content: [
      {
        type: "text",
        text: `${error.code}: ${error.message}${
          error.details !== undefined ? ` ${JSON.stringify(error.details)}` : ""
        }`,
      },
    ],
    isError: true,
    structuredContent: { error: errorContent },
  };
}

/** One pending approval for a `permission: "ask"` tool call. */
export interface GatewayApprovalRequest {
  threadId: string;
  turnId: string | null;
  toolName: string;
  description: string;
  /** The validated arguments, so the prompt shows exactly what would run. */
  args: GatewayRecord;
}

/**
 * Asks the user to approve one gateway tool call. Resolves true to let the call
 * through. A registry built without one refuses every `"ask"` tool: the rung
 * means "a human decides", so with no one to ask the only safe answer is no.
 */
export type GatewayApprove = (request: GatewayApprovalRequest) => Promise<boolean>;

export type GatewayToolScope = "worker" | "assistant";

function matchesScope(tool: ToolEntry, scope?: GatewayToolScope): boolean {
  if (!scope) return true;
  const target = tool.target ?? "all";
  return target === "all" || target === scope;
}

export interface GatewayRegistry {
  /** The tool definitions tools/list advertises (denied tools omitted). Each
   *  inputSchema is the tool's hand-written JSON Schema object. */
  listTools(scope?: GatewayToolScope): ReadonlyArray<{ name: string; description: string; inputSchema: GatewayRecord }>;
  /** What the host-context block says about the tools this gateway actually
   *  serves — the same `deny` filter tools/list applies, so the prose and the
   *  advertised surface cannot disagree. */
  listToolPrompts(scope?: GatewayToolScope): ReadonlyArray<GatewayToolPrompt>;
  /** Dispatch one tools/call through the full dispatch order. Never throws. */
  call(
    ctx: GatewayToolContext,
    name: string,
    args: GatewayValue | undefined,
    scope?: GatewayToolScope,
  ): Promise<GatewayToolResult>;
}

export function createRegistry(
  tools: ReadonlyArray<ToolEntry>,
  options: { approve?: GatewayApprove } = {},
): GatewayRegistry {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const servable = tools.filter((tool) => tool.permission !== "deny");

  function listTools(scope?: GatewayToolScope) {
    return servable
      .filter((tool) => matchesScope(tool, scope))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.jsonSchema,
      }));
  }

  function listToolPrompts(scope?: GatewayToolScope): ReadonlyArray<GatewayToolPrompt> {
    const list: GatewayToolPrompt[] = [];
    for (const tool of servable) {
      if (!matchesScope(tool, scope)) continue;
      const snippet = tool.promptSnippet;
      if (!snippet) continue;
      list.push({
        name: tool.name,
        snippet,
        guidelines: tool.promptGuidelines ?? [],
        needsApproval: tool.permission === "ask",
      });
    }
    return list;
  }

  async function call(
    ctx: GatewayToolContext,
    name: string,
    args: GatewayValue | undefined,
    scope?: GatewayToolScope,
  ): Promise<GatewayToolResult> {
    const tool = toolsByName.get(name);
    if (!tool) {
      return gatewayToolErrorResult(
        new GatewayToolError("invalid_input", `Unknown tool "${name}".`),
      );
    }
    if (tool.permission === "deny") {
      return gatewayToolErrorResult(
        new GatewayToolError("permission_denied", `Tool "${name}" is not permitted.`),
      );
    }
    if (scope && !matchesScope(tool, scope)) {
      return gatewayToolErrorResult(
        new GatewayToolError(
          "permission_denied",
          `Tool "${name}" is not available for ${scope} sessions.`,
        ),
      );
    }
    if (tool.requiresActiveTurn && !ctx.turnId) {
      return gatewayToolErrorResult(
        new GatewayToolError(
          "capability_denied",
          "This write requires an active agent turn — the calling session has no live turn to bind to.",
        ),
      );
    }
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      return gatewayToolErrorResult(
        new GatewayToolError("invalid_input", `Invalid arguments for "${name}".`, {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        }),
      );
    }
    // SAFETY: every tool's inputSchema is a zod object schema, so validated
    // args are a JSON object by construction before the handler sees them.
    const input = parsed.data as GatewayRecord;

    if (tool.permission === "ask") {
      if (!options.approve) {
        return gatewayToolErrorResult(
          new GatewayToolError(
            "permission_denied",
            `Tool "${name}" requires approval, and this session has no approval channel.`,
          ),
        );
      }
      const approved = await options.approve({
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        toolName: name,
        description: tool.description,
        args: input,
      });
      if (!approved) {
        return gatewayToolErrorResult(
          new GatewayToolError("permission_denied", `Tool "${name}" was not approved.`),
        );
      }
    }

    try {
      return await tool.handler(ctx, input);
    } catch (cause) {
      if (cause instanceof GatewayToolError) {
        return gatewayToolErrorResult(cause);
      }
      // A cancelled in-flight call is not a tool failure — the transport
      // turns AbortError into an empty 202. Swallowing it here would log a
      // fake crash and return isError to a client that already hung up.
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[gateway] tool "${name}" failed:`, cause);
      return gatewayToolErrorResult(
        new GatewayToolError("internal", `Tool "${name}" failed: ${message}`),
      );
    }
  }

  return { listTools, listToolPrompts, call };
}

export function isGatewayErrorCode(value: string): value is GatewayErrorCode {
  return (
    value === "permission_denied" ||
    value === "capability_denied" ||
    value === "idempotency_conflict" ||
    value === "revision_conflict" ||
    value === "not_found" ||
    value === "invalid_input" ||
    value === "provider_unavailable" ||
    value === "internal"
  );
}
