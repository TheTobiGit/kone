import type { RuntimeEvent } from "~/types/desktop";

/** Holding pen for mid-turn questions that arrive before their thread is
 *  on screen. A reload wipes the renderer's sessions, then the main process
 *  replays its parked asks on subscribe — before rehydrate/openStored has
 *  adopted the stored id, so the fan-out below finds nobody and the modal is
 *  lost. Stashed here by thread id until a session claims it, instead of
 *  being dropped. Keyed globally: thread ids are unique across projects. */
const orphanedUserInputs = new Map<string, RuntimeEvent[]>();

function isUserInputRequested(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { type: "user-input.requested" }> {
  return event.type === "user-input.requested";
}

/** Park a question whose thread has no resident session yet. Replays send the
 *  same ask twice (immediate + delayed pass), so a repeat requestId replaces
 *  rather than stacks. */
export function stashOrphanUserInput(
  event: Extract<RuntimeEvent, { type: "user-input.requested" }>,
): void {
  const list = orphanedUserInputs.get(event.threadId) ?? [];
  const next = list.filter((e) => {
    if (!isUserInputRequested(e)) return true;
    return e.requestId !== event.requestId;
  });
  next.push(event);
  orphanedUserInputs.set(event.threadId, next);
}

/** Take (and clear) every stashed question for a thread being claimed. */
export function takeOrphanUserInputs(threadId: string): RuntimeEvent[] {
  const list = orphanedUserInputs.get(threadId) ?? [];
  orphanedUserInputs.delete(threadId);
  return list;
}

/** Drop one stashed question — its resolve landed before the thread opened. */
export function dropOrphanUserInput(threadId: string, requestId: string): void {
  const list = orphanedUserInputs.get(threadId);
  if (!list) return;
  const next = list.filter((e) => {
    if (!isUserInputRequested(e)) return true;
    return e.requestId !== requestId;
  });
  if (next.length === 0) orphanedUserInputs.delete(threadId);
  else orphanedUserInputs.set(threadId, next);
}

/** Drop every stashed question for a thread whose turn settled unanswered. */
export function clearOrphanUserInputs(threadId: string): void {
  orphanedUserInputs.delete(threadId);
}

/** Holding pen for tool approvals that arrive before their thread is on
 *  screen — the same reload race as the questions above: the main process
 *  replays its parked gates on subscribe, before rehydrate/openStored has
 *  adopted the stored id, so the fan-out below finds nobody and the in-thread
 *  modal never renders. Stashed here by thread id until a session claims it.
 *  Top-level threads land here; a genuine spawned child (known via a resident
 *  parent's spawnedChildren) goes to the registry inbox in agentPrefetch
 *  instead, so the two pens never hold the same ask and the global feed never
 *  mislabels a top-level thread as spawned. Keyed globally, like the
 *  questions above: thread ids are unique across projects. */
const orphanedApprovals = new Map<string, RuntimeEvent[]>();

function isApprovalRequested(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { type: "approval.requested" }> {
  return event.type === "approval.requested";
}

/** Park an approval whose thread has no resident session yet. Replays send the
 *  same ask twice (immediate + delayed pass), so a repeat requestId replaces
 *  rather than stacks. */
export function stashOrphanApproval(
  event: Extract<RuntimeEvent, { type: "approval.requested" }>,
): void {
  const list = orphanedApprovals.get(event.threadId) ?? [];
  const next = list.filter((e) => {
    if (!isApprovalRequested(e)) return true;
    return e.requestId !== event.requestId;
  });
  next.push(event);
  orphanedApprovals.set(event.threadId, next);
}

/** Take (and clear) every stashed approval for a thread being claimed. */
export function takeOrphanApprovals(threadId: string): RuntimeEvent[] {
  const list = orphanedApprovals.get(threadId) ?? [];
  orphanedApprovals.delete(threadId);
  return list;
}

/** Drop one stashed approval — its resolve landed before the thread opened. */
export function dropOrphanApproval(threadId: string, requestId: string): void {
  const list = orphanedApprovals.get(threadId);
  if (!list) return;
  const next = list.filter((e) => {
    if (!isApprovalRequested(e)) return true;
    return e.requestId !== requestId;
  });
  if (next.length === 0) orphanedApprovals.delete(threadId);
  else orphanedApprovals.set(threadId, next);
}

/** Drop every stashed approval for a thread whose turn settled unanswered. */
export function clearOrphanApprovals(threadId: string): void {
  orphanedApprovals.delete(threadId);
}
