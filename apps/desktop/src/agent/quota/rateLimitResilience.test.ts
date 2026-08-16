import { describe, expect, test } from "bun:test";

import {
  MAX_RATE_LIMIT_COOLDOWN_SECONDS,
  MIN_RATE_LIMIT_COOLDOWN_SECONDS,
  createRateLimitResilience,
} from "./rateLimitResilience.js";
import { percent as percentValue } from "./types.js";
import type { QuotaProviderReport } from "./types.js";

// A fixed epoch keeps every `nowMs` argument (and the cooldown arithmetic
// around it) deterministic — nothing in this module is tested against the
// wall clock.
const NOW = 1_752_000_000_000;

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
    spend: [
      { id: "today", label: "Today", dollars: 4.08, tokens: 1_200_000, estimated: false },
    ],
    trend: [{ date: "2026-07-10", dollars: 4.08, tokens: 1_200_000 }],
    planLabel: "Plus",
    excludedModels: [],
    fetchedAt: NOW,
  };
}

describe("createRateLimitResilience", () => {
  test("enterCooldown after a clean read keeps the last-good report on screen, flagged rateLimited", () => {
    const resilience = createRateLimitResilience();
    const good = connectedReport();
    resilience.rememberLastGood("codex", good);

    const report = resilience.enterCooldown("codex", 60, NOW);

    expect(report.connection).toBe("connected");
    expect(report.rateLimited).toBe(true);
    expect(report.windows).toEqual(good.windows);
    expect(report.spend).toEqual(good.spend);
    expect(report.trend).toEqual(good.trend);
    expect(report.planLabel).toBe("Plus");
    expect(report.message).toContain("retrying in");
  });

  test("enterCooldown with no prior clean read returns an honest transient failure", () => {
    const resilience = createRateLimitResilience();

    const report = resilience.enterCooldown("codex", 60, NOW);

    expect(report.connection).toBe("transientFailure");
    expect(report.rateLimited).toBe(true);
    expect(report.windows).toHaveLength(0);
    expect(report.message).toContain("retrying in");
  });

  test("enterCooldown clamps a huge Retry-After to the max cooldown", () => {
    const resilience = createRateLimitResilience();

    resilience.enterCooldown("codex", 999_999, NOW);

    expect(
      resilience.serveDuringCooldown("codex", NOW + MAX_RATE_LIMIT_COOLDOWN_SECONDS * 1000 - 1),
    ).not.toBeNull();
    expect(
      resilience.serveDuringCooldown("codex", NOW + MAX_RATE_LIMIT_COOLDOWN_SECONDS * 1000 + 1),
    ).toBeNull();
  });

  test("enterCooldown raises a sub-minute Retry-After to the min cooldown", () => {
    const resilience = createRateLimitResilience();

    resilience.enterCooldown("codex", 1, NOW);

    expect(
      resilience.serveDuringCooldown("codex", NOW + MIN_RATE_LIMIT_COOLDOWN_SECONDS * 1000 - 1),
    ).not.toBeNull();
    expect(
      resilience.serveDuringCooldown("codex", NOW + MIN_RATE_LIMIT_COOLDOWN_SECONDS * 1000 + 1),
    ).toBeNull();
  });

  test("a clean read clears an active cooldown", () => {
    const resilience = createRateLimitResilience();

    resilience.enterCooldown("codex", 300, NOW);
    resilience.rememberLastGood("codex", connectedReport());

    expect(resilience.serveDuringCooldown("codex", NOW)).toBeNull();
  });

  test("forget drops the remembered snapshot so a later cooldown can't re-serve it", () => {
    const resilience = createRateLimitResilience();

    resilience.rememberLastGood("codex", connectedReport());
    resilience.forget("codex");

    const report = resilience.enterCooldown("codex", 60, NOW);

    expect(report.connection).toBe("transientFailure");
    expect(report.windows).toHaveLength(0);
  });

  test("reset clears all remembered cooldown state", () => {
    const resilience = createRateLimitResilience();

    resilience.rememberLastGood("codex", connectedReport());
    resilience.enterCooldown("codex", 300, NOW);
    resilience.reset();

    expect(resilience.serveDuringCooldown("codex", NOW)).toBeNull();
  });

  test("maxCooldownSeconds option overrides the default ceiling", () => {
    const resilience = createRateLimitResilience({ maxCooldownSeconds: 120 });

    resilience.enterCooldown("codex", 9999, NOW);

    expect(resilience.serveDuringCooldown("codex", NOW + 119_999)).not.toBeNull();
    expect(resilience.serveDuringCooldown("codex", NOW + 120_001)).toBeNull();
  });
});
