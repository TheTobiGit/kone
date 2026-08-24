import type { IpcErrorKind } from "@kone/protocol/ipc-error";

// The pure mapping from a gh CLI stderr line to the semantic failure kind it
// represents. Kept free of any electron import so it is unit-testable without
// stubbing electron — github.ts re-exports it for the callers that care.

/** Map a gh stderr line to a semantic failure kind, or null when it matches no
 *  recognized failure shape. Evaluation order matters: the specific matchers
 *  (auth, repo absence, not-found) run before the broad network one, so an auth
 *  failure that also names a host still reads as NOT_AUTHENTICATED rather than
 *  a connectivity problem. */
export function classifyGhError(message: string): IpcErrorKind | null {
  if (/auth(enticat| login)|not logged in|bad credentials|\b401\b|\b403\b/i.test(message)) {
    return "NOT_AUTHENTICATED";
  }
  if (
    /no git remotes found|do not point to a known GitHub host|could not determine the default repository/i.test(
      message,
    )
  ) {
    return "NO_GITHUB_REMOTE";
  }
  if (/no pull requests found|could not resolve to a (pull request|repository)/i.test(message)) {
    return "NOT_FOUND";
  }
  if (
    /could not resolve host|connection (refused|reset|timed out)|network is unreachable|temporary failure in name resolution|operation timed out|early eof|failed to connect/i.test(
      message,
    )
  ) {
    return "NETWORK";
  }
  return null;
}
