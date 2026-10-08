import type { ConversationSearchHit } from "../conversationStoreTypes.js";

// Thread-level search results. The FTS index returns one row per matching block
// or item, so a single thread can appear many times; a conversation list wants
// one answer per thread, and it wants the user's own words to outrank the
// agent's. This collapses ranked hits to one best per thread:
//
//   - a user message (an indexed block) always beats an assistant hit (an
//     indexed item) for the same thread;
//   - within the same kind, the lower bm25 rank wins (FTS rank is "smaller is
//     better");
//   - the surviving hits are ordered the same way, so the threads whose title
//     the user's words should inform come first.

/** Whether a hit is the user's own words. The FTS index stores one row per user
 *  block and one per turn item, so a block hit is user-authored and an item is
 *  the agent's. */
function isUserHit(hit: ConversationSearchHit): boolean {
  return hit.entryKind === "block";
}

function better(a: ConversationSearchHit, b: ConversationSearchHit): boolean {
  if (isUserHit(a) !== isUserHit(b)) return isUserHit(a);
  return a.rank < b.rank;
}

/** One best hit per thread, best first. */
export function collapseSearchHits(
  hits: readonly ConversationSearchHit[],
): ConversationSearchHit[] {
  const best = new Map<string, ConversationSearchHit>();
  for (const hit of hits) {
    const current = best.get(hit.threadId);
    if (!current || better(hit, current)) best.set(hit.threadId, hit);
  }
  return [...best.values()].sort((a, b) => {
    if (isUserHit(a) !== isUserHit(b)) return isUserHit(a) ? -1 : 1;
    return a.rank - b.rank;
  });
}
