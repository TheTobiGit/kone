import type { ConversationSearchHit, ConversationSearchOptions } from "../conversationStoreTypes.js";

const SEARCH_CANDIDATE_PAGE_SIZE = 100;

/** Read candidate pages from the bounded store API without confusing its
 *  per-call limit with the total ranked hit count. */
export function fetchSearchCandidates(
  search: (query: string, options?: ConversationSearchOptions) => ConversationSearchHit[],
  query: string,
  candidateCap = 1_000,
): ConversationSearchHit[] {
  const hits: ConversationSearchHit[] = [];
  while (hits.length < candidateCap) {
    const limit = Math.min(SEARCH_CANDIDATE_PAGE_SIZE, candidateCap - hits.length);
    const page = search(query, { limit, offset: hits.length });
    hits.push(...page);
    if (page.length < limit) break;
  }
  return hits;
}

// Thread-level search results. The FTS index returns one row per matching block
// or item, so a single thread can appear many times; a conversation list wants
// one answer per thread, and it wants the user's own words to outrank the
// agent's. This collapses ranked hits to one best per thread:
//
//   - a user-authored message beats assistant hits (including imported
//     assistant blocks) for the same thread;
//   - within the same kind, the lower bm25 rank wins (FTS rank is "smaller is
//     better");
//   - the surviving hits are ordered the same way, so the threads whose title
//     the user's words should inform come first.

/** Whether a hit is the user's own words. Imported assistant messages may use
 *  user-role blocks, so the indexed sender metadata breaks that tie. */
function isUserHit(hit: ConversationSearchHit): boolean {
  return hit.entryKind === "block" && hit.isUserAuthored !== false;
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
