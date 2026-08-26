import { describe, expect, it } from "bun:test";
import { ExtensionRegistry } from "../ExtensionRegistry.js";
import {
  checkCommandSafety,
  createSafetyGateExtension,
  DEFAULT_DANGEROUS_PATTERNS,
  extractCommandsFromArgs,
  isMonitoredTool,
  SafetyGateError,
  safetyGateExtension,
  validateCommand,
  type DangerousPatternRule,
} from "./safetyGate.js";

describe("safetyGate - Pattern Matching", () => {
  it("detects and flags recursive root deletion (rm -rf /)", () => {
    const dangerousCommands = [
      "rm -rf /",
      "rm -fr /",
      "rm -r -f /",
      "rm -f -r /",
      "rm -rf /*",
      "rm -rf ~",
      "rm -rf $HOME",
      'rm -rf "$HOME"',
      "rm --recursive --force /",
      "rm -rf / --no-preserve-root",
      "rm --no-preserve-root -rf /",
      "rm -rf / ; ls",
      "echo hi && rm -rf /",
    ];

    for (const cmd of dangerousCommands) {
      const result = checkCommandSafety(cmd);
      expect(result.isSafe).toBe(false);
      expect(result.matchedRule?.id).toBe("rm-rf-root-or-home");
    }
  });

  it("detects filesystem formatting commands (mkfs)", () => {
    const formatCommands = [
      "mkfs.ext4 /dev/sda1",
      "mkfs.vfat /dev/nvme0n1p1",
      "mkfs.xfs -f /dev/sdb",
      "mkfs /dev/sdc",
      "sudo mkfs.btrfs /dev/sda2",
    ];

    for (const cmd of formatCommands) {
      const result = checkCommandSafety(cmd);
      expect(result.isSafe).toBe(false);
      expect(result.matchedRule?.id).toBe("mkfs-format");
    }
  });

  it("detects raw disk writing with dd (dd if=)", () => {
    const ddCommands = [
      "dd if=/dev/zero of=/dev/sda bs=1M",
      "dd if=/dev/urandom of=/dev/nvme0n1",
      "dd if=boot.img of=/dev/sdb",
    ];

    for (const cmd of ddCommands) {
      const result = checkCommandSafety(cmd);
      expect(result.isSafe).toBe(false);
      expect(result.matchedRule?.id).toBe("dd-raw-write");
    }
  });

  it("detects database drop statements (DROP DATABASE)", () => {
    const sqlCommands = [
      "DROP DATABASE production;",
      "drop database staging",
      "DROP DATABASE IF EXISTS test_db;",
      "psql -c 'DROP DATABASE main;'",
    ];

    for (const cmd of sqlCommands) {
      const result = checkCommandSafety(cmd);
      expect(result.isSafe).toBe(false);
      expect(result.matchedRule?.id).toBe("drop-database");
    }
  });

  it("detects destructive hard git resets (git reset --hard)", () => {
    const gitCommands = [
      "git reset --hard",
      "git reset --hard HEAD~1",
      "git reset --hard origin/main",
      "git reset -q --hard",
    ];

    for (const cmd of gitCommands) {
      const result = checkCommandSafety(cmd);
      expect(result.isSafe).toBe(false);
      expect(result.matchedRule?.id).toBe("git-reset-hard");
    }
  });

  it("detects shell fork bombs and raw device node overwrites", () => {
    expect(checkCommandSafety(":(){ :|:& };:").isSafe).toBe(false);
    expect(checkCommandSafety("cat payload > /dev/sda").isSafe).toBe(false);
  });

  it("allows safe commands to pass without flagging", () => {
    const safeCommands = [
      "ls -la",
      "git status",
      "git log -n 5",
      "git reset --soft HEAD~1",
      "rm ./temp.txt",
      "rm -f build/bundle.js",
      "npm test",
      "bun run build",
      "echo 'Hello world'",
      "mkdir -p src/components",
    ];

    for (const cmd of safeCommands) {
      const result = checkCommandSafety(cmd);
      expect(result.isSafe).toBe(true);
      expect(result.matchedRule).toBeUndefined();
    }
  });
});

describe("safetyGate - validateCommand and extractCommandsFromArgs", () => {
  it("throws SafetyGateError on dangerous command via validateCommand", () => {
    expect(() => validateCommand("rm -rf /", "bash")).toThrow(SafetyGateError);

    try {
      validateCommand("mkfs.ext4 /dev/sda", "terminal");
    } catch (err) {
      expect(err instanceof SafetyGateError).toBe(true);
      if (err instanceof SafetyGateError) {
        expect(err.ruleId).toBe("mkfs-format");
        expect(err.toolName).toBe("terminal");
        expect(err.message).toContain("[SafetyGate]");
      }
    }
  });

  it("does not throw on safe command via validateCommand", () => {
    expect(() => validateCommand("echo test", "bash")).not.toThrow();
  });

  it("extracts command strings from various argument fields and arrays", () => {
    const args = {
      command: "git reset --hard",
      script: "rm -rf /",
      args: ["-c", "mkfs.ext4 /dev/sda"],
      code: "echo ok",
    };

    const extracted = extractCommandsFromArgs(args);
    expect(extracted).toContain("git reset --hard");
    expect(extracted).toContain("rm -rf /");
    expect(extracted).toContain("-c");
    expect(extracted).toContain("mkfs.ext4 /dev/sda");
    expect(extracted).toContain("echo ok");
  });

  it("identifies monitored tools correctly", () => {
    const monitored = ["bash", "exec", "terminal"];
    expect(isMonitoredTool("bash", monitored)).toBe(true);
    expect(isMonitoredTool("BASH", monitored)).toBe(true);
    expect(isMonitoredTool("terminal_exec", monitored)).toBe(true);
    expect(isMonitoredTool("file_reader", monitored)).toBe(false);
  });
});

describe("safetyGate - Extension Integration with ExtensionRegistry", () => {
  it("blocks dangerous command on tool_call dispatch and records in storage", async () => {
    const registry = new ExtensionRegistry();
    const api = await registry.registerExtension("safetyGate", safetyGateExtension);

    const dispatchResult = await registry.dispatch("tool_call", {
      toolName: "bash",
      args: { command: "rm -rf /" },
    });

    expect(dispatchResult.errors.length).toBe(1);
    expect(dispatchResult.errors[0]?.error instanceof SafetyGateError).toBe(true);

    const storage = api.storage;
    const blockedCount = storage.get<number>("blockedCommandsCount");
    expect(blockedCount).toBe(1);

    const lastBlocked = storage.get<{
      toolName: string;
      command: string;
      ruleId: string;
    }>("lastBlockedCommand");
    expect(lastBlocked?.command).toBe("rm -rf /");
    expect(lastBlocked?.ruleId).toBe("rm-rf-root-or-home");
  });

  it("allows safe commands on tool_call dispatch without errors", async () => {
    const registry = new ExtensionRegistry();
    await registry.registerExtension("safetyGate", safetyGateExtension);

    const dispatchResult = await registry.dispatch("tool_call", {
      toolName: "bash",
      args: { command: "git status" },
    });

    expect(dispatchResult.errors.length).toBe(0);
  });

  it("ignores post-execution tool_call events", async () => {
    const registry = new ExtensionRegistry();
    await registry.registerExtension("safetyGate", safetyGateExtension);

    // If result is present, tool has already executed — should not throw
    const dispatchResult = await registry.dispatch("tool_call", {
      toolName: "bash",
      args: { command: "rm -rf /" },
      result: "executed",
    });

    expect(dispatchResult.errors.length).toBe(0);
  });

  it("ignores unmonitored tool names", async () => {
    const registry = new ExtensionRegistry();
    await registry.registerExtension("safetyGate", safetyGateExtension);

    const dispatchResult = await registry.dispatch("tool_call", {
      toolName: "sql_runner",
      args: { query: "DROP DATABASE users" },
    });

    // Default monitored tools list command runners; sql_runner is not in default monitored tools
    expect(dispatchResult.errors.length).toBe(0);
  });

  it("supports custom rules and onBlocked callback", async () => {
    const blockedCalls: Array<{ ruleId: string; command: string }> = [];

    const customRule: DangerousPatternRule = {
      id: "custom-forbidden",
      name: "Custom Forbidden Tool",
      pattern: /\bformat-c\b/i,
      description: "Custom format forbidden",
      severity: "high",
    };

    const customExtension = createSafetyGateExtension({
      rules: [customRule, ...DEFAULT_DANGEROUS_PATTERNS],
      onBlocked: ({ rule, command }) => {
        blockedCalls.push({ ruleId: rule.id, command });
      },
    });

    const registry = new ExtensionRegistry();
    await registry.registerExtension("customSafety", customExtension);

    const dispatchResult = await registry.dispatch("tool_call", {
      toolName: "exec",
      args: { command: "format-c" },
    });

    expect(dispatchResult.errors.length).toBe(1);
    expect(blockedCalls.length).toBe(1);
    expect(blockedCalls[0]?.ruleId).toBe("custom-forbidden");
  });

  it("supports blockAction: 'log' to warn without throwing errors", async () => {
    const logOnlyExtension = createSafetyGateExtension({
      blockAction: "log",
    });

    const registry = new ExtensionRegistry();
    await registry.registerExtension("logSafety", logOnlyExtension);

    const dispatchResult = await registry.dispatch("tool_call", {
      toolName: "bash",
      args: { command: "rm -rf /" },
    });

    expect(dispatchResult.errors.length).toBe(0);
  });
});
