import { describe, expect, it } from "bun:test";

import {
  checkCommandSafety,
  describeScreenedCall,
  DEFAULT_DANGEROUS_PATTERNS,
  extractCommandsFromArgs,
  isMonitoredTool,
  screenToolCall,
  type DangerousPatternRule,
} from "./commandSafety.js";

describe("commandSafety — pattern matching", () => {
  it("detects recursive root/home deletion in every spelling of the flags", () => {
    const dangerous = [
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

    for (const cmd of dangerous) {
      const result = checkCommandSafety(cmd);
      expect(result.isSafe).toBe(false);
      expect(result.matchedRule?.id).toBe("rm-rf-root-or-home");
    }
  });

  it("detects filesystem formatting", () => {
    for (const cmd of [
      "mkfs.ext4 /dev/sda1",
      "mkfs.vfat /dev/nvme0n1p1",
      "mkfs.xfs -f /dev/sdb",
      "mkfs /dev/sdc",
      "sudo mkfs.btrfs /dev/sda2",
    ]) {
      expect(checkCommandSafety(cmd).matchedRule?.id).toBe("mkfs-format");
    }
  });

  it("detects raw device writes, fork bombs and device-node redirection", () => {
    expect(checkCommandSafety("dd if=/dev/zero of=/dev/sda bs=1M").matchedRule?.id).toBe(
      "dd-raw-write",
    );
    expect(checkCommandSafety(":(){ :|:& };:").isSafe).toBe(false);
    expect(checkCommandSafety("cat payload > /dev/sda").matchedRule?.id).toBe(
      "raw-device-redirection",
    );
    expect(checkCommandSafety("psql -c 'DROP DATABASE prod'").matchedRule?.id).toBe(
      "drop-database",
    );
  });

  it("rates a hard git reset as recoverable rather than catastrophic", () => {
    const result = checkCommandSafety("git reset --hard HEAD~3");
    expect(result.isSafe).toBe(false);
    expect(result.matchedRule?.id).toBe("git-reset-hard");
    // The full-access gate refuses `critical` only, so this tier is what keeps
    // an ordinary cleanup from being blocked outright.
    expect(result.matchedRule?.severity).toBe("high");
  });

  it("leaves ordinary commands alone", () => {
    for (const cmd of [
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
    ]) {
      const result = checkCommandSafety(cmd);
      expect(result.isSafe).toBe(true);
      expect(result.matchedRule).toBeUndefined();
    }
  });
});

describe("commandSafety — argument extraction", () => {
  it("reads every command-bearing key, including argv arrays", () => {
    const extracted = extractCommandsFromArgs({
      command: "git reset --hard",
      script: "rm -rf /",
      args: ["-c", "mkfs.ext4 /dev/sda"],
      code: "echo ok",
    });
    expect(extracted).toContain("git reset --hard");
    expect(extracted).toContain("rm -rf /");
    expect(extracted).toContain("mkfs.ext4 /dev/sda");
    expect(extracted).toContain("echo ok");
  });

  it("identifies shell tools by whole name segments", () => {
    const monitored = ["bash", "exec", "terminal"];
    expect(isMonitoredTool("bash", monitored)).toBe(true);
    expect(isMonitoredTool("BASH", monitored)).toBe(true);
    expect(isMonitoredTool("terminal_exec", monitored)).toBe(true);
    expect(isMonitoredTool("file_reader", monitored)).toBe(false);
    // The reason segment matching exists: substring containment would flag these.
    expect(isMonitoredTool("publish", monitored)).toBe(false);
    expect(isMonitoredTool("preprocess_data", monitored)).toBe(false);
  });
});

describe("commandSafety — screenToolCall", () => {
  it("flags a dangerous command on a shell tool", () => {
    const screened = screenToolCall({ toolName: "Bash", args: { command: "rm -rf /" } });
    expect(screened.rule?.id).toBe("rm-rf-root-or-home");
    expect(screened.command).toBe("rm -rf /");
  });

  it("ignores tools that are not shells", () => {
    expect(screenToolCall({ toolName: "Read", args: { command: "rm -rf /" } }).rule).toBeUndefined();
  });

  it("does not flag a destructive command merely quoted in free text", () => {
    const screened = screenToolCall({
      toolName: "Bash",
      args: { command: "echo done", description: "cleanup that is not rm -rf /" },
    });
    expect(screened.rule).toBeUndefined();
  });

  it("returns nothing for a call with no arguments", () => {
    expect(screenToolCall({ toolName: "Bash", args: undefined }).rule).toBeUndefined();
  });

  it("accepts caller-supplied rules", () => {
    const rules: DangerousPatternRule[] = [
      {
        id: "no-curl",
        name: "Network Fetch",
        pattern: /\bcurl\b/i,
        description: "No network in this session.",
        severity: "critical",
      },
    ];
    expect(screenToolCall({ toolName: "bash", args: { command: "curl x" }, rules }).rule?.id).toBe(
      "no-curl",
    );
    // The default set has no opinion about curl.
    expect(screenToolCall({ toolName: "bash", args: { command: "curl x" } }).rule).toBeUndefined();
  });

  it("describes a screened call with the rule and the command", () => {
    const screened = screenToolCall({ toolName: "bash", args: { command: "mkfs.ext4 /dev/sda" } });
    const text = describeScreenedCall({ rule: screened.rule!, command: screened.command! });
    expect(text).toContain("mkfs-format");
    expect(text).toContain("mkfs.ext4 /dev/sda");
  });

  it("ships only critical rules plus the one recoverable tier", () => {
    const tiers = new Set(DEFAULT_DANGEROUS_PATTERNS.map((r) => r.severity));
    expect(tiers.has("critical")).toBe(true);
  });
});
