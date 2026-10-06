// delegateColumns — which handed-off agents get a column of their own.
//
// A delegate or contractor gets a column beside the agent that handed it over
// the moment it is handed off. "The moment" is the whole rule: a parent's
// children are also re-seeded from the store whenever its thread is opened —
// on every launch, for every restored column — and opening a column for each
// of those would bring back every delegate the user had already closed. So a
// child only ever earns a column once, and only if it was handed off while
// this app run was up to see it.

import type { SpawnedThread } from "~/types/desktop";

/** When this run started. A child created before it was handed off in an
 *  earlier run, which already gave it its column (and the user since kept or
 *  closed it — the saved layout says which). */
const runStartedAt = Date.now();

/** Children already given a column this run. Module-scoped, not per row: a row
 *  that unmounts and comes back in the same run must not reopen them either. */
const opened = new Set<string>();

/** True exactly once per child that should open a column now: a delegation or
 *  contract handed off during this run, not seen before. */
export function claimDelegateColumn(
  child: Pick<SpawnedThread, "threadId" | "handOff" | "createdAt">,
  since: number = runStartedAt,
): boolean {
  if (child.handOff !== "delegation" && child.handOff !== "contract") return false;
  if (opened.has(child.threadId)) return false;
  if (child.createdAt < since) return false;
  opened.add(child.threadId);
  return true;
}

/** Forget every claim, for tests. */
export function resetDelegateColumns(): void {
  opened.clear();
}
