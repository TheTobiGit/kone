import { replayForTurn, handInFraming, type HandoffBudgetOptions } from "./sidechat.js";
import { sameProviderModel, type TurnSelection } from "./selection.js";
import { resolveProviderSendAvailability } from "./providerHealth.js";
import type { QueuedTurnRow } from "./conversationStoreTypes.js";
import type { HandInTarget, InteractionMode, ProviderKind, ProviderStatus, StoredThread, StoredThreadMeta } from "./types.js";

// The two decisions a delivery of a selected follow-up makes: whether a
// provider switch can be honoured, and what refusal to record when it cannot.
// Kept out of AgentService so both are exercised without a live session.

const QUEUED_MODES: readonly InteractionMode[] = ["ask", "accept-edits", "full-access"];

/** The interaction mode a stored queue row's `mode` column names, if any. */
export function queuedMode(value: string | undefined): InteractionMode | undefined {
  return QUEUED_MODES.find((mode) => mode === value);
}

/** The selection a queued row was enqueued with, or null when it named no
 *  provider (a row that runs on the thread's current owner). */
export function queuedSelection(row: QueuedTurnRow): TurnSelection | null {
  if (!row.provider) return null;
  const selection: TurnSelection = { provider: row.provider };
  if (row.model) selection.model = row.model;
  if (row.effort) selection.effort = row.effort;
  if (row.serviceTier) selection.serviceTier = row.serviceTier;
  if (row.contextWindow) selection.contextWindow = row.contextWindow;
  const mode = queuedMode(row.mode);
  if (mode) selection.mode = mode;
  return selection;
}

/** The hand-in target a selection names: provider, model, effort and mode are
 *  what a session start reads; service tier and context window ride the turn
 *  itself. */
export function selectionTargetFromInput(selection: TurnSelection): HandInTarget {
  const target: HandInTarget = { provider: selection.provider };
  if (selection.model) target.model = selection.model;
  if (selection.effort) target.effort = selection.effort;
  if (selection.mode) target.mode = selection.mode;
  return target;
}

/** Why a provider switch cannot be delivered, or null when it can.
 *
 *  The first check is the no-op rule the picker already enforces: a hand-in to
 *  the hands the thread is in would cost a session restart and leave a marker
 *  saying nothing changed. The second is the P1 hand-in budget: a replay that
 *  cannot fit the target window refuses here, before the hand-in writes
 *  anything, so the thread stays on its current owner rather than being
 *  retargeted by a switch that then cannot carry its history. */
export function selectionRefusalForHandIn(input: {
  meta: Pick<StoredThreadMeta, "provider" | "model">;
  thread: Pick<StoredThread, "blocks" | "title" | "branch" | "threadId">;
  target: HandInTarget;
  prompt: string;
  budget: HandoffBudgetOptions;
}): string | null {
  if (
    sameProviderModel(
      { provider: input.target.provider, model: input.target.model },
      { provider: input.meta.provider, model: input.meta.model },
    )
  ) {
    return "Select a different provider or model to hand this thread to";
  }
  try {
    replayForTurn(input.thread, input.prompt, handInFraming, input.budget);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

/** Why the target provider cannot take the switch right now, or null. Reads
 *  the cached status surface the composer's own send gate reads: only a KNOWN
 *  bad row refuses, so a provider kone has never probed is unknown, not
 *  broken. */
export function providerSwitchUnavailableReason(
  provider: ProviderKind,
  statuses: readonly ProviderStatus[],
): string | null {
  const availability = resolveProviderSendAvailability({ provider, statuses });
  return availability.usable ? null : availability.reason;
}
