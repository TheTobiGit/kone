/**
 * Safety Gate Built-in Extension for Agent-Core.
 * Automatically hooks into `tool_call` lifecycle events for command execution tools
 * (`bash`, `exec`, `terminal`, `sh`, `shell`, etc.) and scans commands against
 * dangerous, destructive, or catastrophic patterns, blocking them with a descriptive error.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionModule,
  ToolCallEvent,
} from "../types.js";

/**
 * Definition of a safety rule for detecting dangerous commands.
 */
export interface DangerousPatternRule {
  id: string;
  name: string;
  pattern: RegExp;
  description: string;
  severity: "critical" | "high";
}

/**
 * Result of checking a command against safety rules.
 */
export interface SafetyCheckResult {
  isSafe: boolean;
  matchedRule?: DangerousPatternRule;
  command: string;
}

/**
 * Error thrown when a command matches a dangerous pattern rule and is blocked.
 */
export class SafetyGateError extends Error {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly command: string;
  readonly toolName: string;
  readonly severity: "critical" | "high";

  constructor(options: {
    ruleId: string;
    ruleName: string;
    description: string;
    command: string;
    toolName: string;
    severity?: "critical" | "high";
  }) {
    const message = `[SafetyGate] Blocked dangerous command in tool "${options.toolName}": "${options.command}". Rule: ${options.ruleName} (${options.ruleId}) - ${options.description}`;
    super(message);
    this.name = "SafetyGateError";
    this.ruleId = options.ruleId;
    this.ruleName = options.ruleName;
    this.command = options.command;
    this.toolName = options.toolName;
    this.severity = options.severity ?? "critical";
  }
}

/**
 * Default set of dangerous pattern rules checking for catastrophic commands.
 */
export const DEFAULT_DANGEROUS_PATTERNS: ReadonlyArray<DangerousPatternRule> = [
  {
    id: "rm-rf-root-or-home",
    name: "Recursive Root/Home Deletion",
    pattern:
      /\brm\s+(?:.*?\s+)?(?:-[a-zA-Z0-9_-]*r[a-zA-Z0-9_-]*f[a-zA-Z0-9_-]*|-[a-zA-Z0-9_-]*f[a-zA-Z0-9_-]*r[a-zA-Z0-9_-]*|-[a-zA-Z0-9_-]*r[a-zA-Z0-9_-]*\s+-[a-zA-Z0-9_-]*f[a-zA-Z0-9_-]*|-[a-zA-Z0-9_-]*f[a-zA-Z0-9_-]*\s+-[a-zA-Z0-9_-]*r[a-zA-Z0-9_-]*|--recursive\s+--force|--force\s+--recursive|--no-preserve-root)(?:.*?\s+)?(?:\/|\/\*|~|\$HOME|"\$HOME"|'~'|'\/')(?:\s|$|;|&|\|)/i,
    description:
      "Destructive recursive deletion targeting the root directory or user home folder.",
    severity: "critical",
  },
  {
    id: "mkfs-format",
    name: "Filesystem Formatting",
    pattern: /\bmkfs(?:\.[a-zA-Z0-9_-]+)?\b/i,
    description:
      "Formatting a filesystem destroys existing partition tables and all data.",
    severity: "critical",
  },
  {
    id: "dd-raw-write",
    name: "Raw Device Block Write (dd if=)",
    pattern: /\bdd\s+.*?\bif=\S+/i,
    description:
      "Direct block writes with dd can overwrite partition tables, bootloaders, or disks.",
    severity: "critical",
  },
  {
    id: "drop-database",
    name: "Drop Database",
    pattern: /\bDROP\s+DATABASE\b/i,
    description:
      "SQL command dropping an entire database schema and all associated records.",
    severity: "critical",
  },
  {
    id: "git-reset-hard",
    name: "Hard Git Reset",
    pattern: /\bgit\s+(?:-[a-zA-Z0-9_-]+\s+)*reset\s+(?:-[a-zA-Z0-9_-]+\s+)*--hard\b/i,
    description:
      "Hard git reset irreversibly discards uncommitted workspace files and staged index changes.",
    severity: "critical",
  },
  {
    id: "shell-fork-bomb",
    name: "Shell Fork Bomb",
    pattern: /:\(\)\s*\{\s*:\|:&\s*\};:|:\(\)\{\s*:\s*\|\s*:\s*&\s*\};:/i,
    description:
      "Process multiplication fork bomb designed to exhaust system resources.",
    severity: "critical",
  },
  {
    id: "raw-device-redirection",
    name: "Device Node Overwrite",
    pattern: />\s*\/dev\/(?:sd[a-z]|nvme\d+n\d+|hd[a-z]|vd[a-z]|loop\d+)/i,
    description:
      "Direct stream redirection into raw disk device nodes destroys filesystem structures.",
    severity: "critical",
  },
];

/**
 * Default tool names monitored by the safety gate.
 */
export const DEFAULT_MONITORED_TOOLS: ReadonlyArray<string> = [
  "bash",
  "exec",
  "terminal",
  "sh",
  "shell",
  "cmd",
  "execute_command",
  "process",
  "subprocess",
  "run_command",
];

export interface SafetyGateOptions {
  /**
   * Custom list of dangerous pattern rules.
   * If omitted, `DEFAULT_DANGEROUS_PATTERNS` is used.
   */
  rules?: DangerousPatternRule[];
  /**
   * List of tool names to monitor for dangerous command patterns.
   * If omitted, `DEFAULT_MONITORED_TOOLS` is used.
   */
  monitoredTools?: string[];
  /**
   * Whether to throw a `SafetyGateError` on violation ("throw") or only log a warning ("log").
   * Defaults to "throw".
   */
  blockAction?: "throw" | "log";
  /**
   * Optional callback invoked whenever a command is blocked.
   */
  onBlocked?: (event: {
    rule: DangerousPatternRule;
    command: string;
    toolName: string;
    context: ExtensionContext;
  }) => void;
}

/**
 * Checks a single command string against a list of dangerous pattern rules.
 */
export function checkCommandSafety(
  command: string,
  rules: ReadonlyArray<DangerousPatternRule> = DEFAULT_DANGEROUS_PATTERNS,
): SafetyCheckResult {
  const trimmed = command.trim();
  if (trimmed === "") {
    return { isSafe: true, command };
  }

  for (const rule of rules) {
    if (rule.pattern.test(trimmed)) {
      return {
        isSafe: false,
        matchedRule: rule,
        command,
      };
    }
  }

  return { isSafe: true, command };
}

/**
 * Validates a command string and throws a `SafetyGateError` if it violates any safety rules.
 */
export function validateCommand(
  command: string,
  toolName = "terminal",
  rules: ReadonlyArray<DangerousPatternRule> = DEFAULT_DANGEROUS_PATTERNS,
): void {
  const result = checkCommandSafety(command, rules);
  if (!result.isSafe && result.matchedRule) {
    throw new SafetyGateError({
      ruleId: result.matchedRule.id,
      ruleName: result.matchedRule.name,
      description: result.matchedRule.description,
      command,
      toolName,
      severity: result.matchedRule.severity,
    });
  }
}

/**
 * Extracts candidate command strings from tool call arguments.
 */
export function extractCommandsFromArgs(args: Record<string, unknown>): string[] {
  const extracted: string[] = [];
  const primaryKeys: Record<string, true> = {
    command: true,
    cmd: true,
    script: true,
    code: true,
    input: true,
    query: true,
    statement: true,
    exec: true,
  };

  for (const key of Object.keys(primaryKeys)) {
    const val = args[key];
    if (typeof val === "string" && val.trim().length > 0) {
      extracted.push(val);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string" && item.trim().length > 0) {
          extracted.push(item);
        }
      }
    }
  }

  // Also check other string/array args for dangerous shell commands
  for (const [key, val] of Object.entries(args)) {
    if (primaryKeys[key]) {
      continue;
    }
    if (typeof val === "string" && val.trim().length > 0) {
      extracted.push(val);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string" && item.trim().length > 0) {
          extracted.push(item);
        }
      }
    }
  }

  return extracted;
}

/**
 * Determines whether a given tool name is monitored by the safety gate.
 */
export function isMonitoredTool(
  toolName: string,
  monitoredTools: ReadonlyArray<string>,
): boolean {
  const normalized = toolName.toLowerCase().trim();
  for (const item of monitoredTools) {
    const normItem = item.toLowerCase().trim();
    if (
      normalized === normItem ||
      normalized.includes(normItem) ||
      normItem.includes(normalized)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Processes a `tool_call` event and blocks execution if dangerous patterns are detected.
 */
export async function handleToolCallSafetyCheck(
  payload: ToolCallEvent,
  context: ExtensionContext,
  api: ExtensionAPI,
  options?: SafetyGateOptions,
): Promise<void> {
  // Only inspect pre-execution tool calls (skip post-execution result/error events)
  if (
    payload.result !== undefined ||
    payload.isError !== undefined ||
    payload.error !== undefined
  ) {
    return;
  }

  const monitoredTools = options?.monitoredTools ?? DEFAULT_MONITORED_TOOLS;
  if (!isMonitoredTool(payload.toolName, monitoredTools)) {
    return;
  }

  const rules = options?.rules ?? DEFAULT_DANGEROUS_PATTERNS;
  const commands = extractCommandsFromArgs(payload.args);

  for (const command of commands) {
    const result = checkCommandSafety(command, rules);
    if (!result.isSafe && result.matchedRule) {
      const rule = result.matchedRule;
      const error = new SafetyGateError({
        ruleId: rule.id,
        ruleName: rule.name,
        description: rule.description,
        command,
        toolName: payload.toolName,
        severity: rule.severity,
      });

      api.logger.error(
        `SafetyGate blocked execution of dangerous command in "${payload.toolName}": "${command}" (Rule: ${rule.name})`,
      );

      // Record blocked event in extension storage
      context.storage.set("lastBlockedCommand", {
        toolName: payload.toolName,
        command,
        ruleId: rule.id,
        timestamp: Date.now(),
      });

      const currentBlockedCount =
        context.storage.get<number>("blockedCommandsCount") ?? 0;
      context.storage.set("blockedCommandsCount", currentBlockedCount + 1);

      if (options?.onBlocked) {
        options.onBlocked({
          rule,
          command,
          toolName: payload.toolName,
          context,
        });
      }

      if (options?.blockAction !== "log") {
        throw error;
      }
    }
  }
}

/**
 * Factory to create a Safety Gate extension module with custom options.
 */
export function createSafetyGateExtension(
  options?: SafetyGateOptions,
): ExtensionModule {
  return {
    name: "safetyGate",
    version: "1.0.0",
    activate: (api: ExtensionAPI) => {
      api.on("tool_call", async (payload, context) => {
        await handleToolCallSafetyCheck(payload, context, api, options);
      });
    },
  };
}

/**
 * Standard default Safety Gate extension instance.
 */
export const safetyGateExtension: ExtensionModule = createSafetyGateExtension();

export const safetyGate = safetyGateExtension;

export default safetyGateExtension;
