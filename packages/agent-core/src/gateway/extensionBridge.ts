import { z } from "zod";
import type { ExtensionRegistry } from "../extensions/ExtensionRegistry.js";
import { GatewayToolError, type GatewayRecord, type GatewayToolContext, type GatewayToolResult, type GatewayValue, type ToolEntry } from "./schemas.js";

/**
 * Coerce an arbitrary value into the JSON-safe shape the gateway transport accepts.
 *
 * Extension tools are user-supplied, so their schemas and results can contain
 * things the transport cannot carry — functions, symbols, bigints, cycles.
 * Casting would let those reach serialization and throw from somewhere far away,
 * so they are dropped here instead. `seen` breaks reference cycles.
 */
function toGatewayValue(value: unknown, seen = new WeakSet<object>()): GatewayValue | undefined {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }

  const obj = value as object;
  if (seen.has(obj)) {
    return undefined;
  }
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      return obj.map((item) => toGatewayValue(item, seen) ?? null);
    }
    const record: GatewayRecord = {};
    for (const [key, item] of Object.entries(obj)) {
      const coerced = toGatewayValue(item, seen);
      if (coerced !== undefined) {
        record[key] = coerced;
      }
    }
    return record;
  } finally {
    seen.delete(obj);
  }
}

function toGatewayRecord(value: unknown): GatewayRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const seen = new WeakSet<object>([value]);
  const record: GatewayRecord = {};
  for (const [key, item] of Object.entries(value)) {
    const coerced = toGatewayValue(item, seen);
    if (coerced !== undefined) {
      record[key] = coerced;
    }
  }
  return record;
}

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

  const jsonSchema = toGatewayRecord(tool.parameters) ?? {
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

        const structuredContent = toGatewayRecord(result);
        const serialized = JSON.stringify(structuredContent ?? toGatewayValue(result) ?? null, null, 2);
        return {
          content: [{ type: "text", text: serialized }],
          structuredContent,
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
