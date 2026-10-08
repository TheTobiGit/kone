// When a merged pull request means a thread is done. The rule is deliberately
// narrow, because settling is silent and a mistake hides work the user still
// wanted:
//
//   - the PR must actually be merged (a closed-unmerged PR is not the end);
//   - the user must not have written to the thread after the merge — if they
//     did, the thread is still live whatever the PR says;
//   - and when the merge time is unknown we refuse rather than guess, since
//     with no merge time there is no way to tell whether a later user message
//     came before or after it.
//
// Work that will wake the agent (a running turn, a queued follow-up, a
// subagent) is excluded by the caller BEFORE this check — this module only
// answers the merge-vs-user question.

/** Whether a merged PR should settle the thread. Pure; the caller supplies the
 *  merge time and the user's last prompt, both epoch ms or null. */
export function prMergeSettlesThread(input: {
  mergedAt: number | null;
  lastUserAuthoredAt: number | null;
}): boolean {
  if (input.lastUserAuthoredAt === null) return true;
  // No merge time: we cannot prove the user's message came before the merge,
  // so we leave the thread alone rather than settle on a guess.
  if (input.mergedAt === null) return false;
  // Wrote at the merge instant or before: the merge is still the last thing.
  return input.lastUserAuthoredAt <= input.mergedAt;
}
