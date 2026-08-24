// useStudioPlane — the studio's vertical axis.
//
// The plane is rows of projects; useStudio owns what happens *along* a row and
// this owns what happens *between* them. It is deliberately thin: the row set is
// derived from the persisted plane rather than declared beside it, because a row
// exists only where work does. Nothing here can create or destroy a row — panes
// do that, by being opened and closed — so there is no way for the axis and the
// work to disagree about which rows exist.
//
// Travel is discrete, like a tiling window manager's workspaces: one row fills
// the viewport and the camera moves in whole rows. It does not wrap. Wrapping
// makes sense for a ring of two or three, but the plane grows with the number of
// projects you have work in, and a camera that jumps from the last row back to
// the first loses you your place in a way a hard end never does.

import { computed, shallowRef, watch } from "vue";
import type { ComputedRef } from "vue";
import { setFocusedRow, studioPlane } from "~/composables/useStudioPersistence";
import type { PaneId } from "~/types/studio";

/** One row as the axis sees it: who it belongs to, how much work is on it, and
 *  where its own focus was left. Deliberately not the panes themselves — the
 *  rail and the camera need identity and weight, not contents. */
export interface PlaneRow {
  projectPath: string;
  /** Last path segment. The rail shows this, not the whole path. */
  name: string;
  paneCount: number;
  focusedId: PaneId | null;
}

function basename(path: string): string {
  // Tolerate a trailing separator: a path is a user-chosen folder, and one that
  // ends in "/" would otherwise render as an empty row name.
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

export interface UseStudioPlane {
  rows: ComputedRef<PlaneRow[]>;
  /** The focused row's path, or null when the plane is empty. */
  focusedPath: ComputedRef<string | null>;
  /** Index of the focused row, or -1 when the plane is empty. The camera reads
   *  this: its offset is `-index * 100vh`. */
  focusedIndex: ComputedRef<number>;
  /** Move the camera by whole rows. Clamped at both ends; returns whether it
   *  actually moved, so a caller can sound a refusal at the edge. */
  stepRow: (delta: number) => boolean;
  /** Focus a row by path. Ignores a path with no row — the axis cannot invent
   *  one. Returns whether it landed. */
  focusRow: (projectPath: string) => boolean;
}

export function useStudioPlane(): UseStudioPlane {
  const plane = studioPlane();

  const rows = computed<PlaneRow[]>(() =>
    (plane.value?.rows ?? []).map((r) => ({
      projectPath: r.projectPath,
      name: basename(r.projectPath),
      paneCount: r.panes.length,
      focusedId: r.focusedId,
    })),
  );

  // The persisted `focusedRow` is the source of truth, but it can name a row
  // that has since died (its last pane closed while the studio was open, or
  // another window closed it). Rather than let the camera point at nothing, the
  // axis keeps its own resolved value and falls back to a neighbour.
  const resolved = shallowRef<string | null>(null);
  // The index the focused row held, so a death hands focus to whoever took its
  // place rather than always to the top of the plane.
  const lastIndex = shallowRef(0);

  const focusedPath = computed<string | null>(() => {
    const list = rows.value;
    if (!list.length) return null;
    const want = resolved.value ?? plane.value?.focusedRow ?? null;
    if (want && list.some((r) => r.projectPath === want)) return want;
    // The row we were on is gone. The row that slid into its index is the one
    // the eye is already looking at; clamp for the case where it was the last.
    const at = Math.min(lastIndex.value, list.length - 1);
    return list[at]?.projectPath ?? null;
  });

  const focusedIndex = computed(() =>
    rows.value.findIndex((r) => r.projectPath === focusedPath.value),
  );

  // Remember where focus sits so the fallback above has an index to reach for.
  watch(focusedIndex, (i) => {
    if (i >= 0) lastIndex.value = i;
  });

  function focusRow(projectPath: string): boolean {
    if (!rows.value.some((r) => r.projectPath === projectPath)) return false;
    resolved.value = projectPath;
    // Persist it, so a relaunch comes back to the row you were working in
    // rather than to the top of the plane.
    setFocusedRow(projectPath);
    return true;
  }

  function stepRow(delta: number): boolean {
    const list = rows.value;
    if (!list.length) return false;
    const from = focusedIndex.value;
    if (from < 0) return false;
    const to = from + delta;
    if (to < 0 || to >= list.length) return false; // the plane has ends
    const next = list[to];
    if (!next) return false;
    resolved.value = next.projectPath;
    setFocusedRow(next.projectPath);
    return true;
  }

  return { rows, focusedPath, focusedIndex, stepRow, focusRow };
}

// Exported for the test — the rail's row name is the one piece of formatting the
// axis does, and a path with a trailing separator has bitten this before.
export const __basename = basename;
