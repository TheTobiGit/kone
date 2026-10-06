import { resolveAntigravityContextWindow } from "../usage/local/antigravityScan.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestKind,
  ModelDescriptor,
  UserInputAnswers,
  UserInputQuestion,
} from "../types.js";

// Pure ACP protocol shapes for the Antigravity server: value-cursor readers,
// config-option parsing, approval/question mapping, and tool-event rendering.
// Nothing here spawns, owns, or mutates a session — the adapter drives the
// lifecycle and calls into these helpers with decoded JSON documents.

/** One decoded ACP JSON document. The RPC layer parses bytes once at its
 *  boundary; everything downstream branches on these domain values, so no
 *  step has to interrogate a representation. */
export type AntigravityAcpValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | AntigravityAcpValue[]
  | { [key: string]: AntigravityAcpValue };

export type AntigravityAcpRecord = { [key: string]: AntigravityAcpValue };

export type AntigravityAcpConfigOption = {
  id: string;
  name?: string;
  currentValue?: string;
  options: { value: string; name?: string }[];
};

/** Decoded JSON numbers are always finite, so finiteness separates the number
 *  variant from every other JSON variant without inspecting representations. */
export function isAcpNumber(value: AntigravityAcpValue | undefined): value is number {
  return Number.isFinite(value);
}

export function isAcpRecord(value: AntigravityAcpValue | undefined): value is AntigravityAcpRecord {
  return value instanceof Object && !Array.isArray(value);
}

/** Text is the one JSON variant left after every other variant is excluded by
 *  value — booleans by identity, numbers by finiteness, composites by their
 *  constructors. */
export function acpText(value: AntigravityAcpValue | undefined): string | null {
  if (value === undefined || value === null || value === true || value === false) return null;
  if (Array.isArray(value) || value instanceof Object || isAcpNumber(value)) return null;
  return value;
}

/** The entries of a decoded JSON array, or none — callers iterate without
 *  branching on the container variant. */
export function acpArray(value: AntigravityAcpValue | undefined): AntigravityAcpValue[] {
  return Array.isArray(value) ? value : [];
}

/** Walk a path of record keys from a decoded document; undefined the moment a
 *  step lands off-record. */
export function readValue(
  cursor: AntigravityAcpValue | undefined,
  ...path: string[]
): AntigravityAcpValue | undefined {
  for (const key of path) cursor = isAcpRecord(cursor) ? cursor[key] : undefined;
  return cursor;
}

export function readString(cursor: AntigravityAcpValue | undefined, ...path: string[]): string | undefined {
  const text = acpText(readValue(cursor, ...path));
  return text ?? undefined;
}

export function readNumber(cursor: AntigravityAcpValue | undefined, ...path: string[]): number | undefined {
  const leaf = readValue(cursor, ...path);
  return isAcpNumber(leaf) ? leaf : undefined;
}

/** Parse a session config option (`{ id, name, currentValue, options:
 *  [{ value, name }] }`), tolerating the fields the server omits. */
export function parseAntigravityConfigOptions(value: AntigravityAcpValue | undefined): AntigravityAcpConfigOption[] {
  const out: AntigravityAcpConfigOption[] = [];
  for (const raw of acpArray(value)) {
    const id = readString(raw, "id");
    if (!id) continue;
    const options: { value: string; name?: string }[] = [];
    for (const rawOption of acpArray(readValue(raw, "options"))) {
      const optionValue = readString(rawOption, "value");
      if (!optionValue) continue;
      options.push({ value: optionValue, name: readString(rawOption, "name") });
    }
    out.push({
      id,
      name: readString(raw, "name"),
      currentValue: readString(raw, "currentValue"),
      options,
    });
  }
  return out;
}

export function findOption(
  options: readonly AntigravityAcpConfigOption[],
  ids: readonly string[],
): AntigravityAcpConfigOption | undefined {
  return options.find((option) => ids.includes(option.id));
}

// ── model catalog ────────────────────────────────────────────────────────────

/** Project one `model` config-option entry onto kone's ModelDescriptor.
 *  Thinking levels are separate model options on this server, so there is no
 *  effort ladder to probe — the option's own current value is the only axis. */
export function toAntigravityModelDescriptor(option: { value: string; name?: string }): ModelDescriptor {
  const label = option.name?.trim() || option.value;
  const descriptor: ModelDescriptor = {
    id: option.value,
    label,
    contextWindowTokens: resolveAntigravityContextWindow(option.value),
  };
  return descriptor;
}

// ── permission + question mapping ────────────────────────────────────────────

/** True when a permission request is really a native fixed-choice question:
 *  its tool-call id carries the `interaction_` prefix. */
export function isAntigravityQuestion(params: AntigravityAcpValue | undefined): boolean {
  return (readString(readValue(params, "toolCall"), "toolCallId") ?? "").startsWith("interaction_");
}

/** Normalize an ACP `session/request_permission` payload into the neutral ask
 *  the renderer shows. The request names the tool call it wants to allow, so
 *  the headline is the command/title and the kind follows the tool family. A
 *  prompt-injection warning the server attached rides the detail. */
export function buildAntigravityApprovalRequest(params: AntigravityAcpValue | undefined): ApprovalRequest {
  const toolCall = readValue(params, "toolCall");
  const toolKind = readString(toolCall, "kind") ?? "";
  const kind: ApprovalRequestKind = /^execute$/i.test(toolKind)
    ? "command"
    : /^read$/i.test(toolKind)
      ? "file-read"
      : /^(edit|write|delete|move|create)$/i.test(toolKind)
        ? "file-change"
        : "permission";
  const title =
    readString(toolCall, "command")?.trim() || readString(toolCall, "title")?.trim() || "Request permission";
  const request: ApprovalRequest = { kind, title };
  const detail = readString(toolCall, "detail")?.trim();
  if (detail) request.detail = detail;
  return request;
}

/** Read the prompt-injection warning the server attaches to an "allow always"
 *  option's `_meta["agy.security.warning"]`. Undefined when the option
 *  carries none. */
export function antigravityOptionWarning(option: AntigravityAcpValue | undefined): string | undefined {
  const meta = readValue(option, "_meta");
  if (!isAcpRecord(meta)) return undefined;
  const warning = readValue(meta, "agy.security.warning");
  if (!isAcpRecord(warning)) return undefined;
  const text = readString(warning, "message") ?? readString(warning, "title");
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 512 ? `${trimmed.slice(0, 509)}...` : trimmed;
}

export function buildAntigravityApprovalRequestWithWarnings(params: AntigravityAcpValue | undefined): ApprovalRequest {
  const request = buildAntigravityApprovalRequest(params);
  const warnings = acpArray(readValue(params, "options"))
    .map((option) => antigravityOptionWarning(option))
    .filter((warning): warning is string => warning !== undefined);
  if (warnings.length > 0) {
    const joined = warnings.join("\n\n");
    request.detail = request.detail ? `${request.detail}\n\n${joined}` : joined;
  }
  return request;
}

/** Pick the reply option for a decision, matching the option's `kind`
 *  (`allow_once` / `allow_always` / `reject_once`) because the server's
 *  optionIds are its own spellings. Reject falls back to any deny/reject/
 *  cancel option; `reject-and-stop` deliberately matches NOTHING — the server
 *  gets a cancelled outcome and the adapter interrupts the turn. No match
 *  returns undefined (a cancelled outcome). */
export function selectPermissionOption(
  options: readonly AntigravityAcpValue[],
  decision: ApprovalDecision,
): string | undefined {
  if (decision === "reject-and-stop") return undefined;
  const wanted =
    decision === "allow-always" ? "allow_always" : decision === "reject-once" ? "reject_once" : "allow_once";
  const direct = options.find((option) => readString(option, "kind")?.startsWith(wanted));
  if (direct) return readString(direct, "optionId");
  if (decision === "reject-once") {
    const fallback = options.find((option) => /^(deny|reject|cancel)/.test(readString(option, "kind") ?? ""));
    if (fallback) return readString(fallback, "optionId");
  }
  return undefined;
}

/** Normalize a native fixed-choice question into kone's question shape.
 *  Undefined when the request is not a well-formed question (duplicate or
 *  empty option ids) — the caller then fails closed with a cancelled
 *  outcome instead of parking an unanswerable ask. */
export function toAntigravityQuestion(
  params: AntigravityAcpValue | undefined,
): { question: UserInputQuestion; optionIds: string[] } | undefined {
  const toolCall = readValue(params, "toolCall");
  const toolCallId = readString(toolCall, "toolCallId");
  const options = acpArray(readValue(params, "options"));
  if (!toolCallId || options.length === 0) return undefined;
  const seen = new Set<string>();
  const labels: { label: string; optionId: string }[] = [];
  for (const option of options) {
    const optionId = readString(option, "optionId")?.trim();
    if (!optionId || seen.has(optionId)) return undefined;
    seen.add(optionId);
    const label = readString(option, "name")?.trim() || optionId;
    labels.push({ label, optionId });
  }
  const questionText = readString(toolCall, "title")?.trim() || "Choose an option.";
  return {
    question: {
      id: toolCallId,
      header: "Question",
      question: questionText.length > 8000 ? `${questionText.slice(0, 7997)}...` : questionText,
      options: labels.map(({ label }) => ({ label, description: label })),
      multiSelect: false,
    },
    optionIds: labels.map(({ optionId }) => optionId),
  };
}

/** Map the user's answers back onto the server's optionIds: an exact optionId
 *  match first, then a unique label match. Undefined when nothing matches —
 *  the caller fails closed with a cancelled outcome. */
export function selectQuestionOption(
  parsed: { question: UserInputQuestion; optionIds: string[] },
  answers: UserInputAnswers,
  params: AntigravityAcpValue | undefined,
): string | undefined {
  const raw = answers[parsed.question.id];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const options = acpArray(readValue(params, "options"));
  if (options.some((option) => readString(option, "optionId") === value)) return value;
  const matching = options.filter(
    (option) => (readString(option, "name")?.trim() || readString(option, "optionId")) === value,
  );
  if (matching.length === 1) return readString(matching[0], "optionId");
  return undefined;
}

