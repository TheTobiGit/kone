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

  const message = (cause instanceof Error ? cause.message : String(cause)).toLowerCase();
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
  const message = (cause instanceof Error ? cause.message : String(cause)).toLowerCase();
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
  const message = (cause instanceof Error ? cause.message : String(cause)).toLowerCase();
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
