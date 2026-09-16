// Conversation search helpers: everything about the search palette that can
// live without a DOM or a bridge, so it can be unit-tested.
//
// The store answers each query with ranked hits whose `snippet` is an FTS5
// excerpt with `<mark>` around the matched spans. The renderer never trusts
// that HTML verbatim — matched text is conversation content, so it is escaped
// first and only the mark tags are let back through.

import type { ConversationSearchHit } from "~/types/desktop";

// How long the palette waits after the last keystroke before asking the
// store. Long enough that fast typing issues one query per burst, short
// enough that the list feels live.
export const SEARCH_DEBOUNCE_MS = 250;

// Upper bound the palette ever asks for: the store caps at 100 anyway, and a
// palette shows a handful of groups — more rows are scrolling, not finding.
export const SEARCH_RESULT_LIMIT = 30;

/** A query with nothing searchable in it — the palette answers these locally
 *  with an empty list and never touches the database. */
export function isSearchableQuery(query: string): boolean {
  return query.trim().length > 0;
}

// Escape the snippet, then let exactly the excerpt marks back through. The
// store only ever emits `<mark>` / `</mark>`, but the matched text around them
// is arbitrary conversation content — it may itself contain tags — so the
// escape runs first and the restore matches the escaped shapes.
export function sanitizeSearchSnippet(snippet: string): string {
  return snippet
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}

/** The snippet as plain text (marks stripped) — for aria labels and titles,
 *  where markup cannot render. */
export function plainSnippetText(snippet: string): string {
  return snippet.replace(/<\/?mark>/g, "");
}

export type SearchHitGroup = {
  threadId: string;
  hits: ConversationSearchHit[];
};

/** Collect hits under their thread, keeping the store's rank order both
 *  between groups (a group leads with its best hit) and within them. */
export function groupSearchHits(hits: ConversationSearchHit[]): SearchHitGroup[] {
  const groups: SearchHitGroup[] = [];
  const byThread = new Map<string, SearchHitGroup>();
  for (const hit of hits) {
    const existing = byThread.get(hit.threadId);
    if (existing) {
      existing.hits.push(hit);
      continue;
    }
    const group: SearchHitGroup = { threadId: hit.threadId, hits: [hit] };
    byThread.set(hit.threadId, group);
    groups.push(group);
  }
  return groups;
}

/** Which transcript row the thread view should reveal for a hit. Both kinds
 *  carry it: prompt hits point at their own block, item hits at the assistant
 *  block carrying their turn. Null when the turn has no block yet — the thread
 *  still opens, just without a scroll target. */
export function scrollBlockIdForHit(hit: ConversationSearchHit): string | null {
  return hit.blockId;
}

/** Short label for the hit's kind, shown beside each row. */
export function hitKindLabel(hit: ConversationSearchHit): string {
  return hit.entryKind === "block" ? "Prompt" : "Message";
}

export type SearchStatus = "idle" | "searching" | "ready";

/** Why a search failed, as a displayable sentence. The controller owns the
 *  wording — the palette shows its own line either way, so the bridge's raw
 *  rejection never reaches the template. */
export type SearchFailure = {
  query: string;
  cause: string;
};

export type SearchControllerOptions = {
  /** Debounce window; defaults to SEARCH_DEBOUNCE_MS. */
  delayMs?: number;
  /** Maximum hits per query; defaults to SEARCH_RESULT_LIMIT. */
  limit?: number;
  /** The bridge read. Must resolve stale-safe — the controller ignores every
   *  answer except the latest query's, but the call itself still runs. */
  search: (query: string, limit: number) => Promise<ConversationSearchHit[]>;
  onResults: (query: string, hits: ConversationSearchHit[]) => void;
  onError?: (failure: SearchFailure) => void;
};

/** The palette's handle on a debounced search: submit every keystroke, cancel
 *  when the query is abandoned, dispose with the surface. */
export type SearchController = {
  submit: (query: string) => void;
  cancel: () => void;
  dispose: () => void;
};

/** Debounced, stale-guarded search submission for the palette input.
 *
 *  Every keystroke calls `submit`; the store is only asked once the query has
 *  been still for the delay window, and answers are applied only when they
 *  belong to the latest submitted query — a slow earlier answer can never
 *  overwrite a newer one. Unsearchable input answers empty immediately and
 *  cancels anything in flight. */
export function createSearchController(options: SearchControllerOptions): SearchController {
  const delayMs = options.delayMs ?? SEARCH_DEBOUNCE_MS;
  const limit = options.limit ?? SEARCH_RESULT_LIMIT;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let disposed = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function run(query: string, gen: number): void {
    timer = null;
    if (disposed || gen !== generation) return;
    if (!isSearchableQuery(query)) {
      options.onResults(query, []);
      return;
    }
    void options
      .search(query, limit)
      .then((hits) => {
        if (disposed || gen !== generation) return;
        options.onResults(query, hits);
      })
      .catch(() => {
        if (disposed || gen !== generation) return;
        options.onError?.({ query, cause: "The search failed before it answered." });
      });
  }

  return {
    submit(query: string): void {
      generation += 1;
      const gen = generation;
      clearTimer();
      if (!isSearchableQuery(query)) {
        options.onResults(query, []);
        return;
      }
      timer = setTimeout(() => run(query, gen), delayMs);
    },
    cancel(): void {
      generation += 1;
      clearTimer();
    },
    dispose(): void {
      disposed = true;
      clearTimer();
    },
  };
}
