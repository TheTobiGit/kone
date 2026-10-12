import type { DatabaseSync } from "../sqlite.js";

/** The queue states that still stand for a message the user sent and that has
 *  not run: waiting, being handed to the provider, or held after its retries
 *  ran out. Every "is something still queued here?" read uses this one set. */
export const PENDING_QUEUE_STATES = `('queued', 'promoting', 'failed')`;

/** The states a queue strip lists: everything the user still has waiting or
 *  held, plus a row that was refused a provider switch. A refused row is
 *  terminal but stays visible with its reason; it is not pending, so it pauses
 *  nothing and a claim never returns it. */
export const LISTED_QUEUE_STATES = `('queued', 'promoting', 'failed', 'refused')`;

/** Transcript reads skip a user prompt its queued follow-up was journaled for
 *  while the queue row is still pending (PENDING_QUEUE_STATES — the same set
 *  listQueuedTurns reads). The prompt is already durable in `blocks`, but
 *  it hasn't run yet: showing it would put an unanswered message in the thread
 *  on every reload until the live queue re-seeds and hides it again. Settling
 *  the row (promoted/cancelled) returns the block to reads — promotion means
 *  the turn is running, cancellation of a never-started turn removes the block
 *  outright (see cancelQueuedTurn / cancelQueuedTurnsForThread). Written against the `blocks` table, whose
 *  own thread/block ids the subquery correlates on. */
export const WITHOUT_ACTIVE_QUEUE = `(role != 'user' OR NOT EXISTS (
  SELECT 1 FROM queued_turns q
  WHERE q.thread_id = blocks.thread_id
    AND q.user_block_id = blocks.block_id
    AND q.state IN ${PENDING_QUEUE_STATES}
))`;

/** Put one block after everything else on its thread's transcript; its `at`
 *  stays the moment it was written. `seq` is the blocks table's rowid, unique
 *  across every thread, so the new place is one past the highest seq of any
 *  thread: one past this thread's own is often another thread's block. Throws
 *  on a store error, so a caller inside a transaction rolls it back. */
export function moveBlockToTail(db: DatabaseSync, threadId: string, blockId: string): void {
  db.prepare(
    `UPDATE blocks SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM blocks)
      WHERE thread_id = ? AND block_id = ?`,
  ).run(threadId, blockId);
}
