import { describe, expect, test } from "bun:test";

import type { ConversationSearchHit } from "../conversationStoreTypes.js";
import { collapseSearchHits } from "./searchCollapse.js";

const hit = (
  threadId: string,
  entryKind: "block" | "item",
  rank: number,
  at = 1,
): ConversationSearchHit => ({
  threadId,
  entryKind,
  blockId: entryKind === "block" ? `b-${threadId}-${rank}` : null,
  turnId: null,
  itemId: entryKind === "item" ? `i-${threadId}-${rank}` : null,
  at,
  snippet: `${threadId}:${entryKind}:${rank}`,
  rank,
});

describe("collapseSearchHits", () => {
  test("keeps one best hit per thread", () => {
    const collapsed = collapseSearchHits([
      hit("a", "item", 1),
      hit("a", "block", 5),
      hit("b", "block", 2),
    ]);
    expect(collapsed.map((h) => h.threadId).sort()).toEqual(["a", "b"]);
    expect(collapsed).toHaveLength(2);
  });

  test("a user message beats an assistant hit for the same thread", () => {
    const collapsed = collapseSearchHits([hit("a", "item", 1), hit("a", "block", 9)]);
    expect(collapsed[0]?.entryKind).toBe("block");
  });

  test("an imported assistant block is not ranked as a user-authored hit", () => {
    const imported = { ...hit("imported", "block", 1), isUserAuthored: false };
    const user = { ...hit("user", "block", 9), isUserAuthored: true };
    const collapsed = collapseSearchHits([imported, user]);
    expect(collapsed.map((h) => h.threadId)).toEqual(["user", "imported"]);
    expect(collapsed[1]?.isUserAuthored).toBe(false);
  });

  test("within a kind, the lower rank wins", () => {
    const collapsed = collapseSearchHits([hit("a", "block", 9), hit("a", "block", 3)]);
    expect(collapsed[0]?.rank).toBe(3);
  });

  test("user-hit threads come before assistant-only threads", () => {
    const collapsed = collapseSearchHits([hit("assistant-only", "item", 1), hit("user", "block", 8)]);
    expect(collapsed.map((h) => h.threadId)).toEqual(["user", "assistant-only"]);
  });

  test("empty input stays empty", () => {
    expect(collapseSearchHits([])).toEqual([]);
  });
});
