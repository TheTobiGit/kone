// Peel Electron's IPC wrapper + git's own prefixes off a rejected `invoke`, so
// the UI shows just the underlying message. A rejected bridge call arrives as
// e.g. "Error invoking remote method 'git:clone': GitError: fatal: <what git
// said>"; strip those layers down to git's own words. A classified error also
// carries a leading "[kone:KIND] " marker — the kind survives IPC serialization
// in the message string — which is stripped here so no caller ever renders it
// verbatim. Shared by the launcher flows (clone / create), the agent surfaces,
// and the Git Space.

/** The machine-readable failure kinds a classified error can carry, kept in
 *  lockstep with the marker the desktop main process writes. */
export const IPC_ERROR_KINDS = [
  "AUTH_FAILURE",
  "NOT_AUTHENTICATED",
  "NOT_INSTALLED",
  "NOT_A_REPO",
  "NO_GITHUB_REMOTE",
  "NOT_FOUND",
  "NETWORK",
  "INVALID_INPUT",
  "INTERNAL",
  "TIMEOUT",
] as const;

export type IpcErrorKind = (typeof IPC_ERROR_KINDS)[number];

/** The marker prefix a classified error's message starts with. */
const KIND_MARKER = /^\[kone:([A-Z_]+)\]\s*/;

/** Drop a leading "[kone:KIND] " marker. The marker is a serialization detail,
 *  never something a user should read. */
function stripKindMarker(message: string): string {
  return message.replace(KIND_MARKER, "");
}

/** The shared unwrapping: Electron's wrapper, the thrown error's own name, and
 *  git's "fatal:" prefix, with the kind marker left in place for parsing. */
function peel(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
    .replace(/^fatal:\s*/i, "")
    .trim();
}

export function peelIpcError(error: unknown, fallback: string): string {
  return stripKindMarker(peel(error)) || fallback;
}

/** `peelIpcError`, then collapsed to the one line a compact surface can show.
 *  git writes multi-line stderr; a masthead has room for a single line, so the
 *  wrappers are stripped first and the last non-empty line — the part that
 *  names the failure — is what survives. */
export function peelIpcErrorLine(error: unknown, fallback: string): string {
  const cleaned = peelIpcError(error, "");
  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? fallback;
}

/** Unwrap the same layers `peelIpcError` does, but recover the kind marker
 *  instead of discarding it. Unmarked messages come back with `kind: null` and
 *  their peeled text as `message`; `fallback` stands in when nothing remains. */
export function classifyIpcError(
  error: unknown,
  fallback: string,
): { kind: IpcErrorKind | null; message: string } {
  const cleaned = peel(error);
  const match = KIND_MARKER.exec(cleaned);
  const kind = match ? (match[1] as IpcErrorKind) : null;
  const message = (match ? cleaned.slice(match[0].length) : cleaned).trim();
  return { kind, message: message || fallback };
}

/** A short actionable sentence for a known kind, null when the message itself
 *  should stand — the kind is unknown or carries no guidance. */
export function kindHint(kind: IpcErrorKind | null): string | null {
  switch (kind) {
    case "AUTH_FAILURE":
      return "Check your git credentials.";
    case "NOT_AUTHENTICATED":
      return "Sign in to GitHub to use this.";
    case "NOT_INSTALLED":
      return "Install the GitHub CLI to use this.";
    case "NOT_A_REPO":
      return "Open a git repository to use this.";
    case "NO_GITHUB_REMOTE":
      return "This repository has no GitHub remote.";
    case "NOT_FOUND":
      return "That no longer exists.";
    case "NETWORK":
      return "Can't reach GitHub — check your connection.";
    case "INVALID_INPUT":
      return "That request was malformed.";
    case "TIMEOUT":
      return "The request timed out — try again.";
    default:
      return null;
  }
}
