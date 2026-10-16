import type { GitBranch } from "../types/desktop";

/** Where a local branch stands with its remote, one word per branch. */
export type BranchStanding = "even" | "ahead" | "behind" | "both" | "unpushed" | "gone";

export const STANDINGS: { id: BranchStanding; label: string; color: string }[] = [
  // Nothing to do reads quiet; the colours are kept for what wants doing.
  { id: "even", label: "In step", color: "color-mix(in srgb, var(--ink) 30%, transparent)" },
  { id: "ahead", label: "To push", color: "var(--accent-2)" },
  { id: "behind", label: "To pull", color: "var(--accent)" },
  { id: "both", label: "Both ways", color: "var(--warn)" },
  { id: "unpushed", label: "Not pushed", color: "" },
  { id: "gone", label: "Remote gone", color: "" },
];

export function standing(b: GitBranch): BranchStanding {
  if (b.gone) return "gone";
  if (!b.upstream) return "unpushed";
  const ahead = b.ahead ?? 0;
  const behind = b.behind ?? 0;
  if (ahead && behind) return "both";
  if (ahead) return "ahead";
  if (behind) return "behind";
  return "even";
}

/** "origin/feature/x" → "feature/x". A remote's name can hold slashes, so
 *  the longest known remote that prefixes the ref wins over the first slash. */
export function localNameOf(remoteRef: string, remotes: readonly string[] = []): string {
  const known = remotes
    .filter((r) => remoteRef.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (known) return remoteRef.slice(known.length + 1);
  const i = remoteRef.indexOf("/");
  return i === -1 ? remoteRef : remoteRef.slice(i + 1);
}

/** "feat/git-space" → "feat"; a name without a slash has no kind. */
export function kindOf(name: string): string | null {
  const i = name.indexOf("/");
  return i > 0 ? name.slice(0, i) : null;
}

const DAY_MS = 86_400_000;

/** Days since the branch's tip commit, or null when git didn't say. */
export function daysSince(b: GitBranch, now = Date.now()): number | null {
  const t = b.date ? Date.parse(b.date) : Number.NaN;
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / DAY_MS);
}

/** A short age: "now", "5h", "3d", "6w", "4mo", "2y". */
export function shortAge(days: number | null): string {
  if (days === null) return "";
  if (days < 1 / 24) return "now";
  if (days < 1) return `${Math.floor(days * 24)}h`;
  if (days < 14) return `${Math.floor(days)}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** A spoken age for labels: "3 days ago". */
export function spokenAge(days: number | null): string {
  if (days === null) return "";
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (days < 1 / 24) return "just now";
  if (days < 1) return unit(Math.floor(days * 24), "hour");
  if (days < 14) return unit(Math.floor(days), "day");
  if (days < 60) return unit(Math.floor(days / 7), "week");
  if (days < 365) return unit(Math.floor(days / 30), "month");
  return unit(Math.floor(days / 365), "year");
}

/** A branch untouched this long reads as stale. */
export const STALE_DAYS = 30;

/**
 * What git would object to in a new branch name, in words, or null when it
 * would take it. The rules of `git check-ref-format --branch`, checked as you
 * type so Enter never meets a refusal.
 */
export function branchNameProblem(name: string): string | null {
  if (!name) return null;
  if (/\s/.test(name)) return "No spaces; a dash reads the same.";
  if (name.startsWith("-")) return "It can't start with a dash.";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//"))
    return "Slashes go between words.";
  if (name.includes("..")) return "No two dots in a row.";
  if (name.includes("@{") || name === "@" || name === "HEAD") return "That spelling is reserved.";
  if (/[~^:?*[\\]/.test(name) || [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    return "No ~ ^ : ? * [ or \\.";
  if (name.endsWith(".") || name.split("/").some((part) => part.endsWith(".lock")))
    return "No part can end in .lock, and the name can't end in a dot.";
  if (name.split("/").some((part) => part.startsWith("."))) return "No part can start with a dot.";
  return null;
}

/** git's refusal to switch because uncommitted work would be overwritten. */
export function isDirtyRefusal(message: string | null | undefined): boolean {
  return !!message && /would be overwritten|commit your changes or stash them/i.test(message);
}
