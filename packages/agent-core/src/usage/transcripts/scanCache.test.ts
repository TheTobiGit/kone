import { describe, expect, it } from "bun:test";

import { decodeScanCache, encodeScanCache, type ScanCache } from "./scanCache.js";
import type { UsageRecord } from "./transcripts.js";

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    provider: "claude",
    timestampMs: Date.parse("2026-09-28T10:00:00.000Z"),
    model: "claude-opus-5",
    sessionId: "s-1",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 20,
      cacheCreationTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    dedupeKey: "m:r",
    ...overrides,
  };
}

describe("scan cache", () => {
  it("round-trips each record's working directory, and its absence", () => {
    const cache: ScanCache = new Map([
      [
        "/logs/a.jsonl",
        {
          size: 100,
          mtimeMs: 1,
          provider: "claude",
          records: [record({ cwd: "/work/app" }), record({ dedupeKey: "m2:r", cwd: "/work/app" }), record({ dedupeKey: "m3:r" })],
        },
      ],
    ]);

    const encoded = encodeScanCache(cache);
    // The directory is interned once however many records share it.
    expect(encoded.cwds).toEqual(["/work/app"]);

    const records = decodeScanCache(JSON.parse(JSON.stringify(encoded))).get("/logs/a.jsonl")?.records ?? [];
    expect(records.map((r) => r.cwd)).toEqual(["/work/app", "/work/app", undefined]);
  });

  it("drops a cache written before records carried a directory", () => {
    const stale = { version: 2, models: ["m"], sessions: ["s"], files: {} };
    expect(decodeScanCache(stale).size).toBe(0);
  });
});
