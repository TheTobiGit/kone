import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ANTGRAVITY_BINARY,
  antigravityTranscriptPath,
  buildAntigravityEnv,
  buildAntigravityProbeEnv,
  parseAntigravityVersion,
  resolveAntigravityBinary,
} from "../antigravityHome.js";
import {
  parseCreatedSubagents,
  parseInboundMessage,
  parseInvokeSubagentSpecs,
  type AntigravityJsonRecord,
  type AntigravityJsonValue,
  type AntigravitySubagentSpec,
} from "../antigravitySubagents.js";
import { koneHostContextForFirstRun } from "../gateway/appContext.js";
import { STDIO_PROXY_PATH } from "../gateway/injection.js";
import { killTree, probeResult } from "../spawn.js";
import { versionProbeFailure, versionProbeUsable } from "../providerHealth.js";
import {
  COMMAND_KEYS,
  DEFAULT_DANGEROUS_PATTERNS,
  DEFAULT_MONITORED_TOOLS,
} from "../commandSafety.js";
import {
  readAntigravityConversationUsage,
  resolveAntigravityContextWindow,
} from "../usage/local/antigravityScan.js";
import type { TokenUsageSplits } from "../usage/report.js";
import type {
  AdapterCapabilities,
  AgentPersona,
  EmitEvent,
  GatewayConnection,
  InteractionMode,
  ModelDescriptor,
  ProviderAdapter,
  ProviderConfig,
  ProviderStatus,
  RuntimeItem,
  RuntimeItemKind,
  RuntimeEvent,
  Session,
  SendTurnInput,
  SessionStartInput,
  SubagentRunSnapshot,
  SubagentStatus,
  TokenUsage,
  TurnStartResult,
} from "../types.js";

// Antigravity adapter — drives Google's `agy` CLI in print mode: one fresh
// process per turn (`agy -p`), the transcript it writes under
// ~/.gemini/antigravity-cli/brain/<conversationId>/ as the turn-rendering
// source, and a globally-installed "kone-capture" plugin whose hooks stream
// tool lifecycle + conversation identity to a per-turn file the adapter polls.
//
// for provider/process work — see AGENTS.md), rewritten in kone's plain-TS
// main-process style. All protocol facts below were verified there against the
// live CLI:
//
//  1. Print mode cannot pause for interactive approvals. `agy -p` either runs
//     with `--dangerously-skip-permissions` (full access) or asks at the
//     terminal — which a kone child has none of. So the session REQUIRES
//     full-access; the mode validation rejects everything else (same wording
//  2. `agy models` prints one row per (model, effort) combination — either
//     `Display Name (Effort)` or, on newer builds, `slug<TAB>Display Name
//     (Effort)`. kone collapses those rows into base models with an effort
//     ladder and rebuilds the exact `--model` label at dispatch
//     (resolveAntigravityCliModelLabel).
//  3. The capture plugin's hooks fire for EVERY agy session (global install).
//     Outside kone-managed sessions (no KONE_ANTIGRAVITY_EVENTS) the hook
//     wrapper must carry explicit decisions where the CLI expects them:
//     `{"decision":"ask"}` on PreToolUse and `{"decision":"allow"}` on
//     PreInvocation — an empty object is treated as a denial with an empty
//     reason, which blocks every tool call on PreToolUse and refuses the
//     subagent launch PreInvocation gates (the parent then exits 1).
//     Stop hooks stay `{}`: `{"decision":"stop"}` is not a valid stop
//     decision and can hang the print process after the reply.
//  4. The mcp_config.json in the plugin is secret-free: it references
//     `$KONE_GATEWAY_URL` / `$KONE_GATEWAY_BOOTSTRAP_TOKEN` env placeholders
//     the CLI process env supplies per turn, and the spawned stdio proxy
//     exchanges the single-use bootstrap at POST /bootstrap for the real
//     session token — which never enters the CLI process env, so exec-tool
//     descendants can't inherit it (see gateway/stdioProxy.mjs).
//  5. Windows: the prompt rides `-p` as a command-line argument, so it is
//  6. Native subagents (`invoke_subagent`) are separate conversations that
//     outlive the tool call that made them, and every artifact names the
//     conversation it belongs to: hook lines carry the child's id, the result
//     step carries the child's transcript path, and the child's report arrives
//     as a message to the parent signed with that same id. The Stop hook's
//     `fullyIdle` says whether any of that is still running — false means the
//     agent has finished speaking but its own background work has not, and
//     print mode is right to keep waiting.

const PROVIDER = "antigravity" as const;
const DEFAULT_MODEL = "Gemini 3.5 Flash";
const PRINT_TIMEOUT = "30m";
const POLL_INTERVAL_MS = 75;
/** How long a turn keeps waiting after the agent has stopped talking but left
 *  background work running (a native subagent). Every hook line refreshes it,
 *  so a working subagent holds the turn open for as long as it keeps acting;
 *  the window only expires when nothing at all is happening. */
const BACKGROUND_IDLE_GRACE_MS = 120_000;
/** Cap on hook lines held back for a conversation kone has not met yet, so a
 *  stream that never explains itself cannot grow without bound. */
const DEFERRED_HOOK_LINE_LIMIT = 1_000;
/** Bound for `agy models` probes. Generous on purpose: a cold CLI spends most
 *  of it spinning up its language server before the first row prints, and a
 *  timed-out probe reports a false needs-login that empties the model picker
 *  (the composer then falls back to "Default model"). */
const MODEL_DISCOVERY_TIMEOUT_MS = 60_000;
const PLUGIN_INSTALL_TIMEOUT_MS = 30_000;
const HELPER_OUTPUT_MAX_CHARS = 128 * 1024;
const WINDOWS_PROMPT_MAX_CHARS = 24_000;
const MIN_ANTIGRAVITY_CLI_VERSION = "1.0.12";

/** The capture-plugin env vars. KONE_ANTIGRAVITY_EVENTS is the per-turn hook
 *  stream the shell wrapper + capture script append to; the decision var makes
 *  every PreToolUse hook answer "allow" (the turn already runs full-access). */
const HOOK_EVENTS_ENV = "KONE_ANTIGRAVITY_EVENTS";
const HOOK_DECISION_ENV = "KONE_ANTIGRAVITY_HOOK_DECISION";
/** The gateway bootstrap env the CLI process env carries per turn — see the
 *  stdio proxy's bootstrap exchange (gateway/stdioProxy.mjs). */
export const KONE_AGENT_GATEWAY_URL_ENV = "KONE_GATEWAY_URL";
export const KONE_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV = "KONE_GATEWAY_BOOTSTRAP_TOKEN";

/** One transcript step from the conversation's transcript.jsonl (the CLI's own
 *  brain log). */
type TranscriptStep = {
  step_index?: number;
  type?: string;
  status?: string;
  content?: string;
  tool_calls?: ReadonlyArray<{ name?: string; args?: AntigravityJsonRecord }> | null;
};

/** A tool call the hooks reported started but not yet finished. */
type PendingTool = {
  stepIndex: number;
  itemId: string;
  name: string;
  args?: AntigravityJsonRecord;
};

/** One native subagent run this turn started, from the `invoke_subagent` call
 *  that briefed it to the report it sends back. Keyed by the child's own
 *  conversation id, which is the id its hook lines and its `sender=` message
 *  both carry — so it doubles as the run's `toolUseId`. */
type AntigravitySubagentRun = {
  snapshot: SubagentRunSnapshot;
  /** The child's transcript, tailed exactly like the parent's. */
  transcriptPath?: string;
  processedTranscriptBytes: number;
  processedSteps: Set<number>;
  pendingTools: PendingTool[];
  nextToolSequence: number;
  settled: boolean;
};

type AntigravitySession = {
  threadId: string;
  cwd: string;
  model: string;
  mode: InteractionMode;
  /** Provider-native conversation id — learned from the hooks mid-turn,
   *  seeded from SessionStartInput.resume. */
  conversationId?: string;
  /** Set when `SessionStartInput.resume` was actually adopted. */
  resumedFrom?: string;
  /** The kone gateway connection minted at startSession — the plugin's MCP
   *  config routes the agent's kone tools to it (bootstrap-exchanged). */
  gatewayConnection?: GatewayConnection;
  /** The named agent this session works as, when the thread was handed to one.
   *  Rides the prompt, since print mode has no system-instruction surface. */
  agent?: AgentPersona;
  /** The user's configured per-session effort (modelOptions.reasoningEffort). */
  modelOptions?: { reasoningEffort?: string };
  /** The CLI executable to spawn. */
  binary: string;
  homeDir?: string;
  activeTurnId?: string;
  activeProcess?: ChildProcess;
  eventFile?: string;
  transcriptPath?: string;
  processedHookBytes: number;
  processedTranscriptBytes: number;
  processedTranscriptPath?: string;
  processedSteps: Set<number>;
  pendingTools: PendingTool[];
  /** Every tool item this turn opened, kept past its completion and keyed by
   *  the step it reported — an `invoke_subagent` run has to hang off its
   *  spawning item, and the result step that names the children arrives after
   *  the item has already closed. */
  toolItemsByStep: Map<number, { itemId: string; name: string; args?: AntigravityJsonRecord }>;
  nextToolSequence: number;
  /** Briefs from `invoke_subagent` calls whose result step has not named the
   *  children yet. The result lists them in the order they were briefed, so
   *  these queue in that same order. */
  pendingSubagentSpecs: { spec: AntigravitySubagentSpec; parentItemId?: string }[];
  /** Native subagent runs, keyed by the child's conversation id. */
  subagentRuns: Map<string, AntigravitySubagentRun>;
  /** Hook lines from a conversation that was unknown when they arrived. */
  deferredHookLines: string[];
  /** When the agent stopped talking with background work still running — the
   *  start of the grace window, refreshed by any hook activity. Absent while
   *  the agent is still working. */
  backgroundIdleSince?: number;
  sawAssistant: boolean;
  interrupted: boolean;
  /** The turn's Stop hook has fired with nothing left running, and the print
   *  process was torn down rather than waited out. The non-zero exit that
   *  follows is that teardown, not a failure. */
  agentStopped: boolean;
  stopped: boolean;
  /** Guards against double turn settlement (process close + interrupt/stop). */
  turnTerminalEmitted: boolean;
  /** Resolves when the active child has actually exited — stopSession awaits
   *  it (bounded) so a replacement turn never spawns while the predecessor
   *  still runs. */
  exited?: Promise<void>;
};

/** One decoded line from the capture-hook stream (`<event>\t<json>`), written
 *  by the generated capture script this adapter installs. Every field is
 *  optional: older CLIs omit fields, and each reader validates before use. */
type AntigravityHookPayload = {
  /** Conversation (thread or subagent run) the hook fired in. */
  conversationId?: string;
  /** Transcript file the CLI is appending to — re-pointed on resume. */
  transcriptPath?: string;
  /** Zero-based step index that binds a `pre-tool` to its `post-tool`. */
  stepIdx?: number;
  /** The tool invocation a `pre-tool` hook announces. */
  toolCall?: { name?: string; args?: AntigravityJsonRecord };
  /** Whether the tool failed, carried by `post-tool` hooks. */
  failed?: boolean;
  /** The tool's error text, carried by `post-tool` hooks. */
  error?: string;
  toolOutput?: string;
  result?: string;
  /** `false` only when the agent still has background work at `stop` — an
   *  older CLI that omits it is taken at its word: done is done. */
  fullyIdle?: boolean;
};

// ── small helpers ────────────────────────────────────────────────────────────

function trim(value: string | null | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function resumeConversationId(value: AntigravityJsonValue | null | undefined): string | undefined {
  if (value && !(value instanceof Object) && value !== true) return trim(String(value));
  if (!value || !(value instanceof Object) || Array.isArray(value)) return undefined;
  // SAFETY: value instanceof Object && !Array.isArray(value) verifies it is a record object.
  const record = value as AntigravityJsonRecord;
  for (const key of ["conversationId", "providerThreadId", "id"]) {
    const v = record[key];
    if (v && !(v instanceof Object) && v !== true && String(v).trim()) return String(v).trim();
  }
  return undefined;
}

function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** How a finished print process settles its turn.
 *
 *  A user interrupt wins outright. After that, `agentStopped` decides: the
 *  Stop hook already said the agent was done with nothing left running, and
 *  the adapter killed the process rather than wait for print mode to notice.
 *  The CLI answers that kill by printing its wait timeout and exiting
 *  non-zero, so neither the code nor the signal describes the turn — the turn
 *  is complete. Only an exit with no Stop behind it is a failure. */
export function antigravityTurnOutcome(input: {
  interrupted: boolean;
  agentStopped: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}): "completed" | "interrupted" | "failed" {
  if (input.interrupted) return "interrupted";
  if (input.agentStopped) return "completed";
  if (input.signal !== null) return "interrupted";
  return (input.code ?? 1) !== 0 ? "failed" : "completed";
}

/** Hook output when capture is inactive (the session is not kone-managed).
 *  Antigravity requires PreToolUse output to carry a `decision`: an empty
 *  object is treated as a denial with an empty reason, which blocks every tool
 *  call because the hook is installed globally with `matcher: "*"`. "ask"
 *  preserves the permission flow the user would have without the hook.
 *
 *  PreInvocation is a veto point with the same decision semantics over the
 *  model call it precedes: an empty object denies that call. The CLI raises it
 *  for a native subagent's first model call, so `{}` there refuses the
 *  subagent launch and the parent CLI exits 1 — "allow" keeps sessions outside
 *  kone behaving as if the hook were absent.
 *
 *  `{}` stays correct for the other hook points, including Stop, where an
 *  inactive hook must not force a decision over Antigravity's default. */
function inactiveHookOutput(event: string): string {
  if (event === "pre-tool") return '{"decision":"ask"}';
  if (event === "pre-invocation") return '{"decision":"allow"}';
  return "{}";
}


const DEFAULT_EFFORT_BY_MODEL: Readonly<Record<string, string>> = {
  "Gemini 3.6 Flash": "medium",
  "Gemini 3.5 Flash": "medium",
  "Gemini 3.1 Pro": "low",
  "Claude Sonnet 4.6": "thinking",
  "Claude Opus 4.6": "thinking",
  "GPT-OSS 120B": "medium",
};

const EFFORT_ORDER = ["low", "medium", "high", "thinking"] as const;

function effortLabel(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/** Parse one `agy models` row into a base model + effort. Handles both the
 *  display-label form (`Gemini 3.5 Flash (High)`) and the newer
 *  `slug<TAB>Display Name (Effort)` rows; the display column wins so a
 *  `slug\tName` row is never treated as a single model id at dispatch. */
export function parseAntigravityCliModelLabel(
  value: string,
): { model: string; effort?: string } | null {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!stripped) return null;

  const tabIndex = stripped.indexOf("\t");
  const labelColumn =
    tabIndex >= 0 ? stripped.slice(tabIndex + 1).trim() : stripped.replace(/^(?:[*•-]\s+)+/u, "");
  const trimmed = labelColumn.replace(/^(?:[*•-]\s+)+/u, "").trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(.*?)\s+\(([^()]+)\)$/u);
  if (!match?.[1] || !match[2]) return { model: trimmed };
  return {
    model: match[1].trim(),
    effort: match[2].trim().toLowerCase(),
  };
}

/** Collapse `agy models` output into base models with effort ladders, in
 *  effort order. A future CLI model needs no static catalog update — whatever
 *  the CLI prints is exactly what kone offers. */
export function parseAntigravityModelLines(output: string): ModelDescriptor[] {
  const groups = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/g)) {
    const parsed = parseAntigravityCliModelLabel(line);
    if (!parsed) continue;
    const efforts = groups.get(parsed.model) ?? [];
    if (parsed.effort && !efforts.includes(parsed.effort)) efforts.push(parsed.effort);
    groups.set(parsed.model, efforts);
  }
  return [...groups.entries()].map(([model, discoveredEfforts]) => {
    // SAFETY: indexOf returns -1 for efforts missing from EFFORT_ORDER, and the
    // comparison below handles that; the casts only name the element type.
    const efforts = discoveredEfforts.toSorted((left, right) => {
      // SAFETY: indexOf returns -1 for efforts missing from EFFORT_ORDER; the comparison below handles that.
      const leftIndex = EFFORT_ORDER.indexOf(left as (typeof EFFORT_ORDER)[number]);
      // SAFETY: indexOf returns -1 for efforts missing from EFFORT_ORDER; the comparison below handles that.
      const rightIndex = EFFORT_ORDER.indexOf(right as (typeof EFFORT_ORDER)[number]);
      return (
        (leftIndex < 0 ? EFFORT_ORDER.length : leftIndex) -
        (rightIndex < 0 ? EFFORT_ORDER.length : rightIndex)
      );
    });
    const defaultEffort = DEFAULT_EFFORT_BY_MODEL[model] ?? efforts[0];
    const descriptor: ModelDescriptor = {
      id: model,
      label: model,
      contextWindowTokens: resolveAntigravityContextWindow(model),
    };
    if (efforts.length > 0) {
      descriptor.reasoningEfforts = efforts;
      if (defaultEffort) descriptor.defaultReasoningEffort = defaultEffort;
    }
    return descriptor;
  });
}

/** Rebuild the exact CLI `--model` label for one dispatch: the base model plus
 *  the effort to bake in (the turn's own request, else the discovered default,
 *  else the static default). Returning the raw input would preserve corrupted
 *  `slug\tName (Effort)` rows from older discovery parsing. */
export function resolveAntigravityCliModelLabel(
  model: string,
  options?: { reasoningEffort?: string },
  discoveredDefaultEffort?: string,
): string {
  const parsed = parseAntigravityCliModelLabel(model);
  if (!parsed) return model;
  const effort =
    parsed.effort ??
    options?.reasoningEffort?.trim().toLowerCase() ??
    discoveredDefaultEffort?.trim().toLowerCase() ??
    DEFAULT_EFFORT_BY_MODEL[parsed.model];
  return effort ? `${parsed.model} (${effortLabel(effort)})` : parsed.model;
}

/** Windows: prompts ride `-p` as a command-line argument, so overlong prompts
 *  would blow the command line before the CLI ever sees them. Returns a
 *  user-facing issue, or null when the prompt is fine. */
export function antigravityPromptCommandLineIssue(
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "win32" || prompt.length <= WINDOWS_PROMPT_MAX_CHARS) {
    return null;
  }
  return `Antigravity prompts on Windows are limited to ${WINDOWS_PROMPT_MAX_CHARS.toLocaleString("en-US")} characters because the CLI accepts print-mode prompts as command-line arguments. Shorten the prompt or attach the content as files.`;
}

export interface AntigravityToolSummary {
  text: string;
  detail?: string;
}

/** Extract human-readable target text and structured detail from tool arguments. */
export function summarizeAntigravityTool(
  name: string,
  args?: AntigravityJsonRecord,
): AntigravityToolSummary {
  if (!args || !(args instanceof Object)) {
    return { text: "" };
  }

  const getString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const val = args[key];
      if (val && !(val instanceof Object) && val !== true && String(val).trim().length > 0) {
        return String(val).trim();
      }
    }
    return undefined;
  };

  let text = "";
  const lowerName = name.trim().toLowerCase();

  if (
    lowerName === "run_command" ||
    lowerName === "bash" ||
    lowerName === "execute_command" ||
    lowerName === "run" ||
    lowerName === "command"
  ) {
    text = getString("CommandLine", "command", "cmd", "toolAction", "toolSummary") ?? "";
  } else if (
    lowerName === "view_file" ||
    lowerName === "read_file" ||
    lowerName === "read"
  ) {
    text = getString("AbsolutePath", "TargetFile", "path", "file", "toolAction") ?? "";
  } else if (
    lowerName === "write_to_file" ||
    lowerName === "create_file" ||
    lowerName === "write"
  ) {
    text = getString("TargetFile", "AbsolutePath", "path", "file", "toolAction") ?? "";
  } else if (
    lowerName === "replace_file_content" ||
    lowerName === "edit_file" ||
    lowerName === "edit" ||
    lowerName === "str_replace" ||
    lowerName === "apply_patch" ||
    lowerName === "multi_replace_file_content"
  ) {
    text = getString("TargetFile", "AbsolutePath", "path", "file", "toolAction") ?? "";
  } else if (lowerName === "list_dir" || lowerName === "ls" || lowerName === "list") {
    text = getString("DirectoryPath", "SearchDirectory", "path", "dir", "toolAction") ?? "";
  } else if (lowerName === "grep_search" || lowerName === "grep" || lowerName === "ripgrep") {
    text = getString("Query", "query", "pattern", "SearchPath", "toolAction") ?? "";
  } else if (lowerName === "find_by_name" || lowerName === "glob_file_search" || lowerName === "glob") {
    text = getString("Pattern", "pattern", "SearchDirectory", "toolAction") ?? "";
  } else if (lowerName === "search_web" || lowerName === "web_search" || lowerName === "websearch") {
    text = getString("query", "Query", "toolAction") ?? "";
  } else if (
    lowerName === "read_url_content" ||
    lowerName === "web_fetch" ||
    lowerName === "view_web_document" ||
    lowerName === "webfetch"
  ) {
    text = getString("Url", "url", "toolAction") ?? "";
  } else if (lowerName === "manage_task") {
    const action = getString("Action", "action");
    const taskId = getString("TaskId", "taskId");
    const toolAction = getString("toolAction", "toolSummary");
    if (action && taskId) {
      text = `${action} ${taskId}`;
    } else if (toolAction) {
      text = toolAction;
    } else if (action) {
      text = action;
    } else if (taskId) {
      text = taskId;
    }
  } else if (lowerName === "schedule") {
    const prompt = getString("Prompt", "CronExpression", "toolAction");
    const duration =
      args.DurationSeconds !== undefined && Number.isFinite(args.DurationSeconds)
        ? `${args.DurationSeconds}s`
        : undefined;
    text = prompt ?? duration ?? "";
  } else if (lowerName === "invoke_subagent") {
    const toolSummary = getString("toolSummary", "toolAction");
    if (toolSummary) {
      text = toolSummary;
    } else {
      const specs = parseInvokeSubagentSpecs(args);
      const roles = specs.map((s) => s.role || s.typeName || "").filter(Boolean);
      text = roles.join(", ");
    }
  } else if (lowerName === "generate_image") {
    text = getString("Prompt", "ImageName", "toolAction") ?? "";
  } else if (lowerName === "ask_question") {
    text = getString("toolAction", "toolSummary") ?? "";
  } else if (lowerName === "send_message") {
    text = getString("Recipient", "recipient", "toolAction") ?? "";
  } else {
    text =
      getString(
        "toolAction",
        "toolSummary",
        "CommandLine",
        "command",
        "cmd",
        "TargetFile",
        "AbsolutePath",
        "DirectoryPath",
        "SearchPath",
        "path",
        "file",
        "Query",
        "query",
        "Pattern",
        "pattern",
        "Url",
        "url",
        "Prompt",
        "prompt",
        "Description",
        "description",
        "Action",
        "action",
      ) ?? "";
  }

  if (text.toLowerCase() === name.toLowerCase() || text.toLowerCase() === lowerName.replace(/_/g, " ")) {
    text = "";
  }

  let detail: string | undefined;
  try {
    if (Object.keys(args).length > 0) {
      detail = JSON.stringify(args, null, 2);
    }
  } catch {
    detail = undefined;
  }

  return { text, detail };
}

/** The shell wrapper for one hook point. Inactive when
 *  KONE_ANTIGRAVITY_EVENTS is unset (a session outside kone): drain stdin and
 *  answer the neutral payload. Active: run the capture script as Node. */
export function buildKoneCaptureCommand(
  executablePath: string,
  scriptPath: string,
  event: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const fallback = inactiveHookOutput(event);
  if (platform === "win32") {
    // The CLI hands hook command strings to cmd.exe without decoding the
    // escapes its own serialization added: every `"` in the command arrives as
    // `\"`, which derails cmd's quote parsing so a quoted program path is
    // executed literally and the hook never runs. Keep the whole invocation
    // free of double quotes — the helper paths are space-free in every
    // supported install layout (dev Electron binaries and packaged apps under
    // %LOCALAPPDATA%\Programs).
    const invocation = `${executablePath} ${scriptPath} ${event}`;
    return `if not defined ${HOOK_EVENTS_ENV} (more >nul 2>nul & echo ${fallback}) else (set ELECTRON_RUN_AS_NODE=1&& ${invocation})`;
  }
  const invocation = `${shellQuote(executablePath, platform)} ${shellQuote(scriptPath, platform)} ${shellQuote(event, platform)}`;
  return `if [ -z "\${${HOOK_EVENTS_ENV}:-}" ]; then cat >/dev/null 2>&1 || :; printf '%s\\n' '${fallback}'; else ELECTRON_RUN_AS_NODE=1 ${invocation}; fi`;
}

/** The critical rules, flattened into something a standalone script can rebuild
 *  a RegExp from. The hook runs in its own node process with no access to this
 *  package, so the screen has to travel to it as data rather than as an import —
 *  and it travels from the one list, so the rules cannot drift apart. */
function criticalRuleTable(): string {
  return JSON.stringify(
    DEFAULT_DANGEROUS_PATTERNS.filter((rule) => rule.severity === "critical").map((rule) => ({
      id: rule.id,
      name: rule.name,
      source: rule.pattern.source,
      flags: rule.pattern.flags,
    })),
  );
}

/** The capture script itself — appends hook payloads to the event file and
 *  answers the hook with the decision. */
export function hookScriptSource(): string {
  return `const fs = require("node:fs");
// Command screening, inlined.
//
// A kone-managed full-access session answers every PreToolUse with "allow" —
// that is the rung's contract, and a child with no terminal must never wait on
// a person. This hook is therefore the only thing standing between the model
// and the handful of commands that take the machine rather than the worktree,
// and it is the only rung where nobody can be asked. Same rules the other
// adapters screen with; a screen, not a sandbox.
const KONE_CRITICAL = ${criticalRuleTable()}.map((r) => ({ id: r.id, name: r.name, re: new RegExp(r.source, r.flags) }));
const KONE_SHELL_TOOLS = ${JSON.stringify([...DEFAULT_MONITORED_TOOLS])};
const KONE_COMMAND_KEYS = ${JSON.stringify([...COMMAND_KEYS])};
function koneCriticalCommand(toolCall) {
  const name = toolCall && typeof toolCall.name === "string" ? toolCall.name.trim().toLowerCase() : "";
  if (!name) return null;
  // Whole name segments only, so "publish" is not read as a shell.
  const segments = new Set(name.split(/[^a-z0-9]+/).filter(Boolean));
  if (!KONE_SHELL_TOOLS.some((t) => name === t || segments.has(t))) return null;
  const args = toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {};
  const candidates = [];
  for (const key of KONE_COMMAND_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) candidates.push(value.trim());
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && item.trim()) candidates.push(item.trim());
    }
  }
  for (const command of candidates) {
    for (const rule of KONE_CRITICAL) {
      if (rule.re.test(command)) return { rule, command };
    }
  }
  return null;
}
const event = process.argv[2] || "unknown";
let payload = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { payload += chunk; });
process.stdin.on("end", () => {
  const target = process.env.${HOOK_EVENTS_ENV};
  if (!target) {
    // Mirrors the shell wrapper's inactive fallback: PreToolUse must carry a
    // decision or the tool call is denied with an empty reason, PreInvocation
    // must carry "allow" or the model call it gates (a subagent launch) is
    // denied and the parent CLI exits 1.
    process.stdout.write((event === "pre-tool" ? '{"decision":"ask"}' : event === "pre-invocation" ? '{"decision":"allow"}' : "{}") + "\\n");
    return;
  }
  let capturedPayload = payload.trim();
  if (event === "pre-tool" || event === "post-tool") {
    try {
      const input = JSON.parse(capturedPayload);
      const sanitized = {};
      for (const key of ["conversationId", "transcriptPath", "modelName"]) {
        if (typeof input[key] === "string" && input[key].trim()) sanitized[key] = input[key];
      }
      if (Number.isInteger(input.stepIdx) && input.stepIdx >= 0) sanitized.stepIdx = input.stepIdx;
      if (event === "pre-tool") {
        const name = input.toolCall && typeof input.toolCall.name === "string"
          ? input.toolCall.name.trim()
          : "";
        if (name) {
          sanitized.toolCall = {
            name,
            ...(input.toolCall.args && typeof input.toolCall.args === "object"
              ? { args: input.toolCall.args }
              : {}),
          };
        }
      } else {
        const name = input.toolCall && typeof input.toolCall.name === "string"
          ? input.toolCall.name.trim()
          : "";
        if (name) {
          sanitized.toolCall = {
            name,
            ...(input.toolCall.args && typeof input.toolCall.args === "object"
              ? { args: input.toolCall.args }
              : {}),
          };
        }
        sanitized.failed = typeof input.error === "string" && input.error.trim().length > 0;
        if (typeof input.error === "string" && input.error.trim()) sanitized.error = input.error;
        if (input.toolOutput !== undefined) sanitized.toolOutput = input.toolOutput;
        if (input.result !== undefined) sanitized.result = input.result;
      }
      capturedPayload = JSON.stringify(sanitized);
    } catch {
      capturedPayload = "{}";
    }
  }
  fs.appendFileSync(target, event + "\\t" + capturedPayload + "\\n");
  if (event === "pre-tool") {
    let decision = process.env.${HOOK_DECISION_ENV} === "allow" ? "allow" : "ask";
    let reason = "";
    if (decision === "allow") {
      let hit = null;
      try { hit = koneCriticalCommand(JSON.parse(capturedPayload).toolCall); } catch { hit = null; }
      if (hit) {
        decision = "deny";
        reason = hit.rule.name + " (" + hit.rule.id + ") — refused by kone. Command: " + hit.command;
        process.stderr.write("[kone] full-access: REFUSED — " + reason + "\\n");
      }
    }
    process.stdout.write(JSON.stringify(reason ? { decision, reason } : { decision }) + "\\n");
  } else if (event === "pre-invocation") {
    // PreInvocation vetoes the model call that follows; kone-managed sessions
    // spawn native subagents deliberately, so the launch it gates must never
    // be blocked — an empty object denies it and the parent CLI exits 1.
    process.stdout.write('{"decision":"allow"}\\n');
  } else {
    process.stdout.write("{}\\n");
  }
});
`;
}

/** One generated capture hook: a command line the plugin spawns per event. */
type KoneHook = { type: "command"; command: string };

/** The plugin's hooks.json — every generated hook is a command hook, grouped
 *  by the agy lifecycle event that spawns it. */
type KoneHookConfig = {
  "kone-capture": {
    PreToolUse: { matcher: string; hooks: KoneHook[] }[];
    PostToolUse: { matcher: string; hooks: KoneHook[] }[];
    PreInvocation: KoneHook[];
    PostInvocation: KoneHook[];
    Stop: KoneHook[];
  };
};

export function buildKoneHookConfig(
  command: (event: string) => string,
): KoneHookConfig {
  const hook = (event: string): KoneHook => ({ type: "command", command: command(event) });
  return {
    "kone-capture": {
      PreToolUse: [{ matcher: "*", hooks: [hook("pre-tool")] }],
      PostToolUse: [{ matcher: "*", hooks: [hook("post-tool")] }],
      PreInvocation: [hook("pre-invocation")],
      PostInvocation: [hook("post-invocation")],
      Stop: [hook("stop")],
    },
  };
}

/** Run a short agy helper (plugin install / models) to completion. */
export async function runAntigravityHelperProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(new Error(`Antigravity helper timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`)),
      );
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout = appendBounded(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = appendBounded(stderr, chunk)));
    child.once("error", (cause) => finish(() => reject(cause)));
    child.once("close", (code) => finish(() => resolve({ stdout, stderr, code: code ?? 1 })));
  });
}

function appendBounded(current: string, chunk: string | Buffer | Uint8Array): string {
  const next = current + String(chunk);
  return next.length > HELPER_OUTPUT_MAX_CHARS ? next.slice(-HELPER_OUTPUT_MAX_CHARS) : next;
}

/** Read complete newline-terminated JSONL records from `offset` — a partial
  *  trailing record is left for the next read. */
export async function readCompleteAntigravityLines(
  filePath: string,
  offset: number,
): Promise<{ lines: string[]; nextOffset: number }> {
  const file = await fs.open(filePath, "r");
  try {
    const stats = await file.stat();
    const start = offset <= stats.size ? offset : 0;
    const remaining = stats.size - start;
    if (remaining === 0) return { lines: [], nextOffset: start };
    const buffer = Buffer.allocUnsafe(remaining);
    const { bytesRead } = await file.read(buffer, 0, remaining, start);
    const contents = buffer.subarray(0, bytesRead);
    const lastNewline = contents.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], nextOffset: start };
    return {
      lines: contents
        .subarray(0, lastNewline + 1)
        .toString("utf8")
        .split(/\r?\n/g)
        .filter(Boolean),
      nextOffset: start + lastNewline + 1,
    };
  } finally {
    await file.close();
  }
}

/** Install (or refresh) the global kone-capture plugin: hooks.json +
 *  capture.cjs + a secret-free mcp_config.json pointing at the kone stdio
 *  proxy when a gateway connection exists (removed otherwise). Idempotent;
 *  also refreshes on every startSession so a moved binary path or proxy
 *  script takes effect. */
export async function ensureCapturePlugin(
  binaryPath: string,
  stdioProxy?: { command: string; args: string[] },
  options: { homeDir?: string; runHelper?: typeof runAntigravityHelperProcess } = {},
): Promise<void> {
  const pluginDir = path.join(options.homeDir ?? os.homedir(), ".gemini", "antigravity-cli", "plugins", "kone-capture");
  const scriptPath = path.join(pluginDir, "capture.cjs");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    `${JSON.stringify(
      {
        $schema: "https://antigravity.google/schemas/v1/plugin.json",
        name: "kone-capture",
        description: "Streams Antigravity CLI lifecycle events to kone when requested.",
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(scriptPath, hookScriptSource(), { mode: 0o700 });
  const command = (event: string) => buildKoneCaptureCommand(process.execPath, scriptPath, event);
  await fs.writeFile(
    path.join(pluginDir, "hooks.json"),
    `${JSON.stringify(buildKoneHookConfig(command), null, 2)}\n`,
  );
  // The plugin's MCP config is GLOBAL on disk, so it must be secret-free: the
  // env block references variables the CLI process env supplies per turn, and
  // the stdio proxy exchanges the one-shot bootstrap for the session token.
  const mcpConfigPath = path.join(pluginDir, "mcp_config.json");
  if (stdioProxy) {
    await fs.writeFile(
      mcpConfigPath,
      `${JSON.stringify(
        {
          mcpServers: {
            kone: {
              command: stdioProxy.command,
              args: [...stdioProxy.args],
              env: {
                [KONE_AGENT_GATEWAY_URL_ENV]: `$${KONE_AGENT_GATEWAY_URL_ENV}`,
                [KONE_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV]: `$${KONE_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV}`,
                ELECTRON_RUN_AS_NODE: "1",
              },
              disabled: false,
              disabledTools: [],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  } else {
    await fs.rm(mcpConfigPath, { force: true });
  }
  const env = await buildAntigravityProbeEnv();
  if (options.homeDir) {
    env.HOME = options.homeDir;
    env.USERPROFILE = options.homeDir;
  }
  const installed = await (options.runHelper ?? runAntigravityHelperProcess)(
    binaryPath,
    ["plugin", "install", pluginDir],
    {
      // The agent env (PATH recovery) so a Dock-launched kone can reach the
      // CLI and its install dir the same way every other probe does.
      env,
      timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS,
    },
  );
  if (installed.code !== 0) {
    throw new Error(installed.stderr.trim() || installed.stdout.trim() || "Plugin install failed.");
  }
}

export class AntigravityPrintAdapter implements ProviderAdapter {
  readonly provider: typeof PROVIDER = PROVIDER;
  readonly capabilities: AdapterCapabilities = {
    // The model/effort is baked into each `agy -p` invocation's --model label;
    // switching means the next turn runs under a new label, so a mid-thread
    sessionModelSwitch: "restart-session",
    // Transcript steps arrive as whole blobs, not incremental deltas.
    streamsText: false,
    supportsToolEvents: true,
    supportsResume: true,
    supportsModelList: true,
    // Native subagents are separate conversations, but every artifact they
    // produce is attributable: the capture hooks tag each line with the
    // child's own conversation id, and the child writes its own transcript.
    supportsSubagents: true,
  };

  private readonly emit: EmitEvent;
  private readonly sessions = new Map<string, AntigravitySession>();
  private modelsCache: Promise<ModelDescriptor[]> | null = null;
  private binary: string;
  /** Effort defaults discovered from `agy models`, keyed by base model —
   *  refreshed at every listModels, consulted at dispatch. */
  private readonly defaultEffortByModel = new Map(Object.entries(DEFAULT_EFFORT_BY_MODEL));

  /** Mints a per-turn stdio bootstrap token for a session credential — wired
   *  by AgentService to the gateway handle (the plugin's secret-free MCP path).
   *  Null until the gateway is attached. */
  private readonly issueBootstrapToken: (sessionToken: string) => string | null;
  /** Plugin install dir root — the real home in production; tests point this
   *  at a temp dir so the machine's ~/.gemini is never touched. */
  private readonly homeDir?: string;
  private readonly resolveBinaryOption?: () => string;

  constructor(
    emit: EmitEvent,
    issueBootstrapToken?: (sessionToken: string) => string | null,
    options: { homeDir?: string; resolveBinary?: () => string } = {},
  ) {
    this.emit = emit;
    this.resolveBinaryOption = options.resolveBinary;
    this.binary = options.resolveBinary ? options.resolveBinary() : ANTGRAVITY_BINARY;
    this.issueBootstrapToken = issueBootstrapToken ?? (() => null);
    this.homeDir = options.homeDir;
  }

  setConfig(config: ProviderConfig): void {
    const next = this.resolveBinaryOption
      ? this.resolveBinaryOption()
      : resolveAntigravityBinary(config.binaryPath);
    if (next === this.binary) return;
    this.binary = next;
    this.modelsCache = null;
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  async discover(): Promise<ProviderStatus> {
    const env = await buildAntigravityProbeEnv();
    if (this.homeDir) {
      env.HOME = this.homeDir;
      env.USERPROFILE = this.homeDir;
    }
    const versionResult = await probeResult(this.binary, ["--version"], env, 5_000);
    const version = parseAntigravityVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (!versionProbeUsable(versionResult, version)) {
      return {
        provider: this.provider,
        label: "Antigravity",
        ...versionProbeFailure({
          label: "Antigravity CLI (`agy`)",
          installHint:
            "Antigravity CLI (`agy`) not found. Install it from https://antigravity.google, then sign in.",
          result: versionResult,
        }),
      };
    }

    if (version !== undefined && !this.versionAtLeast(version, MIN_ANTIGRAVITY_CLI_VERSION)) {
      return {
        provider: this.provider,
        label: "Antigravity",
        available: true,
        authStatus: "unknown",
        readiness: "error",
        version,
        message: `Antigravity CLI ${version} is too old — upgrade to ${MIN_ANTIGRAVITY_CLI_VERSION} or newer.`,
      };
    }

    // The CLI ships no auth subcommand; a non-empty `agy models` list is the
    // only signal that the user is signed in.
    const modelsResult = await probeResult(
      this.binary,
      ["models"],
      env,
      MODEL_DISCOVERY_TIMEOUT_MS,
    );
    if (modelsResult.outcome === "timeout" || modelsResult.outcome === "failure") {
      // The list never came back, so "no models" is not an answer about sign-in.
      return {
        provider: this.provider,
        label: "Antigravity",
        available: true,
        authStatus: "unknown",
        readiness: "error",
        version,
        message: "Antigravity did not report its model list in time — try again in a moment.",
        transient: true,
      };
    }
    const models = modelsResult.stdout;
    if (models.trim().length === 0) {
      return {
        provider: this.provider,
        label: "Antigravity",
        available: true,
        authStatus: "unauthenticated",
        readiness: "needs-login",
        version,
        message: "Run `agy` once to sign in.",
      };
    }

    return {
      provider: this.provider,
      label: "Antigravity",
      available: true,
      authStatus: "authenticated",
      readiness: "ready",
      version,
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (!this.modelsCache) {
      this.modelsCache = this.fetchModels().catch((cause: unknown) => {
        this.modelsCache = null;
        throw cause;
      });
    }
    return this.modelsCache;
  }

  private async fetchModels(): Promise<ModelDescriptor[]> {
    const env = await buildAntigravityProbeEnv();
    if (this.homeDir) {
      env.HOME = this.homeDir;
      env.USERPROFILE = this.homeDir;
    }
    const result = await runAntigravityHelperProcess(this.binary, ["models"], {
      env,
      timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
    }).catch(() => ({ stdout: "", stderr: "", code: 1 }));
    if (result.code !== 0) return [];
    const models = parseAntigravityModelLines(result.stdout);
    for (const model of models) {
      if (model.defaultReasoningEffort) {
        this.defaultEffortByModel.set(model.id, model.defaultReasoningEffort);
      }
    }
    return models;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async startSession(input: SessionStartInput): Promise<Session> {
    // Print mode cannot pause for interactive approvals — the CLI either skips
    // permissions or asks at a terminal kone's child doesn't have.
    if ((input.mode ?? "accept-edits") !== "full-access") {
      throw new Error(
        "Antigravity CLI print mode cannot pause for interactive approvals. Select Full access to use this provider.",
      );
    }
    const prior = this.sessions.get(input.threadId);
    if (prior) {
      // A second open racing a live turn must never silently murder it (the
      // old behavior stopped the session and its turn aborted with no
      // message). Refuse loudly instead: legitimate restarts stop the old
      // session first, so a replacement arriving mid-turn is always a caller
      // bug worth surfacing — and the live turn keeps running to completion.
      if (prior.activeTurnId) {
        throw new Error(
          `Refusing to replace the live Antigravity session for thread ${input.threadId} while turn ${prior.activeTurnId} is still running. Stop it first if the replacement is intentional.`,
        );
      }
      await this.stopSession(input.threadId);
    }

    // The capture plugin is global and secret-free; (re)install it so its
    // hooks + MCP config reflect this session's gateway connection.
    try {
      await ensureCapturePlugin(
        this.binary,
        {
          command: process.execPath,
          args: [STDIO_PROXY_PATH],
        },
        { homeDir: this.homeDir },
      );
    } catch (error) {
      console.error(
        "[antigravity] capture plugin install failed:",
        error instanceof Error ? error.message : String(error),
      );
    }

    const conversationId = resumeConversationId(input.resume);
    const session: AntigravitySession = {
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model ?? DEFAULT_MODEL,
      mode: "full-access",
      gatewayConnection: input.gatewayConnection,
      agent: input.agent,
      binary: this.binary,
      homeDir: this.homeDir,
      processedHookBytes: 0,
      processedTranscriptBytes: 0,
      processedSteps: new Set(),
      pendingTools: [],
      toolItemsByStep: new Map(),
      nextToolSequence: 0,
      pendingSubagentSpecs: [],
      subagentRuns: new Map(),
      deferredHookLines: [],
      sawAssistant: false,
      interrupted: false,
      agentStopped: false,
      stopped: false,
      turnTerminalEmitted: false,
    };
    if (conversationId) {
      session.conversationId = conversationId;
      session.resumedFrom = conversationId;
      session.transcriptPath = antigravityTranscriptPath(conversationId, this.homeDir);
    }
    if (input.effort) session.modelOptions = { reasoningEffort: input.effort };
    this.sessions.set(input.threadId, session);
    this.emit({ ...this.base(session), source: "antigravity.cli.lifecycle", type: "session.started" });
    if (conversationId) {
      this.emitUsage(session);
    } else {
      const initialContextWindow = resolveAntigravityContextWindow(session.model);
      this.emit({
        ...this.base(session),
        source: "antigravity.cli.lifecycle",
        type: "thread.token-usage.updated",
        usage: {
          contextWindow: initialContextWindow,
          compactsAutomatically: true,
        },
      });
    }
    return this.toSession(session);
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.requireSession(input.threadId);
    if (session.activeProcess) {
      throw new Error("An Antigravity turn is already active for this thread.");
    }

    let promptText = input.input.trim();
    if (input.attachments?.length) {
      // Imported at call time, and only when there's something to attach:
      // promptAttachments reaches the attachment store, which pulls in
      // node:sqlite — statically importing it would make this module
      // unloadable outside the Electron runtime (same pattern as
      // CursorAdapter/DroidAdapter). Images can't ride a print-mode prompt
      // string, so all attachments (visual or text) are named in the
      // on-disk path block for the agent to inspect with its tools.
      const attachments = await import("../promptAttachments.js");
      const fileBlock = await attachments.buildTextAttachmentBlock(input.attachments);
      promptText = attachments.composePromptText(promptText, fileBlock);
    }
    if (!promptText) {
      throw new Error("A prompt or file attachment is required.");
    }
    // First-prompt host-context channel (no system-instruction surface in
    // print mode) — tells the agent the kone gateway tools exist.
    promptText = koneHostContextForFirstRun({
      prompt: promptText,
      runOrdinal: 1,
      gateway: session.gatewayConnection,
      agent: session.agent,
    });

    const promptIssue = antigravityPromptCommandLineIssue(promptText);
    if (promptIssue) throw new Error(promptIssue);

    const turnId = `antigravity-turn-${randomUUID()}`;
    // Model/effort are baked into this invocation's --model label, so a
    // per-turn override applies here (the session's knobs update to match, so
    // listSessions reports what actually ran).
    const turnModel = input.model ?? session.model;
    const turnEffort = input.effort ?? session.modelOptions?.reasoningEffort;
    const cliModel = resolveAntigravityCliModelLabel(
      turnModel,
      turnEffort ? { reasoningEffort: turnEffort } : undefined,
      this.defaultEffortByModel.get(turnModel),
    );
    session.model = turnModel;
    if (turnEffort) session.modelOptions = { reasoningEffort: turnEffort };

    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "kone-antigravity-"));
    const eventFile = path.join(runDir, "hooks.ndjson");
    const logFile = path.join(runDir, "agy.log");
    await fs.writeFile(eventFile, "");

    // The gateway bootstrap: each print turn is a fresh process (and fresh
    // proxy), so each turn mints its own single-use bootstrap from the session
    // credential. The session token itself never enters the CLI env.
    const bootstrapToken = session.gatewayConnection
      ? this.issueBootstrapToken(session.gatewayConnection.bearerToken)
      : undefined;

    session.activeTurnId = turnId;
    session.eventFile = eventFile;
    session.processedHookBytes = 0;
    session.processedSteps.clear();
    session.pendingTools = [];
    session.toolItemsByStep.clear();
    session.nextToolSequence = 0;
    session.pendingSubagentSpecs = [];
    session.subagentRuns.clear();
    session.deferredHookLines = [];
    delete session.backgroundIdleSince;
    session.sawAssistant = false;
    session.interrupted = false;
    session.agentStopped = false;
    session.turnTerminalEmitted = false;
    // A resumed conversation's transcript already holds prior turns — mark it
    // processed so only this turn's steps render (the resume-scope seam).
    await this.markExistingTranscriptStepsProcessed(session);

    this.emit({ ...this.base(session), type: "turn.started", turnId });

    const conversationId = session.conversationId;
    const args: string[] = [
      ...(conversationId ? ["--conversation", conversationId] : ["--new-project"]),
      "--dangerously-skip-permissions",
      "--model",
      cliModel,
      "--log-file",
      logFile,
      "--print-timeout",
      PRINT_TIMEOUT,
      "-p",
      promptText,
    ];

    let child: ChildProcess;
    try {
      child = spawn(session.binary, args, {
        cwd: session.cwd,
        env: await buildAntigravityTurnEnvironment(session, eventFile, bootstrapToken),
        // Own process group on POSIX so killTree can reap the tool subprocesses.
        detached: process.platform !== "win32",
        // stdin closed: print mode must never block on an interactive prompt.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      this.failTurn(session, turnId, error, "Failed to launch Antigravity CLI.");
      return { threadId: input.threadId, turnId };
    }
    session.activeProcess = child;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    session.exited = exited;

    let stdout = "";
    let stderr = "";
    // stdio is piped for both, so these are never null in practice.
    const out = child.stdout!;
    const err = child.stderr!;
    out.setEncoding("utf8");
    err.setEncoding("utf8");
    out.on("data", (chunk) => (stdout += String(chunk)));
    err.on("data", (chunk) => (stderr += String(chunk)));

    const timer = setInterval(() => {
      if (this.ownsTurn(session, child, turnId)) void this.pollHookFile(session);
    }, POLL_INTERVAL_MS);

    child.once("error", (cause) => {
      clearInterval(timer);
      if (!this.ownsTurn(session, child, turnId)) return;
      this.emit({
        ...this.base(session),
        source: "antigravity.cli.stderr",
        type: "session.state.changed",
        state: "running",
        message: messageFromCause(cause, "Failed to launch Antigravity CLI."),
      });
    });

    child.once("close", (code, signal) => {
      clearInterval(timer);
      void (async () => {
        if (!this.ownsTurn(session, child, turnId)) return;
        // Drain hooks/transcript before deciding — the stop hook may have
        // landed just before the process exited.
        await this.pollHookFile(session).catch(() => {});
        if (!this.ownsTurn(session, child, turnId)) return;
        if (!session.sawAssistant && stdout.trim()) {
          this.emitTranscriptItem(session, {
            step_index: Number.MAX_SAFE_INTEGER,
            type: "PRINT_OUTPUT",
            content: stdout.trim(),
          }, "assistant_text");
        }
        if (session.turnTerminalEmitted) {
          if (session.activeProcess === child) delete session.activeProcess;
          await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
          return;
        }
        const outcome = antigravityTurnOutcome({
          interrupted: session.interrupted,
          agentStopped: session.agentStopped,
          code,
          signal,
        });
        const failed = outcome === "failed";
        if (failed && stderr.trim()) {
          this.emit({
            ...this.base(session),
            source: "antigravity.cli.stderr",
            type: "session.state.changed",
            state: "error",
            message: stderr.trim(),
          });
        }
        this.settleActiveTurn(session, {
          state: outcome,
          message: failed ? stderr.trim() || `Antigravity CLI exited with code ${code ?? 1}.` : undefined,
        });
        await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      })();
    });

    return { threadId: input.threadId, turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session?.activeProcess || !session.activeTurnId) return;
    session.interrupted = true;
    killTree(session.activeProcess.pid);
    // Prefer process close for settlement so hooks/stdout still drain (the
    // close handler settles with state "interrupted"). If the teardown cannot
    // prove exit within a bounded window, force-settle so Cancel never no-ops
    // — the close handler is idempotent-guarded either way.
    await withTimeout(session.exited, 5_000);
    if (!session.turnTerminalEmitted && session.activeTurnId !== undefined) {
      this.settleActiveTurn(session, { state: "interrupted" });
    }
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.stopped = true;
    session.interrupted = true;
    if (session.activeProcess) {
      await killTree(session.activeProcess.pid);
      if (session.activeTurnId && !session.turnTerminalEmitted) {
        this.settleActiveTurn(session, { state: "interrupted" });
      }
    }
    this.sessions.delete(threadId);
    this.emit({
      ...this.base(session),
      source: "antigravity.cli.lifecycle",
      type: "session.exited",
      code: null,
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((threadId) => this.stopSession(threadId)));
  }

  async respondToRequest(): Promise<void> {
    // Print mode never surfaces interactive requests (full-access only).
  }

  async respondToUserInput(): Promise<void> {
    // Print mode never surfaces mid-turn questions.
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()].map((session) => this.toSession(session));
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  // ── turn rendering ────────────────────────────────────────────────────────

  private ownsTurn(
    session: AntigravitySession,
    child: ChildProcess,
    turnId: string,
  ): boolean {
    return (
      this.sessions.get(session.threadId) === session &&
      session.activeProcess === child &&
      session.activeTurnId === turnId
    );
  }

  /** Read the cumulative usage across the session's conversation SQLite database
   *  (and any subagent runs), and emit a thread.token-usage.updated event. */
  private emitUsage(session: AntigravitySession): void {
    const conversationIds: string[] = [];
    if (session.conversationId) conversationIds.push(session.conversationId);
    for (const subId of session.subagentRuns.keys()) {
      if (subId && !conversationIds.includes(subId)) conversationIds.push(subId);
    }
    if (conversationIds.length === 0) return;

    const usageResult = readAntigravityConversationUsage(conversationIds, this.homeDir);
    const contextWindow = resolveAntigravityContextWindow(session.model);
    if (!usageResult) {
      this.emit({
        ...this.base(session),
        type: "thread.token-usage.updated",
        usage: {
          contextWindow,
          compactsAutomatically: true,
        },
      });
      return;
    }

    const usage: TokenUsage & TokenUsageSplits = {
      input: usageResult.inputTokens,
      output: usageResult.outputTokens,
      total: usageResult.totalTokens,
      contextWindow,
      contextUsed: usageResult.latestContextUsed ?? usageResult.totalTokens,
      compactsAutomatically: true,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: usageResult.thinkingTokens,
    };
    this.emit({ ...this.base(session), type: "thread.token-usage.updated", usage });
  }

  /** Settle the active turn exactly once — process close, interrupt and stop
   *  can all race, and the guard makes the first one win. */
  private settleActiveTurn(
    session: AntigravitySession,
    input: { state: "completed" | "interrupted" | "failed"; message?: string },
  ): void {
    if (session.turnTerminalEmitted || session.activeTurnId === undefined) return;
    const turnId = session.activeTurnId;
    // Before the turn loses its id: a run still open has to be closed out
    // while there is still a turn to attach the event to.
    this.settleLiveSubagentRuns(session);
    this.emitUsage(session);
    session.turnTerminalEmitted = true;
    delete session.activeProcess;
    delete session.activeTurnId;
    if (input.state === "completed") {
      this.emit({
        ...this.base(session),
        type: "turn.completed",
        turnId,
        conversationId: session.conversationId,
      });
    } else {
      const event: Extract<RuntimeEvent, { type: "turn.aborted" }> = {
        ...this.base(session),
        type: "turn.aborted",
        turnId,
        reason: input.state === "interrupted" ? "interrupted" : "failed",
      };
      if (input.message) event.message = input.message;
      this.emit(event);
    }
  }

  private failTurn(
    session: AntigravitySession,
    turnId: string,
    cause: unknown,
    fallback: string,
  ): void {
    if (session.turnTerminalEmitted || session.activeTurnId !== turnId) return;
    this.emitUsage(session);
    session.turnTerminalEmitted = true;
    delete session.activeTurnId;
    const message = messageFromCause(cause, fallback);
    this.emit({
      ...this.base(session),
      source: "antigravity.cli.lifecycle",
      type: "turn.aborted",
      turnId,
      reason: session.interrupted ? "interrupted" : "failed",
      message,
    });
  }

  /** Read the transcript tail and render new steps as items. Only
   *  PLANNER_RESPONSE steps render: with tool_calls they are the agent's
   *  reasoning before an action, without they are the assistant's reply. */
  private async readTranscript(session: AntigravitySession): Promise<void> {
    if (!session.transcriptPath || !session.activeTurnId) return;
    const isInitialRead = session.processedTranscriptPath !== session.transcriptPath;
    if (isInitialRead) session.processedTranscriptBytes = 0;
    let batch: Awaited<ReturnType<typeof readCompleteAntigravityLines>>;
    try {
      batch = await readCompleteAntigravityLines(session.transcriptPath, session.processedTranscriptBytes);
    } catch {
      return;
    }
    session.processedTranscriptBytes = batch.nextOffset;
    session.processedTranscriptPath = session.transcriptPath;
    const steps = batch.lines.flatMap((line) => {
      try {
        // SAFETY: JSON.parse yields unknown; consumers probe fields before use.
        return [JSON.parse(line) as TranscriptStep];
      } catch {
        return [];
      }
    });
    // On the first read of a resumed conversation, everything up to the latest
    // user input is history — only steps after it belong to this turn.
    const latestUserIndex = isInitialRead
      ? steps.reduce((latest, step) => {
          const idx = step.step_index;
          return step.type === "USER_INPUT" && idx !== undefined && Number.isFinite(idx)
            ? Math.max(latest, idx)
            : latest;
        }, -1)
      : -1;
    for (const step of steps) {
      const idx = step.step_index;
      if (idx !== undefined && Number.isFinite(idx) && idx > latestUserIndex) {
        this.processTranscriptStep(session, step);
      }
    }
  }

  /** Mark the whole existing transcript as processed without rendering — the
   *  resume-scope seam: a resumed turn must not replay prior turns. */
  private async markExistingTranscriptStepsProcessed(session: AntigravitySession): Promise<void> {
    if (!session.transcriptPath) return;
    try {
      const batch = await readCompleteAntigravityLines(session.transcriptPath, 0);
      session.processedTranscriptBytes = batch.nextOffset;
      session.processedTranscriptPath = session.transcriptPath;
    } catch {
      return;
    }
  }

  private processTranscriptStep(session: AntigravitySession, step: TranscriptStep): void {
    const stepIndex = step.step_index;
    if (stepIndex === undefined || !Number.isFinite(stepIndex) || session.processedSteps.has(stepIndex)) return;
    session.processedSteps.add(stepIndex);

    if (step.type === "PLANNER_RESPONSE") {
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      for (const call of calls) {
        if (call?.name !== "invoke_subagent") continue;
        for (const spec of parseInvokeSubagentSpecs(call.args)) {
          session.pendingSubagentSpecs.push({ spec });
        }
      }
      if (calls.length > 0) {
        this.emitTranscriptItem(session, step, "reasoning_text");
      } else {
        this.emitTranscriptItem(session, step, "assistant_text");
      }
      return;
    }

    if (step.type === "GENERIC") {
      // The `invoke_subagent` result: the step that turns each queued brief
      // into a real child with an id and a transcript of its own.
      const handles = parseCreatedSubagents(step.content);
      if (handles.length === 0) return;
      const parentItemId = session.toolItemsByStep.get(stepIndex)?.itemId;
      for (const handle of handles) {
        const queued = session.pendingSubagentSpecs.shift();
        this.startSubagentRun(session, handle, queued?.spec, parentItemId);
      }
      return;
    }

    if (step.type === "SYSTEM_MESSAGE") {
      // A child reporting back. agy delivers it to the parent as a system
      // message whose sender is the child's conversation id; anything else
      // (agy's own notices, background shell tasks) names no run here.
      const message = parseInboundMessage(step.content);
      const run = message ? session.subagentRuns.get(message.sender) : undefined;
      if (!message || !run) return;
      run.snapshot.summary = message.content;
      this.settleSubagentRun(session, run, "completed");
    }
  }

  private emitTranscriptItem(
    session: AntigravitySession,
    step: TranscriptStep,
    kind: RuntimeItemKind,
  ): void {
    const content = trim(step.content);
    const turnId = session.activeTurnId;
    if (!content || !turnId) return;
    const itemId = `antigravity-${turnId}-${step.step_index ?? randomUUID()}-${kind}`;
    const item: RuntimeItem = { itemId, kind, status: "completed", text: content };
    this.emit({ ...this.base(session), type: "item.started", turnId, item });
    this.emit({ ...this.base(session), type: "item.completed", turnId, item });
    if (kind === "assistant_text") session.sawAssistant = true;
  }

  // ── native subagents ──────────────────────────────────────────────────────

  /** Begin tracking a child agy created, and announce it. The child's
   *  conversation id is the run's id: it is what the child's hook lines carry,
   *  what its report-back message is signed with, and what its transcript
   *  directory is named. */
  private startSubagentRun(
    session: AntigravitySession,
    handle: { conversationId: string; transcriptPath?: string },
    spec: AntigravitySubagentSpec | undefined,
    parentItemId: string | undefined,
  ): void {
    if (!session.activeTurnId || session.subagentRuns.has(handle.conversationId)) return;
    const snapshot: SubagentRunSnapshot = {
      toolUseId: handle.conversationId,
      status: "running",
      startedAt: Date.now(),
      // The tool returns as soon as the children exist — every native
      // subagent runs in the background and reports back by message.
      background: true,
    };
    if (parentItemId) snapshot.parentItemId = parentItemId;
    if (spec?.typeName) snapshot.agentType = spec.typeName;
    if (spec?.role) snapshot.description = spec.role;
    if (spec?.prompt) snapshot.prompt = spec.prompt;
    if (spec?.model) snapshot.model = spec.model;
    const run: AntigravitySubagentRun = {
      snapshot,
      transcriptPath:
        handle.transcriptPath ??
        antigravityTranscriptPath(handle.conversationId, session.homeDir),
      processedTranscriptBytes: 0,
      processedSteps: new Set(),
      pendingTools: [],
      nextToolSequence: 0,
      settled: false,
    };
    session.subagentRuns.set(handle.conversationId, run);
    this.emitSubagent(session, run, "subagent.started");
  }

  private emitSubagent(
    session: AntigravitySession,
    run: AntigravitySubagentRun,
    type: "subagent.started" | "subagent.updated" | "subagent.completed",
  ): void {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    this.emit({ ...this.base(session), type, turnId, subagent: { ...run.snapshot } });
  }

  private settleSubagentRun(
    session: AntigravitySession,
    run: AntigravitySubagentRun,
    status: SubagentStatus,
  ): void {
    if (run.settled) {
      // A late report still belongs to the run — the child messages the parent
      // before it goes idle, but the two can arrive the other way round.
      this.emitSubagent(session, run, "subagent.completed");
      return;
    }
    run.settled = true;
    run.snapshot.status = status;
    run.snapshot.endedAt = Date.now();
    for (const pending of run.pendingTools) {
      this.emitToolItem(session, pending.itemId, pending.name, "failed", pending.args, run);
    }
    run.pendingTools = [];
    this.emitSubagent(session, run, "subagent.completed");
  }

  /** Close out every run still open when the turn ends. The print process is
   *  gone by then, so a child that never reported back is stopped, not failed
   *  — it was doing its job right up to the moment the turn stopped watching. */
  private settleLiveSubagentRuns(session: AntigravitySession): void {
    for (const run of session.subagentRuns.values()) {
      if (!run.settled) this.settleSubagentRun(session, run, "stopped");
    }
  }

  /** Tail each child's transcript for its own reasoning and replies, exactly
   *  as the parent's is tailed. */
  private async readSubagentTranscripts(session: AntigravitySession): Promise<void> {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    for (const run of session.subagentRuns.values()) {
      if (!run.transcriptPath) continue;
      let batch: Awaited<ReturnType<typeof readCompleteAntigravityLines>>;
      try {
        batch = await readCompleteAntigravityLines(run.transcriptPath, run.processedTranscriptBytes);
      } catch {
        continue;
      }
      run.processedTranscriptBytes = batch.nextOffset;
      for (const line of batch.lines) {
        let step: TranscriptStep;
        try {
          // SAFETY: JSON.parse yields unknown; consumers probe fields before use.
          step = JSON.parse(line) as TranscriptStep;
        } catch {
          continue;
        }
        const stepIndex = step.step_index;
        if (!Number.isFinite(stepIndex) || run.processedSteps.has(stepIndex!)) continue;
        run.processedSteps.add(stepIndex!);
        if (step.type !== "PLANNER_RESPONSE") continue;
        const content = trim(step.content);
        if (!content) continue;
        const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        const kind: RuntimeItemKind = calls.length > 0 ? "reasoning_text" : "assistant_text";
        const item: RuntimeItem = {
          itemId: `antigravity-${turnId}-sub-${run.snapshot.toolUseId}-${stepIndex}-${kind}`,
          kind,
          status: "completed",
          text: content,
        };
        this.emit({
          ...this.base(session),
          type: "item.started",
          turnId,
          item,
          subagentToolUseId: run.snapshot.toolUseId,
        });
        this.emit({
          ...this.base(session),
          type: "item.completed",
          turnId,
          item,
          subagentToolUseId: run.snapshot.toolUseId,
        });
      }
    }
  }

  /** Tear the print process down so the close handler settles the turn. The
   *  non-zero exit that follows is this kill, not a failure — see
   *  antigravityTurnOutcome. */
  private tearDownPrintProcess(session: AntigravitySession): void {
    if (!session.activeProcess || session.turnTerminalEmitted) return;
    const child = session.activeProcess;
    session.agentStopped = true;
    delete session.backgroundIdleSince;
    void killTree(child.pid);
  }

  /** Poll the hook event file: pre/post-tool lifecycle becomes tool items, the
   *  conversation id + transcript path are learned here, and a stop hook with
   *  nothing left running tears the lingering print process down.
   *
   *  Every line names the conversation it came from, and a turn that spawns
   *  native subagents interleaves theirs with the parent's — so identity is
   *  read from the parent's lines only, and a child's are projected onto its
   *  run instead. */
  private async pollHookFile(session: AntigravitySession): Promise<void> {
    if (session.stopped) return;
    if (!session.eventFile) return;
    let batch: Awaited<ReturnType<typeof readCompleteAntigravityLines>>;
    try {
      batch = await readCompleteAntigravityLines(session.eventFile, session.processedHookBytes);
    } catch {
      return;
    }
    session.processedHookBytes = batch.nextOffset;
    const deferred = this.consumeHookLines(session, [...session.deferredHookLines, ...batch.lines]);
    session.deferredHookLines = [];
    await this.readTranscript(session);
    // Lines from a conversation that was unknown a moment ago: reading the
    // transcript may have just introduced the child that wrote them.
    session.deferredHookLines = this.consumeHookLines(session, deferred);
    await this.readSubagentTranscripts(session);

    // Nothing has happened since the agent stopped talking and left background
    // work running. Waiting further only holds the turn open for a child that
    // has gone quiet without reporting.
    if (
      session.backgroundIdleSince !== undefined &&
      Date.now() - session.backgroundIdleSince > BACKGROUND_IDLE_GRACE_MS
    ) {
      this.tearDownPrintProcess(session);
    }
  }

  /** Process hook lines, returning the ones whose conversation is not yet
   *  known — a child's first lines can outrun the transcript step that
   *  introduces it. */
  private consumeHookLines(session: AntigravitySession, lines: string[]): string[] {
    const deferred: string[] = [];
    for (const line of lines) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const eventName = line.slice(0, tab);
      let payload: AntigravityHookPayload;
      try {
        // SAFETY: JSON.parse yields unknown; the field probes below validate before use.
        payload = JSON.parse(line.slice(tab + 1)) as AntigravityHookPayload;
      } catch {
        continue;
      }
      const conversationId = payload.conversationId?.trim() || undefined;
      // The parent always speaks first: its own hooks fire before it can have
      // invoked anything, so the first id on the stream is this turn's.
      if (conversationId && !session.conversationId) session.conversationId = conversationId;
      const isParent = !conversationId || conversationId === session.conversationId;
      const run = isParent ? undefined : session.subagentRuns.get(conversationId);
      if (!isParent && !run) {
        if (deferred.length < DEFERRED_HOOK_LINE_LIMIT) deferred.push(line);
        continue;
      }
      // Any hook line is proof the turn is still doing something, so it
      // restarts the wait on background work.
      if (session.backgroundIdleSince !== undefined) session.backgroundIdleSince = Date.now();

      if (isParent) {
        const transcriptPath = payload.transcriptPath?.trim() || undefined;
        if (transcriptPath && transcriptPath !== session.transcriptPath) {
          session.transcriptPath = transcriptPath;
          session.processedTranscriptBytes = 0;
          delete session.processedTranscriptPath;
        }
      }
      const stepIndex =
        payload.stepIdx !== undefined && payload.stepIdx !== null &&
        Number.isInteger(payload.stepIdx) &&
        payload.stepIdx >= 0
          ? payload.stepIdx
          : undefined;
      if (eventName === "pre-tool" && stepIndex !== undefined && session.activeTurnId) {
        const name = payload.toolCall?.name ? trim(payload.toolCall.name) : undefined;
        if (name) {
          const args = payload.toolCall?.args;
          const owner = run ?? session;
          const scope = run ? `sub-${run.snapshot.toolUseId}-tool` : "tool";
          const itemId = `antigravity-${session.activeTurnId}-${scope}-${owner.nextToolSequence++}`;
          owner.pendingTools.push({ stepIndex, itemId, name, args });
          if (run) {
            run.snapshot.lastToolName = name;
            run.snapshot.toolUses = (run.snapshot.toolUses ?? 0) + 1;
            this.emitSubagent(session, run, "subagent.updated");
          } else {
            session.toolItemsByStep.set(stepIndex, { itemId, name, args });
          }
          this.emitToolItem(session, itemId, name, "in-progress", args, run);
        }
      } else if (eventName === "post-tool" && stepIndex !== undefined) {
        const owner = run ?? session;
        const pendingIndex = owner.pendingTools.findIndex((pending) => pending.stepIndex === stepIndex);
        const pending = pendingIndex >= 0 ? owner.pendingTools.splice(pendingIndex, 1)[0] : undefined;
        if (pending) {
          const failed =
            payload.failed === true ||
            Boolean(payload.error && payload.error.trim().length > 0);
          const args = payload.toolCall?.args ?? pending.args;
          const output =
            payload.error?.trim() ||
            payload.result?.trim() ||
            payload.toolOutput?.trim();
          this.emitToolItem(session, pending.itemId, pending.name, failed ? "failed" : "completed", args, run, output);
        }
      } else if (eventName === "stop") {
        // `fullyIdle` is the whole distinction: false means the agent has
        // finished speaking but its own background work (a native subagent) is
        // still going, and print mode is right to keep waiting. Killing there
        // would cut off the very report the turn is waiting for. An older CLI
        // that reports no such field is taken at its word: done is done.
        const fullyIdle = payload.fullyIdle !== false;
        if (run) {
          if (fullyIdle) this.settleSubagentRun(session, run, "completed");
        } else if (fullyIdle) {
          this.tearDownPrintProcess(session);
        } else {
          session.backgroundIdleSince = Date.now();
        }
      }
    }
    return deferred;
  }

  private emitToolItem(
    session: AntigravitySession,
    itemId: string,
    name: string,
    status: "in-progress" | "completed" | "failed",
    args?: AntigravityJsonRecord,
    run?: AntigravitySubagentRun,
    output?: string,
  ): void {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    const summary = summarizeAntigravityTool(name, args);
    const item: RuntimeItem = {
      itemId,
      kind: "tool_call",
      status,
      text: summary.text,
      name,
    };
    if (output) {
      item.detail = output;
    } else if (summary.detail) {
      item.detail = summary.detail;
    }
    const type = status === "in-progress" ? "item.started" : "item.completed";
    const event: Extract<RuntimeEvent, { type: "item.started" | "item.completed" }> = {
      ...this.base(session),
      type,
      turnId,
      item,
    };
    if (run) event.subagentToolUseId = run.snapshot.toolUseId;
    this.emit(event);
  }

  // ── shared helpers ────────────────────────────────────────────────────────

  private base(session: AntigravitySession) {
    const envelope = {
      threadId: session.threadId,
      provider: this.provider,
      at: Date.now(),
      source: "antigravity.cli.event" as const,
    };
    // The resume id rides every envelope so a turn that never completes
    // still leaves the thread resumable.
    return session.conversationId ? { ...envelope, refs: { conversationId: session.conversationId } } : envelope;
  }

  private toSession(session: AntigravitySession): Session {
    const result: Session = {
      threadId: session.threadId,
      provider: this.provider,
      cwd: session.cwd,
      status: session.activeTurnId ? "running" : "ready",
      conversationId: session.conversationId,
      resumedFrom: session.resumedFrom,
      activeTurnId: session.activeTurnId,
      model: session.model,
      mode: session.mode,
    };
    if (session.modelOptions?.reasoningEffort) result.effort = session.modelOptions.reasoningEffort;
    return result;
  }

  private requireSession(threadId: string): AntigravitySession {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`No Antigravity session for thread ${threadId}`);
    return session;
  }

  private versionAtLeast(version: string, minimum: string): boolean {
    const parse = (value: string) =>
      value.split(".").map((segment) => Number.parseInt(segment, 10) || 0);
    const left = parse(version);
    const right = parse(minimum);
    for (let i = 0; i < 3; i++) {
      if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) > (right[i] ?? 0);
    }
    return true;
  }
}

/** The turn child's environment: the agent env plus the per-turn hook stream,
 *  and — when a gateway connection exists — the URL + one-shot bootstrap the
 *  plugin's MCP config expands (see ensureCapturePlugin + stdioProxy.mjs). */
async function buildAntigravityTurnEnvironment(
  session: AntigravitySession,
  eventFile: string,
  bootstrapToken: string | null | undefined,
): Promise<NodeJS.ProcessEnv> {
  const env = await buildAntigravityEnv(eventFile);
  if (session.homeDir) {
    env.HOME = session.homeDir;
    env.USERPROFILE = session.homeDir;
  }
  if (session.gatewayConnection && bootstrapToken) {
    env[KONE_AGENT_GATEWAY_URL_ENV] = session.gatewayConnection.url;
    env[KONE_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV] = bootstrapToken;
  }
  return env;
}

function messageFromCause(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

/** Resolve with the value, or `undefined` after `ms` — bounds the interrupt
 *  teardown gate so a stuck child can't hang Cancel. */
function withTimeout<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}
