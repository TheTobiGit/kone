import { ref, type Ref } from "vue";
import type {
  KoneAgentApi,
  PreviewTurnCheckpointResult,
  RevertTurnCheckpointResult,
  TurnCheckpointRecord,
} from "~/types/desktop";
import { seedFromBridge } from "./useCompaction";

/** One failed preview/revert, phrased for the timeline — the sentence the
 *  restore control shows under the turn. Pure so the message table is
 *  unit-testable without a bridge. */
export function checkpointFailureMessage(
  result: Extract<PreviewTurnCheckpointResult, { ok: false }> | Extract<
    RevertTurnCheckpointResult,
    { ok: false }
  >,
): string {
  switch (result.reason) {
    case "missing":
      return "No checkpoint was recorded for this turn.";
    case "no-workdir":
      return result.detail
        ? `The thread's directory is gone — looked for ${result.detail}.`
        : "The thread's directory can't be found.";
    case "busy":
      return "A turn is still running here — restore after it settles.";
    case "checkpoint-gone":
      return "The snapshot itself is gone — its git data was cleaned up.";
    case "dirty":
      return "Restoring would overwrite uncommitted work.";
    case "failed":
      return result.detail ? `Restore failed — ${result.detail}` : "Restore failed.";
  }
}

/** How many file paths the confirm step lists before rolling the rest up
 *  into a "+N more" line — enough to recognize the blast radius, few enough
 *  to fit under a turn. */
export const CHECKPOINT_CONFIRM_LIST_CAP = 8;

/** The checkpoint slice of the desktop bridge — the three methods the
 *  restore flow reads. Optional throughout (like the queue's QueueBridge):
 *  presence is checked at runtime, so a bridge predating the surface simply
 *  hides the control instead of breaking the timeline. */
export type CheckpointBridge = {
  turnCheckpoints?: (threadId: string) => Promise<TurnCheckpointRecord[]>;
  previewTurnCheckpoint?: (
    threadId: string,
    turnId: string,
  ) => Promise<PreviewTurnCheckpointResult>;
  revertTurnCheckpoint?: (
    threadId: string,
    turnId: string,
    force?: boolean,
  ) => Promise<RevertTurnCheckpointResult>;
};

/** Per-turn restore state for one thread: the seeded checkpoint list plus the
 *  preview/revert calls the timeline's restore control drives. Mirrors
 *  useCompaction — the session owns the thread id and the bridge, this unit
 *  owns everything the turn footer reads. */
export function useTurnCheckpoints(deps: {
  threadId: Ref<string>;
  bridge: () => KoneAgentApi | CheckpointBridge | null;
}) {
  /** Every pre-turn snapshot recorded for the thread, oldest first. Seeded
   *  when a stored identity is adopted; a live turn's own capture lands on
   *  the next seed, so the control appears for it after a re-read. */
  const checkpoints = ref<TurnCheckpointRecord[]>([]);

  /** Re-seed the list from the store for a thread that just adopted a stored
   *  identity — best-effort via seedFromBridge, like compactions. */
  function seedCheckpoints(): void {
    seedFromBridge(deps.bridge()?.turnCheckpoints, deps.threadId, (rows) => {
      checkpoints.value = [...(rows ?? [])].sort((a, b) => a.createdAt - b.createdAt);
    });
  }

  /** The checkpoint recorded for one turn, or null when the turn has none
   *  (non-repo thread, or capture degraded on a git error). */
  function checkpointForTurn(turnId: string): TurnCheckpointRecord | null {
    return checkpoints.value.find((c) => c.turnId === turnId) ?? null;
  }

  /** What restoring the turn's snapshot would change. Null when the bridge
   *  has no checkpoint surface (an older shell) — the control stays hidden
   *  rather than guessing. */
  async function previewCheckpoint(
    turnId: string,
  ): Promise<PreviewTurnCheckpointResult | null> {
    const preview = deps.bridge()?.previewTurnCheckpoint;
    if (!preview) return null;
    return preview(deps.threadId.value, turnId);
  }

  /** Restore the turn's snapshot. Pass `force` only after the user has seen
   *  the preview and confirmed it — without it a dirty tree answers `dirty`
   *  with the exact file lists instead of being overwritten. */
  async function revertCheckpoint(
    turnId: string,
    force?: boolean,
  ): Promise<RevertTurnCheckpointResult | null> {
    const revert = deps.bridge()?.revertTurnCheckpoint;
    if (!revert) return null;
    return revert(deps.threadId.value, turnId, force);
  }

  return {
    checkpoints,
    seedCheckpoints,
    checkpointForTurn,
    previewCheckpoint,
    revertCheckpoint,
  };
}
