import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import {
  DROID_BINARY,
  buildDroidEnv,
  buildDroidProbeEnv,
  detectDroidAuth,
  parseDroidVersion,
  resolveDroidBinary,
} from "../droidHome.js";
import { JsonRpcClient } from "../jsonRpc.js";
import { formatPlanTasks, reconcilePlanTasks } from "../planTasks.js";
import { isResumeRefusalError } from "./errors.js";
import { koneHostContextForFirstRun } from "../gateway/appContext.js";
import { acpAgentSupportsHttp, acpMcpServers } from "../gateway/injection.js";
import type { CursorImageBlock } from "../promptAttachments.js";
import { probe } from "../spawn.js";
import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestKind,
  EmitEvent,
  GatewayConnection,
  InteractionMode,
  ModelDescriptor,
  PlanTask,
  ProviderAdapter,
  ProviderConfig,
  ProviderStatus,
  RuntimeItem,
  RuntimeItemKind,
  RuntimeItemStatus,
  Session,
  SendTurnInput,
  SessionStartInput,
  TokenUsage,
  TurnStartResult,
  UserInputAnswers,
} from "../types.js";
import type { TokenUsageSplits } from "../usage/report.js";

// Droid adapter — drives Factory's `droid exec --output-format acp`, a
// persistent JSON-RPC-over-stdio child per thread speaking ACP (the Agent
// Client Protocol), the same transport CursorAdapter drives for `cursor-agent
// acp`. Everything below was verified live against droid 0.186.0 on 2026-08-03
// (captures in docs/archive/droid/raw/).
//
// "Bring your own subscription" holds: kone never runs `droid` login and never
// opens a credential — discover() checks FACTORY_API_KEY / ~/.factory auth-file
// *presence* only (droidHome.detectDroidAuth), and every child is spawned with
// NO_BROWSER so a missing login can't pop a browser tab mid-turn.
//
// Protocol facts worth knowing before editing this file — all confirmed live,
// none of them guessable from the ACP spec:
//
//  1. The model catalog is ORG-POLICY GATED. `session/new`'s
//     `models.availableModels` is the ONLY authoritative source: this account
//     sees exactly 9 entries (`kimi-k2.6`, `custom:*` …) while the ~38
//     "built-in" models `droid exec -m <bogus>` prints are a marketing list —
//     `droid exec -m gemini-3.5-flash` fails with "Model blocked by
//     organization policy", and only the org's allowed set actually runs.
//     NEVER scrape the CLI's invalid-model error output and never hardcode a
//     catalog; every model in it must come from a live `session/new`.
//  2. There is NO usage over ACP. All 364 captured `session/update`
//     notifications (agent_message_chunk ×166, agent_thought_chunk ×168, tool
//     calls, mode/config/command updates) contain zero token fields, and the
//     `session/prompt` result is always bare `{ "stopReason": … }`. The
//     on-disk `~/.factory/sessions/**/*.settings.json` `tokenUsage` object is
//     always zeros. So this adapter emits NO `thread.token-usage.updated` —
//     the `usage_update` handler below is defensive ground truth, kept for the
//     day a droid build starts emitting it (the shape is the ACP standard).
//  3. `session/set_config_option` answers `{}` — the *refreshed* config matrix
//     arrives asynchronously as a `config_option_update` notification (seen
//     live after `set_config_option model=…`: the `reasoning_effort` options
//     changed with the model). The adapter waits for that notification before
//     considering a config change applied.
//  4. `session/set_mode { sessionId, modeId }` works on this build (live:
//     `set_mode modeId=normal` → `current_mode_update normal`) and also
//     surfaces through the `autonomy_level` config option. Older builds exposed
//     only the `autonomy_level` select, so a rejected set_mode falls back to
//     `session/set_config_option` on that option — never spawn flags.
//  5. `session/request_permission` IS issued (live capture: a Write-tool ask
//     with `options: [{optionId:"proceed_once",kind:"allow_once",…},
//     {optionId:"proceed_always",kind:"allow_always",…},
//     {optionId:"cancel",kind:"reject_once",…}]`). droid's optionIds are its
//     own spellings — SELECT BY `kind`, RETURN the matched option's `optionId`.
//     An unanswered request hangs the turn forever, so every request is parked
//     and surfaced to the user via `approval.requested` (see wireRequests) —
//     the turn stays hung until they decide.
//  6. A cancelled turn resolves `session/prompt` with `stopReason: "cancelled"`
//     (live) — unlike Cursor's ambiguous `end_turn`. The `interrupting` flag
//     is still kept: belt-and-braces, identical to CursorAdapter's.
//  7. droid advertises `loadSession` AND `sessionCapabilities.resume`;
//     `session/resume` does not replay history, `session/load` may. Resume
//     prefers `session/resume`. A load's replay needs no suppression: it lands
//     before any turn is active, and every transcript handler is gated on an
//     `activeTurnId`, so a replayed chunk has nowhere to go (see startSession).
//  8. The CLI auto-updates (moved 0.185.0 → 0.186.0 during this project).
//     Never gate behaviour on a version — the mode/config surface above is
//     resolved from the live handshake instead.

const DROID_INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientInfo: { name: "kone", title: "kone", version: "0.1.0" },
  clientCapabilities: {
    // kone doesn't proxy the filesystem or a terminal for the agent — droid
    // runs its own tools in the workspace it was spawned in. It advertises
    // `promptCapabilities.image`, so images ride as native ACP blocks.
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
} as const;

/** Auth method ids droid advertises (initialize result). Prefer the API key
 *  when FACTORY_API_KEY is set; device-pairing needs a human login. */
const DROID_API_KEY_AUTH_METHOD = "factory-api-key";
const DROID_DEVICE_PAIRING_AUTH_METHOD = "device-pairing";

/** Per-step startup budgets. `authenticate` gets the longest: device pairing
 *  can stall while deciding there is no browser to open. */
const INITIALIZE_TIMEOUT_MS = 20_000;
const AUTHENTICATE_TIMEOUT_MS = 30_000;
const SESSION_SETUP_TIMEOUT_MS = 20_000;
/** A turn runs as long as it needs to — `session/prompt` only settles when the
 *  agent is done — so the RPC deadline has to be far past any real turn. */
const PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const CONFIG_TIMEOUT_MS = 15_000;
/** How long to wait for the `config_option_update` notification that follows a
 *  `session/set_config_option` / `session/set_mode` (`{}` response, fact 3). */
const CONFIG_REFRESH_TIMEOUT_MS = 5_000;
/** Total budget for the per-model effort probe in `fetchModels`. The probe is
 *  inherently serial (one session switched model by model), so a catalog where
 *  every switch stalls costs models × CONFIG_REFRESH_TIMEOUT_MS while holding a
 *  `droid exec` child open. Measured live: 9 models in ~5.4s. Past the budget
 *  the remaining models are still listed, just without an effort ladder — the
 *  same degradation an org-blocked model already gets. */
const CATALOG_PROBE_BUDGET_MS = 45_000;
/** How long stopSession waits for the old child to actually exit before a
 *  teardown gate exists because both the old
 *  `droid exec` child and the replacement's config writes touch droid's single
 *  sqlite store — spawning the new child while the old one still holds the
 *  store lock can fail the new session's open. Bounded: a child that ignores
 *  SIGTERM must not hang the user's stop. */
const DROID_TEARDOWN_GRACE_MS = 5_000;
/** Timeout for the per-session `droid mcp remove` cleanup probe. Bounded so a
 *  hung local CLI can't stall stopSession (and with it app quit) for long. */
const DROID_CLEANUP_TIMEOUT_MS = 5_000;

/** The config-option ids droid exposes (session/new `configOptions`), by kone
 *  axis. The mode/autonomy select carries `category: "mode"`. */
const MODEL_CONFIG_IDS = ["model"] as const;
const EFFORT_CONFIG_IDS = ["reasoning_effort"] as const;
const MODE_CONFIG_IDS = ["autonomy_level", "mode"] as const;

/** kone InteractionMode → droid ACP mode id, resolved against the live
 *  `modes.availableModes` list (never hard-coded wholesale). The three rungs
 *  map onto droid's autonomy ladder by *what each mode auto-approves*:
 *  `normal` = "Auto (Off) — auto-approves only read operations" (kone's `ask`
 *  sandbox), `auto-low` = "auto-approves file edits and low-risk actions"
 *  (`accept-edits`), `auto-high` = "auto-approves all actions" (`full-access`).
 *  droid also advertises `spec` (read-only plan mode) — kone has no plan axis,
 *  so it is never selected.
 *
 *  Each rung lists its fallbacks in *descending* autonomy order, so a droid
 *  build that drops a mode id degrades to a narrower rung (the agent asks more
 *  often) and never to a wider one. */
const DROID_MODE_PREFERENCES = {
  ask: ["normal"],
  "accept-edits": ["auto-low", "normal"],
  "full-access": ["auto-high", "auto-low", "normal"],
} satisfies Record<InteractionMode, readonly string[]>;

type DroidItemBuffer = {
  itemId: string;
  kind: RuntimeItemKind;
  name?: string;
  text: string;
  detail: string;
  tasks?: PlanTask[];
};

type DroidConfigOption = {
  id: string;
  name?: string;
  category?: string;
  currentValue?: string;
  options: { value: string; name?: string }[];
};

type DroidSession = {
  threadId: string;
  cwd: string;
  model?: string;
  mode: InteractionMode;
  conversationId?: string;
  /** Set only when `SessionStartInput.resume` was actually adopted — see Session.resumedFrom. */
  resumedFrom?: string;
  /** The kone gateway connection minted at startSession — the agent's app
   *  tools (kone_scratchpad_read/write via the gateway's MCP server). */
  gatewayConnection?: GatewayConnection;
  /** User turns sent so far; the kone host-context block rides the first one. */
  runOrdinal: number;
  activeTurnId?: string;
  rpc: JsonRpcClient;
  items: Map<string, DroidItemBuffer>;
  /** Config options as droid last reported them (session/new response plus
   *  every `config_option_update`) — the source of truth for which axes this
   *  model actually has (fact 3). */
  configOptions: DroidConfigOption[];
  /** Session mode ids from `session/new`, used to resolve an InteractionMode
   *  onto a real mode id rather than assuming droid's spelling. */
  modeIds: string[];
  /** Set by interruptTurn so the turn's terminal event is `turn.aborted`
   *  even though droid reports a real `cancelled` stop reason (fact 6). */
  interrupting: boolean;
  /** Assistant/reasoning text arrives as bare chunks with no item identity, so
   *  one contiguous run of one kind is one synthetic item. */
  segment?: { itemId: string; kind: RuntimeItemKind };
  segmentCount: number;
  /** Items emitted as started/updated but never completed — a tool call a
   *  cancel cut mid-flight would otherwise spin in the transcript forever. */
  openItemIds: Set<string>;
  /** In-flight `session/request_permission` round-trips, keyed by our
   *  requestId. The RPC handler awaits `promise`; respondToRequest resolves it
   *  (or we drain on interrupt/stop) — the decision selects the reply option. */
  pendingApprovals: Map<string, PendingApproval>;
  /** Resolves once the child process has actually exited (fires on the RPC
   *  client's close). stopSession awaits this — bounded — so a replacement
   *  session never spawns while the predecessor still runs. */
  exited: Promise<void>;
};

/** A parked ACP permission request: the ask we surfaced and the resolver the
 *  awaited `session/request_permission` handler is blocked on. */
type PendingApproval = {
  approval: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
};

// ── small JSON helpers ───────────────────────────────────────────────────────

/** The droid MCP config entry name for one session's gateway connection.
 *  Thread-scoped: droid's `mcp` config is global per user, so concurrent
 *  droid sessions must never share an entry (a shared entry would clobber
 *  the previous session's token). */
function koneMcpServerName(threadId: string): string {
  return `kone-${threadId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown, ...path: string[]): string | undefined {
  let cursor: unknown = value;
  for (const key of path) cursor = asRecord(cursor)?.[key];
  return typeof cursor === "string" ? cursor : undefined;
}

function readNumber(value: unknown, ...path: string[]): number | undefined {
  let cursor: unknown = value;
  for (const key of path) cursor = asRecord(cursor)?.[key];
  return typeof cursor === "number" ? cursor : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Resolve with the value, or `undefined` after `ms` — used to bound the
 *  teardown gate so a stuck child can't hang stopSession. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
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

/** Normalize an ACP `session/request_permission` payload into the neutral ask
 *  the renderer shows. The request names the tool call it wants to allow, so
 *  the headline is the command/title and the kind follows the tool family. */
function buildAcpApprovalRequest(params: unknown): ApprovalRequest {
  const toolCall = asRecord(asRecord(params)?.toolCall);
  const toolKind = readString(toolCall, "kind") ?? "";
  const kind: ApprovalRequestKind = /^bash$/i.test(toolKind)
    ? "command"
    : /^(edit|write|delete|move|create)$/i.test(toolKind)
      ? "file-change"
      : /^read$/i.test(toolKind)
        ? "file-read"
        : "permission";
  const title =
    readString(toolCall, "command")?.trim() ??
    readString(toolCall, "title")?.trim() ??
    "Request permission";
  const detail = readString(toolCall, "detail")?.trim();
  const request: ApprovalRequest = {
    kind,
    title,
  };
  if (detail) request.detail = detail;
  return request;
}

/** Pick the reply option for a decision, matching the option's `kind` prefix
 *  (`allow_once` / `allow_always` / `reject_once`) because the provider's
 *  optionIds are its own spellings. Reject falls back to any deny/reject/cancel
 *  option; `reject-and-stop` deliberately matches NOTHING — the provider gets a
 *  cancelled outcome and the adapter interrupts the turn (the ACP spell of
 *  undefined for "cancel"). No match returns undefined (a cancelled outcome). */
function selectPermissionOption(options: unknown[], decision: ApprovalDecision): string | undefined {
  if (decision === "reject-and-stop") return undefined;
  const wanted = decision === "allow-once" ? "allow_once" : decision === "allow-always" ? "allow_always" : "reject_once";
  const direct = options.find((option) => readString(option, "kind")?.startsWith(wanted));
  if (direct) return readString(direct, "optionId");
  if (decision === "reject-once") {
    const fallback = options.find((option) =>
      /^(deny|reject|cancel)/.test(readString(option, "kind") ?? ""),
    );
    if (fallback) return readString(fallback, "optionId");
  }
  return undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parse a droid config option (`{ id, name, category, currentValue, options:
 *  [{ value, name }] }`), tolerating the fields it omits. Same ACP shape
 *  CursorAdapter parses. */
export function parseDroidConfigOptions(value: unknown): DroidConfigOption[] {
  const out: DroidConfigOption[] = [];
  for (const raw of asArray(value)) {
    const id = readString(raw, "id");
    if (!id) continue;
    const options: { value: string; name?: string }[] = [];
    for (const rawOption of asArray(asRecord(raw)?.options)) {
      const optionValue = readString(rawOption, "value");
      if (!optionValue) continue;
      options.push({ value: optionValue, name: readString(rawOption, "name") });
    }
    out.push({
      id,
      name: readString(raw, "name"),
      category: readString(raw, "category"),
      currentValue: readString(raw, "currentValue"),
      options,
    });
  }
  return out;
}

function findOption(options: readonly DroidConfigOption[], ids: readonly string[]): DroidConfigOption | undefined {
  return options.find((option) => ids.includes(option.id));
}

/** Match the live mode list: the exact id droid advertises for the kone rung,
 *  else the widest advertised mode that is still no wider than the rung asked
 *  for. Deliberately *not* CursorAdapter's `?? available[0]` catch-all — the
 *  ids here are an autonomy ladder, and `available[0]` on a droid build that
 *  renamed `normal` would silently run kone's read-only `ask` rung under
 *  whichever mode happens to sort first, possibly `auto-high`. Returning
 *  undefined instead leaves the session on droid's own default (`normal`),
 *  which is the narrow end of the ladder. */
export function resolveDroidModeId(
  mode: InteractionMode,
  available: readonly string[],
): string | undefined {
  return DROID_MODE_PREFERENCES[mode].find((id) => available.includes(id));
}

// ── model catalog ────────────────────────────────────────────────────────────

/** Project one `models.availableModels` entry (from a `session/new` response)
 *  onto kone's ModelDescriptor. `modelId` → `id` (kone uses `label`, not
 *  `displayName` — a past bug in this repo shipped that mixup). Per-model
 *  reasoning efforts come from the `reasoning_effort` config option as probed
 *  for that model; undefined when the probe failed or the model has no axis. */
export function toDroidModelDescriptor(
  raw: unknown,
  efforts?: { values: readonly string[]; current?: string },
): ModelDescriptor | undefined {
  const modelId = readString(raw, "modelId");
  if (!modelId) return undefined;
  const descriptor: ModelDescriptor = { id: modelId, label: readString(raw, "name")?.trim() || modelId };
  if (efforts && efforts.values.length > 0) {
    descriptor.reasoningEfforts = [...efforts.values];
    if (efforts.current) descriptor.defaultReasoningEffort = efforts.current;
  }
  return descriptor;
}

// ── mode → droid session mode ───────────────────────────────────────────────

// ── tool-call presentation ───────────────────────────────────────────────────

/** ACP tool kinds → the canonical tool keyword kone's thread UI understands.
 *  Same contract CursorAdapter's TOOL_KIND_NAMES honors — the vocabulary is
 *  with the renderer, not the provider. */
const TOOL_KIND_NAMES: Record<string, string> = {
  read: "read_file",
  edit: "edit_file",
  delete: "edit_file",
  move: "edit_file",
  execute: "run",
  search: "search",
  fetch: "web_search",
  think: "tool",
  switch_mode: "tool",
  other: "tool",
};

/** A short, human inline target for a tool row: the command, path, or query —
 *  never the tool's own name, which travels separately as `name`. droid's
 *  Write tool puts the path in `rawInput.file_path` (live capture). */
export function toolCallTarget(update: Record<string, unknown>): string {
  const rawInput = asRecord(update.rawInput);
  const command = readString(rawInput, "command");
  if (command) return command;

  const path = readString(rawInput, "path") ?? readString(rawInput, "file_path");
  if (path) return path;

  const query = readString(rawInput, "query") ?? readString(rawInput, "pattern") ?? readString(rawInput, "url");
  if (query) return query;

  const locations = asArray(update.locations);
  const firstPath = locations.length > 0 ? readString(locations[0], "path") : undefined;
  if (firstPath) return locations.length > 1 ? `${firstPath} +${locations.length - 1} more` : firstPath;

  return readString(update, "title") ?? "";
}

/** The expandable body of a tool row. droid sends `content` arrays with
 *  `{ type: "diff", path, oldText, newText }` and `{ type: "content",
 *  content: { type: "text", text } }` blocks (live capture); results may land
 *  in `rawOutput`. */
export function toolCallDetail(update: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const block of asArray(update.content)) {
    const text = readString(block, "content", "text") ?? readString(block, "text");
    if (text) parts.push(text);
  }
  const rawOutput = asRecord(update.rawOutput);
  if (rawOutput) {
    const output = readString(rawOutput, "content") ?? readString(rawOutput, "output") ?? readString(rawOutput, "stdout");
    if (output) parts.push(output);
    else parts.push(JSON.stringify(rawOutput, null, 2));
  }
  return parts.join("\n").trim();
}

export function toolCallStatus(raw: string | undefined): RuntimeItemStatus {
  if (raw === "completed") return "completed";
  if (raw === "failed") return "failed";
  return "in-progress";
}

/** ACP plan entries are `{ content, status }` with `in_progress` spelled with
 *  an underscore; kone's PlanTaskStatus uses a hyphen. Defensive ground truth:
 *  droid 0.186.0 never emitted a `plan` update across 364 live notifications,
 *  but the shape is the ACP standard and it costs nothing to keep. */
export function parseDroidPlan(update: Record<string, unknown>): Omit<PlanTask, "id">[] | undefined {
  const entries = asArray(update.entries);
  if (entries.length === 0) return undefined;
  const out: Omit<PlanTask, "id">[] = [];
  for (const entry of entries) {
    const content = readString(entry, "content")?.trim();
    if (!content) continue;
    const rawStatus = readString(entry, "status");
    const status =
      rawStatus === "completed" ? "completed" : rawStatus === "in_progress" ? "in-progress" : "pending";
    out.push({ content, status });
  }
  return out.length > 0 ? out : undefined;
}

export class DroidAdapter implements ProviderAdapter {
  readonly provider = "droid" as const;
  readonly capabilities: AdapterCapabilities = {
    // `session/set_config_option {configId: "model"}` takes effect on a live
    // session (verified: the model config updated mid-session and the turn
    // that followed ran on the new model), so a switch never restarts.
    sessionModelSwitch: "in-session",
    streamsText: true,
    supportsToolEvents: true,
    supportsResume: true,
    supportsModelList: true,
    // droid's `Task` tool spawns nested agents, but ACP reports one flat tool
    // stream — a delegated run isn't distinguishable as a nested one.
    supportsSubagents: false,
  };

  private readonly emit: EmitEvent;
  private readonly sessions = new Map<string, DroidSession>();
  private modelsCache: Promise<ModelDescriptor[]> | null = null;
  /** True while `modelsCache` holds only the catalog `startSession` seeded from
   *  its own `session/new` response. That seed is org-accurate and free, but it
   *  knows the reasoning-effort ladder of exactly one model — whichever the
   *  session opened on — so every other model in it comes back with no efforts
   *  at all. It has to stay upgradeable: without this flag the first session to
   *  start pins 8 of 9 models to a dead effort dial for the whole app run, and
   *  AgentService writes that through to the on-disk catalog cache. */
  private modelsCacheIsSeed = false;
  /** The CLI executable to spawn — the user's override or `droid`. */
  private binary = DROID_BINARY;

  constructor(emit: EmitEvent) {
    this.emit = emit;
  }

  setConfig(config: ProviderConfig): void {
    const next = resolveDroidBinary(config.binaryPath);
    if (next === this.binary) return;
    this.binary = next;
    this.modelsCache = null;
    this.modelsCacheIsSeed = false;
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  async discover(): Promise<ProviderStatus> {
    const env = await buildDroidProbeEnv();
    const versionOutput = await probe(this.binary, ["--version"], env, 5_000);
    if (versionOutput === null) {
      return {
        provider: this.provider,
        label: "Factory Droid",
        available: false,
        authStatus: "unknown",
        readiness: "not-installed",
        message: "Droid CLI not found. Install it from https://factory.ai, then sign in.",
      };
    }

    const version = parseDroidVersion(versionOutput);
    const auth = await detectDroidAuth();
    if (!auth.authenticated) {
      return {
        provider: this.provider,
        label: "Factory Droid",
        available: true,
        authStatus: "unauthenticated",
        readiness: "needs-login",
        version,
        message: "Run `droid` once to sign in (device pairing), or set FACTORY_API_KEY.",
      };
    }

    return {
      provider: this.provider,
      label: "Factory Droid",
      available: true,
      authStatus: "authenticated",
      readiness: "ready",
      version,
      authLabel: auth.label,
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // A seeded catalog still needs the real probe — it's missing every model's
    // effort ladder but its own (see `modelsCacheIsSeed`). Serve it meanwhile;
    // the probe replaces it in place once it lands.
    if (this.modelsCache && !this.modelsCacheIsSeed) return this.modelsCache;
    const seeded = this.modelsCache;
    this.modelsCacheIsSeed = false;
    this.modelsCache = this.fetchModels()
      .then(async (models) => {
        // An empty probe means unauthenticated or a session that wouldn't
        // open — never throw away a good seed for it.
        if (models.length === 0 && seeded) {
          this.modelsCacheIsSeed = true;
          return seeded;
        }
        return models;
      })
      .catch((error: unknown) => {
        this.modelsCache = seeded;
        this.modelsCacheIsSeed = seeded !== null;
        throw error;
      });
    return this.modelsCache;
  }

  /** Discover the catalog IN-PROTOCOL: a disposable ACP session's
   *  `session/new` response is the org-policy-gated, per-user truth (fact 1) —
   *  droid has no CLI model-list surface worth trusting. Each model is then
   *  probed for its own reasoning-effort options by switching the session to
   *  it (the `reasoning_effort` config option is per-model; its options change
   *  with `currentModelId`, verified live), then the original model is
   *  restored. A blocked or invalid model probe degrades to no efforts rather
   *  than dropping the model. */
  private async fetchModels(): Promise<ModelDescriptor[]> {
    const env = await buildDroidEnv();
    const rpc = new JsonRpcClient(this.binary, ["exec", "--output-format", "acp"], {
      cwd: homedir(),
      env,
    });
    const state: Pick<DroidSession, "configOptions"> = { configOptions: [] };
    rpc.onNotification("session/update", (params) => {
      const update = asRecord(asRecord(params)?.update);
      if (readString(update, "sessionUpdate") !== "config_option_update") return;
      const refreshed = parseDroidConfigOptions(asRecord(update)?.configOptions);
      if (refreshed.length > 0) state.configOptions = refreshed;
    });
    try {
      const initializeResult = await rpc.call<Record<string, unknown>>(
        "initialize",
        DROID_INITIALIZE_PARAMS,
        INITIALIZE_TIMEOUT_MS,
      );
      await this.authenticateRpc(rpc, initializeResult);
      const response = await rpc.call<Record<string, unknown>>(
        "session/new",
        { cwd: homedir(), mcpServers: [] },
        SESSION_SETUP_TIMEOUT_MS,
      );
      const sessionId = readString(response, "sessionId");
      if (!sessionId) return [];
      state.configOptions = parseDroidConfigOptions(asRecord(response)?.configOptions);
      const originalModel = findOption(state.configOptions, MODEL_CONFIG_IDS)?.currentValue;
      const models = asArray(asRecord(asRecord(response)?.models)?.availableModels);

      const descriptors: ModelDescriptor[] = [];
      const probeDeadline = Date.now() + CATALOG_PROBE_BUDGET_MS;
      for (const raw of models) {
        const modelId = readString(raw, "modelId");
        if (!modelId) continue;
        const efforts =
          Date.now() < probeDeadline
            ? await this.probeModelEfforts(rpc, state, sessionId, modelId)
            : undefined;
        const descriptor = toDroidModelDescriptor(raw, efforts);
        if (descriptor) descriptors.push(descriptor);
      }

      if (originalModel && findOption(state.configOptions, MODEL_CONFIG_IDS)?.currentValue !== originalModel) {
        await rpc
          .call("session/set_config_option", { sessionId, configId: "model", value: originalModel }, CONFIG_TIMEOUT_MS)
          .catch(() => {});
      }
      return descriptors;
    } catch {
      // Not authenticated, or the session couldn't be created — an empty
      // catalog beats offering models the account can't run.
      return [];
    } finally {
      rpc.kill();
    }
  }

  /** The reasoning-effort options droid advertises for one model, by switching
   *  the disposable discovery session onto it and reading the refreshed
   *  `reasoning_effort` config option. The session's current model needs no
   *  probe — `session/new` already reported its options. */
  private async probeModelEfforts(
    rpc: JsonRpcClient,
    state: { configOptions: DroidConfigOption[] },
    sessionId: string,
    modelId: string,
  ): Promise<{ values: readonly string[]; current?: string } | undefined> {
    if (findOption(state.configOptions, MODEL_CONFIG_IDS)?.currentValue?.trim() === modelId) {
      return this.effortsFrom(state.configOptions);
    }
    try {
      await rpc.call(
        "session/set_config_option",
        { sessionId, configId: "model", value: modelId },
        CONFIG_TIMEOUT_MS,
      );
      const refreshed = await this.waitForConfigValue(state, MODEL_CONFIG_IDS[0], modelId);
      if (refreshed) return this.effortsFrom(refreshed);
    } catch {
      // Org-blocked or otherwise invalid model — no efforts, model stays.
    }
    return undefined;
  }

  private effortsFrom(configOptions: readonly DroidConfigOption[]): { values: readonly string[]; current?: string } | undefined {
    const efforts = findOption(configOptions, EFFORT_CONFIG_IDS);
    if (!efforts || efforts.options.length === 0) return undefined;
    return { values: efforts.options.map((option) => option.value), current: efforts.currentValue };
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async startSession(input: SessionStartInput): Promise<Session> {
    // Retire whatever this thread already owns before spawning its replacement —
    // the map is overwritten unconditionally below, so the previous `droid acp`
    // child would otherwise never be killed. See CodexAdapter for the same guard.
    if (this.sessions.has(input.threadId)) await this.stopSession(input.threadId);

    const env = await buildDroidEnv();
    const rpc = new JsonRpcClient(this.binary, ["exec", "--output-format", "acp"], {
      cwd: input.cwd,
      env,
    });
    // The teardown gate's completion signal: resolves when this child's
    // process actually closes, so a replacement session can await the
    // predecessor's real exit before spawning.
    const exited = new Promise<void>((resolve) => rpc.onExit(() => resolve()));
    const mode: InteractionMode = input.mode ?? "accept-edits";

    const session: DroidSession = {
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model,
      mode,
      rpc,
      items: new Map(),
      configOptions: [],
      modeIds: [],
      gatewayConnection: input.gatewayConnection,
      runOrdinal: 0,
      interrupting: false,
      segmentCount: 0,
      openItemIds: new Set(),
      pendingApprovals: new Map(),
      exited,
    };
    this.wireNotifications(session);
    this.wireRequests(session);
    rpc.onExit((code) => {
      // Only the session the map still points at may retire the entry; a
      // replacement can claim this threadId while this child shuts down. No
      // entry means stopSession already took ours, so still announce the exit.
      const current = this.sessions.get(input.threadId);
      if (current && current !== session) {
        // A replacement owns the thread now — the old session's parked asks
        // still die with it.
        this.drainApprovals(session);
        return;
      }
      if (current) this.sessions.delete(input.threadId);
      // Fail closed on the way out: resolve every parked permission request as
      // rejected so no RPC handler hangs on a promise nothing will settle.
      this.drainApprovals(session);
      this.emit({ ...this.base(session), source: "droid.acp.lifecycle", type: "session.exited", code });
    });

    try {
      const initializeResult = await rpc.call<Record<string, unknown>>(
        "initialize",
        DROID_INITIALIZE_PARAMS,
        INITIALIZE_TIMEOUT_MS,
      );
      await this.authenticateRpc(rpc, initializeResult);

      // The kone gateway (docs/mcp-gateway-design.md §4): droid manages MCP
      // servers through its own persistent CLI config (`droid mcp add`), not
      // the ACP `mcpServers` session param (which droid ignores — verified
      // against the live binary). Register per-session here so the agent's
      // tools resolve; the config is global per user, so the server name is
      // thread-scoped (kone-<threadId prefix>) to keep concurrent droid
      // sessions from clobbering each other's token, and stopSession removes
      // exactly that entry.
      if (input.gatewayConnection) {
        try {
          await this.registerGatewayMcp(input.threadId, input.gatewayConnection);
        } catch (error) {
          console.error(
            "[droid] kone MCP registration failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      // The kone gateway (docs/mcp-gateway-design.md §4): thread the app's MCP
      // server into every session door. An agent that advertises
      // `agentCapabilities.mcpCapabilities.http` gets the direct loopback HTTP
      // entry; otherwise droid spawns the stdio proxy (stdioProxy.mjs), which
      // forwards JSON-RPC to the same endpoint. No gateway connection → no
      // mcpServers at all — never promise tools the session can't reach.
      const mcpServers = input.gatewayConnection
        ? acpMcpServers(input.gatewayConnection, {
            httpCapable: acpAgentSupportsHttp(initializeResult),
          })
        : [];

      // droid advertises `sessionCapabilities.resume` (no replay) AND
      // `loadSession` (may replay history). Resume prefers `session/resume`
      // and falls back to `session/load`; a refused resume means the session
      // is gone from droid's store — start fresh rather than failing the
      // thread open, matching CursorAdapter's stale-id handling.
      //
      // A `session/load` may replay the prior transcript as `session/update`
      // notifications (fact 7), and nothing here suppresses them — nothing has
      // to. Replay lands while the session is still opening, and every
      // transcript handler (appendText, handleToolCall, handlePlan) is already
      // gated on an `activeTurnId` that no turn has set yet, so a replayed
      // chunk has nowhere to go. An explicit "drop replay until the first turn
      // settles" flag was tried and removed: the replay it aimed at arrives
      // before the load response can set it, so the only thing it ever
      // suppressed was the first real turn.
      const sessionCapabilities = asRecord(asRecord(initializeResult.agentCapabilities)?.sessionCapabilities);
      const supportsResume = sessionCapabilities !== undefined && "resume" in sessionCapabilities;
      const supportsLoad = asRecord(initializeResult.agentCapabilities)?.loadSession === true;
      let response: Record<string, unknown> | undefined;
      if (input.resume) {
        const method = supportsResume ? "session/resume" : supportsLoad ? "session/load" : undefined;
        if (method) {
          try {
            response = await rpc.call<Record<string, unknown>>(
              method,
              { sessionId: input.resume, cwd: input.cwd, mcpServers },
              SESSION_SETUP_TIMEOUT_MS,
            );
            session.conversationId = input.resume;
            session.resumedFrom = input.resume;
          } catch (error) {
            // Only a refusal-class failure (session gone/pruned) deserves the
            // fresh-session fallback — a transport or protocol error must
            // surface, or the thread would reopen blank for no reason. Same
            // gate CodexAdapter now applies to `thread/resume`.
            if (!isResumeRefusalError(error)) throw error;
            response = undefined;
          }
        }
      }
      if (!response) {
        response = await rpc.call<Record<string, unknown>>(
          "session/new",
          { cwd: input.cwd, mcpServers },
          SESSION_SETUP_TIMEOUT_MS,
        );
        const sessionId = readString(response, "sessionId");
        if (!sessionId) throw new Error("session/new response did not include a session id.");
        session.conversationId = sessionId;
      }

      // `modes: { currentModeId, availableModes: [{ id, name }] }`.
      session.modeIds = asArray(asRecord(asRecord(response)?.modes)?.availableModes)
        .map((raw) => readString(raw, "id"))
        .filter((id): id is string => id !== undefined);

      // `configOptions` from the session response — the starting matrix before
      // any `config_option_update` notification arrives.
      session.configOptions = parseDroidConfigOptions(asRecord(response)?.configOptions);

      // The session response's model catalog is the org-gated truth (fact 1);
      // seed the picker cache with it so the catalog is never stale. The
      // reasoning-effort axis is only known for the *current* model here — the
      // per-model probe fills the rest when listModels() runs, which is why the
      // seed is only ever a placeholder (`modelsCacheIsSeed`) and never
      // overwrites a catalog the probe already completed.
      const modelOption = findOption(session.configOptions, MODEL_CONFIG_IDS);
      const currentModelId = modelOption?.currentValue;
      const models = asArray(asRecord(asRecord(response)?.models)?.availableModels);
      const descriptors = models
        .map((raw) => {
          const modelId = readString(raw, "modelId");
          const efforts =
            modelId !== undefined && modelId === currentModelId ? this.effortsFrom(session.configOptions) : undefined;
          return toDroidModelDescriptor(raw, efforts);
        })
        .filter((descriptor): descriptor is ModelDescriptor => descriptor !== undefined);
      if (descriptors.length > 0 && (this.modelsCache === null || this.modelsCacheIsSeed)) {
        this.modelsCache = Promise.resolve(descriptors);
        this.modelsCacheIsSeed = true;
      }

      await this.applyMode(session, mode);
      if (input.model) await this.applyModel(session, input.model);
      if (input.effort) await this.applyConfigOption(session, EFFORT_CONFIG_IDS, input.effort);
      // A session started on droid's default model never went through
      // applyModel, so `session.model` is still unset — read it from the
      // config matrix so toSession/reporting carry the real model.
      if (!session.model) {
        const modelOptionAfter = findOption(session.configOptions, MODEL_CONFIG_IDS);
        if (modelOptionAfter?.currentValue) session.model = modelOptionAfter.currentValue;
      }
    } catch (error) {
      rpc.kill();
      throw error;
    }

    this.sessions.set(input.threadId, session);
    this.emit({ ...this.base(session), source: "droid.acp.lifecycle", type: "session.started" });
    return this.toSession(session);
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.requireSession(input.threadId);
    const mode = input.mode ?? session.mode;

    // Imported at call time, and only when there's something to attach, like
    // CursorAdapter does: promptAttachments reaches the attachment store,
    // which pulls in node:sqlite — statically importing it would make this
    // module unloadable outside the Electron runtime. droid advertises
    // `promptCapabilities.image`, so images ride as the same native ACP blocks
    // Cursor sends; other files become an `<attached_files>` path block.
    let imageBlocks: CursorImageBlock[] = [];
    let promptText = input.input.trim();
    if (input.attachments?.length) {
      const attachments = await import("../promptAttachments.js");
      const built = await attachments.buildCursorAttachmentInput(input.attachments);
      imageBlocks = built.imageBlocks;
      promptText = attachments.composePromptText(promptText, built.fileBlock ?? "");
    }
    // prependT3OrchestrationInstructions pattern — the same wiring as
    // OpenCodeAdapter): the app-context block rides the very first user turn
    // so the agent knows the gateway tools exist.
    promptText = koneHostContextForFirstRun({
      prompt: promptText,
      runOrdinal: session.runOrdinal + 1,
      gatewayControlAvailable: session.gatewayConnection !== undefined,
    });
    session.runOrdinal += 1;
    const prompt: Array<{ type: "text"; text: string } | CursorImageBlock> = [];
    if (promptText.length > 0) prompt.push({ type: "text", text: promptText });
    prompt.push(...imageBlocks);
    if (prompt.length === 0) {
      throw new Error("Turn input must include text or an attachment.");
    }

    // droid holds mode/model/effort on the session, not the turn, so re-assert
    // whatever this turn asked for before prompting. Each is best-effort: an
    // unavailable model or effort degrades to the session's current value
    // rather than failing a turn the user already sent.
    if (mode !== session.mode) await this.applyMode(session, mode);
    session.mode = mode;
    if (input.model && input.model !== session.model) await this.applyModel(session, input.model);
    if (input.effort) await this.applyConfigOption(session, EFFORT_CONFIG_IDS, input.effort);
    // `serviceTier` / `contextWindow` are deliberately not applied: droid's
    // model surface advertises no fast/context axes, so the picker never
    // offers them — a per-turn value could only arrive from a stale selection.

    // kone mints the turn id: droid's ACP has no turn identity (a turn is one
    // `session/prompt` round-trip), and a per-session counter would collide
    // across threads in the shared store (a documented bug in this repo).
    const turnId = `droid-turn-${randomUUID()}`;
    session.activeTurnId = turnId;
    session.interrupting = false;
    this.emit({ ...this.base(session), type: "turn.started", turnId });

    // `session/prompt` only settles when the whole turn is done, so it is
    // deliberately not awaited here — sendTurn is request/ack.
    void session.rpc
      .call<Record<string, unknown>>(
        "session/prompt",
        { sessionId: session.conversationId, prompt },
        PROMPT_TIMEOUT_MS,
      )
      .then(
        (response) => this.completeTurn(session, turnId, readString(response, "stopReason")),
        (error: unknown) => this.failTurn(session, turnId, error),
      );

    return { threadId: input.threadId, turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session?.activeTurnId || !session.conversationId) return;
    this.drainApprovals(session);
    // Flag first: the cancel lands as `stopReason: "cancelled"` (fact 6), and
    // the flag is the belt-and-braces that decides the terminal event either way.
    session.interrupting = true;
    session.rpc.notify("session/cancel", { sessionId: session.conversationId });
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.drainApprovals(session);
    this.abortLiveTurn(session);
    session.rpc.kill();
    this.sessions.delete(threadId);
    // Drop the per-session kone MCP entry from droid's persistent config so a
    // revoked token never lingers. Best-effort.
    const name = koneMcpServerName(threadId);
    const cleanup = probe(this.binary, ["mcp", "remove", name], process.env, DROID_CLEANUP_TIMEOUT_MS);
    // Teardown gate: startSession replaces this session the moment stopSession
    // returns, and the replacement's own `droid mcp remove`/`add`
    // (registerGatewayMcp) plus its fresh child both touch droid's single
    // sqlite store. If they interleave with this in-flight cleanup — or the
    // new child spawns while the old one still holds the store lock — the new
    // session can lose its gateway tools or fail to open. Wait (bounded) for
    // the old child's actual exit and the cleanup to settle first.
    await Promise.allSettled([cleanup, withTimeout(session.exited, DROID_TEARDOWN_GRACE_MS)]);
  }

  /** Register the kone gateway in droid's persistent MCP config (the ACP
   *  `mcpServers` session param is ignored by droid — its CLI owns that
   *  surface). Thread-scoped name so concurrent droid sessions don't clobber
   *  each other's token. The bearer rides the `--header` arg, visible only to
   *  local processes for the duration of the CLI call. */
  private async registerGatewayMcp(threadId: string, connection: GatewayConnection): Promise<void> {
    const env = await buildDroidEnv();
    const name = koneMcpServerName(threadId);
    await probe(this.binary, ["mcp", "remove", name], env, 10_000);
    const output = await probe(
      this.binary,
      [
        "mcp", "add", name, connection.url,
        "--type", "http",
        "--header", `Authorization: Bearer ${connection.bearerToken}`,
        "--no-oauth",
      ],
      env,
      15_000,
    );
    if (output === null) {
      throw new Error("droid mcp add exited non-zero");
    }
  }

  /** Seal a turn that's still live as we tear the session down. Killing the
   *  transport means droid's `session/cancel` reply never arrives, so nothing
   *  else will ever speak for this turn — without this the journaled assistant
   *  block stays 'running' forever and the thread reopens permanently busy.
   *  See CodexAdapter for the same guard. */
  private abortLiveTurn(session: DroidSession): void {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    session.activeTurnId = undefined;
    session.interrupting = false;
    this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason: "interrupted" });
  }

  async stopAll(): Promise<void> {
    // Delegates to stopSession so every session gets the same drain → seal →
    // kill → teardown-gate sequence (including the MCP cleanup, which the old
    // loop skipped).
    await Promise.all([...this.sessions.keys()].map((threadId) => this.stopSession(threadId)));
  }

  async respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.resolveApproval(session, requestId, decision);
    // "Reject and stop" — the parked call resolves with a cancelled outcome
    // (selectPermissionOption matched nothing) and the TURN is interrupted, not
    // just the call. Same session/cancel the interrupt path sends; drain's
    // reject-once resolves are idempotent, so firing after the specific resolve
    // is safe.
    if (decision === "reject-and-stop") void this.interruptTurn(threadId);
  }

  async respondToUserInput(_threadId: string, _requestId: string, _answers: UserInputAnswers): Promise<void> {
    // droid's ACP surface was never observed sending an `elicitation/create`
    // reverse request; nothing parks a question, so there's nothing to resolve.
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()].map((session) => this.toSession(session));
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  // ── session configuration ────────────────────────────────────────────────

  /** droid answers `{}` when the login is already good (verified), so this is
   *  safe to run on every start. A hard failure here is the real "not logged
   *  in" signal and must surface. The method id comes from the live handshake:
   *  API key when FACTORY_API_KEY is set, else device pairing. */
  private async authenticateRpc(rpc: JsonRpcClient, initializeResult: Record<string, unknown>): Promise<void> {
    const methodId = resolveDroidAuthMethodId(initializeResult);
    if (!methodId) {
      throw new Error(
        "Droid ACP is not authenticated. Run `droid` once to sign in (device pairing), or set FACTORY_API_KEY.",
      );
    }
    await rpc.call(
      "authenticate",
      { methodId, _meta: { headless: true } },
      AUTHENTICATE_TIMEOUT_MS,
    );
  }

  /** Apply kone's mode rung onto droid's session mode, in-protocol. `session/
   *  set_mode` is the standard ACP call and works on this build (fact 4);
   *  older builds exposed only the `autonomy_level` select, so a rejected
   *  set_mode falls back to that config option. Either way the refreshed
   *  state arrives as a `config_option_update` notification, which is awaited
   *  so the next prompt runs under the requested mode. */
  private async applyMode(session: DroidSession, mode: InteractionMode): Promise<void> {
    const modeId = resolveDroidModeId(mode, session.modeIds);
    if (!modeId) return;
    try {
      await session.rpc.call(
        "session/set_mode",
        { sessionId: session.conversationId, modeId },
        CONFIG_TIMEOUT_MS,
      );
      await this.waitForConfigValue(session, MODE_CONFIG_IDS[0], modeId);
    } catch {
      // Older Droid builds exposed the autonomy selector without a modes block;
      // applyConfigOption degrades-and-warns itself.
      await this.applyConfigOption(session, MODE_CONFIG_IDS, modeId).catch(() => {});
    }
  }

  private async applyModel(session: DroidSession, model: string): Promise<void> {
    await this.applyConfigOption(session, MODEL_CONFIG_IDS, model);
    // Only claim the model applied when droid's matrix actually reflects it —
    // an org-blocked model leaves the session on its current model.
    const applied = findOption(session.configOptions, MODEL_CONFIG_IDS);
    if (applied && applied.currentValue?.trim() === model.trim()) session.model = model;
  }

  /** Set one config axis (model/effort/mode) by config id. The response is
   *  `{}`; the refreshed matrix arrives as a `config_option_update`
   *  notification, which waitForConfigValue polls for (fact 3). */
  private async applyConfigOption(
    session: DroidSession,
    ids: readonly string[],
    value: string,
  ): Promise<void> {
    const configId = findOption(session.configOptions, ids)?.id ?? ids[0];
    if (!configId) return;
    try {
      await session.rpc.call(
        "session/set_config_option",
        { sessionId: session.conversationId, configId, value },
        CONFIG_TIMEOUT_MS,
      );
      await this.waitForConfigValue(session, configId, value);
    } catch (error) {
      this.warn(session, `Droid rejected ${configId}="${value}"`, error);
    }
  }

  /** Wait for the `config_option_update` notification that reflects a config
   *  change, polling the last matrix the notification handler saw. Resolves
   *  with the refreshed matrix, or undefined when the change never landed
   *  (rejected value, or a droid build that skips the notification). */
  private async waitForConfigValue(
    state: { configOptions: DroidConfigOption[] },
    configId: string,
    value: string,
  ): Promise<readonly DroidConfigOption[] | undefined> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < CONFIG_REFRESH_TIMEOUT_MS) {
      const option = findOption(state.configOptions, [configId]);
      if (option && option.currentValue !== undefined && option.currentValue.trim() === value.trim()) {
        return state.configOptions;
      }
      await sleep(25);
    }
    return undefined;
  }

  // ── notifications / server requests ─────────────────────────────────────

  private wireNotifications(session: DroidSession): void {
    const { rpc } = session;

    rpc.onNotification("session/update", (params) => {
      const update = asRecord(asRecord(params)?.update);
      if (!update) return;
      this.handleSessionUpdate(session, update);
    });

    rpc.onStderrLine((line) => {
      const text = line.trim();
      if (text.length === 0) return;
      this.emit({
        ...this.base(session),
        source: "droid.acp.stderr",
        type: "session.state.changed",
        state: "running",
        message: text,
      });
    });
  }

  private wireRequests(session: DroidSession): void {
    // A permission request is parked and surfaced to the user via
    // `approval.requested`; the user's decision selects the reply option by its
    // `kind` because droid's optionIds are its own spellings (`proceed_once`,
    // `cancel`, …).
    session.rpc.onRequest("session/request_permission", (params) =>
      this.requestPermission(session, params),
    );
  }

  /** Park one ACP permission request: normalize the ask, emit
   *  `approval.requested`, and block the RPC handler on the resolver until the
   *  renderer answers (or we drain on interrupt/stop). The decision selects the
   *  option by kind (`allow_once` / `allow_always` / `reject_once`), falling
   *  back to a cancelled outcome when none matches. */
  private async requestPermission(
    session: DroidSession,
    params: unknown,
  ): Promise<{ outcome: { outcome: string; optionId?: string } }> {
    const options = asArray(asRecord(params)?.options);
    // Fail closed: a permission request with no active turn (a recovery or
    // replay callback after a crash/interrupt) has no trustworthy mode behind
    // it — cancel rather than park a gate nobody is watching.
    if (!session.activeTurnId) {
      return { outcome: { outcome: "cancelled" } };
    }
    // Full Access never stops to ask: select an allow option (the persistent
    // allow_always rung first, then the request-scoped allow_once) and return
    // selectAcpFullAccessPermissionOptionId — a full-access child on a provider
    // exposing only the protocol's persistent allow option must stay
    // operational, and a full-access session must never deadlock on a gate.
    if (session.mode === "full-access") {
      const optionId =
        selectPermissionOption(options, "allow-always") ??
        selectPermissionOption(options, "allow-once");
      return optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    const requestId = randomUUID();
    const turnId = session.activeTurnId;
    const approval = buildAcpApprovalRequest(params);
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      session.pendingApprovals.set(requestId, { approval, resolve });
      this.emit({
        ...this.base(session),
        type: "approval.requested",
        requestId,
        turnId,
        approval,
      });
    });
    this.emit({ ...this.base(session), type: "approval.resolved", requestId, decision });
    const optionId = selectPermissionOption(options, decision);
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
  }

  /** Settle one parked permission request (idempotent — a no-op once drained). */
  private resolveApproval(session: DroidSession, requestId: string, decision: ApprovalDecision): void {
    const pending = session.pendingApprovals.get(requestId);
    if (!pending) return;
    session.pendingApprovals.delete(requestId);
    pending.resolve(decision);
  }

  /** Reject every parked permission request — on interrupt/stop so no RPC
   *  handler hangs and the renderer's pending prompt clears. */
  private drainApprovals(session: DroidSession): void {
    for (const [requestId] of [...session.pendingApprovals]) {
      this.resolveApproval(session, requestId, "reject-once");
    }
  }

  private handleSessionUpdate(session: DroidSession, update: Record<string, unknown>): void {
    const variant = readString(update, "sessionUpdate");
    switch (variant) {
      case "agent_message_chunk":
        this.appendText(session, "assistant_text", readString(update, "content", "text"));
        return;
      case "agent_thought_chunk":
        this.appendText(session, "reasoning_text", readString(update, "content", "text"));
        return;
      case "tool_call":
      case "tool_call_update":
        this.handleToolCall(session, update);
        return;
      case "plan":
        this.handlePlan(session, update);
        return;
      case "usage_update":
        this.handleUsage(session, update);
        return;
      case "session_info_update": {
        const title = readString(update, "title")?.trim();
        if (title) this.emit({ ...this.base(session), type: "thread.title.updated", title });
        return;
      }
      case "current_mode_update":
      case "available_commands_update":
        // Session state kone doesn't surface yet.
        return;
      case "config_option_update": {
        const refreshed = parseDroidConfigOptions(asRecord(update)?.configOptions);
        if (refreshed.length > 0) session.configOptions = refreshed;
        return;
      }
      default:
        // `user_message_chunk` and anything droid adds later — the renderer
        // already owns the user's own message.
        return;
    }
  }

  /** Assistant and reasoning text stream as bare chunks with no item id, so a
   *  contiguous run of one kind becomes one synthetic item. A switch of kind —
   *  or a tool call landing between chunks — closes the open segment. */
  private appendText(session: DroidSession, kind: RuntimeItemKind, text: string | undefined): void {
    if (!text || !session.activeTurnId) return;

    if (session.segment && session.segment.kind !== kind) this.closeSegment(session);

    if (!session.segment) {
      session.segmentCount += 1;
      const itemId = `${session.activeTurnId}:${kind}:${session.segmentCount}`;
      session.segment = { itemId, kind };
      session.items.set(itemId, { itemId, kind, text: "", detail: "" });
      this.emitItem(session, "item.started", session.items.get(itemId)!, "in-progress");
    }

    const buffer = session.items.get(session.segment.itemId);
    if (!buffer) return;
    buffer.text += text;
    this.emitItem(session, "item.updated", buffer, "in-progress");
  }

  private closeSegment(session: DroidSession): void {
    const open = session.segment;
    if (!open) return;
    session.segment = undefined;
    const buffer = session.items.get(open.itemId);
    if (buffer) this.emitItem(session, "item.completed", buffer, "completed");
  }

  private handleToolCall(session: DroidSession, update: Record<string, unknown>): void {
    const toolCallId = readString(update, "toolCallId");
    if (!toolCallId || !session.activeTurnId) return;

    // A tool call interrupts whatever text was streaming — close it so the two
    // don't interleave into one block.
    this.closeSegment(session);

    const itemId = `${session.activeTurnId}:${toolCallId}`;
    let buffer = session.items.get(itemId);
    const isNew = buffer === undefined;
    if (!buffer) {
      buffer = { itemId, kind: "tool_call", text: "", detail: "" };
      session.items.set(itemId, buffer);
    }

    const kind = readString(update, "kind");
    if (kind) buffer.name = TOOL_KIND_NAMES[kind] ?? "tool";
    if (!buffer.name) buffer.name = "tool";
    const target = toolCallTarget(update);
    if (target) buffer.text = target;
    const detail = toolCallDetail(update);
    if (detail) buffer.detail = detail;

    const status = toolCallStatus(readString(update, "status"));
    if (isNew) this.emitItem(session, "item.started", buffer, status);
    else if (status === "in-progress") this.emitItem(session, "item.updated", buffer, status);
    else this.emitItem(session, "item.completed", buffer, status);
  }

  private handlePlan(session: DroidSession, update: Record<string, unknown>): void {
    if (!session.activeTurnId) return;
    const snapshot = parseDroidPlan(update);
    if (!snapshot) return;

    const itemId = `${session.activeTurnId}:plan`;
    const existing = session.items.get(itemId);
    const tasks = reconcilePlanTasks(existing?.tasks ?? [], snapshot);
    const buffer: DroidItemBuffer = {
      itemId,
      kind: "plan_text",
      text: formatPlanTasks(tasks),
      detail: "",
      tasks,
    };
    session.items.set(itemId, buffer);
    this.emitItem(session, existing ? "item.updated" : "item.started", buffer, "in-progress");
  }

  /** ACP's `usage_update` carrying the session's running `used`/`size` totals.
   *  droid 0.186.0 has never been observed emitting it (fact 2), so this is
   *  defensive ground truth, kept for the day a build starts reporting it. */
  private handleUsage(session: DroidSession, update: Record<string, unknown>): void {
    const used = readNumber(update, "used");
    const size = readNumber(update, "size");
    if (used === undefined && size === undefined) return;
    // The ACP `usage_update` shape is only ever `used`/`size` — no
    // input/output split, so no cache/reasoning split either. droid's
    // on-disk `tokenUsage` (fact 2) is always zeros too, so there is no
    // other source to fall back to for this provider.
    const usage: TokenUsage & TokenUsageSplits = {
      compactsAutomatically: true,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };
    if (used !== undefined) {
      usage.contextUsed = used;
      usage.total = used;
    }
    if (size !== undefined) usage.contextWindow = size;
    this.emit({ ...this.base(session), type: "thread.token-usage.updated", usage });
  }

  // ── turn completion ──────────────────────────────────────────────────────

  /** Close out a turn's bookkeeping: settle anything still marked in-progress,
   *  then drop the turn's buffers so a long thread doesn't accumulate them. */
  private endTurn(session: DroidSession, turnId: string, status: RuntimeItemStatus): void {
    this.closeSegment(session);
    for (const itemId of [...session.openItemIds]) {
      const buffer = session.items.get(itemId);
      if (buffer) this.emitItem(session, "item.completed", buffer, status, turnId);
      else session.openItemIds.delete(itemId);
    }
    session.items.clear();
    session.openItemIds.clear();
    session.segmentCount = 0;
    session.activeTurnId = undefined;
  }

  private completeTurn(session: DroidSession, turnId: string, stopReason: string | undefined): void {
    if (session.activeTurnId !== turnId) return;
    const aborted = session.interrupting || stopReason === "cancelled" || stopReason === "refusal" || stopReason === "max_tokens";
    this.endTurn(session, turnId, aborted ? "failed" : "completed");

    // No token-usage emission here, by design: droid reports nothing over ACP
    // (fact 2) and its on-disk settings sidecar tokenUsage is always zeros —
    // inventing a fill or tally would be lying to the context ring, so there
    // is no Cursor-style sqlite fallback for this provider.

    // droid reports a real `cancelled` stop reason (fact 6), so both the flag
    // and the reason decide. `refusal`/`max_tokens` are genuine failures.
    if (session.interrupting || stopReason === "cancelled") {
      session.interrupting = false;
      this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason: "interrupted" });
      return;
    }
    if (stopReason === "refusal" || stopReason === "max_tokens") {
      this.emit({
        ...this.base(session),
        type: "turn.aborted",
        turnId,
        reason: "failed",
        message: `Droid stopped the turn (${stopReason}).`,
      });
      return;
    }
    this.emit({
      ...this.base(session),
      type: "turn.completed",
      turnId,
      conversationId: session.conversationId,
    });
  }

  private failTurn(session: DroidSession, turnId: string, error: unknown): void {
    if (session.activeTurnId !== turnId) return;
    this.endTurn(session, turnId, "failed");
    // A prompt rejected because the child died is already covered by the
    // `session.exited` event; report the turn as failed either way so the
    // renderer never keeps a turn spinning.
    const message = error instanceof Error ? error.message : String(error);
    const reason = session.interrupting ? "interrupted" : "failed";
    session.interrupting = false;
    this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason, message });
  }

  // ── shared helpers ───────────────────────────────────────────────────────

  /** A degraded-but-continuing condition (a rejected model, a mode droid
   *  doesn't have). Surfaced as session state, never thrown — none of these are
   *  worth losing a session over. */
  private warn(session: DroidSession, summary: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.emit({
      ...this.base(session),
      source: "droid.acp.lifecycle",
      type: "session.state.changed",
      state: session.activeTurnId ? "running" : "ready",
      message: `${summary}: ${detail}`,
    });
  }

  private emitItem(
    session: DroidSession,
    type: "item.started" | "item.updated" | "item.completed",
    buffer: DroidItemBuffer,
    status: RuntimeItemStatus,
    turnId: string | undefined = session.activeTurnId,
  ): void {
    if (!turnId) return;
    if (type === "item.completed") session.openItemIds.delete(buffer.itemId);
    else session.openItemIds.add(buffer.itemId);
    const item: RuntimeItem = {
      itemId: buffer.itemId,
      kind: buffer.kind,
      status,
      text: buffer.text,
      name: buffer.name,
    };
    if (buffer.tasks?.length) item.tasks = buffer.tasks;
    if (buffer.detail.length > 0) item.detail = buffer.detail;
    this.emit({ ...this.base(session), type, turnId, item });
  }

  private base(session: DroidSession) {
    const envelope = {
      threadId: session.threadId,
      provider: this.provider,
      at: Date.now(),
      source: "droid.acp.notification" as const,
    };
    // See ClaudeAdapter.base: the resume id rides every envelope so a turn that
    // never completes still leaves the thread resumable.
    if (session.conversationId) {
      return { ...envelope, refs: { conversationId: session.conversationId } };
    }
    return envelope;
  }

  private toSession(session: DroidSession): Session {
    // droid holds effort on the session's live config matrix — the
    // `reasoning_effort` option's currentValue is the honest read, absent when
    // the current model exposes no effort axis.
    const effort = findOption(session.configOptions, EFFORT_CONFIG_IDS)?.currentValue;
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
    if (effort) result.effort = effort;
    return result;
  }

  private requireSession(threadId: string): DroidSession {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`No Droid session for thread ${threadId}`);
    return session;
  }
}

/** Pick droid's auth method from the live `initialize` result: the API key
 *  when FACTORY_API_KEY is set in the server env (it would be pointless to
 *  open a pairing flow kone can't complete), else device pairing. Undefined
 *  when neither is offered. */
export function resolveDroidAuthMethodId(initializeResult: Record<string, unknown>): string | undefined {
  const methods = new Set(
    asArray(asRecord(initializeResult)?.authMethods)
      .map((method) => readString(method, "id"))
      .filter((id): id is string => id !== undefined),
  );
  if (process.env.FACTORY_API_KEY?.trim() && methods.has(DROID_API_KEY_AUTH_METHOD)) {
    return DROID_API_KEY_AUTH_METHOD;
  }
  if (methods.has(DROID_DEVICE_PAIRING_AUTH_METHOD)) {
    return DROID_DEVICE_PAIRING_AUTH_METHOD;
  }
  return undefined;
}
