import { describe, expect, it } from "bun:test";
import { ExtensionRegistry } from "../ExtensionRegistry.js";
import {
  createScratchpadExtension,
  scratchpadExtension,
  scratchpadClearTool,
  scratchpadReadTool,
  scratchpadWriteTool,
} from "./scratchpad.js";
import {
  createSubagentDispatcherExtension,
  subagentDispatcherExtension,
  type SubagentDispatchResult,
} from "./subagentDispatcher.js";

describe("Built-in Extension: Scratchpad", () => {
  it("registers scratchpad tools and allows write, read, and clear", async () => {
    const registry = new ExtensionRegistry();
    await registry.registerExtension("scratchpad", scratchpadExtension);

    expect(registry.hasTool("scratchpad_write")).toBe(true);
    expect(registry.hasTool("scratchpad_read")).toBe(true);
    expect(registry.hasTool("scratchpad_clear")).toBe(true);

    // 1. Write initial note under default key
    const writeResult1 = (await registry.executeTool("scratchpad_write", {
      content: "First note content",
    })) as { success: boolean; key: string; bytesWritten: number };

    expect(writeResult1.success).toBe(true);
    expect(writeResult1.key).toBe("default");
    expect(writeResult1.bytesWritten).toBe("First note content".length);

    // 2. Read default note
    const readResult1 = (await registry.executeTool("scratchpad_read", {
      key: "default",
    })) as { found: boolean; key: string; content: string };

    expect(readResult1.found).toBe(true);
    expect(readResult1.key).toBe("default");
    expect(readResult1.content).toBe("First note content");

    // 3. Append to default note
    const writeResult2 = (await registry.executeTool("scratchpad_write", {
      key: "default",
      content: "Second line of notes",
      append: true,
    })) as { success: boolean; key: string };

    expect(writeResult2.success).toBe(true);

    const readResult2 = (await registry.executeTool("scratchpad_read", {
      key: "default",
    })) as { found: boolean; content: string };

    expect(readResult2.content).toBe("First note content\nSecond line of notes");

    // 4. Write note with a specific custom key
    await registry.executeTool("scratchpad_write", {
      key: "plan",
      content: "Step 1: Research, Step 2: Implement",
    });

    // 5. Read all notes
    const readAll = (await registry.executeTool("scratchpad_read", {})) as {
      found: boolean;
      count: number;
      entries: Record<string, string>;
    };

    expect(readAll.found).toBe(true);
    expect(readAll.count).toBe(2);
    expect(readAll.entries.default).toBe(
      "First note content\nSecond line of notes",
    );
    expect(readAll.entries.plan).toBe("Step 1: Research, Step 2: Implement");

    // 6. Clear specific key
    const clearPlan = (await registry.executeTool("scratchpad_clear", {
      key: "plan",
    })) as { success: boolean; key: string; deleted: boolean };

    expect(clearPlan.success).toBe(true);
    expect(clearPlan.deleted).toBe(true);

    const readPlanAfterClear = (await registry.executeTool("scratchpad_read", {
      key: "plan",
    })) as { found: boolean; content: null };

    expect(readPlanAfterClear.found).toBe(false);
    expect(readPlanAfterClear.content).toBeNull();

    // 7. Clear all notes
    const clearAll = (await registry.executeTool("scratchpad_clear", {
      key: "all",
    })) as { success: boolean; clearedAll: boolean };

    expect(clearAll.success).toBe(true);
    expect(clearAll.clearedAll).toBe(true);

    const readAllAfterClear = (await registry.executeTool(
      "scratchpad_read",
      {},
    )) as { found: boolean; count: number };

    expect(readAllAfterClear.found).toBe(false);
    expect(readAllAfterClear.count).toBe(0);
  });

  it("validates scratchpad tool arguments", async () => {
    const registry = new ExtensionRegistry();
    await registry.registerExtension("scratchpad", createScratchpadExtension());

    // write without content should throw
    await expect(
      registry.executeTool("scratchpad_write", {}),
    ).rejects.toThrow("scratchpad_write requires a 'content' string parameter");
  });
});

describe("Built-in Extension: Subagent Dispatcher", () => {
  it("registers delegate_subagent tool and records dispatches", async () => {
    const registry = new ExtensionRegistry();
    await registry.registerExtension(
      "subagent_dispatcher",
      subagentDispatcherExtension,
    );

    expect(registry.hasTool("delegate_subagent")).toBe(true);

    const result = (await registry.executeTool(
      "delegate_subagent",
      {
        agentRole: "researcher",
        task: "Investigate performance bottleneck in AST parser",
        context: { targetDir: "src/parser" },
      },
      { threadId: "th_main_1" },
    )) as SubagentDispatchResult;

    expect(result.success).toBe(true);
    expect(result.agentRole).toBe("researcher");
    expect(result.task).toBe(
      "Investigate performance bottleneck in AST parser",
    );
    expect(result.status).toBe("dispatched");
    expect(typeof result.dispatchId).toBe("string");
    expect(result.dispatchId.startsWith("sub_")).toBe(true);

    const storage = registry.getExtensionStorage("subagent_dispatcher");
    const dispatches = storage.get<unknown[]>("dispatches");
    expect(Array.isArray(dispatches)).toBe(true);
    expect(dispatches?.length).toBe(1);
  });

  it("supports custom subagent dispatcher handlers", async () => {
    const customDispatcher = async (args: {
      agentRole: string;
      task: string;
    }) => {
      return {
        customHandled: true,
        role: args.agentRole,
        echo: `Done: ${args.task}`,
      };
    };

    const registry = new ExtensionRegistry();
    const ext = createSubagentDispatcherExtension({
      dispatcher: customDispatcher,
    });
    await registry.registerExtension("subagent_custom", ext);

    const result = (await registry.executeTool("delegate_subagent", {
      agentRole: "code_reviewer",
      task: "Review PR #42",
    })) as { customHandled: boolean; role: string; echo: string };

    expect(result.customHandled).toBe(true);
    expect(result.role).toBe("code_reviewer");
    expect(result.echo).toBe("Done: Review PR #42");
  });

  it("validates delegate_subagent arguments", async () => {
    const registry = new ExtensionRegistry();
    await registry.registerExtension(
      "subagent_dispatcher",
      subagentDispatcherExtension,
    );

    await expect(
      registry.executeTool("delegate_subagent", { task: "some task" }),
    ).rejects.toThrow(
      "delegate_subagent requires a non-empty 'agentRole' string parameter",
    );

    await expect(
      registry.executeTool("delegate_subagent", { agentRole: "tester" }),
    ).rejects.toThrow(
      "delegate_subagent requires a non-empty 'task' string parameter",
    );
  });
});
