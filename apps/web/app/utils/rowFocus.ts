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
// restarts. A *transient* row is one AppStudio keeps on screen without any work
// behind it — for the open project before it has any, and for the row the camera
// is standing in once its last pane closes. It is on screen, but the axis knows
// nothing about it and cannot remember or move it.
//
// The case this exists for: you are standing in a persisted row and you close
// its last pane. The row stops being persisted, so the axis drops it and falls
// back to whichever project slid into its index. But your project is still on
// screen — it became a transient row a moment ago — and being sent into someone
// else's work for the crime of tidying up your own is not something any gesture
// asked for. So a pin to your own row wins over the axis's fallback.

import type { StudioDestination } from "~/types/studio";

/** A row as the plane renders it — the axis's persisted rows plus, at most, the
 *  transient one for the open project. */
export interface FocusRow {
  projectPath: string;
  /** True for a row with no work behind it — the open project before it has
   *  any, or the row the camera is standing in after its last pane closed. */
  transient: boolean;
}

/** A project the app knows about, newest-first in the list handed below. */
export interface KnownProject {
  path: string;
  name: string;
}

/** A row as the plane renders it — a focus row plus the name it reads. */
export interface RenderRow extends FocusRow {
  name: string;
}

/**
 * The row the camera was last deliberately landed on, with everything needed to
 * put it back on screen once nothing persists it: which project, what it is
 * called, and which slot it belongs in.
 *
 * The name travels with the pin rather than being looked up when it is wanted,
 * because by then the row it would be read off may be gone — or, worse, may be
 * a different project's row that has since slid into the same index.
 */
export interface StandingRow {
  path: string;
  name: string;
  /** Where the row sits among the persisted ones. For a project that never had
   *  a row, the foot of the plane — which is where a new one would be born. */
  index: number;
}

/**
 * The rows the plane shows: the persisted ones, plus at most two transient.
 *
 * The first is the row the camera is standing in without work behind it. That
 * is one state reached two ways — a row whose last pane just closed, and a
 * project travelled to by name that has never held work at all — and both are
 * answered by the same pin, which is why `standing` carries an index rather
 * than the caller keeping a second ref for the second case. A row that emptied
 * under the camera records the slot it already held; a project that never had a
 * row records the foot of the plane. The splice below is the same either way.
 *
 * Without it, a row that stops being persisted vanishes mid-gesture and every
 * project below it slides up one — and since the camera moves in whole rows
 * with a transition, you would watch it travel into somebody else's work for
 * the crime of tidying up your own.
 *
 * The second is for the landing project when it has no row at all. Without it,
 * summoning the plane with no work anywhere would land on nothing, when the
 * whole reason to summon it is to start working.
 *
 * Neither is ever persisted (a row with no panes is dropped on save), so both
 * appear and disappear on their own as the first pane opens and the last one
 * closes.
 */
export function renderPlaneRows(
  persisted: readonly { projectPath: string; name: string }[],
  standing: StandingRow | null,
  landing: KnownProject | null,
): RenderRow[] {
  const rows: RenderRow[] = persisted.map((r) => ({
    projectPath: r.projectPath,
    name: r.name,
    transient: false,
  }));
  if (standing && !rows.some((r) => r.projectPath === standing.path)) {
    // Back into the slot it held, not onto the end: appending would move the
    // row out from under the camera, which is the thing being prevented.
    const at = Math.min(standing.index, rows.length);
    rows.splice(at, 0, { projectPath: standing.path, name: standing.name, transient: true });
  }
  if (landing && !rows.some((r) => r.projectPath === landing.path)) {
    rows.push({ projectPath: landing.path, name: landing.name, transient: true });
  }
  return rows;
}

/**
 * Every project the camera can travel to, in the order the axis visits them.
 *
 * The rows as they stand first — persisted and transient alike, so the list
 * reads top to bottom exactly as stepping down the axis would — and then the
 * projects the app knows that have no row yet, newest first. Those join the
 * foot of the plane the moment one is picked, which is where `focusRow` pins a
 * project that has never held work, so the order a chooser shows is the order
 * travel actually produces.
 *
 * `columns` is how much work is waiting there, and it is counted off the
 * persisted rows rather than off the rendered ones: a transient row exists
 * precisely because nothing is open in it, so the answer for one is zero, and
 * so is the answer for a project with no row. The plane builds this once and
 * hands the same list to every row.
 */
export function planeDestinations(
  rows: readonly RenderRow[],
  persisted: readonly { projectPath: string; paneCount: number }[],
  known: readonly KnownProject[],
): StudioDestination[] {
  const paneCounts = new Map(persisted.map((row) => [row.projectPath, row.paneCount]));
  const listed = new Set<string>();
  const list: StudioDestination[] = rows.map((row) => {
    listed.add(row.projectPath);
    return {
      projectPath: row.projectPath,
      name: row.name,
      columns: paneCounts.get(row.projectPath) ?? 0,
    };
  });
  for (const project of known) {
    if (listed.has(project.path)) continue;
    listed.add(project.path);
    list.push({ projectPath: project.path, name: project.name, columns: 0 });
  }
  return list;
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
  // No persisted row is focused — an empty plane, or the focused row died with
  // nothing pinned to hold its place. The last row is where a newly-born or
  // landing row sits, which is the only place left worth landing.
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
