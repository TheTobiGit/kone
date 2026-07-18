// Peel Electron's IPC wrapper + git's own prefixes off a rejected `invoke`, so
// the UI shows just the underlying message. A rejected bridge call arrives as
// e.g. "Error invoking remote method 'git:clone': GitError: fatal: <what git
// said>"; strip those layers down to git's own words. Shared by the launcher
// flows (clone / create).
export function peelIpcError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
    .replace(/^fatal:\s*/i, "")
    .trim();
  return cleaned || fallback;
}
