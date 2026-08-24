// Which row the studio's camera sits on.
//
// A leaf module on purpose. This rule has been wrong three times, and every time
// the symptom was the same: the camera moved to a project the user had not asked
// for. It is worth having somewhere it can be stated once and checked, rather
// than inline in a component where the only way to exercise it is to drive the
// whole app.
//
// The plane shows two kinds of row. A *persisted* row is one with work on it,
// owned by the axis (useStudioPlane), which is what remembers focus across
// restarts. A *transient* row is the one AppStudio adds for the open project
// when that project has no work yet — it is on screen, but the axis knows
// nothing about it and cannot remember or move it.
//
// The case this exists for: you are standing in a persisted row and you close
// its last pane. The row stops being persisted, so the axis drops it and falls
// back to whichever project slid into its index. But your project is still on
// screen — it became the transient row a moment ago — and being sent into
// someone else's work for the crime of tidying up your own is not something any
// gesture asked for. So a pin to your own row wins over the axis's fallback.

/** A row as the plane renders it — the axis's persisted rows plus, at most, the
 *  transient one for the open project. */
export interface FocusRow {
  projectPath: string;
  /** True for the row that exists only because a project is open with no work
   *  on it yet. */
  transient: boolean;
}

export interface RowFocusInput {
  /** Rows in camera order, top to bottom. */
  rows: readonly FocusRow[];
  /** A row the plane pinned itself, because focus landed on a transient one. */
  transientFocus: string | null;
  /** The row the camera was last on while it was still persisted. This is the
   *  one that matters when a row empties underneath the camera. */
  standing: string | null;
  /** What the axis thinks is focused, among persisted rows only. */
  axisPath: string | null;
}

/** Resolve the focused row, or null when the plane has nothing to show. */
export function resolveRowFocus({
  rows,
  transientFocus,
  standing,
  axisPath,
}: RowFocusInput): string | null {
  // The pin only ever holds a *transient* row, which is what keeps it from
  // shadowing a real move: travelling re-records `standing`, and a row that is
  // still persisted is resolved by the axis below. The moment your row stops
  // being transient — its first new pane opens — the pin stops applying on its
  // own, with nothing to clear.
  const pinned = transientFocus ?? standing;
  if (pinned && rows.some((r) => r.projectPath === pinned && r.transient)) {
    return pinned;
  }
  if (axisPath && rows.some((r) => r.projectPath === axisPath)) return axisPath;
  // No persisted row is focused — an empty plane, or the focused row just died
  // and its project is not the open one. The last row is where a newly-born or
  // transient row sits, which is the only place worth landing.
  return rows[rows.length - 1]?.projectPath ?? null;
}

/** Should `standing` be updated to this path? Only a row that is still persisted
 *  is worth recording: the moment a row goes transient this must stop, or the
 *  pin would be overwritten by the very transition it exists to survive. */
export function recordsStanding(rows: readonly FocusRow[], path: string | null): boolean {
  if (!path) return false;
  const row = rows.find((r) => r.projectPath === path);
  return !!row && !row.transient;
}

/** A project the app knows about, newest-first in the list handed below. */
export interface KnownProject {
  path: string;
  name: string;
}

/** Which project the studio should land in when it holds no work for one yet.
 *
 *  Three cases, and the third is the one that is easy to get wrong:
 *
 *  - No projects at all → null. There is nowhere for a row to be, and this is
 *    the single case where the studio has nothing to open and refuses to.
 *  - A project page is open → that project. You are already there; the studio
 *    should not move you.
 *  - Otherwise → the most recently opened project. Summoning the studio from the
 *    launcher should put you back into what you were last doing, rather than
 *    into nothing or into whichever project happens to sort first.
 *
 *  `recentsNewestFirst` is expected already ordered — useRecentProjects.byRecency
 *  sorts on lastOpenedAt, and re-sorting here would be a second opinion about
 *  recency that could disagree with the launcher's. */
export function resolveLandingProject(
  activeProject: KnownProject | null,
  recentsNewestFirst: readonly KnownProject[],
): KnownProject | null {
  if (activeProject) return activeProject;
  const recent = recentsNewestFirst[0];
  return recent ? { path: recent.path, name: recent.name } : null;
}
