/** Transcript reads skip a user prompt its queued follow-up was journaled for
 *  while the queue row is still active (`queued`/`promoting` — the same active
 *  set listQueuedTurns reads). The prompt is already durable in `blocks`, but
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
    AND q.state IN ('queued', 'promoting')
))`;
