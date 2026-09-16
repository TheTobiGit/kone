import { describe, expect, test } from "bun:test";
import type { ConversationSearchHit } from "~/types/desktop";
import {
  createSearchController,
  groupSearchHits,
  hitKindLabel,
  isSearchableQuery,
  plainSnippetText,
  sanitizeSearchSnippet,
  scrollBlockIdForHit,
  type SearchFailure,
} from "./conversationSearch";

function hit(partial: Partial<ConversationSearchHit> & { threadId: string }): ConversationSearchHit {
  return {
    entryKind: "block",
    blockId: "b-1",
    turnId: null,
    itemId: null,
    at: 1,
    snippet: "some … <mark>match</mark> … text",
    rank: -1,
    ...partial,
  };
}

describe("isSearchableQuery", () => {
  test("blank input is not searchable", () => {
    expect(isSearchableQuery("")).toBe(false);
    expect(isSearchableQuery("   ")).toBe(false);
  });
  test("anything with a non-space character is searchable", () => {
    expect(isSearchableQuery("or")).toBe(true);
    expect(isSearchableQuery(" red planet ")).toBe(true);
  });
});

describe("sanitizeSearchSnippet", () => {
  test("keeps the excerpt marks and escapes everything else", () => {
    const out = sanitizeSearchSnippet(`a <mark>match</mark> and <b>bold</b>`);
    expect(out).toBe(`a <mark>match</mark> and &lt;b&gt;bold&lt;/b&gt;`);
  });
  test("neutralises markup inside the matched span itself", () => {
    const out = sanitizeSearchSnippet(`<mark><img src="x" onerror="alert(1)"></mark>`);
    expect(out).toBe(`<mark>&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;</mark>`);
    expect(out.includes("<img")).toBe(false);
  });
  test("escapes ampersands without double-escaping the restored marks", () => {
    const out = sanitizeSearchSnippet(`fish &amp; chips <mark>here</mark>`);
    expect(out).toBe(`fish &amp;amp; chips <mark>here</mark>`);
  });
});

describe("plainSnippetText", () => {
  test("strips the excerpt marks", () => {
    expect(plainSnippetText(`a <mark>match</mark> here`)).toBe(`a match here`);
  });
});

describe("groupSearchHits", () => {
  test("collects hits under their thread in rank order", () => {
    const groups = groupSearchHits([
      hit({ threadId: "t-a", rank: -3 }),
      hit({ threadId: "t-b", rank: -2 }),
      hit({ threadId: "t-a", rank: -1 }),
    ]);
    expect(groups.map((g) => g.threadId)).toEqual(["t-a", "t-b"]);
    expect(groups[0]?.hits.map((h) => h.rank)).toEqual([-3, -1]);
    expect(groups[1]?.hits.length).toBe(1);
  });
  test("empty in, empty out", () => {
    expect(groupSearchHits([])).toEqual([]);
  });
});

describe("scrollBlockIdForHit", () => {
  test("prompt hits jump to their own block", () => {
    expect(scrollBlockIdForHit(hit({ threadId: "t-a", entryKind: "block", blockId: "b-9" }))).toBe(
      "b-9",
    );
  });
  test("item hits jump to the block carrying their turn", () => {
    expect(
      scrollBlockIdForHit(
        hit({ threadId: "t-a", entryKind: "item", blockId: "t::turn-1", itemId: "i-1" }),
      ),
    ).toBe("t::turn-1");
  });
  test("a turn with no block yet has no scroll target", () => {
    expect(
      scrollBlockIdForHit(hit({ threadId: "t-a", entryKind: "item", blockId: null })),
    ).toBeNull();
  });
});

describe("hitKindLabel", () => {
  test("labels blocks as prompts and items as messages", () => {
    expect(hitKindLabel(hit({ threadId: "t-a", entryKind: "block" }))).toBe("Prompt");
    expect(hitKindLabel(hit({ threadId: "t-a", entryKind: "item" }))).toBe("Message");
  });
});

describe("createSearchController", () => {
  test("debounces rapid keystrokes into one search", async () => {
    const seen: string[] = [];
    const results: Array<{ query: string; hits: ConversationSearchHit[] }> = [];
    const controller = createSearchController({
      delayMs: 5,
      search: (query) => {
        seen.push(query);
        return Promise.resolve([]);
      },
      onResults: (query, hits) => {
        results.push({ query, hits });
      },
    });
    controller.submit("r");
    controller.submit("re");
    controller.submit("red");
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual(["red"]);
    expect(results.map((x) => x.query)).toEqual(["red"]);
    controller.dispose();
  });

  test("blank input answers empty without touching the store", async () => {
    let calls = 0;
    const results: ConversationSearchHit[][] = [];
    const controller = createSearchController({
      delayMs: 1,
      search: () => {
        calls += 1;
        return Promise.resolve([hit({ threadId: "t-x" })]);
      },
      onResults: (_query, hits) => {
        results.push(hits);
      },
    });
    controller.submit("something");
    await new Promise((r) => setTimeout(r, 10));
    controller.submit("   ");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    expect(results[results.length - 1]).toEqual([]);
    controller.dispose();
  });

  test("a stale answer never overwrites a newer one", async () => {
    const results: Array<{ query: string; count: number }> = [];
    type ReleaseGate = { release: ((hits: ConversationSearchHit[]) => void) | null };
    const gate: ReleaseGate = { release: null };
    const controller = createSearchController({
      delayMs: 1,
      search: (query) => {
        if (query === "first") {
          return new Promise<ConversationSearchHit[]>((resolve) => {
            gate.release = resolve;
          });
        }
        return Promise.resolve([hit({ threadId: "t-new" })]);
      },
      onResults: (query, hits) => {
        results.push({ query, count: hits.length });
      },
    });
    controller.submit("first");
    await new Promise((r) => setTimeout(r, 10));
    controller.submit("second");
    await new Promise((r) => setTimeout(r, 10));
    gate.release?.([hit({ threadId: "t-stale" }), hit({ threadId: "t-stale-2" })]);
    await new Promise((r) => setTimeout(r, 10));
    expect(results).toEqual([{ query: "second", count: 1 }]);
    controller.dispose();
  });

  test("cancel drops a pending query", async () => {
    let calls = 0;
    const results: string[] = [];
    const controller = createSearchController({
      delayMs: 5,
      search: () => {
        calls += 1;
        return Promise.resolve([]);
      },
      onResults: (query) => {
        results.push(query);
      },
    });
    controller.submit("abandoned");
    controller.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
    expect(results).toEqual([]);
    controller.dispose();
  });

  test("errors surface through onError", async () => {
    const errors: SearchFailure[] = [];
    const controller = createSearchController({
      delayMs: 1,
      search: () => Promise.reject(new Error("db gone")),
      onResults: () => {},
      onError: (failure) => {
        errors.push(failure);
      },
    });
    controller.submit("boom");
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toEqual([{ query: "boom", cause: "The search failed before it answered." }]);
    controller.dispose();
  });
});
