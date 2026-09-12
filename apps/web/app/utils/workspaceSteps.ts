// The few seconds between choosing a worktree and having one.
//
// Three steps, in a fixed order, because they happen in that order and a list
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
  message?: string;
};

/** The steps as they read, in the order they happen. */
const STEP_LABELS: ReadonlyArray<{ step: ThreadWorkspaceStep; label: string }> = [
  { step: "create", label: "Creating branch and worktree" },
  { step: "link", label: "Linking thread workspace" },
  { step: "start", label: "Starting session" },
];

/** All three, none started. The shape a surface renders before any report. */
export function initialWorkspaceSteps(): WorkspaceStepRow[] {
  return STEP_LABELS.map(({ step, label }) => ({ step, label, state: "pending" }));
}

/** Fold one report into the list. Returns a new array so a ref assignment is
 *  what triggers the render; unknown steps are ignored rather than appended,
 *  which keeps a newer main process from growing the list under an older UI. */
export function applyWorkspaceStep(
  rows: WorkspaceStepRow[],
  report: { step: ThreadWorkspaceStep; state: "running" | "done" | "failed"; message?: string },
): WorkspaceStepRow[] {
  return rows.map((row) => {
    if (row.step !== report.step) return row;
    const next: WorkspaceStepRow = { ...row, state: report.state };
    if (report.message) next.message = report.message;
    else delete next.message;
    return next;
  });
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
