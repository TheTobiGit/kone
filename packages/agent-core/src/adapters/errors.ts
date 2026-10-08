import { z } from "zod";

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

// ── provider reset times ─────────────────────────────────────────────────────

/** The payload fields that can carry a reset time, and the containers one may
 *  be nested under. Named rather than indexed so a dynamic read stays typed. */
type ResetPayload = {
  resetsAt?: unknown;
  resets_at?: unknown;
  resetAt?: unknown;
  reset_at?: unknown;
  resetTime?: unknown;
  windowEnd?: unknown;
  endDate?: unknown;
  secondsRemaining?: unknown;
  retry_after?: unknown;
  error?: unknown;
  data?: unknown;
  detail?: unknown;
  reason?: unknown;
  description?: unknown;
  cause?: unknown;
  rate_limit?: unknown;
  rate_limit_event?: unknown;
  codexErrorInfo?: unknown;
  additionalDetails?: unknown;
  headers?: unknown;
};

/** An absolute reset timestamp. */
const RESET_ABSOLUTE_FIELDS: ReadonlyArray<keyof ResetPayload> = [
  "resetsAt",
  "resets_at",
  "resetAt",
  "reset_at",
  "resetTime",
  "windowEnd",
  "endDate",
];
/** A reset expressed as a duration from now (the provider's own Retry-After). */
const RESET_DURATION_FIELDS: ReadonlyArray<keyof ResetPayload> = [
  "secondsRemaining",
  "retry_after",
];
/** Objects a reset may be nested inside. */
const RESET_CONTAINER_FIELDS: ReadonlyArray<keyof ResetPayload> = [
  "error",
  "data",
  "detail",
  "reason",
  "description",
  "cause",
  "rate_limit",
  "rate_limit_event",
  "codexErrorInfo",
  "additionalDetails",
  "headers",
];

/** Bounded so a hostile or deeply wrapped payload cannot walk forever. */
const RESET_WALK_DEPTH = 6;

/** A scalar a reset can be encoded as. Parsed at the payload boundary so the
 *  readers below take a real domain type rather than `unknown`. */
const ResetScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
type ResetScalar = z.infer<typeof ResetScalarSchema>;

/** The `Retry-After` header, in the spellings a transport is seen to use. */
const RetryAfterHeaderSchema = z.object({
  "retry-after": ResetScalarSchema.optional(),
  "Retry-After": ResetScalarSchema.optional(),
  retryAfter: ResetScalarSchema.optional(),
  RetryAfter: ResetScalarSchema.optional(),
});

/** Read a provider reset time from an error/result payload, as epoch millis, or
 *  null when the payload carries none. Only real provider fields are read —
 *  absolute timestamps (epoch seconds or ms, or a parseable date) and the
 *  provider's own Retry-After/seconds hints. A time at or before `now` is not a
 *  reset and reads as null, and nothing is ever fabricated from a nominal
 *  window. */
export function limitResetFromError(cause: unknown, now: number): number | null {
  return walkForReset(cause, now, 0, new Set());
}

function walkForReset(
  cause: unknown,
  now: number,
  depth: number,
  seen: Set<object>,
): number | null {
  if (depth > RESET_WALK_DEPTH || !(cause instanceof Object) || seen.has(cause)) return null;
  seen.add(cause);
  if (Array.isArray(cause)) {
    for (const entry of cause) {
      const nested = walkForReset(entry, now, depth + 1, seen);
      if (nested !== null) return nested;
    }
    return null;
  }
  // SAFETY: cause is verified as a non-null, non-array Object; the reader
  // touches only the named ResetPayload fields.
  const payload = cause as ResetPayload;
  for (const field of RESET_ABSOLUTE_FIELDS) {
    const scalar = ResetScalarSchema.safeParse(payload[field]);
    if (!scalar.success) continue;
    const at = absoluteReset(scalar.data, now);
    if (at !== null) return at;
  }
  for (const field of RESET_DURATION_FIELDS) {
    const scalar = ResetScalarSchema.safeParse(payload[field]);
    if (!scalar.success) continue;
    const at = durationReset(scalar.data, now);
    if (at !== null) return at;
  }
  const header = retryAfterHeader(payload.headers, now);
  if (header !== null) return header;
  for (const field of RESET_CONTAINER_FIELDS) {
    const nested = walkForReset(payload[field], now, depth + 1, seen);
    if (nested !== null) return nested;
  }
  return null;
}

/** Parse an absolute reset value: epoch seconds, epoch millis, or a date. */
function absoluteReset(value: ResetScalar, now: number): number | null {
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{9,}$/.test(text)) {
    const n = Number(text);
    // Epoch seconds vs millis: anything this large in seconds is already a ms
    // value, which is the only sane reading of a 13-digit number.
    const ms = n > 1_000_000_000_000 ? n : n * 1_000;
    return ms > now ? ms : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

/** Parse a duration reset value: seconds from now, or an absolute date. */
function durationReset(value: ResetScalar, now: number): number | null {
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const ms = now + Number(text) * 1_000;
    return ms > now ? ms : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

function retryAfterHeader(cause: unknown, now: number): number | null {
  const parsed = RetryAfterHeaderSchema.safeParse(cause);
  if (!parsed.success) return null;
  const raw =
    parsed.data["retry-after"] ??
    parsed.data["Retry-After"] ??
    parsed.data.retryAfter ??
    parsed.data.RetryAfter;
  return raw === undefined ? null : durationReset(raw, now);
}

