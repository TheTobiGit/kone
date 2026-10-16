import type { GitHubCheck } from "~/types/desktop";

// Small words the pull request card and its side column both draw with.

/** "Aug 25" — the short date a pull request's events are labelled with. */
export function prDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** How long a check ran: "48s", "3m 12s", "running" while it still is. */
export function checkDuration(c: GitHubCheck): string {
  if (!c.startedAt) return "";
  const start = Date.parse(c.startedAt);
  if (Number.isNaN(start)) return "";
  if (!c.completedAt) return c.state === "pending" ? "running" : "";
  const secs = Math.max(0, Math.round((Date.parse(c.completedAt) - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** A file's share of a change as a split bar, square-root scaled against the
 *  biggest file so the one enormous file doesn't flatten the rest. */
export function changeBar(f: { additions: number; deletions: number }, peak: number, max: number) {
  const total = f.additions + f.deletions;
  if (!total) return { add: 0, del: 0 };
  const w = Math.max(2, Math.sqrt(total / Math.max(1, peak)) * max);
  return { add: (f.additions / total) * w, del: (f.deletions / total) * w };
}
