/**
 * Pattern screening for commands an agent is about to run.
 *
 * kone hands provider CLIs their own shells, and under `full-access` nothing
 * asks the user before a command runs — the mode exists precisely so nobody has
 * to sit there approving. That is the right default for work that is
 * recoverable: a bad edit is a diff away from undone. It is the wrong default
 * for the handful of commands that take the machine, not the worktree, with
 * them. This module names those, so the one rung with no human in it can still
 * refuse them.
 *
 * It is a screen, not a sandbox. The patterns catch the recognizable spelling of
 * a catastrophe; they do not survive an adversary, and anything that reaches a
 * shell through a script file or an alias is invisible to them. Real isolation
 * is the operating system's job.
 *
 * It also only reaches as far as each provider lets it. A screen has to sit on a
 * gate, and a gate only exists where the CLI still asks kone something before it
 * runs: Claude's PreToolUse hook, Cursor's and Droid's ACP permission request,
 * OpenCode's permission reply, and Antigravity's capture hook — which runs in a
 * process of its own, so the rules are shipped into it as data. Codex under
 * full-access asks nothing (`approvalPolicy: "never"`), so nothing here applies
 * to it. That is worth stating plainly rather than leaving the coverage to be
 * inferred from the module's name.
 */

import { z } from "zod";

import type { JsonValue } from "./lib-jsonValue.js";

export type CommandSeverity = "critical" | "high";

export interface DangerousPatternRule {
  id: string;
  name: string;
  pattern: RegExp;
  description: string;
  /**
   * `critical` — irreversible past the worktree: the disk, the machine, a
   * database. Refused outright on the rung that has no one to ask.
   * `high` — destructive but recoverable by someone who knows what they lost.
   * Reported, never refused.
   */
  severity: CommandSeverity;
}

export interface CommandSafetyResult {
  isSafe: boolean;
  matchedRule?: DangerousPatternRule;
  command: string;
}

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
    // The destination is what makes this dangerous, not `dd` itself. Matching
    // any `if=` caught `dd if=backup.img of=restore.img` — an ordinary file
    // copy — and refusing that on a rung with nobody to ask is a screen that
    // breaks work it was never meant to touch. `of=` pointing at a raw device
    // (or at a bare `/dev/…` at all) is the spelling that ends a disk.
    id: "dd-raw-write",
    name: "Raw Device Block Write (dd of=/dev/…)",
    pattern: /\bdd\s+(?:[^\s;&|]+\s+)*?of=(?:\/dev\/|["']\/dev\/)/i,
    description:
      "Direct block writes with dd onto a device node can overwrite partition tables, bootloaders, or disks.",
    severity: "critical",
  },
  {
    // Two conditions, because the bare string is not the command. It has to
    // START a statement — or a quoted one, which is how it reaches a shell at
    // all (`psql -c 'DROP DATABASE prod'`) — so `echo "never DROP DATABASE"`
    // does not match. And it has to NAME something, so `grep "DROP DATABASE"
    // migrations.sql` does not either: searching for the words is not saying
    // them. A refusal an agent learns to read as noise is worse than no screen.
    id: "drop-database",
    name: "Drop Database",
    pattern: /(?:^|[;&|(]|["'`]|\bDO\s|\bTHEN\s)\s*DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?[\w"'`]/i,
    description:
      "SQL command dropping an entire database schema and all associated records.",
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
  {
    // Deliberately not critical. Discarding uncommitted work is a real loss, but
    // it is a loss inside one repository that a reflog and a stash often undo —
    // and it is a legitimate move an agent cleaning up after itself will make.
    // Refusing it would break ordinary work to prevent an ordinary mistake.
    id: "git-reset-hard",
    name: "Hard Git Reset",
    pattern: /\bgit\s+(?:-[a-zA-Z0-9_-]+\s+)*reset\s+(?:-[a-zA-Z0-9_-]+\s+)*--hard\b/i,
    description:
      "Hard git reset irreversibly discards uncommitted workspace files and staged index changes.",
    severity: "high",
  },
];

/** Tool names that mean "this argument reaches a shell". */
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

/** The first rule a command trips, or safe. */
export function checkCommandSafety(
  command: string,
  rules: ReadonlyArray<DangerousPatternRule> = DEFAULT_DANGEROUS_PATTERNS,
): CommandSafetyResult {
  const trimmed = command.trim();
  if (trimmed === "") return { isSafe: true, command };

  for (const rule of rules) {
    if (rule.pattern.test(trimmed)) {
      return { isSafe: false, matchedRule: rule, command };
    }
  }

  return { isSafe: true, command };
}

/** A non-empty command string, or an argv-style list carrying one. */
const CommandText = z.string().trim().min(1);
const CommandField = z.union([CommandText, z.array(z.unknown())]);

/**
 * The shape of a tool call's arguments, as far as this module cares.
 *
 * Only command-bearing keys are declared. Scanning every string argument would
 * scan free-text fields too, so a `description` that merely mentions a
 * destructive command would block an otherwise harmless call. Each field
 * catches its own failure rather than failing the object, because one
 * unexpected value must not blind the screen to the others.
 *
 * `args` is here for the `command: "/bin/sh", args: ["-c", "..."]` spelling,
 * where the payload is in the list rather than the command.
 */
export const COMMAND_KEYS = [
  "command",
  "cmd",
  // Antigravity's shell tool spells it this way; the rest of the app never
  // sees the key, and a tool that does not carry it is unaffected.
  "CommandLine",
  "args",
  "script",
  "code",
  "input",
  "query",
  "statement",
  "exec",
] as const;

const OptionalCommand = CommandField.optional().catch(undefined);
const CommandBearingArgs = z.object({
  command: OptionalCommand,
  cmd: OptionalCommand,
  CommandLine: OptionalCommand,
  args: OptionalCommand,
  script: OptionalCommand,
  code: OptionalCommand,
  input: OptionalCommand,
  query: OptionalCommand,
  statement: OptionalCommand,
  exec: OptionalCommand,
});

/** The command strings inside a tool call's arguments, in declaration order. */
export function extractCommandsFromArgs(args: JsonValue | undefined): string[] {
  const parsed = CommandBearingArgs.safeParse(args);
  if (!parsed.success) return [];

  const extracted: string[] = [];
  for (const key of COMMAND_KEYS) {
    const value = parsed.data[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = CommandText.safeParse(item);
        if (text.success) extracted.push(text.data);
      }
      continue;
    }
    extracted.push(value);
  }
  return extracted;
}

/** Whether a tool name means a shell. */
export function isMonitoredTool(
  toolName: string,
  monitoredTools: ReadonlyArray<string> = DEFAULT_MONITORED_TOOLS,
): boolean {
  const normalized = toolName.toLowerCase().trim();
  // Match on whole name segments only. Loose substring containment would treat
  // any tool whose name merely contains "sh", "cmd", "exec" or "process" —
  // `publish`, `preprocess_data` — as a command runner.
  const segments = new Set(normalized.split(/[^a-z0-9]+/).filter(Boolean));
  for (const item of monitoredTools) {
    const normItem = item.toLowerCase().trim();
    if (normalized === normItem || segments.has(normItem)) return true;
  }
  return false;
}

export interface ScreenedToolCall {
  /** The matched rule, or undefined when nothing matched. */
  rule?: DangerousPatternRule;
  /** The offending command, for the refusal message and the log line. */
  command?: string;
}

/**
 * Screen one tool call. Returns `{}` for a call that is not a shell, carries no
 * command, or trips nothing.
 *
 * The caller decides what a match costs: severity is reported, not enforced
 * here, because the same rule means "refuse" on a rung with nobody to ask and
 * "say so" on a rung where the user is already approving each call.
 */
export function screenToolCall(input: {
  toolName: string;
  /** The provider's tool input, exactly as it arrived: JSON kone has not
   *  interpreted. `CommandBearingArgs` is the parser for it. */
  args: JsonValue | undefined;
  rules?: ReadonlyArray<DangerousPatternRule>;
  monitoredTools?: ReadonlyArray<string>;
}): ScreenedToolCall {
  if (!isMonitoredTool(input.toolName, input.monitoredTools ?? DEFAULT_MONITORED_TOOLS)) return {};

  for (const command of extractCommandsFromArgs(input.args)) {
    const result = checkCommandSafety(command, input.rules ?? DEFAULT_DANGEROUS_PATTERNS);
    if (!result.isSafe && result.matchedRule) {
      return { rule: result.matchedRule, command };
    }
  }
  return {};
}

/** The line shown to the agent when a call is refused, and logged when it is not. */
export function describeScreenedCall(screened: Required<ScreenedToolCall>): string {
  return `${screened.rule.name} (${screened.rule.id}) — ${screened.rule.description} Command: ${screened.command}`;
}
