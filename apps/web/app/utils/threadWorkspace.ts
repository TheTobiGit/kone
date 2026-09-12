// How a conversation's workspace reads on screen.
//
// One resolver, because the answer appears in five places — the inbox row, the
// thread header, the composer tray, the studio strip, the home recents — and a
// surface that derived it for itself would eventually disagree with the others.
//
// The governing rule from the design work: make it unmistakable, but quiet. One
// small mark at rest, the full path only on hover. A thread running in the
// project's own checkout is the ABSENCE of the mark, never a competing mark of
// its own — most threads are local, and a badge on all of them says nothing.
//
// The basename is what shows. A full path in a row is unreadable at a glance and
// pushes everything else out of the line; the tooltip is where it belongs.
//
// The pending verdict is derived here too, from the same two facts — intent
// without a place — so no surface hand-computes it for itself.

import type { ThreadEnvMode } from "~/types/desktop";

/** What a surface renders, or null for a thread in the project's own checkout. */
export type WorkspaceMark = {
  /** The short form: a directory basename, or the pending phrase. */
  label: string;
  /** The long form, for a tooltip. */
  title: string;
  /** Chosen but not built yet, so nothing can open it. */
  pending: boolean;
};

/** The stored facts a surface has about where a thread works.
 *
 *  Carried raw — the pending verdict is derived at the leaf, so every surface
 *  agrees on it. A pre-send draft choice (picked in the composer, nothing
 *  persisted yet) and a stored pending thread (intent persisted, directory not
 *  yet built) arrive in the same shape — a worktree asked for, no directory
 *  yet — and wear the same mark. That sharing is deliberate: until the
 *  directory exists the two are indistinguishable on screen, and splitting them
 *  would be two flags for one fact. */
export type WorkspaceFacts = {
  /** What the thread asked for. Anything but worktree reads as local. */
  envMode?: ThreadEnvMode | null;
  worktreePath?: string | null;
  /** The branch a pending worktree was asked for, when the user named one. */
  requestedBranch?: string | null;
};

/** The last path segment, tolerating a trailing separator and either separator
 *  style — the path comes from the platform git ran on, not from this one. */
function basename(fullPath: string): string {
  const parts = fullPath.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || fullPath;
}

/**
 * Whether the thread asked for a worktree it does not have yet.
 *
 * Intent without a place: the mode says worktree and no directory has
 * materialized. A blank path counts as no directory — it carries nothing to
 * open. Anything but the literal worktree mode reads as local, the same safe
 * reading the store uses: a thread that runs in the project's checkout is the
 * behaviour that has always worked.
 */
export function isWorkspacePending(facts: WorkspaceFacts): boolean {
  return facts.envMode === "worktree" && !facts.worktreePath?.trim();
}

/**
 * The mark for a thread, or null when it runs in its project's checkout.
 *
 * The materialized path wins over the pending verdict: if the directory exists
 * the thread is in it, whatever an intent recorded earlier says.
 */
export function workspaceMark(facts: WorkspaceFacts): WorkspaceMark | null {
  const worktree = facts.worktreePath?.trim();
  if (worktree) {
    return { label: basename(worktree), title: worktree, pending: false };
  }
  if (isWorkspacePending(facts)) {
    return {
      label: "Worktree pending",
      title: "This conversation's worktree hasn't been created yet.",
      pending: true,
    };
  }
  return null;
}

/** Whether a thread has a directory of its own — the gate on anything that would
 *  open a path. A pending thread answers false: it has nowhere to open. */
export function hasOwnWorkspace(facts: WorkspaceFacts): boolean {
  return Boolean(facts.worktreePath?.trim());
}
