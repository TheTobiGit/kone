// Live worktree-setup progress, per thread. This is the richer, staged view of
// what happens between "this thread wants its own worktree" and "the agent's
// first turn has started" — the reference is t3's worktreeSetup contract and
// WorktreeSetupTracker.
//
// It is separate from the coarse `thread.workspace.progress` steps the existing
// stepper renders: those are four fixed rows shipped to the current UI, while
// this is the full stage model (fetch → checkout with git's own % → submodules →
// setup script → agent) with per-stage logs and errors, for the worktree-setup
// card the UI phase will build. Keeping them apart means neither the old
// stepper nor a later card has to know the other exists.
//
// State is memory only and short lived: it exists from `begin` until the setup
// settles, and is dropped when the thread's turn starts. Nothing here is
// persisted — the durable record of a setup is the thread's worktree path.

/** The stages in the order they run. `fetch` is the base freshen, `checkout`
 *  the `git worktree add` (the only stage with a real percentage), `submodules`
 *  the recursive update, `setup-script` the project's own command, and `agent`
 *  the hand-off to the provider. */
export const WORKTREE_SETUP_STAGE_ORDER = [
  "fetch",
  "checkout",
  "submodules",
  "setup-script",
  "agent",
] as const;

export type WorktreeSetupStageId = (typeof WORKTREE_SETUP_STAGE_ORDER)[number];

export type WorktreeSetupStageStatus =
  | "pending"
  | "running"
  | "done"
  | "skipped"
  | "warning"
  | "failed";

export interface WorktreeSetupStage {
  id: WorktreeSetupStageId;
  status: WorktreeSetupStageStatus;
  startedAt: number | null;
  endedAt: number | null;
  /** Only `checkout` reports a real percentage, parsed from git's progress. */
  percent: number | null;
  /** One short line for the row (a file count, an exit code, a reason). */
  detail: string | null;
  /** Last few output lines, newest last. */
  tail: string[];
}

export type WorktreeSetupPhase = "running" | "done" | "failed" | "cancelled";

export interface WorktreeSetupSnapshot {
  threadId: string;
  phase: WorktreeSetupPhase;
  startedAt: number;
  endedAt: number | null;
  branch: string | null;
  baseRef: string | null;
  worktreePath: string | null;
  /** The setup command when one is configured for the project. */
  setupScript: { command: string } | null;
  stages: WorktreeSetupStage[];
  error: string | null;
  /** Monotonic per thread across setups, so a late subscriber drops stale
   *  frames rather than stepping backwards. */
  sequence: number;
}

/** One stage patch, as a producer reports it. */
export interface WorktreeSetupProgress {
  stage: WorktreeSetupStageId;
  status?: WorktreeSetupStageStatus;
  percent?: number | null;
  detail?: string | null;
  tail?: string[];
}

export const WORKTREE_SETUP_DETAIL_MAX_LENGTH = 200;
export const WORKTREE_SETUP_TAIL_LINES = 4;
export const WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH = 400;
export const WORKTREE_SETUP_ERROR_MAX_LENGTH = 1_000;

function clampText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function emptyStage(id: WorktreeSetupStageId): WorktreeSetupStage {
  return { id, status: "pending", startedAt: null, endedAt: null, percent: null, detail: null, tail: [] };
}

/** Parse git's own checkout progress (`Updating files:  42% (10/24)`) or the
 *  receive side (`Receiving objects:  42%`). Returns null when the chunk names
 *  no percentage. Exported for tests. */
export function parseGitProgressPercent(chunk: string): number | null {
  const match = /(\d{1,3})%/.exec(chunk);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/** In-memory setup tracker for the dispatcher. One instance covers every
 *  thread; `onChange` is called with each new snapshot (and with the final one)
 *  so the host can broadcast it. */
export class WorktreeSetupTracker {
  private readonly setups = new Map<string, WorktreeSetupSnapshot>();
  private readonly lastSequence = new Map<string, number>();

  constructor(private readonly onChange?: (snapshot: WorktreeSetupSnapshot) => void) {}

  /** Start a fresh running snapshot for the thread, replacing any prior one. */
  begin(input: {
    threadId: string;
    branch: string | null;
    baseRef: string | null;
    /** The stages to track, in canonical order; anything not listed is omitted. */
    stages?: readonly WorktreeSetupStageId[];
  }): WorktreeSetupSnapshot {
    const wanted = input.stages ?? WORKTREE_SETUP_STAGE_ORDER;
    const sequence = (this.lastSequence.get(input.threadId) ?? -1) + 1;
    this.lastSequence.set(input.threadId, sequence);
    const snapshot: WorktreeSetupSnapshot = {
      threadId: input.threadId,
      phase: "running",
      startedAt: Date.now(),
      endedAt: null,
      branch: input.branch,
      baseRef: input.baseRef,
      worktreePath: null,
      setupScript: null,
      stages: WORKTREE_SETUP_STAGE_ORDER.filter((id) => wanted.includes(id)).map(emptyStage),
      error: null,
      sequence,
    };
    this.set(snapshot);
    return snapshot;
  }

  /** Set the worktree path / setup command once known. */
  setSnapshotFields(
    threadId: string,
    fields: { worktreePath?: string | null; setupScript?: { command: string } | null },
  ): void {
    this.mutate(threadId, (snapshot) => ({ ...snapshot, ...fields }));
  }

  /** Patch one stage. Percent and detail are clamped; `tail` replaces the
   *  stage's tail. */
  stage(threadId: string, progress: WorktreeSetupProgress): void {
    const at = Date.now();
    this.mutate(threadId, (snapshot) => ({
      ...snapshot,
      stages: snapshot.stages.map((entry) => {
        if (entry.id !== progress.stage) return entry;
        const status = progress.status ?? entry.status;
        const startedAt =
          entry.startedAt ?? (status === "pending" ? null : at);
        const endedAt =
          status === "running" || status === "pending" ? null : (entry.endedAt ?? at);
        return {
          ...entry,
          status,
          startedAt,
          endedAt,
          percent:
            progress.percent === undefined
              ? entry.percent
              : progress.percent === null
                ? null
                : Math.max(0, Math.min(100, Math.round(progress.percent))),
          detail:
            progress.detail === undefined
              ? entry.detail
              : progress.detail === null
                ? null
                : clampText(progress.detail, WORKTREE_SETUP_DETAIL_MAX_LENGTH),
          tail:
            progress.tail === undefined
              ? entry.tail
              : progress.tail
                  .map((line) => clampText(line, WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH))
                  .slice(-WORKTREE_SETUP_TAIL_LINES),
        };
      }),
    }));
  }

  /** Append one output line to a stage's tail, keeping the newest few. */
  appendTail(threadId: string, stage: WorktreeSetupStageId, line: string): void {
    this.mutate(threadId, (snapshot) => ({
      ...snapshot,
      stages: snapshot.stages.map((entry) =>
        entry.id === stage
          ? {
              ...entry,
              tail: [...entry.tail, clampText(line, WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH)].slice(
                -WORKTREE_SETUP_TAIL_LINES,
              ),
            }
          : entry,
      ),
    }));
  }

  /** Settle the setup. Any stage still running becomes done/skipped/failed to
   *  match the phase. Returns the settled snapshot, or null when nothing was
   *  tracked for the thread. */
  finish(
    threadId: string,
    phase: "done" | "failed" | "cancelled",
    error?: string | null,
  ): WorktreeSetupSnapshot | null {
    const settled = this.mutate(threadId, (snapshot) => ({
      ...snapshot,
      phase,
      endedAt: Date.now(),
      error:
        error === undefined || error === null
          ? null
          : clampText(error, WORKTREE_SETUP_ERROR_MAX_LENGTH),
      stages: snapshot.stages.map((entry) =>
        entry.status === "running"
          ? {
              ...entry,
              status: phase === "done" ? "done" : phase === "cancelled" ? "skipped" : "failed",
              endedAt: Date.now(),
            }
          : entry,
      ),
    }));
    if (settled) this.setups.delete(threadId);
    return settled;
  }

  /** The current snapshot for a thread, or null when none is tracked. */
  get(threadId: string): WorktreeSetupSnapshot | null {
    return this.setups.get(threadId) ?? null;
  }

  /** Drop any tracking for a thread without emitting (thread deleted). */
  forget(threadId: string): void {
    this.setups.delete(threadId);
    this.lastSequence.delete(threadId);
  }

  private mutate(
    threadId: string,
    fn: (snapshot: WorktreeSetupSnapshot) => WorktreeSetupSnapshot,
  ): WorktreeSetupSnapshot | null {
    const existing = this.setups.get(threadId);
    if (!existing) return null;
    const sequence = (this.lastSequence.get(threadId) ?? existing.sequence) + 1;
    this.lastSequence.set(threadId, sequence);
    const next = { ...fn(existing), sequence };
    this.set(next);
    return next;
  }

  private set(snapshot: WorktreeSetupSnapshot): void {
    this.setups.set(snapshot.threadId, snapshot);
    this.onChange?.(snapshot);
  }
}
