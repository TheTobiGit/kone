// CodexAdapter.toSessionError and codexAppServerManager.isRecoverableThreadResumeError).
// One classifier so every adapter makes the same recovery decisions: which
// failures mean "the session/thread is gone, fall back to a fresh
// conversation", which mean "auth is broken, don't pretend", and which are
// benign enough that only a warning is owed.

/** What a provider failure actually means, once the raw message is classified. */
export type ProviderErrorClass = "session-closed" | "auth" | "quota" | "unknown";

/** Classify a provider error message. `session-closed` = the session/thread is
 *  SessionNotFoundError + SessionClosedError); `auth` = a credential/login
 *  problem (never mask it with a "fresh start"); `unknown` = everything else. */
export function classifyProviderError(message: string): ProviderErrorClass {
  const normalized = message.trim().toLowerCase();
  if (
    normalized.includes("unknown session") ||
    normalized.includes("unknown provider session")
  ) {
    return "session-closed";
  }
  // A closed stdin is the transport-level signature of a dead app-server
  // process; treat it as a closed session so callers recover via resume
  // instead of surfacing a raw request failure.
  if (
    normalized.includes("session is closed") ||
    normalized.includes("stdin closed") ||
    normalized.includes("stdin is closed")
  ) {
    return "session-closed";
  }
  if (
    normalized.includes("not authenticated") ||
    normalized.includes("authentication failed") ||
    normalized.includes("authentication required") ||
    normalized.includes("unauthorized") ||
    normalized.includes("login required") ||
    normalized.includes(" 401") ||
    normalized.startsWith("401")
  ) {
    return "auth";
  }
  if (isQuotaOrRateLimitError(normalized)) {
    return "quota";
  }
  return "unknown";
}

/** Does a provider failure indicate a 429 / rate limit / quota exhaustion? */
export function isQuotaOrRateLimitError(cause: unknown): boolean {
  if (cause instanceof Object && !Array.isArray(cause)) {
    // SAFETY: cause is verified as a non-array Object record.
    const obj = cause as { status?: unknown; statusCode?: unknown; code?: unknown; rateLimited?: unknown };
    if (obj.status === 429 || obj.statusCode === 429 || obj.code === 429) {
      return true;
    }
    if (
      obj.code === "rate_limit_exceeded" ||
      obj.code === "insufficient_quota" ||
      obj.code === "RESOURCE_EXHAUSTED" ||
      obj.code === "rate_limit"
    ) {
      return true;
    }
    if (obj.rateLimited === true) {
      return true;
    }
  }

  const message = errorText(cause).toLowerCase();
  return [
    "429",
    "rate limit",
    "rate_limit",
    "ratelimit",
    "rate-limit",
    "rate limited",
    "too many requests",
    "quota",
    "resource exhausted",
    "resource_exhausted",
    "overloaded",
    "credit limit",
    "credits depleted",
    "usage limit",
    "usage-exhausted",
    "usage exhausted",
  ].some((snippet) => message.includes(snippet));
}

/** Can a Codex `thread/resume` failure be recovered by falling back to a fresh
 *  `thread/start`? Only refusal-class errors — the stored thread is gone,
 *  pruned, or foreign — deserve the fallback; a transport, auth or protocol
 *  failure must surface, not be silently masked by starting fresh (the thread
 *  would reopen on a blank conversation and the user would never know why).
 *  session-closed classifiers, where the process is dead and a fresh start is
 *  genuinely the only option). */
export function isRecoverableCodexResumeError(cause: unknown): boolean {
  const message = errorText(cause).toLowerCase();
  if (!message.includes("thread/resume")) return false;
  return [
    "not found",
    "missing thread",
    "no such thread",
    "unknown thread",
    "does not exist",
    "unknown session",
    "unknown provider session",
    "session is closed",
    "stdin closed",
  ].some((snippet) => message.includes(snippet));
}

/** Can a session resume/load failure be recovered by starting fresh? Only
 *  refusal-class errors — the stored session is gone, pruned, or foreign —
 *  deserve the fallback; a transport, auth or protocol failure must surface
 *  (silently starting fresh would reopen the thread on a blank conversation
 *  and the user would never know why). Shared by the adapters that resume a
 *  stored session id: Cursor (`session/load`), Droid (`session/resume`/
 *  `session/load`) and Claude (`query` resume). Codex uses the method-scoped
 *  isRecoverableCodexResumeError above. */
export function isResumeRefusalError(cause: unknown): boolean {
  const message = errorText(cause).toLowerCase();
  return [
    "not found",
    "does not exist",
    "unknown session",
    "unknown provider session",
    "missing session",
    "no such session",
    "no conversation found",
    "missing thread",
    "no such thread",
    "unknown thread",
    "session is closed",
    "stdin closed",
    "stdin is closed",
  ].some((snippet) => message.includes(snippet));
}

/** Known-benign Codex error-notification messages — the session continues, only
 *  a warning is owed. (`write_stdin failed: stdin is closed for this session`
 *  is Codex complaining it lost its own stdin while tearing down — noise, not
 *  news.) */
const NON_FATAL_CODEX_ERROR_SNIPPETS = [
  "write_stdin failed: stdin is closed for this session",
];

export function isNonFatalCodexError(message: string): boolean {
  const lower = message.trim().toLowerCase();
  return NON_FATAL_CODEX_ERROR_SNIPPETS.some((snippet) => lower.includes(snippet));
}

/** The text-bearing fields a provider failure payload is observed to use.
 *  `data` is where OpenCode nests it (`{ name, data: { message } }`); `name`
 *  is the last resort for the variants that carry no message at all. */
type ErrorPayload = {
  message?: unknown;
  code?: unknown;
  error?: unknown;
  data?: unknown;
  detail?: unknown;
  description?: unknown;
  reason?: unknown;
  name?: unknown;
};

/** Searched in order, and the order is deliberate: `message` is the layer
 *  nearest the user — the wrapper that chose to say something — so it wins over
 *  the `error` it wrapped. A payload that carries only the inner failure has no
 *  `message`, so nothing is hidden by preferring it. */
const ERROR_TEXT_FIELDS = [
  "message",
  "error",
  "data",
  "detail",
  "description",
  "reason",
] as const;

/** Render an arbitrary failure value as text a human can read.
 *
 *  Anything that crosses a provider boundary is `unknown` in practice even when
 *  its declared type says `string`: SDKs throw plain objects, and wire payloads
 *  nest their text (OpenCode's `{ name, data: { message } }`) where the schema
 *  promises a bare string. A raw `String(cause)` on those renders the literal
 *  "[object Object]", which reaches the user as their whole error message.
 *
 *  Returns "" when there is genuinely nothing to say, so callers decide what an
 *  empty failure should read as. */
export function errorText(cause: unknown): string {
  return readErrorText(cause) ?? "";
}

/** The reader behind `errorText`. `undefined` means "found no text here" — kept
 *  distinct from a real message so a textless nested payload falls through to
 *  the parent's remaining fields instead of short-circuiting them. */
function readErrorText(cause: unknown): string | undefined {
  if (cause === null || cause === undefined) return undefined;
  if (cause instanceof Error) {
    // A message of its own is the nearest thing to the user, so it wins. A
    // wrapper thrown without one (`new Error("", { cause: payload })`, or a
    // subclass that carries its detail on `cause`) would otherwise report
    // nothing at all — walk the chain rather than lose it.
    return cause.message || readErrorText(cause.cause);
  }
  if (Array.isArray(cause)) {
    const parts = cause.flatMap((entry) => {
      const text = readErrorText(entry);
      return text === undefined ? [] : [text];
    });
    return parts.length > 0 ? parts.join("; ") : undefined;
  }
  // Primitives (the declared-`string` case included) stringify faithfully.
  if (!(cause instanceof Object)) return String(cause).trim() || undefined;

  // SAFETY: cause is verified as a non-array Object; each field is re-validated
  // by the recursive call below.
  const payload = cause as ErrorPayload;
  for (const field of ERROR_TEXT_FIELDS) {
    const nested = payload[field];
    // Guard against a self-referential `{ error: itself }` payload.
    if (nested === cause) continue;
    const text = readErrorText(nested);
    if (text !== undefined) return text;
  }

  // A typed-but-textless failure (OpenCode's MessageOutputLengthError carries
  // an empty `data`): its name is the only honest thing left to report.
  const name = payload.name;
  if (name !== undefined && !(name instanceof Object)) {
    const named = String(name).trim();
    if (named) return named;
  }

  // Nothing recognizable. The payload is machine detail, and a user's whole
  // error message must not be a JSON dump — so say the one thing that is both
  // true and useful (its code, when it has one) and put the body where whoever
  // is debugging can read it. "[object Object]" is what this all exists to
  // avoid; a serialized blob is only marginally kinder.
  if (Object.keys(cause).length === 0) return undefined;
  logUnrecognized(payload);
  const code = payload.code;
  if (code !== undefined && !(code instanceof Object)) {
    const coded = String(code).trim();
    if (coded) return `Unknown error (code ${coded})`;
  }
  return "Unknown error from the provider";
}

function logUnrecognized(payload: ErrorPayload): void {
  try {
    console.debug("[kone] unrecognized provider error payload:", JSON.stringify(payload));
  } catch {
    // Circular or non-serializable — the object itself still prints.
    console.debug("[kone] unrecognized provider error payload:", payload);
  }
}
