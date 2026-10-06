import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestKind,
  InteractionMode,
  ModelDescriptor,
} from "../types.js";
import { errorText } from "./errors.js";

// Pure ACP protocol shapes for `cline --acp`: value-cursor readers, config-
// option parsing, permission mapping and tool-event rendering. Nothing here
// spawns, owns, or mutates a session — ClineAdapter drives the lifecycle and
// calls into these with decoded JSON documents. Same split Antigravity's ACP
// adapter uses (antigravityAcpProtocol.ts).
//
// Verified live against cline 3.0.65 (2026-09-29, no turn run): the
// `initialize` handshake, `session/new` (sessionId, `modes`, `models`,
// `configOptions`), `session/set_mode`, `session/set_config_option` for
// selects, and the error answers to `session/load`, `session/resume` and
// `session/prompt` on an unknown id. Everything about streamed turns —
// `session/update` payloads, `session/request_permission`, `session/prompt`
// results — is UNVERIFIED (no signed-in account to run a turn on) and follows
// the ACP standard, decoded defensively.

/** One decoded ACP JSON document. The RPC layer parses bytes once at its
 *  boundary; everything downstream branches on these domain values, so no
 *  step has to interrogate a representation. */
export type ClineAcpValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ClineAcpValue[]
  | { [key: string]: ClineAcpValue };

export type ClineAcpRecord = { [key: string]: ClineAcpValue };

/** Decoded JSON numbers are always finite, so finiteness separates the number
 *  variant from every other JSON variant without inspecting representations. */
function isAcpNumber(value: ClineAcpValue): value is number {
  return Number.isFinite(value);
}

export function isAcpRecord(value: ClineAcpValue): value is ClineAcpRecord {
  return value instanceof Object && !Array.isArray(value);
}

/** Text is the one JSON variant left after every other variant is excluded by
 *  value — booleans by identity, numbers by finiteness, composites by their
 *  constructors. */
function acpText(value: ClineAcpValue): string | null {
  if (value === undefined || value === null || value === true || value === false) return null;
  if (Array.isArray(value) || value instanceof Object || isAcpNumber(value)) return null;
  return value;
}

/** The entries of a decoded JSON array, or none — callers iterate without
 *  branching on the container variant. */
export function acpArray(value: ClineAcpValue): ClineAcpValue[] {
  return Array.isArray(value) ? value : [];
}

/** Walk a path of record keys from a decoded document; undefined the moment a
 *  step lands off-record. */
export function readValue(cursor: ClineAcpValue, ...path: string[]): ClineAcpValue {
  for (const key of path) cursor = isAcpRecord(cursor) ? cursor[key] : undefined;
  return cursor;
}

export function readString(cursor: ClineAcpValue, ...path: string[]): string | undefined {
  return acpText(readValue(cursor, ...path)) ?? undefined;
}

export function readNumber(cursor: ClineAcpValue, ...path: string[]): number | undefined {
  const leaf = readValue(cursor, ...path);
  return isAcpNumber(leaf) ? leaf : undefined;
}

// ── auth ─────────────────────────────────────────────────────────────────────

/** What the user sees when Cline has no account. kone never runs the login
 *  itself — `cline auth` is interactive (browser OAuth) and belongs in the
 *  user's own terminal. */
export const CLINE_SIGN_IN_MESSAGE =
  "Cline is not signed in. Run `cline auth` in a terminal to sign in (or set CLINE_API_KEY), then try again.";

/** Cline answers `session/new` with `-32000 "Authentication required: Call
 *  authenticate before starting a session"` when no account is configured
 *  (verified on a signed-out install). Matched on the message too, because the
 *  code is the generic server-error code other failures share. */
export function isClineAuthRequired(cause: unknown): boolean {
  const message = errorText(cause).toLowerCase();
  if (message.includes("authentication required")) return true;
  return jsonRpcErrorCode(cause) === -32000 && message.includes("authenticate");
}

/** The JSON-RPC error code an RPC failure carried, if it carried one. Read off
 *  the error's shape rather than `instanceof JsonRpcError`: adapter test suites
 *  swap the transport module out wholesale, and a class import that survives
 *  only under the real transport would break every one of them at link time. */
export function jsonRpcErrorCode(cause: unknown): number | undefined {
  if (!(cause instanceof Error)) return undefined;
  // SAFETY: only the read is asserted — JsonRpcClient rejects with an error
  // carrying a numeric `code`, and any other Error has none (or, for a system
  // error, a string that the finiteness check below turns away).
  const code = (cause as Error & { code?: number }).code;
  return Number.isFinite(code) ? code : undefined;
}

// ── config options ───────────────────────────────────────────────────────────

/** A session config option as `session/new` / `set_config_option` report it. A
 *  `boolean` option (`auto_approve`) carries a boolean `currentValue`, kept
 *  here as its string spelling so the matrix stays one shape. */
export type ClineConfigOption = {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options: { value: string; name?: string }[];
};

/** The config-option ids Cline exposes, by kone axis (live `session/new`:
 *  `provider`, `model`, `mode`, `auto_approve`). Cline has no reasoning-effort
 *  option over ACP, so kone's effort axis has nothing to bind to. */
export const CLINE_MODEL_CONFIG_IDS = ["model"] as const;
export const CLINE_MODE_CONFIG_IDS = ["mode"] as const;

/** Parse Cline's `configOptions`, tolerating the fields it omits. */
export function parseClineConfigOptions(value: ClineAcpValue): ClineConfigOption[] {
  const out: ClineConfigOption[] = [];
  for (const raw of acpArray(value)) {
    const id = readString(raw, "id");
    if (!id) continue;
    const options: { value: string; name?: string }[] = [];
    for (const rawOption of acpArray(readValue(raw, "options"))) {
      const optionValue = readString(rawOption, "value");
      if (!optionValue) continue;
      options.push({ value: optionValue, name: readString(rawOption, "name") });
    }
    const current = readValue(raw, "currentValue");
    out.push({
      id,
      name: readString(raw, "name"),
      category: readString(raw, "category"),
      type: readString(raw, "type"),
      currentValue: current === true || current === false ? String(current) : readString(raw, "currentValue"),
      options,
    });
  }
  return out;
}

export function findOption(
  options: readonly ClineConfigOption[],
  ids: readonly string[],
): ClineConfigOption | undefined {
  return options.find((option) => ids.includes(option.id));
}

// ── model catalog / modes ────────────────────────────────────────────────────

/** Project one `models.availableModels` entry (`{ modelId, name }`) onto
 *  kone's ModelDescriptor. Cline reports no context window or effort ladder
 *  over ACP, so the descriptor is id + label only. */
export function toClineModelDescriptor(raw: ClineAcpValue): ModelDescriptor | undefined {
  const modelId = readString(raw, "modelId");
  if (!modelId) return undefined;
  return { id: modelId, label: readString(raw, "name")?.trim() || modelId };
}

/** The model catalog of a `session/new` response: `models.availableModels`,
 *  falling back to the `model` config option's choices when a build reports
 *  only the matrix. */
export function clineModelCatalog(response: ClineAcpValue, configOptions: readonly ClineConfigOption[]): ModelDescriptor[] {
  const fromModels = acpArray(readValue(response, "models", "availableModels"))
    .map(toClineModelDescriptor)
    .filter((descriptor): descriptor is ModelDescriptor => descriptor !== undefined);
  if (fromModels.length > 0) return fromModels;
  const option = findOption(configOptions, CLINE_MODEL_CONFIG_IDS);
  return (option?.options ?? []).map((choice) => ({ id: choice.value, label: choice.name?.trim() || choice.value }));
}

/** The sections of Cline's recommended-models document that run on the `cline`
 *  provider every session opens on. `clinePass` and `clineCloud` belong to
 *  other providers, so their ids would fail on this one. */
const CLINE_FEATURED_SECTIONS = ["recommended", "free"] as const;

/** The models Cline features live — new releases and free or stealth models —
 *  from its recommended-models document (`{ recommended: [{ id, name }], free:
 *  [...] }`). The bundled catalog `session/new` reports lags these, and the
 *  CLI's own picker merges them in the same way. */
export function parseClineFeaturedModels(document: ClineAcpValue): ModelDescriptor[] {
  return CLINE_FEATURED_SECTIONS.flatMap((section) =>
    acpArray(readValue(document, section)).flatMap((raw) => {
      const id = readString(raw, "id");
      return id ? [{ id, label: readString(raw, "name")?.trim() || id }] : [];
    }),
  );
}

/** The session catalog with the featured models it lacks put first. An empty
 *  session catalog stays empty: it means signed out, and a featured model is no
 *  more runnable then than any other. */
export function mergeClineFeaturedModels(
  catalog: readonly ModelDescriptor[],
  featured: readonly ModelDescriptor[],
): ModelDescriptor[] {
  if (catalog.length === 0) return [];
  const known = new Set(catalog.map((model) => model.id));
  const extra = featured.filter((model) => {
    if (known.has(model.id)) return false;
    known.add(model.id);
    return true;
  });
  return [...extra, ...catalog];
}

/** The session model in force: `models.currentModelId`, else the `model`
 *  config option's current value. */
export function clineCurrentModel(response: ClineAcpValue, configOptions: readonly ClineConfigOption[]): string | undefined {
  return (
    readString(response, "models", "currentModelId") ??
    findOption(configOptions, CLINE_MODEL_CONFIG_IDS)?.currentValue
  );
}

/** Cline's two session modes are `plan` (explore, no edits) and `act`. kone's
 *  ask / accept-edits / full-access ladder is an approval axis, not a plan/act
 *  one, so every session runs in `act` and the ladder is enforced where kone
 *  owns the decision — the permission gate (`clinePermissionAutoApproves`).
 *  Returns the id to switch to when the session opened on something else, or
 *  undefined when it is already there or the build advertises no `act`. */
export function clineActModeToApply(
  currentModeId: string | undefined,
  available: readonly string[],
): string | undefined {
  if (!available.includes("act")) return undefined;
  return currentModeId === "act" ? undefined : "act";
}

// ── permission gate ──────────────────────────────────────────────────────────

/** The ACP tool-call `kind` of a `session/request_permission` request. */
export function clinePermissionToolKind(params: ClineAcpValue): string {
  return readString(readValue(params, "toolCall"), "kind")?.toLowerCase() ?? "";
}

/** The command line a permission request would run, for the critical-command
 *  screen. ACP puts tool arguments in `rawInput`; an `execute` request that
 *  names no command falls back to its title so the screen still sees whatever
 *  text there is. */
export function clinePermissionCommand(params: ClineAcpValue): string | undefined {
  const toolCall = readValue(params, "toolCall");
  const command = readString(toolCall, "rawInput", "command") ?? readString(toolCall, "command");
  if (command?.trim()) return command;
  return clinePermissionToolKind(params) === "execute" ? readString(toolCall, "title") : undefined;
}

/** Whether kone answers a permission request itself, by ladder rung. Reads and
 *  searches never stop the agent on any rung (the same reach Droid's read-only
 *  `normal` autonomy gives); `accept-edits` also lets file edits through;
 *  `full-access` lets everything through (the caller still screens critical
 *  commands first). Anything unclassified is put to the user on every rung
 *  below full-access — an unknown tool kind must never be waved through.
 *  Cline's own `auto_approve` option stays off for exactly this reason: on, the
 *  agent would stop asking and kone could neither prompt nor screen. */
export function clinePermissionAutoApproves(mode: InteractionMode, toolKind: string): boolean {
  if (mode === "full-access") return true;
  if (toolKind === "read" || toolKind === "search") return true;
  return mode === "accept-edits" && (toolKind === "edit" || toolKind === "delete" || toolKind === "move");
}

/** Normalize an ACP `session/request_permission` payload into the neutral ask
 *  the renderer shows. The request names the tool call it wants to allow, so
 *  the headline is the command/title and the kind follows the ACP tool kind. */
export function buildClineApprovalRequest(params: ClineAcpValue): ApprovalRequest {
  const toolCall = readValue(params, "toolCall");
  const toolKind = clinePermissionToolKind(params);
  const kind: ApprovalRequestKind =
    toolKind === "execute"
      ? "command"
      : toolKind === "edit" || toolKind === "delete" || toolKind === "move"
        ? "file-change"
        : toolKind === "read" || toolKind === "search"
          ? "file-read"
          : "permission";
  const title =
    readString(toolCall, "rawInput", "command")?.trim() ||
    readString(toolCall, "title")?.trim() ||
    "Request permission";
  const request: ApprovalRequest = { kind, title };
  const detail = readString(toolCall, "detail")?.trim();
  if (detail) request.detail = detail;
  return request;
}

/** Pick the reply option for a decision, matching the option's `kind` prefix
 *  (`allow_once` / `allow_always` / `reject_once`) — ACP's standard spellings —
 *  because option ids are the agent's own. A build that omits `kind` is matched
 *  on the option id instead. Reject falls back to any deny/reject/cancel
 *  option; `reject-and-stop` deliberately matches NOTHING — the agent gets a
 *  cancelled outcome and the adapter interrupts the turn. No match returns
 *  undefined (a cancelled outcome). */
export function selectClinePermissionOption(
  options: readonly ClineAcpValue[],
  decision: ApprovalDecision,
): string | undefined {
  if (decision === "reject-and-stop") return undefined;
  const wanted =
    decision === "allow-always" ? "allow_always" : decision === "reject-once" ? "reject_once" : "allow_once";
  const spelling = (option: ClineAcpValue) =>
    (readString(option, "kind") ?? readString(option, "optionId") ?? "").toLowerCase().replace(/[-\s]/g, "_");
  const direct = options.find((option) => spelling(option).startsWith(wanted));
  if (direct) return readString(direct, "optionId");
  if (decision === "reject-once") {
    const fallback = options.find((option) => /^(deny|reject|cancel)/.test(spelling(option)));
    if (fallback) return readString(fallback, "optionId");
  }
  return undefined;
}

