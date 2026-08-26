import { describe, expect, it } from "bun:test";
import { ExtensionRegistry } from "../ExtensionRegistry.js";
import {
  builtins,
  checkCommandSafety,
  createGitCheckpointExtension,
  createSafetyGateExtension,
  createScratchpadExtension,
  createSubagentDispatcherExtension,
  DEFAULT_DANGEROUS_PATTERNS,
  DEFAULT_MONITORED_TOOLS,
  extractCommandsFromArgs,
  gitCheckpointExtension,
  isMonitoredTool,
  listCheckpointsTool,
  registerDefaultExtensions,
  restoreCheckpointTool,
  SafetyGateError,
  safetyGateExtension,
  scratchpadClearTool,
  scratchpadExtension,
  scratchpadReadTool,
  scratchpadWriteTool,
  subagentDispatcherExtension,
  validateCommand,
  type DangerousPatternRule,
  type GitCheckpointOptions,
  type SafetyCheckResult,
  type SafetyGateOptions,
  type ScratchpadClearResult,
  type ScratchpadReadResult,
  type ScratchpadWriteResult,
  type SubagentDispatchArgs,
  type SubagentDispatchRecord,
  type SubagentDispatchResult,
  type SubagentDispatcherOptions,
  type SubagentStatus,
} from "../index.js";

describe("Built-in Extensions - Barrel & Integration", () => {
  it("exports all default extensions and helpers from builtins barrel and root extensions module", () => {
    // 1. Direct barrel exports
    expect(gitCheckpointExtension).toBeDefined();
    expect(safetyGateExtension).toBeDefined();
    expect(scratchpadExtension).toBeDefined();
    expect(subagentDispatcherExtension).toBeDefined();
    expect(registerDefaultExtensions).toBeDefined();
    expect(typeof registerDefaultExtensions).toBe("function");

    // 2. Namespace export `builtins`
    expect(builtins.gitCheckpointExtension).toBe(gitCheckpointExtension);
    expect(builtins.safetyGateExtension).toBe(safetyGateExtension);
    expect(builtins.scratchpadExtension).toBe(scratchpadExtension);
    expect(builtins.subagentDispatcherExtension).toBe(subagentDispatcherExtension);
    expect(builtins.registerDefaultExtensions).toBe(registerDefaultExtensions);

    // 3. Factory functions
    expect(typeof createGitCheckpointExtension).toBe("function");
    expect(typeof createSafetyGateExtension).toBe("function");
    expect(typeof createScratchpadExtension).toBe("function");
    expect(typeof createSubagentDispatcherExtension).toBe("function");

    // 4. Tools exports
    expect(listCheckpointsTool.name).toBe("git_list_checkpoints");
    expect(restoreCheckpointTool.name).toBe("git_restore_checkpoint");
    expect(scratchpadWriteTool.name).toBe("scratchpad_write");
    expect(scratchpadReadTool.name).toBe("scratchpad_read");
    expect(scratchpadClearTool.name).toBe("scratchpad_clear");
  });

  it("registers all default extensions cleanly onto an ExtensionRegistry", async () => {
    const registry = new ExtensionRegistry();
    await registerDefaultExtensions(registry);

    const activeExtensions = registry.getActiveExtensions();
    expect(activeExtensions).toContain("gitCheckpoint");
    expect(activeExtensions).toContain("safetyGate");
    expect(activeExtensions).toContain("scratchpad");
    expect(activeExtensions).toContain("subagentDispatcher");
    expect(activeExtensions.length).toBe(4);

    // Verify all tools from default extensions are registered
    expect(registry.hasTool("git_list_checkpoints")).toBe(true);
    expect(registry.hasTool("git_restore_checkpoint")).toBe(true);
    expect(registry.hasTool("scratchpad_write")).toBe(true);
    expect(registry.hasTool("scratchpad_read")).toBe(true);
    expect(registry.hasTool("scratchpad_clear")).toBe(true);
    expect(registry.hasTool("delegate_subagent")).toBe(true);
  });

  it("intercepts tool_call events via safetyGate to block destructive commands", async () => {
    const registry = new ExtensionRegistry();
    await registerDefaultExtensions(registry);

    // Safe command dispatch passes with no errors
    const safeDispatch = await registry.dispatch("tool_call", {
      toolName: "bash",
      args: { command: "echo 'hello safe world'" },
    });
    expect(safeDispatch.errors.length).toBe(0);

    // Destructive command dispatch is caught and blocked by safetyGate
    const dangerousDispatch = await registry.dispatch("tool_call", {
      toolName: "bash",
      args: { command: "rm -rf /" },
    });

    expect(dangerousDispatch.errors.length).toBe(1);
    const errorEntry = dangerousDispatch.errors[0]?.error;
    expect(errorEntry).toBeInstanceOf(SafetyGateError);
    if (errorEntry instanceof SafetyGateError) {
      expect(errorEntry.ruleId).toBe("rm-rf-root-or-home");
      expect(errorEntry.toolName).toBe("bash");
      expect(errorEntry.severity).toBe("critical");
    }

    // Direct command validation throws SafetyGateError
    expect(() => validateCommand("mkfs.ext4 /dev/sda1", "terminal")).toThrow(
      SafetyGateError,
    );

    // Check command safety helper
    const checkRes: SafetyCheckResult = checkCommandSafety("rm -rf ~");
    expect(checkRes.isSafe).toBe(false);
    expect(checkRes.matchedRule?.id).toBe("rm-rf-root-or-home");
  });

  it("intercepts turn_start events via gitCheckpoint without crashing", async () => {
    const registry = new ExtensionRegistry();
    await registerDefaultExtensions(registry);

    const dispatchResult = await registry.dispatch("turn_start", {
      turnId: "turn_integration_test_1",
      threadId: "thread_integration_test_1",
      metadata: {
        cwd: "/tmp/non-existent-git-test-path",
      },
    });

    expect(dispatchResult.errors.length).toBe(0);
  });

  it("executes scratchpad tools with persistent memory across multiple calls", async () => {
    const registry = new ExtensionRegistry();
    await registerDefaultExtensions(registry);

    // 1. Write note
    const writeRes = (await registry.executeTool("scratchpad_write", {
      key: "task_plan",
      content: "Phase 1: Build extension barrel",
    })) as ScratchpadWriteResult;

    expect(writeRes.success).toBe(true);
    expect(writeRes.key).toBe("task_plan");
    expect(writeRes.bytesWritten).toBeGreaterThan(0);

    // 2. Append to note
    const appendRes = (await registry.executeTool("scratchpad_write", {
      key: "task_plan",
      content: "Phase 2: Write tests",
      append: true,
    })) as ScratchpadWriteResult;

    expect(appendRes.success).toBe(true);

    // 3. Read note
    const readRes = (await registry.executeTool("scratchpad_read", {
      key: "task_plan",
    })) as ScratchpadReadResult;

    expect(readRes.found).toBe(true);
    expect(readRes.content).toBe(
      "Phase 1: Build extension barrel\nPhase 2: Write tests",
    );

    // 4. Clear specific note
    const clearRes = (await registry.executeTool("scratchpad_clear", {
      key: "task_plan",
    })) as ScratchpadClearResult;

    expect(clearRes.success).toBe(true);
    expect(clearRes.deleted).toBe(true);

    const readAfterClear = (await registry.executeTool("scratchpad_read", {
      key: "task_plan",
    })) as ScratchpadReadResult;

    expect(readAfterClear.found).toBe(false);
    expect(readAfterClear.content).toBeNull();
  });

  it("executes delegate_subagent tool and records dispatches in extension storage", async () => {
    const registry = new ExtensionRegistry();
    await registerDefaultExtensions(registry);

    const dispatchRes = (await registry.executeTool(
      "delegate_subagent",
      {
        agentRole: "code-analyzer",
        task: "Analyze cyclomatic complexity in builtins",
        context: { files: ["index.ts", "builtins.test.ts"] },
      },
      { threadId: "thread_main_worker" },
    )) as SubagentDispatchResult;

    expect(dispatchRes.success).toBe(true);
    expect(dispatchRes.agentRole).toBe("code-analyzer");
    expect(dispatchRes.status).toBe("dispatched");
    expect(dispatchRes.dispatchId).toMatch(/^sub_/);

    const storage = registry.createExtensionAPI("subagentDispatcher").storage;
    const records = storage.get<SubagentDispatchRecord[]>("dispatches");
    expect(Array.isArray(records)).toBe(true);
    expect(records?.length).toBe(1);
    expect(records?.[0]?.agentRole).toBe("code-analyzer");
  });

  it("executes git_list_checkpoints tool cleanly from gitCheckpoint extension", async () => {
    const registry = new ExtensionRegistry();
    await registerDefaultExtensions(registry);

    const result = (await registry.executeTool("git_list_checkpoints", {
      threadId: "test_thread",
    })) as {
      checkpoints: unknown[];
      count: number;
      message?: string;
    };

    expect(Array.isArray(result.checkpoints)).toBe(true);
    expect(typeof result.count).toBe("number");
  });

  it("cleans up tools and subscriptions when an extension is unregistered", async () => {
    const registry = new ExtensionRegistry();
    await registerDefaultExtensions(registry);

    expect(registry.hasTool("scratchpad_write")).toBe(true);
    expect(registry.isExtensionRegistered("scratchpad")).toBe(true);

    // Unregister scratchpad
    const unregistered = await registry.unregisterExtension("scratchpad");
    expect(unregistered).toBe(true);
    expect(registry.isExtensionRegistered("scratchpad")).toBe(false);
    expect(registry.hasTool("scratchpad_write")).toBe(false);
    expect(registry.hasTool("scratchpad_read")).toBe(false);
    expect(registry.hasTool("scratchpad_clear")).toBe(false);

    // Other tools remain intact
    expect(registry.hasTool("delegate_subagent")).toBe(true);
    expect(registry.hasTool("git_list_checkpoints")).toBe(true);
    expect(registry.hasTool("git_restore_checkpoint")).toBe(true);
  });

  it("supports hot-reloading extensions cleanly", async () => {
    const registry = new ExtensionRegistry();
    await registerDefaultExtensions(registry);

    const customDispatcherExt = createSubagentDispatcherExtension({
      dispatcher: async (args: SubagentDispatchArgs) => ({
        customWorkerDispatched: true,
        role: args.agentRole,
        task: args.task,
      }),
    });

    await registry.reloadExtension("subagentDispatcher", customDispatcherExt);

    interface CustomDispatchEcho {
      customWorkerDispatched: boolean;
      role: string;
      task: string;
    }

    const reloadedResult = (await registry.executeTool("delegate_subagent", {
      agentRole: "security-auditor",
      task: "Verify safe shell execution regexes",
    })) as CustomDispatchEcho;

    expect(reloadedResult.customWorkerDispatched).toBe(true);
    expect(reloadedResult.role).toBe("security-auditor");
    expect(reloadedResult.task).toBe("Verify safe shell execution regexes");
  });

  it("supports clearing all extensions and tools at once", async () => {
    const registry = new ExtensionRegistry();
    await registerDefaultExtensions(registry);

    expect(registry.getActiveExtensions().length).toBe(4);
    await registry.clear();

    expect(registry.getActiveExtensions().length).toBe(0);
    expect(registry.listTools().length).toBe(0);
  });
});
