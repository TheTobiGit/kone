// Landing on a conversation-search hit: one old row, named by id, revealed once.
//
// Selecting a search result opens its thread and asks the transcript to show
// one old row. The opener and the transcript never meet — the open crosses an
// async history read — so the target waits in the jump state keyed by thread
// until the thread view showing that thread claims it. Claiming consumes the
// target, so the flash fires once: revisiting the thread later reads as a
// revisit, not a second arrival.
//
// The open window mounts only a suffix of a long transcript, so the target
// row is very likely unmounted. Landing mounts everything in hand first; when
// the row still is not there and the store holds an older page, the same
// load-older affordance the "load older turns" button uses pages it in — a
// few pages at most, then the thread opens at its newest rather than spinning
// forever on a row that is gone.
//
// Scroll ownership is single: `scrollTarget` names what owns the scroll next —
// a pending landing, the initial scroll-to-newest, or nothing. The view reads
// it instead of arbitrating a landing flag against the initial-scroll flag.
import { computed, ref } from "vue";
import { takeSearchJumpFor } from "./useSearchJump";

/** How many older pages a landing chases before giving up and opening at the
 *  newest: enough to cross a windowed history, few enough to end. */
export const SEARCH_LANDING_MAX_PAGES = 12;

/** How long the landed row keeps its flash before fading back to normal. */
export const SEARCH_FLASH_MS = 2600;

/** What owns the scroll next. `jump` suppresses the scroll-to-newest until
 *  the landing resolves; `initial` is the ordinary first scroll to the
 *  newest turn. Null means neither is owed (empty thread, or already there). */
export type SearchLandingScrollTarget =
  | { kind: "jump"; blockId: string }
  | { kind: "initial" };

/** What one reveal attempt did. `paging` asked for another older page,
 *  `waiting` is parked on a page already in flight, `exhausted` gave the
 *  target up, `idle` had no target at all. */
export type SearchLandingOutcome =
  | "revealed"
  | "paging"
  | "waiting"
  | "exhausted"
  | "idle";

/** The paging inputs for one reveal attempt — the windowed-history props. */
export type SearchLandingPage = {
  hasOlder: boolean;
  loadingOlder: boolean;
};

export type SearchLandingDeps = {
  /** The scrolled conversation's identity — what the initial scroll is owed once per. */
  threadKey: () => string;
  /** Whether there is nothing to scroll to yet. */
  isEmpty: () => boolean;
  /** The key the initial scroll already ran for, if any. */
  initialDoneFor: () => string | null;
  /** The mounted row for a block id, or null while it is unmounted. */
  findElement: (blockId: string) => Element | null;
  /** Bring a found row into view. Smooth-centered by default. */
  scrollToElement?: (el: Element) => void;
  /** Fetch the next older page — the session's load-older affordance. */
  requestOlderPage: () => void;
  /** Mount everything in hand — the target is old by definition. */
  expandWindow: () => void;
  /** Claim the parked jump target for a thread. Consumes it. */
  takeJump?: (threadId: string) => { blockId: string } | null;
  maxPages?: number;
  flashMs?: number;
};

export function useSearchLanding(deps: SearchLandingDeps) {
  /** The landed-on row id while the landing is unresolved. */
  const pendingJumpBlock = ref<string | null>(null);
  /** The landed row while it flashes. Bound as a class by the view. */
  const searchFlash = ref<string | null>(null);
  /** Older pages requested for the current landing — reset on every claim. */
  const pageAttempts = ref(0);

  const maxPages = deps.maxPages ?? SEARCH_LANDING_MAX_PAGES;
  const flashMs = deps.flashMs ?? SEARCH_FLASH_MS;
  const takeJump = deps.takeJump ?? takeSearchJumpFor;
  const scrollToElement =
    deps.scrollToElement ??
    ((el: Element) => el.scrollIntoView({ behavior: "smooth", block: "center" }));

  /** What owns the scroll next. A pending landing wins over the initial
   *  scroll; the initial scroll is owed once per key on a non-empty thread. */
  const scrollTarget = computed<SearchLandingScrollTarget | null>(() => {
    const pending = pendingJumpBlock.value;
    if (pending) return { kind: "jump", blockId: pending };
    if (deps.isEmpty() || deps.initialDoneFor() === deps.threadKey()) return null;
    return { kind: "initial" };
  });

  /** Drop any landing in progress — the column now shows another thread. */
  function reset(): void {
    pendingJumpBlock.value = null;
    searchFlash.value = null;
    pageAttempts.value = 0;
  }

  /** Claim this thread's parked jump target, if any. Expands the mounted
   *  window and reports whether the caller should look for the row. */
  function claim(threadId: string | null | undefined): boolean {
    if (!threadId) return false;
    const jump = takeJump(threadId);
    if (!jump) return false;
    pageAttempts.value = 0;
    pendingJumpBlock.value = jump.blockId;
    deps.expandWindow();
    return true;
  }

  /** Look for the pending row once. Reveals it, pages for it, waits on a
   *  page already in flight, or gives it up — never more than maxPages
   *  requests for one landing. */
  function reveal(page: SearchLandingPage): SearchLandingOutcome {
    const blockId = pendingJumpBlock.value;
    if (!blockId) return "idle";
    const el = deps.findElement(blockId);
    if (el) {
      pendingJumpBlock.value = null;
      scrollToElement(el);
      searchFlash.value = blockId;
      const flashed = blockId;
      setTimeout(() => {
        if (searchFlash.value === flashed) searchFlash.value = null;
      }, flashMs);
      return "revealed";
    }
    if (page.hasOlder && !page.loadingOlder && pageAttempts.value < maxPages) {
      pageAttempts.value += 1;
      deps.requestOlderPage();
      return "paging";
    }
    if (!page.hasOlder || pageAttempts.value >= maxPages) {
      pendingJumpBlock.value = null;
      return "exhausted";
    }
    return "waiting";
  }

  return { searchFlash, pageAttempts, scrollTarget, reset, claim, reveal };
}
