import { z } from "zod";
import type { ExtensionRegistry } from "../extensions/ExtensionRegistry.js";
import { GatewayToolError, type GatewayToolContext, type GatewayToolResult, type ToolEntry } from "./schemas.js";

/**
 * Converts a registered custom tool from ExtensionRegistry into a Gateway ToolEntry
 * for exposure over the MCP gateway to all connected agent models.
 */
export function bridgeExtensionToolToGateway(
  extensionRegistry: ExtensionRegistry,
  toolName: string,
): ToolEntry | undefined {
  const tool = extensionRegistry.getTool(toolName);
  if (!tool) {
    return undefined;
  }

  const jsonSchema = (tool.parameters as Record<string, unknown>) ?? {
    type: "object",
    properties: {},
  };

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.record(z.string(), z.unknown()),
    jsonSchema,
    permission: tool.permission ?? "allow",
    requiresActiveTurn: tool.requiresActiveTurn ?? false,
    handler: async (
      ctx: GatewayToolContext,
      args: Record<string, unknown>,
    ): Promise<GatewayToolResult> => {
      try {
        const result = await extensionRegistry.executeTool(tool.name, args, {
          threadId: ctx.threadId ?? undefined,
          turnId: ctx.turnId ?? undefined,
          projectPath: ctx.cwd,
          signal: ctx.signal,
        });

        if (typeof result === "string") {
          return { content: [{ type: "text", text: result }] };
        }

        const serialized = JSON.stringify(result, null, 2);
        return {
          content: [{ type: "text", text: serialized }],
          structuredContent: (result && typeof result === "object" && !Array.isArray(result))
            ? (result as Record<string, unknown>)
            : undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new GatewayToolError("internal", message);
      }
    },
  };
}

/**
 * Bridges all registered custom tools from an ExtensionRegistry into Gateway ToolEntry array.
 */
export function bridgeExtensionToolsToGateway(
  extensionRegistry: ExtensionRegistry,
): ToolEntry[] {
  const tools = extensionRegistry.listTools();
  const entries: ToolEntry[] = [];

  for (const tool of tools) {
    const entry = bridgeExtensionToolToGateway(extensionRegistry, tool.name);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}
