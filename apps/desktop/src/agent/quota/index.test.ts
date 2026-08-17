// Integration coverage for the quota registry shell (quota/index.ts): the 60s
// cache, the join-in-flight coalescing, and — the thing this test exists to
// pin — that a provider whose usage endpoint returns 429 keeps its last clean
// numbers on screen during the cooldown instead of blanking to an error row.
//
// The provider module under test is stubbed (mock.module) so no real CLI token
// is read and no network call leaves this process; the shell is imported
// dynamically so the stub is in place first.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";

import { emptyReport, percent as percentValue } from "./types.js";
import type { QuotaProviderReport } from "./types.js";

let mode: "ok" | "ratelimited" | "disconnected" | "networkError" = "ok";
let calls = 0;

// index.ts re-exports opencode.ts, which imports node:sqlite (an
// Electron-runtime built-in this bun can't load) — stand it in for bun:sqlite
// so the shell is importable at all. None of these tests touch OpenCode.
mock.module("node:sqlite", () => ({
  DatabaseSync: Database,
}));

function connectedReport(): QuotaProviderReport {
  return {
    provider: "codex",
    connection: "connected",
    primary: {
      id: "primary",
      label: "Weekly",
      used: percentValue(50),
      limit: percentValue(100),
      percent: 0.5,
      state: "active",
      resetsAt: null,
    },
    windows: [
      {
        id: "primary",
        label: "Weekly",
        used: percentValue(50),
        limit: percentValue(100),
        percent: 0.5,
        state: "active",
        resetsAt: null,
      },
    ],
    spend: [],
    trend: [],
    planLabel: "Plus",
    excludedModels: [],
    fetchedAt: Date.now(),
  };
}

mock.module(fileURLToPath(new URL("./codex.ts", import.meta.url)), () => ({
  fetchCodexQuota: async (_opts: { signal?: AbortSignal }): Promise<{
    report: QuotaProviderReport;
    retryAfterSeconds?: number;
  }> => {
    calls += 1;
    if (mode === "ratelimited") {
      return {
        report: {
          ...emptyReport("codex", "transientFailure", "Codex's usage endpoint is rate-limiting us — backing off."),
          rateLimited: true,
        },
        retryAfterSeconds: 60,
      };
    }
    if (mode === "networkError") {
      // The key difference from `ratelimited`: no `retryAfterSeconds` at all —
      // this is a plain fetch failure, not a formatted 429.
      return {
        report: emptyReport("codex", "transientFailure", "Could not reach Codex's usage endpoint."),
      };
    }
    if (mode === "disconnected") {
      return { report: emptyReport("codex", "disconnected", "No Codex credential found.") };
    }
    return { report: connectedReport() };
  },
}));

const { fetchProviderQuota, resetQuotaStateForTests } = await import("./index.js");

describe("fetchProviderQuota 429 resilience", () => {
  beforeEach(() => {
    resetQuotaStateForTests();
    mode = "ok";
    calls = 0;
  });

  test("a 429 after a clean read keeps the last-good meters on screen, flagged stale", async () => {
    mode = "ok";
    calls = 0;

    const first = await fetchProviderQuota("codex");
    expect(first.connection).toBe("connected");
    expect(first.windows).toHaveLength(1);

    mode = "ratelimited";
    const second = await fetchProviderQuota("codex", { force: true });

    // The whole point: the card must not collapse to an empty error row.
    expect(second.connection).toBe("connected");
    expect(second.windows).toHaveLength(1);
    expect(second.rateLimited).toBe(true);
    expect(second.message).toContain("retrying in");

    // A non-forced read inside the cooldown is served from the remembered
    // snapshot without hitting the endpoint again.
    const before = calls;
    const third = await fetchProviderQuota("codex");
    expect(calls).toBe(before);
    expect(third.connection).toBe("connected");
    expect(third.rateLimited).toBe(true);
  });

  test("a 429 with no prior clean read returns an honest error, not a blank", async () => {
    mode = "ratelimited";
    calls = 0;

    const report = await fetchProviderQuota("codex");
    expect(report.connection).toBe("transientFailure");
    expect(report.rateLimited).toBe(true);
    expect(report.windows).toHaveLength(0);
  });

  test("a disconnected read forgets the remembered snapshot so a later 429 can't serve stale numbers", async () => {
    mode = "ok";
    calls = 0;
    await fetchProviderQuota("codex");

    mode = "disconnected";
    await fetchProviderQuota("codex", { force: true });

    mode = "ratelimited";
    const report = await fetchProviderQuota("codex", { force: true });
    expect(report.connection).toBe("transientFailure");
    expect(report.windows).toHaveLength(0);
  });

  test("a network error after a clean read keeps the last-good meters, flagged stale", async () => {
    mode = "ok";
    calls = 0;

    const first = await fetchProviderQuota("codex");
    expect(first.connection).toBe("connected");
    expect(first.windows).toHaveLength(1);

    mode = "networkError";
    const second = await fetchProviderQuota("codex", { force: true });

    // Same spirit as the 429 case: the card must not collapse to an empty
    // error row, but the flag is `stale` — nothing here says the provider is
    // throttling us.
    expect(second.connection).toBe("connected");
    expect(second.windows).toHaveLength(1);
    expect(second.stale).toBe(true);
    expect(second.rateLimited).toBeFalsy();
    expect(second.message).toContain("Showing the last known numbers");
  });

  test("a network error with no prior clean read returns the honest bare error", async () => {
    mode = "networkError";
    calls = 0;

    const report = await fetchProviderQuota("codex");
    expect(report.connection).toBe("transientFailure");
    expect(report.windows).toHaveLength(0);
    expect(report.stale).toBeFalsy();
  });
});
