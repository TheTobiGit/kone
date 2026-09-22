import { describe, expect, test } from "bun:test";
import { ref } from "vue";

import type { ThreadSession } from "~/composables/useAgent";
import type { ForkContext, HandInRecord, ProviderKind, ProviderStatus } from "~/types/desktop";
import type { Pane } from "~/types/studio";
import {
  brandOf,
  buildCompactBySession,
  columnLabel,
  handoffSourceBrand,
  hasPaneKind,
  hasScratchpadPane,
  isHandoff,
  readCompactProps,
  threadHands,
} from "./stripColumnLabels";

// These tests pin the strip's column-chrome reads: the brand mark, the header
// and map labels, the meter's memoized Compact props, and kind presence. The
// template calls them in six places and each call must answer the same way, so
// the promises below are stated as behaviour — a refactor of the helpers can't
// quietly rename a column, grey the wrong insert row, or mint a fresh props
// object per frame without one of these failing.

function threadSession(
  key: string,
  fields: {
    provider?: ProviderKind;
    title?: string;
    sideChat?: boolean;
    userTurn?: boolean;
    forkContext?: ForkContext | null;
  } = {},
) {
  const fake = {
    key,
    provider: ref<ProviderKind>(fields.provider ?? "codex"),
    title: ref<string>(fields.title ?? ""),
    isSideChat: ref<boolean>(fields.sideChat ?? false),
    forkContext: ref<ForkContext | null>(fields.forkContext ?? null),
    blocks: ref<Array<{ role: string }>>(fields.userTurn ? [{ role: "user" }] : []),
    timelineBlocks: ref<Array<{ at: number }>>([]),
    handInRecords: ref<HandInRecord[]>([]),
    busy: ref<boolean>(false),
    queuedTurns: ref<Array<unknown>>([]),
    compacting: ref<boolean>(false),
    compactError: ref<string | null>(null),
    compactThread: () => {},
  };
  // SAFETY: the label helpers read only these fields — the brand/title gates
  // plus the CompactSessionLike refs — and never touch the rest of the live
  // session (turns, drafts, listeners).
  return fake as ThreadSession;
}

function threadPane(id: string, session: ThreadSession | null): Pane {
  return {
    id,
    kind: "thread",
    entry: { id, kind: "thread", anchor: { kind: "thread", threadId: null }, width: 0 },
    session,
  };
}

function terminalPane(id: string): Pane {
  return {
    id,
    kind: "terminal",
    entry: { id, kind: "terminal", anchor: { kind: "terminal", terminalId: null }, width: 0 },
    session: null,
  };
}

function scratchpadPane(id: string): Pane {
  return {
    id,
    kind: "scratchpad",
    entry: { id, kind: "scratchpad", anchor: { kind: "scratchpad", scratchpadId: null }, width: 0 },
    session: null,
  };
}

function statusesFor(provider: ProviderKind): ProviderStatus[] {
  return [
    {
      provider,
      label: "Codex",
      available: true,
      authStatus: "authenticated",
      readiness: "ready",
      supportsThreadCompaction: true,
    },
  ];
}

describe("brandOf", () => {
  test("a thread shows its provider's mark", () => {
    expect(brandOf(threadPane("a", threadSession("k1", { provider: "codex" })))).toBe("gpt");
  });

  test("a thread with no session yet falls back to generic", () => {
    expect(brandOf(threadPane("a", null))).toBe("generic");
  });

  test("a non-thread column never has a brand", () => {
    expect(brandOf(terminalPane("t"))).toBe("generic");
  });

  test("an unmapped provider falls back to generic", () => {
    // SAFETY: every real ProviderKind is mapped, so the fallback is reachable
    // only through a provider id the catalog has never seen.
    const session = threadSession("k1", { provider: "nope" as ProviderKind });
    expect(brandOf(threadPane("a", session))).toBe("generic");
  });
});

describe("isHandoff / handoffSourceBrand", () => {
  function handoffSession(sourceProvider?: ProviderKind) {
    const forkContext: ForkContext = {
      sourceThreadId: "t-src",
      forkPointBlockId: null,
      importedAt: 1000,
      bootstrapStatus: "completed",
      forkKind: "handoff",
    };
    if (sourceProvider) forkContext.sourceProvider = sourceProvider;
    return threadSession("k1", { provider: "claudeAgent", forkContext });
  }

  test("a handoff names its source brand", () => {
    const pane = threadPane("a", handoffSession("codex"));
    expect(isHandoff(pane)).toBe(true);
    expect(handoffSourceBrand(pane)).toBe("gpt");
  });

  test("an ordinary thread is no handoff", () => {
    const pane = threadPane("a", threadSession("k1", { provider: "codex" }));
    expect(isHandoff(pane)).toBe(false);
    expect(handoffSourceBrand(pane)).toBe("generic");
  });

  test("a handoff with no recorded source still reads, markless", () => {
    const pane = threadPane("a", handoffSession());
    expect(isHandoff(pane)).toBe(true);
    expect(handoffSourceBrand(pane)).toBe("generic");
  });
});

describe("columnLabel", () => {
  test("a thread shows its title", () => {
    expect(columnLabel(threadPane("a", threadSession("k1", { title: "Fix the leak" })))).toBe(
      "Fix the leak",
    );
  });

  test("an untouched thread is a New thread", () => {
    expect(columnLabel(threadPane("a", threadSession("k1")))).toBe("New thread");
    expect(columnLabel(threadPane("a", null))).toBe("New thread");
  });

  test("a side chat names its parentage", () => {
    expect(
      columnLabel(threadPane("a", threadSession("k1", { title: "Fix the leak", sideChat: true }))),
    ).toBe("Side chat · Fix the leak");
  });

  test("a non-thread column shows its kind label", () => {
    expect(columnLabel(terminalPane("t"))).toBe("Terminal");
    expect(columnLabel(scratchpadPane("s"))).toBe("Scratchpad");
  });
});

describe("hasPaneKind / hasScratchpadPane", () => {
  test("kind presence is board-wide", () => {
    const panes = [threadPane("a", null), terminalPane("t")];
    expect(hasPaneKind(panes, "terminal")).toBe(true);
    expect(hasPaneKind(panes, "scratchpad")).toBe(false);
    expect(hasPaneKind([], "thread")).toBe(false);
  });

  test("the scratchpad singletons the insert menu", () => {
    expect(hasScratchpadPane([threadPane("a", null)])).toBe(false);
    expect(hasScratchpadPane([threadPane("a", null), scratchpadPane("s")])).toBe(true);
  });
});

describe("buildCompactBySession / readCompactProps", () => {
  test("one entry per attached thread, keyed by session", () => {
    const panes = [
      threadPane("a", threadSession("k1", { userTurn: true })),
      threadPane("b", threadSession("k2")),
      terminalPane("t"),
      threadPane("c", null),
    ];
    const map = buildCompactBySession(panes, statusesFor("codex"));
    expect(map.size).toBe(2);
    expect(map.has("k1")).toBe(true);
    expect(map.has("k2")).toBe(true);
  });

  test("two columns on one session share the entry", () => {
    const panes = [threadPane("a", threadSession("k1")), threadPane("b", threadSession("k1"))];
    expect(buildCompactBySession(panes, []).size).toBe(1);
  });

  test("an unsupported provider still memoizes an (empty) entry", () => {
    const panes = [threadPane("a", threadSession("k1", { userTurn: true }))];
    const map = buildCompactBySession(panes, []);
    expect(map.size).toBe(1);
    expect(readCompactProps(map, "k1")).toEqual({});
  });

  test("a supported provider with a user turn is compactable", () => {
    const panes = [threadPane("a", threadSession("k1", { userTurn: true }))];
    const map = buildCompactBySession(panes, statusesFor("codex"));
    expect(readCompactProps(map, "k1").compactState).toBe("available");
  });

  test("a missing key reads as no props", () => {
    const map = buildCompactBySession([threadPane("a", threadSession("k1"))], []);
    expect(readCompactProps(map, "gone")).toEqual({});
  });
});

/** A session that has changed hands, with a timeline to say which of those
 *  swaps a turn has actually landed under. */
function handInSession(
  records: HandInRecord[],
  blockTimes: number[] = [],
): ThreadSession {
  const fake = {
    key: "k-hand-in",
    provider: ref<ProviderKind>("claudeAgent"),
    title: ref<string>(""),
    isSideChat: ref<boolean>(false),
    forkContext: ref<ForkContext | null>(null),
    blocks: ref<Array<{ role: string }>>([]),
    timelineBlocks: ref(blockTimes.map((at) => ({ at }))),
    handInRecords: ref<HandInRecord[]>(records),
    busy: ref<boolean>(false),
    queuedTurns: ref<Array<unknown>>([]),
    compacting: ref<boolean>(false),
    compactError: ref<string | null>(null),
    compactThread: () => {},
  };
  // SAFETY: threadHands reads only handInRecords and timelineBlocks; the rest
  // stands in for the fields the sibling label helpers touch.
  return fake as ThreadSession;
}

function handIn(from: ProviderKind, to: ProviderKind, at: number): HandInRecord {
  return { threadId: "t1", fromProvider: from, toProvider: to, at };
}

describe("threadHands", () => {
  test("a thread that never changed hands wants the plain single mark", () => {
    expect(threadHands(threadPane("a", threadSession("k1")))).toEqual([]);
  });

  test("a staged swap with nothing sent yet still reads as the old hands", () => {
    // The record exists the moment the provider is picked; no turn has landed
    // under it, so the header must not claim the new hands answered anything.
    const session = handInSession([handIn("opencode", "claudeAgent", 500)], [100, 200]);
    expect(threadHands(threadPane("a", session))).toEqual(["opencode"]);
  });

  test("once a turn lands under the swap both hands read", () => {
    const session = handInSession([handIn("opencode", "claudeAgent", 500)], [100, 600]);
    expect(threadHands(threadPane("a", session))).toEqual(["opencode", "claude"]);
  });

  test("only the swaps that were answered count", () => {
    const session = handInSession(
      [handIn("opencode", "claudeAgent", 300), handIn("claudeAgent", "cursor", 900)],
      [100, 400],
    );
    expect(threadHands(threadPane("a", session))).toEqual(["opencode", "claude"]);
  });

  test("handing back to hands it already sits in does not repeat a mark", () => {
    const session = handInSession(
      [handIn("opencode", "claudeAgent", 300), handIn("claudeAgent", "opencode", 500)],
      [100, 400, 600],
    );
    expect(threadHands(threadPane("a", session))).toEqual(["opencode", "claude", "opencode"]);
  });
});
