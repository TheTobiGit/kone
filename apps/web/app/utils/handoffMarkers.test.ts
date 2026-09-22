import { describe, expect, test } from "bun:test";

import type { MarkerExchange } from "./compactionMarkers";
import { groupHandoffMarks, handoffMarkVerb, type HandoffMark } from "./handoffMarkers";

function mark(key: string, at: number): HandoffMark {
  return {
    key,
    at,
    kind: "to",
    relation: "handoff",
    threadId: `thread-${key}`,
    label: key,
    brand: "generic",
  };
}

function exchange(key: string, firstAt: number | undefined): MarkerExchange {
  return { key, firstAt };
}

describe("groupHandoffMarks", () => {
  test("a marker sits above the first exchange starting at or after it", () => {
    const grouped = groupHandoffMarks(
      [mark("h1", 150), mark("h2", 350)],
      [exchange("e1", 100), exchange("e2", 200), exchange("e3", 400)],
    );
    expect(grouped.byExchange.get("e2")?.map((m) => m.key)).toEqual(["h1"]);
    expect(grouped.byExchange.get("e3")?.map((m) => m.key)).toEqual(["h2"]);
    expect(grouped.trailing).toEqual([]);
  });

  test("markers newer than every exchange trail the thread", () => {
    const grouped = groupHandoffMarks([mark("h1", 500)], [exchange("e1", 100)]);
    expect(grouped.byExchange.size).toBe(0);
    expect(grouped.trailing.map((m) => m.key)).toEqual(["h1"]);
  });

  test("a marker at the same instant precedes that exchange", () => {
    const grouped = groupHandoffMarks([mark("h1", 200)], [exchange("e1", 200)]);
    expect(grouped.byExchange.get("e1")?.map((m) => m.key)).toEqual(["h1"]);
  });

  test("no exchanges means everything trails", () => {
    const grouped = groupHandoffMarks([mark("h1", 100)], []);
    expect(grouped.trailing.map((m) => m.key)).toEqual(["h1"]);
  });
});

describe("handoffMarkVerb", () => {
  test("a handoff reads as the conversation changing hands", () => {
    expect(handoffMarkVerb({ kind: "from", relation: "handoff" })).toBe("Handed from");
    expect(handoffMarkVerb({ kind: "to", relation: "handoff" })).toBe("Handed to");
  });

  test("a branch reads as the conversation splitting, not moving", () => {
    expect(handoffMarkVerb({ kind: "from", relation: "branch" })).toBe("Forked from");
    expect(handoffMarkVerb({ kind: "to", relation: "branch" })).toBe("Forked to");
  });
});
