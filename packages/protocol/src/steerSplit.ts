// A message steered into a running turn splits that turn's reply where it
// landed: what the agent wrote before taking it in reads above the message,
// and the rest continues below it as the same turn. The continuation is a
// piece of the view, not a stored row, so both sides derive its id the same
// way — the live reducer when the steer lands, the store when a thread is read
// back — and a reload keeps the pieces the live view showed.

/** The id of the piece of turn `turnId` that follows the message steered in
 *  as `userBlockId`. */
export function steerContinuationId(turnId: string, userBlockId: string): string {
  return `${turnId}~steer~${userBlockId}`;
}
