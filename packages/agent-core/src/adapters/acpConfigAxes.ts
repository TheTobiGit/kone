/** Whether a model axis is already standing at the value a turn is asking for.
 *
 *  Both sides are trimmed. The wanted value comes from kone's picker and the
 *  current one is echoed back by the CLI, and the two have disagreed over
 *  nothing but padding — `"low "` against `"low"` is the same axis in the same
 *  state, and treating it as a difference re-sends an RPC that changes
 *  nothing. An axis the matrix has no reading for is never equal: with nothing
 *  to compare against, the only safe answer is to assert it.
 *
 *  Shared by the guards that decide whether to set an axis and by the polls
 *  that decide whether a set landed, so the two can never read the same wire
 *  state differently. */
export function configValueEquals(currentValue: string | undefined, want: string): boolean {
  if (currentValue === undefined) return false;
  return currentValue.trim() === want.trim();
}
