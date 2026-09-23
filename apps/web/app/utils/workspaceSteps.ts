// The few seconds between choosing a worktree and having one.
//
// Four steps, in a fixed order, because they happen in that order and a list
// that reorders itself as reports land is harder to read than one that does
// not. The reducer only ever changes a step's state — it never adds, removes or
// moves one — so the shape on screen is stable from the first frame.
//
// A failed step stays, marked failed, and the ones after it stay pending.
// Withdrawing the list on failure would leave the user watching something
// vanish with no account of what went wrong, which is the specific thing this
// is here to prevent.

import type { ThreadWorkspaceStep } from "~/types/desktop";

export type WorkspaceStepState = "pending" | "running" | "done" | "failed";

export type WorkspaceStepRow = {
  step: ThreadWorkspaceStep;
  label: string;
  state: WorkspaceStepState;
  /** Why it failed, when it did. */
  error?: string;
  /** On a finished step, what is worth knowing about how it went. */
  note?: string;
};

/** The steps as they read, in the order they happen. */
const STEP_LABELS: ReadonlyArray<{ step: ThreadWorkspaceStep; label: string }> = [
  { step: "fetch", label: "Getting latest changes" },
  { step: "create", label: "Creating branch and worktree" },
  { step: "link", label: "Linking thread workspace" },
  { step: "start", label: "Starting session" },
];

/** Every step, none started. The shape a surface renders before any report. */
export function initialWorkspaceSteps(): WorkspaceStepRow[] {
  return STEP_LABELS.map(({ step, label }) => ({ step, label, state: "pending" }));
}

/** Fold one report into the list. Returns a new array so a ref assignment is
 *  what triggers the render; unknown steps are ignored rather than appended,
 *  which keeps a newer main process from growing the list under an older UI. */
export function applyWorkspaceStep(
  rows: WorkspaceStepRow[],
  report: {
    step: ThreadWorkspaceStep;
    state: "running" | "done" | "failed";
    error?: string;
    note?: string;
  },
): WorkspaceStepRow[] {
  return rows.map((row) => {
    if (row.step !== report.step) return row;
    // Each report says everything about its step, so a sentence the last
    // report carried and this one doesn't is gone, not kept.
    const next: WorkspaceStepRow = { step: row.step, label: row.label, state: report.state };
    if (report.error) next.error = report.error;
    if (report.note) next.note = report.note;
    return next;
  });
}

/** The sentence a settled build leaves on its summary line: the first note in
 *  step order, so where the worktree started from outranks which files came
 *  with it. Empty when no step left one. */
export function settledWorkspaceNote(rows: WorkspaceStepRow[]): string {
  for (const row of rows) if (row.note) return row.note;
  return "";
}

/** Every step finished successfully — the point at which the stepper has nothing
 *  left to say and can leave. */
export function workspaceStepsSettled(rows: WorkspaceStepRow[]): boolean {
  return rows.every((row) => row.state === "done");
}

/** The step that failed, when one did. A failure is terminal: nothing after it
 *  runs, so there is never more than one. */
export function failedWorkspaceStep(rows: WorkspaceStepRow[]): WorkspaceStepRow | null {
  return rows.find((row) => row.state === "failed") ?? null;
}

/** Whether backing out still has anything to undo. True while the build is in
 *  flight and the worktree is not yet linked — the create/link window where
 *  "undo whatever finishes" means something. Once the start step runs the
 *  directory is written and the session is coming up, so there is nothing left
 *  to undo and dismissing the card is just dismissing it. */
export function isWorkspaceCancellable(rows: WorkspaceStepRow[]): boolean {
  if (failedWorkspaceStep(rows)) return false;
  if (workspaceStepsSettled(rows)) return false;
  const start = rows.find((row) => row.step === "start");
  return !start || start.state === "pending";
}
