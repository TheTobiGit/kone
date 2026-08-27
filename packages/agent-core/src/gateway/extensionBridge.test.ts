import { describe, expect, it } from "bun:test";
import { ExtensionRegistry } from "../extensions/ExtensionRegistry.js";
import { bridgeExtensionToolsToGateway } from "./extensionBridge.js";
import { createRegistry } from "./registry.js";
import type { GatewayToolContext } from "./schemas.js";

function makeContext(): GatewayToolContext {
  return {
    threadId: "test-thread",
    turnId: "test-turn",
    cwd: "/tmp/project",
    signal: new AbortController().signal,
  };
}

describe("extensionBridge", () => {
  it("bridges custom extension tools into Gateway ToolEntry items", async () => {
    const extensionRegistry = new ExtensionRegistry();

    extensionRegistry.registerTool({
      name: "kone_calculator",
      description: "Performs basic arithmetic",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
      },
      execute: (args) => {
        // SAFETY: Test arguments pass numbers for a and b
        const a = (args.a as number) ?? 0;
        // SAFETY: Test arguments pass numbers for a and b
        const b = (args.b as number) ?? 0;
        return { sum: a + b };
      },
    });

    const entries = bridgeExtensionToolsToGateway(extensionRegistry);
    expect(entries.length).toBe(1);
    expect(entries[0]!.name).toBe("kone_calculator");

    const gatewayRegistry = createRegistry(entries);
    const listed = gatewayRegistry.listTools();
    expect(listed.map((t) => t.name)).toContain("kone_calculator");

    const callResult = await gatewayRegistry.call(makeContext(), "kone_calculator", { a: 10, b: 25 });
    expect(callResult.isError).toBeFalsy();
    expect(callResult.content[0]!.text).toContain('"sum": 35');
    expect(callResult.structuredContent).toEqual({ sum: 35 });
  });

  it("handles errors during tool execution by returning error results", async () => {
    const extensionRegistry = new ExtensionRegistry();

    extensionRegistry.registerTool({
      name: "failing_tool",
      description: "Throws an error",
      execute: () => {
        throw new Error("Simulated failure in extension tool");
      },
    });

    const entries = bridgeExtensionToolsToGateway(extensionRegistry);
    const gatewayRegistry = createRegistry(entries);

    const callResult = await gatewayRegistry.call(makeContext(), "failing_tool", {});
    expect(callResult.isError).toBe(true);
    expect(callResult.structuredContent?.error.message).toContain("Simulated failure in extension tool");
  });
});
