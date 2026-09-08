import { describe, expect, test } from "bun:test";

import type { CompactionRecord } from "~/types/desktop";
import { compactionMarkerLabel, groupCompactionMarkers } from "./compactionMarkers";

function marker(at: number, before: number | null = 48000, after: number | null = 1200): CompactionRecord {
  return { threadId: "t", at, beforeTokens: before, afterTokens: after };
}

describe("groupCompactionMarkers", () => {
  const exchanges = [
    { key: "a", firstAt: 100 },
    { key: "b", firstAt: 200 },
    { key: "c", firstAt: 300 },
  ];

  test("a marker belongs above the first exchange at or after it", () => {
    const grouped = groupCompactionMarkers([marker(150), marker(200)], exchanges);
    expect(grouped.byExchange.get("a")).toBeUndefined();
    expect(grouped.byExchange.get("b")?.length).toBe(2);
    expect(grouped.trailing).toEqual([]);
  });

  test("markers newer than every exchange trail the thread", () => {
    const grouped = groupCompactionMarkers([marker(301)], exchanges);
    expect(grouped.byExchange.size).toBe(0);
    expect(grouped.trailing.length).toBe(1);
  });

  test("unsorted markers settle oldest-first", () => {
    const grouped = groupCompactionMarkers([marker(250), marker(50)], exchanges);
    expect(grouped.byExchange.get("a")?.length).toBe(1);
    expect(grouped.byExchange.get("c")?.length).toBe(1);
  });

  test("an exchange with no known time only hosts by recency", () => {
    const grouped = groupCompactionMarkers(
      [marker(50)],
      [{ key: "x", firstAt: undefined }],
    );
    expect(grouped.byExchange.get("x")?.length).toBe(1);
  });

  test("empty inputs group to nothing", () => {
    const grouped = groupCompactionMarkers([], exchanges);
    expect(grouped.byExchange.size).toBe(0);
    expect(grouped.trailing).toEqual([]);
  });
});

describe("compactionMarkerLabel", () => {
  const clock = (at: number): string => `t${at}`;

  test("counts on both sides read as a range with the time", () => {
    expect(compactionMarkerLabel(marker(1, 48000, 1200), clock)).toBe(
      "Context compacted · 48k → 1.2k · t1",
    );
  });

  test("unknown counts read as a bare fact with the time", () => {
    expect(compactionMarkerLabel(marker(2, null, null), clock)).toBe("Context compacted · t2");
  });

  test("a half-known pair reads as a bare fact, never a half range", () => {
    expect(compactionMarkerLabel(marker(3, 48000, null), clock)).toBe("Context compacted · t3");
  });
});
