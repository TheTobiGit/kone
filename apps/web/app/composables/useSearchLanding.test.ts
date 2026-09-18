import { describe, expect, test } from "bun:test";
import { ref } from "vue";
import {
  SEARCH_FLASH_MS,
  SEARCH_LANDING_MAX_PAGES,
  useSearchLanding,
} from "./useSearchLanding";

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function setup(opts?: { maxPages?: number; flashMs?: number }) {
  // SAFETY: the stand-in only flows into the harness's own scroll recorder,
  // which checks identity and never reads a DOM member off it.
  const element = {} as Element;
  const mounted = new Set<string>();
  const scrolled: Element[] = [];
  let jump: string | null = "block-9";
  const empty = ref(false);
  const doneFor = ref<string | null>(null);
  let expanded = 0;
  let requested = 0;

  const landing = useSearchLanding({
    threadKey: () => "thread-1",
    isEmpty: () => empty.value,
    initialDoneFor: () => doneFor.value,
    findElement: (blockId: string) => (mounted.has(blockId) ? element : null),
    scrollToElement: (el: Element) => {
      scrolled.push(el);
    },
    requestOlderPage: () => {
      requested += 1;
    },
    expandWindow: () => {
      expanded += 1;
    },
    // Consumes like the real jump handoff: the first claim wins, the rest
    // read as revisits.
    takeJump: (threadId: string) => {
      const blockId = jump;
      jump = null;
      return blockId ? { threadId, blockId } : null;
    },
    maxPages: opts?.maxPages,
    flashMs: opts?.flashMs,
  });

  return {
    landing,
    element,
    scrolled,
    stats: () => ({ expanded, requested }),
    parkJump: (blockId: string | null) => {
      jump = blockId;
    },
    mount: (blockId: string) => mounted.add(blockId),
    setEmpty: (value: boolean) => {
      empty.value = value;
    },
    markDone: () => {
      doneFor.value = "thread-1";
    },
  };
}

describe("useSearchLanding — scrollTarget precedence", () => {
  test("a fresh thread owes the initial scroll, an empty or settled one owes nothing", () => {
    const h = setup();
    expect(h.landing.scrollTarget.value).toEqual({ kind: "initial" });
    h.setEmpty(true);
    expect(h.landing.scrollTarget.value).toBeNull();
    h.setEmpty(false);
    h.markDone();
    expect(h.landing.scrollTarget.value).toBeNull();
  });

  test("a claimed jump outranks the initial scroll until it resolves", () => {
    const h = setup();
    expect(h.landing.claim("thread-1")).toBe(true);
    expect(h.landing.scrollTarget.value).toEqual({ kind: "jump", blockId: "block-9" });
    expect(h.stats().expanded).toBe(1);
    h.mount("block-9");
    expect(h.landing.reveal({ hasOlder: true, loadingOlder: false })).toBe("revealed");
    // The view retires the initial scroll on a found row; until it does, the
    // ordinary scroll is owed again rather than the landing.
    expect(h.landing.scrollTarget.value).toEqual({ kind: "initial" });
    h.markDone();
    expect(h.landing.scrollTarget.value).toBeNull();
  });
});

describe("useSearchLanding — claim-once", () => {
  test("the parked target is consumed: a second claim finds nothing", () => {
    const h = setup();
    expect(h.landing.claim("thread-1")).toBe(true);
    expect(h.landing.claim("thread-1")).toBe(false);
    expect(h.landing.scrollTarget.value).toEqual({ kind: "jump", blockId: "block-9" });
    expect(h.stats().expanded).toBe(1);
  });

  test("a missing thread or a missing target claims nothing", () => {
    const h = setup();
    expect(h.landing.claim(null)).toBe(false);
    expect(h.landing.claim(undefined)).toBe(false);
    h.parkJump(null);
    expect(h.landing.claim("thread-1")).toBe(false);
    expect(h.landing.scrollTarget.value).toEqual({ kind: "initial" });
    expect(h.stats().expanded).toBe(0);
  });
});

describe("useSearchLanding — reveal", () => {
  test("a found row scrolls into view and flashes once", async () => {
    const h = setup({ flashMs: 5 });
    h.landing.claim("thread-1");
    h.mount("block-9");
    expect(h.landing.reveal({ hasOlder: true, loadingOlder: false })).toBe("revealed");
    expect(h.scrolled).toEqual([h.element]);
    expect(h.landing.searchFlash.value).toBe("block-9");
    await sleep(25);
    expect(h.landing.searchFlash.value).toBeNull();
    // Nothing pending, so a repeat look is idle rather than a second flash.
    expect(h.landing.reveal({ hasOlder: true, loadingOlder: false })).toBe("idle");
    expect(h.scrolled).toHaveLength(1);
  });

  test("a missing row pages older history up to the cap, then gives up", () => {
    expect(SEARCH_LANDING_MAX_PAGES).toBe(12);
    const h = setup();
    h.landing.claim("thread-1");
    for (let i = 0; i < SEARCH_LANDING_MAX_PAGES; i += 1) {
      expect(h.landing.reveal({ hasOlder: true, loadingOlder: false })).toBe("paging");
    }
    expect(h.stats().requested).toBe(SEARCH_LANDING_MAX_PAGES);
    expect(h.landing.pageAttempts.value).toBe(SEARCH_LANDING_MAX_PAGES);
    expect(h.landing.reveal({ hasOlder: true, loadingOlder: false })).toBe("exhausted");
    expect(h.stats().requested).toBe(SEARCH_LANDING_MAX_PAGES);
    expect(h.landing.scrollTarget.value).toEqual({ kind: "initial" });
  });

  test("a page already in flight parks without spending an attempt", () => {
    const h = setup();
    h.landing.claim("thread-1");
    expect(h.landing.reveal({ hasOlder: true, loadingOlder: true })).toBe("waiting");
    expect(h.stats().requested).toBe(0);
    expect(h.landing.pageAttempts.value).toBe(0);
    expect(h.landing.scrollTarget.value).toEqual({ kind: "jump", blockId: "block-9" });
  });

  test("no older page ends the landing immediately", () => {
    const h = setup();
    h.landing.claim("thread-1");
    expect(h.landing.reveal({ hasOlder: false, loadingOlder: false })).toBe("exhausted");
    expect(h.stats().requested).toBe(0);
    expect(h.landing.scrollTarget.value).toEqual({ kind: "initial" });
  });

  test("reclaiming resets the paging count for the new target", () => {
    const h = setup();
    h.landing.claim("thread-1");
    expect(h.landing.reveal({ hasOlder: true, loadingOlder: false })).toBe("paging");
    expect(h.landing.reveal({ hasOlder: true, loadingOlder: false })).toBe("paging");
    expect(h.landing.pageAttempts.value).toBe(2);
    h.parkJump("block-10");
    expect(h.landing.claim("thread-1")).toBe(true);
    expect(h.landing.pageAttempts.value).toBe(0);
    expect(h.landing.scrollTarget.value).toEqual({ kind: "jump", blockId: "block-10" });
  });

  test("reset drops the landing and its flash", () => {
    const h = setup({ flashMs: 500 });
    h.landing.claim("thread-1");
    h.mount("block-9");
    expect(h.landing.reveal({ hasOlder: false, loadingOlder: false })).toBe("revealed");
    expect(h.landing.searchFlash.value).toBe("block-9");
    h.landing.reset();
    expect(h.landing.searchFlash.value).toBeNull();
    expect(h.landing.pageAttempts.value).toBe(0);
    expect(h.landing.scrollTarget.value).toEqual({ kind: "initial" });
  });

  test("the default flash lasts long enough to read", () => {
    expect(SEARCH_FLASH_MS).toBe(2600);
  });
});
