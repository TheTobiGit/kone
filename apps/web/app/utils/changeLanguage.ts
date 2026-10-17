import type { GitChange, GitFileStatus } from "../types/desktop";

/** Which side of the working tree a file belongs to, for the section's groups
 *  and the side column's stack. A file with both staged and unstaged edits
 *  stays with the index, where the commit box will take it from. */
export type ChangeSide = "staged" | "unstaged";

export const CHANGE_KINDS: { id: GitFileStatus; label: string; color: string }[] = [
  // Most files are simply modified, so that reads quietest. The colours are
  // kept for the kinds that change what the file is.
  { id: "modified", label: "Modified", color: "color-mix(in srgb, var(--ink) 34%, transparent)" },
  { id: "added", label: "Added", color: "var(--diff-add)" },
  { id: "untracked", label: "Untracked", color: "color-mix(in srgb, var(--diff-add) 72%, transparent)" },
  { id: "deleted", label: "Deleted", color: "var(--diff-del)" },
  { id: "renamed", label: "Renamed", color: "var(--accent-2)" },
  { id: "copied", label: "Copied", color: "color-mix(in srgb, var(--accent-2) 70%, transparent)" },
  { id: "type-changed", label: "Type changed", color: "var(--accent)" },
  { id: "conflicted", label: "Conflicted", color: "var(--warn)" },
  { id: "ignored", label: "Ignored", color: "color-mix(in srgb, var(--muted) 55%, transparent)" },
];

/** A status outside the list above still reads as a change, never blank. */
const FALLBACK_KIND: (typeof CHANGE_KINDS)[number] = {
  id: "modified",
  label: "Changed",
  color: "color-mix(in srgb, var(--ink) 34%, transparent)",
};

/** The kind of change a row is, in the side column's language. */
export function changeKindOf(status: GitFileStatus): (typeof CHANGE_KINDS)[number] {
  return CHANGE_KINDS.find((k) => k.id === status) ?? FALLBACK_KIND;
}

export function sideOf(c: GitChange): ChangeSide {
  return c.staged ? "staged" : "unstaged";
}

/** A file with work on both sides of the index. */
export function partlyStaged(c: GitChange): boolean {
  return c.staged && c.unstaged;
}

/** Lines touched in a file — the number its bar in the side column is drawn
 *  from. Unknown counts (a binary file) are zero, not a guess. */
export function churnOf(c: GitChange): number {
  return (c.added ?? 0) + (c.removed ?? 0);
}

/** The area a file belongs to: its first two path segments, or its first when
 *  it sits at the root. A change list is read top-down from where the work
 *  lives, so "apps/web" is more useful than "apps" and less noisy than a full
 *  directory. Root files get a word rather than an empty label. */
export function areaOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "root";
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

export function nameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}
