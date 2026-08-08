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
  GatewayToolContext,
  GatewayToolResult,
  ToolEntry,
} from "./schemas.js";
import { GatewayToolError } from "./schemas.js";

export type { GatewayToolContext, GatewayToolResult, ToolEntry } from "./schemas.js";

/** The text content of a tool result. */
export function mcpToolResultText(text: string): GatewayToolResult {
  return { content: [{ type: "text", text }] };
}

/** A tool-level failure: successful JSON-RPC, isError: true, machine-readable
 *  code in structuredContent. */
export function gatewayToolErrorResult(error: GatewayToolError): GatewayToolResult {
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
    structuredContent: {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
  };
}

export interface GatewayRegistry {
  /** The tool definitions tools/list advertises (denied tools omitted). */
  listTools(): ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  /** Dispatch one tools/call through the full dispatch order. Never throws. */
  call(ctx: GatewayToolContext, name: string, args: unknown): Promise<GatewayToolResult>;
}

export function createRegistry(tools: ReadonlyArray<ToolEntry>): GatewayRegistry {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const advertised = tools
    .filter((tool) => tool.permission !== "deny")
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema,
    }));

  async function call(
    ctx: GatewayToolContext,
    name: string,
    args: unknown,
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
    try {
      return await tool.handler(ctx, parsed.data);
    } catch (error) {
      if (error instanceof GatewayToolError) {
        return gatewayToolErrorResult(error);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[gateway] tool "${name}" failed:`, error);
      return gatewayToolErrorResult(
        new GatewayToolError("internal", `Tool "${name}" failed: ${message}`),
      );
    }
  }

  return { listTools: () => advertised, call };
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
