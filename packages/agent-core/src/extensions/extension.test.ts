import { describe, expect, it } from "bun:test";
import {
  ExtensionRegistry,
  InMemoryExtensionStorage,
  type BeforeCompactEvent,
  type CustomToolDefinition,
  type ExtensionAPI,
  type ExtensionModule,
  type SessionStartEvent,
  type ToolCallEvent,
  type TurnStartEvent,
} from "./index.js";

describe("ExtensionRegistry - Custom Tools", () => {
  it("registers, lists, checks, and retrieves custom tools", () => {
    const registry = new ExtensionRegistry();

    const tool: CustomToolDefinition = {
      name: "calculator",
      description: "Performs basic arithmetic",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
          op: { type: "string" },
        },
      },
      execute: (args) => {
        const a = typeof args.a === "number" ? args.a : 0;
        const b = typeof args.b === "number" ? args.b : 0;
        return a + b;
      },
    };

    const unregister = registry.registerTool(tool);

    expect(registry.hasTool("calculator")).toBe(true);
    expect(registry.getTool("calculator")?.description).toBe(
      "Performs basic arithmetic",
    );
    expect(registry.listTools().length).toBe(1);

    unregister();

    expect(registry.hasTool("calculator")).toBe(false);
    expect(registry.getTool("calculator")).toBeUndefined();
    expect(registry.listTools().length).toBe(0);
  });

  it("executes a custom tool and returns the computed result", async () => {
    const registry = new ExtensionRegistry();

    registry.registerTool({
      name: "greet",
      description: "Returns greeting message",
      execute: (args, ctx) => {
        const name = typeof args.name === "string" ? args.name : "World";
        return `Hello, ${name}! (from ${ctx.extensionId})`;
      },
    });

    const result = await registry.executeTool(
      "greet",
      { name: "Alice" },
      { threadId: "thread_123" },
    );

    expect(result).toBe("Hello, Alice! (from core)");
  });

  it("validates tool definition on registration", () => {
    const registry = new ExtensionRegistry();

    expect(() => {
      registry.registerTool({
        name: "",
        description: "Invalid",
        execute: () => null,
      });
    }).toThrow("Tool definition must have a non-empty name string");

    expect(() => {
      registry.registerTool({
        name: "test",
        description: "Invalid execute",
        execute: "not-a-function" as unknown as CustomToolDefinition["execute"],
      });
    }).toThrow('Tool "test" must provide an execute function');

    registry.registerTool({
      name: "duplicate_tool",
      description: "First",
      execute: () => "ok",
    });

    expect(() => {
      registry.registerTool({
        name: "duplicate_tool",
        description: "Second",
        execute: () => "conflict",
      });
    }).toThrow('Tool "duplicate_tool" is already registered');
  });

  it("throws descriptive error when executing non-existent tool", async () => {
    const registry = new ExtensionRegistry();

    expect(registry.executeTool("unknown_tool")).rejects.toThrow(
      'Custom tool "unknown_tool" not found',
    );
  });

  it("propagates tool execution errors while dispatching failure event", async () => {
    const registry = new ExtensionRegistry();
    const toolCallEvents: ToolCallEvent[] = [];

    registry.on("tool_call", (payload) => {
      toolCallEvents.push(payload);
    });

    registry.registerTool({
      name: "failing_tool",
      description: "Always throws",
      execute: () => {
        throw new Error("Intentional tool execution error");
      },
    });

    expect(registry.executeTool("failing_tool", { param: 42 })).rejects.toThrow(
      "Intentional tool execution error",
    );

    // Initial tool_call event + failed tool_call event
    expect(toolCallEvents.length).toBe(2);
    expect(toolCallEvents[0].toolName).toBe("failing_tool");
    expect(toolCallEvents[0].result).toBeUndefined();
    expect(toolCallEvents[1].toolName).toBe("failing_tool");
    expect(toolCallEvents[1].isError).toBe(true);
    expect(toolCallEvents[1].error).toBeDefined();
  });
});

describe("ExtensionRegistry - Lifecycle Event Dispatch", () => {
  it("dispatches session_start, turn_start, and before_compact events", async () => {
    const registry = new ExtensionRegistry();

    const receivedSessions: SessionStartEvent[] = [];
    const receivedTurns: TurnStartEvent[] = [];
    const receivedCompacts: BeforeCompactEvent[] = [];

    registry.on("session_start", (payload) => {
      receivedSessions.push(payload);
    });

    registry.on("turn_start", (payload) => {
      receivedTurns.push(payload);
    });

    registry.on("before_compact", (payload) => {
      receivedCompacts.push(payload);
    });

    const sessionPayload: SessionStartEvent = {
      sessionId: "sess_1",
      threadId: "th_1",
      provider: "codex",
      model: "gpt-4o",
      projectPath: "/workspace/project",
      timestamp: 1700000000,
    };

    const turnPayload: TurnStartEvent = {
      turnId: "turn_101",
      threadId: "th_1",
      prompt: "Refactor extensions module",
      timestamp: 1700000005,
      metadata: { priority: "high" },
    };

    const compactPayload: BeforeCompactEvent = {
      threadId: "th_1",
      currentTokens: 95000,
      targetTokens: 20000,
      cutIndex: 5,
      blocksCount: 12,
      customData: { branch: "main" },
    };

    await registry.dispatch("session_start", sessionPayload);
    await registry.dispatch("turn_start", turnPayload);
    await registry.dispatch("before_compact", compactPayload);

    expect(receivedSessions.length).toBe(1);
    expect(receivedSessions[0].sessionId).toBe("sess_1");
    expect(receivedSessions[0].provider).toBe("codex");

    expect(receivedTurns.length).toBe(1);
    expect(receivedTurns[0].turnId).toBe("turn_101");
    expect(receivedTurns[0].prompt).toBe("Refactor extensions module");

    expect(receivedCompacts.length).toBe(1);
    expect(receivedCompacts[0].currentTokens).toBe(95000);
    expect(receivedCompacts[0].cutIndex).toBe(5);
  });

  it("handles event subscription unregistering via off and returned cleanup", async () => {
    const registry = new ExtensionRegistry();
    let counter = 0;

    const handler = () => {
      counter += 1;
    };

    const unregister = registry.on("turn_start", handler);

    await registry.dispatch("turn_start", {
      turnId: "t1",
      threadId: "th1",
    });
    expect(counter).toBe(1);

    unregister();

    await registry.dispatch("turn_start", {
      turnId: "t2",
      threadId: "th1",
    });
    expect(counter).toBe(1);

    // Re-register and use registry.off
    registry.on("turn_start", handler);
    await registry.dispatch("turn_start", {
      turnId: "t3",
      threadId: "th1",
    });
    expect(counter).toBe(2);

    const removed = registry.off("turn_start", handler);
    expect(removed).toBe(true);

    await registry.dispatch("turn_start", {
      turnId: "t4",
      threadId: "th1",
    });
    expect(counter).toBe(2);
  });

  it("isolates handler errors during event dispatch without breaking other handlers", async () => {
    const registry = new ExtensionRegistry();
    const executions: string[] = [];

    registry.on("turn_start", () => {
      executions.push("handler_1");
    });

    registry.on("turn_start", () => {
      executions.push("handler_2");
      throw new Error("Handler 2 failed");
    });

    registry.on("turn_start", () => {
      executions.push("handler_3");
    });

    const result = await registry.dispatch("turn_start", {
      turnId: "t1",
      threadId: "th1",
    });

    expect(executions).toEqual(["handler_1", "handler_2", "handler_3"]);
    expect(result.errors.length).toBe(1);
    const firstError = result.errors[0].error;
    expect(firstError instanceof Error ? firstError.message : "").toBe(
      "Handler 2 failed",
    );
  });
});

describe("ExtensionRegistry - Extensions Lifecycle and Hot Reloading", () => {
  it("registers, activates, and utilizes extension tools and events", async () => {
    const registry = new ExtensionRegistry();
    const eventLog: string[] = [];

    const extensionFactory = (api: ExtensionAPI) => {
      api.storage.set("initTime", 12345);

      api.registerTool({
        name: "ext_tool",
        description: "Extension custom tool",
        execute: (_args, ctx) => {
          const initTime = ctx.storage.get<number>("initTime");
          return `init:${initTime}`;
        },
      });

      api.on("session_start", (payload) => {
        eventLog.push(`session:${payload.sessionId}`);
      });
    };

    const api = await registry.registerExtension("my_ext", extensionFactory);

    expect(registry.isExtensionRegistered("my_ext")).toBe(true);
    expect(registry.getActiveExtensions()).toEqual(["my_ext"]);
    expect(registry.hasTool("ext_tool")).toBe(true);

    const toolResult = await registry.executeTool("ext_tool");
    expect(toolResult).toBe("init:12345");

    await api.emit("session_start", {
      sessionId: "s_100",
      threadId: "th_100",
    });
    expect(eventLog).toEqual(["session:s_100"]);
  });

  it("unregisters an extension cleanly, removing its tools, event hooks, and calling deactivate", async () => {
    const registry = new ExtensionRegistry();
    let deactivated = false;
    let turnCount = 0;

    const extensionModule: ExtensionModule = {
      name: "LifecycleExtension",
      activate: (api) => {
        api.registerTool({
          name: "module_tool",
          description: "Module tool",
          execute: () => "from_module",
        });

        api.on("turn_start", () => {
          turnCount += 1;
        });
      },
      deactivate: () => {
        deactivated = true;
      },
    };

    await registry.registerExtension("module_ext", extensionModule);

    expect(registry.hasTool("module_tool")).toBe(true);

    await registry.dispatch("turn_start", {
      turnId: "turn_1",
      threadId: "th_1",
    });
    expect(turnCount).toBe(1);

    const unregistered = await registry.unregisterExtension("module_ext");
    expect(unregistered).toBe(true);
    expect(deactivated).toBe(true);
    expect(registry.isExtensionRegistered("module_ext")).toBe(false);
    expect(registry.hasTool("module_tool")).toBe(false);

    // Event hooks should no longer fire
    await registry.dispatch("turn_start", {
      turnId: "turn_2",
      threadId: "th_1",
    });
    expect(turnCount).toBe(1);
  });

  it("hot-reloads an extension with updated logic seamlessly", async () => {
    const registry = new ExtensionRegistry();

    // Version 1 of extension
    await registry.registerExtension("reloadable_ext", (api) => {
      api.registerTool({
        name: "version_tool",
        description: "Version reporting",
        execute: () => "v1",
      });
    });

    expect(await registry.executeTool("version_tool")).toBe("v1");

    // Version 2 of extension (hot-reload)
    await registry.reloadExtension("reloadable_ext", (api) => {
      api.registerTool({
        name: "version_tool",
        description: "Version reporting",
        execute: () => "v2",
      });
    });

    expect(await registry.executeTool("version_tool")).toBe("v2");
    expect(registry.listTools().length).toBe(1);
  });

  it("rolls back extension registration if activate throws an error", async () => {
    const registry = new ExtensionRegistry();

    const failingModule: ExtensionModule = {
      activate: (api) => {
        api.registerTool({
          name: "temporary_tool",
          description: "Should be rolled back",
          execute: () => "temp",
        });

        throw new Error("Activation crash");
      },
    };

    expect(
      registry.registerExtension("failing_ext", failingModule),
    ).rejects.toThrow("Activation crash");

    expect(registry.isExtensionRegistered("failing_ext")).toBe(false);
    expect(registry.hasTool("temporary_tool")).toBe(false);
  });

  it("rejects duplicate extension registration when reload is not used", async () => {
    const registry = new ExtensionRegistry();

    await registry.registerExtension("duplicate_ext", () => {});

    expect(
      registry.registerExtension("duplicate_ext", () => {}),
    ).rejects.toThrow(
      'Extension "duplicate_ext" is already registered. Use reloadExtension() to update.',
    );
  });
});

describe("InMemoryExtensionStorage", () => {
  it("provides set, get, has, delete, clear, and entries operations", () => {
    const storage = new InMemoryExtensionStorage();

    expect(storage.has("key1")).toBe(false);
    expect(storage.get("key1")).toBeUndefined();

    storage.set("key1", { count: 10 });
    expect(storage.has("key1")).toBe(true);
    expect(storage.get<{ count: number }>("key1")?.count).toBe(10);

    storage.set("key2", "value2");
    expect(storage.entries().length).toBe(2);

    expect(storage.delete("key1")).toBe(true);
    expect(storage.has("key1")).toBe(false);

    storage.clear();
    expect(storage.entries().length).toBe(0);
  });
});

describe("ExtensionRegistry - subscription and storage identity", () => {
  it("unsubscribes only the caller's own subscription when a handler is shared", async () => {
    const registry = new ExtensionRegistry();
    const seen: string[] = [];
    const shared = () => {
      seen.push("hit");
    };

    const offA = registry.on("tool_call", shared, "extension-a");
    registry.on("tool_call", shared, "extension-b");

    offA();

    await registry.dispatch("tool_call", { toolName: "noop", args: {} });
    expect(seen.length).toBe(1);
  });

  it("keeps storage for tools that have no owning extension", async () => {
    const registry = new ExtensionRegistry();
    registry.registerTool({
      name: "remember",
      description: "writes then reads back",
      parameters: { type: "object", properties: {} },
      execute: async (args, context) => {
        if (args.write !== undefined) {
          context.storage.set("value", args.write);
          return null;
        }
        return context.storage.get("value") ?? null;
      },
    });

    await registry.executeTool("remember", { write: "kept" });
    expect(await registry.executeTool("remember", {})).toBe("kept");
  });
});
