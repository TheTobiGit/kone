import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DROID_HOME_ENV,
  FACTORY_API_KEY_ENV,
  billingWindowOf,
  decodeBillingLimits,
  decodeLegacyUsage,
  detectDroidCredential,
  fetchDroidQuota,
  parseFactoryDotEnvKey,
  planLabelFromAuth,
  resolveFactoryApiKey,
} from "./droid.js";
import type { DroidDeps } from "./droid.js";
import { readSecureFile } from "./security.js";

const NOW = 1_752_000_000_000;

function makeDeps(overrides: Partial<DroidDeps> = {}): DroidDeps {
  return {
    fetch: globalThis.fetch,
    env: {},
    factoryEnvPath: path.join(tmpdir(), "kone-droid-missing-.env"),
    readFile: readSecureFile,
    now: () => NOW,
    ...overrides,
  };
}

describe("Factory API key resolution", () => {
  test("the process env wins when set", async () => {
    const deps = makeDeps({ env: { [FACTORY_API_KEY_ENV]: "fk-env-key" } });
    expect(await resolveFactoryApiKey(deps)).toBe("fk-env-key");
  });

  test("~/.factory/.env is read when the env is empty", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-droid-dotenv-"));
    const envPath = path.join(dir, ".env");
    writeFileSync(envPath, `# comment\nexport FACTORY_API_KEY="fk-from-file"\nOTHER=x\n`, { mode: 0o600 });
    try {
      const deps = makeDeps({ factoryEnvPath: envPath });
      expect(await resolveFactoryApiKey(deps)).toBe("fk-from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parseFactoryDotEnvKey handles export prefixes and quotes", () => {
    expect(parseFactoryDotEnvKey(`FACTORY_API_KEY=fk-1`)).toBe("fk-1");
    expect(parseFactoryDotEnvKey(`export FACTORY_API_KEY='fk-2'`)).toBe("fk-2");
    expect(parseFactoryDotEnvKey(`export FACTORY_API_KEY="fk-3" # trailing`)).toBe("fk-3");
    expect(parseFactoryDotEnvKey(`OTHER_KEY=fk-4\n# FACTORY_API_KEY=fk-5`)).toBeNull();
  });

  test("an unreadable .env reads as no key, not an error", async () => {
    const deps = makeDeps({ factoryEnvPath: "/dev/null/definitely-missing" });
    expect(await resolveFactoryApiKey(deps)).toBeNull();
  });
});

describe("Droid credential detection", () => {
  test("a Factory API key counts as signed in", async () => {
    const deps = makeDeps({ env: { [FACTORY_API_KEY_ENV]: "fk-detected" } });
    expect(await resolveFactoryApiKey(deps)).toBe("fk-detected");
  });

  test("the CLI's device-pairing login files count as signed in", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-droid-home-"));
    writeFileSync(path.join(dir, "auth.v2.file"), "encrypted-bytes");
    process.env[DROID_HOME_ENV] = dir;
    try {
      expect(await detectDroidCredential()).toBe(true);
    } finally {
      delete process.env[DROID_HOME_ENV];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Billing-limits windows", () => {
  test("a live window reports percent used and a seconds-remaining reset", () => {
    const window = billingWindowOf("droid-5h", "5-hour", { usedPercent: 42, secondsRemaining: 3600 }, NOW);
    expect(window).toMatchObject({ id: "droid-5h", percent: 0.42, state: "active" });
    expect(window!.resetsAt).toBe(new Date(NOW + 3600 * 1000).toISOString());
  });

  test("an expired rolling window with stale usage reads as reset (0%)", () => {
    const window = billingWindowOf("droid-5h", "5-hour", { usedPercent: 95, windowEnd: NOW - 1000 }, NOW);
    expect(window).toMatchObject({ percent: 0, state: "notStarted", resetsAt: null });
  });

  test("a windowEnd in the future is the reset time", () => {
    const window = billingWindowOf("droid-weekly", "Weekly", { usedPercent: 12.5, windowEnd: 1_752_600_000_000 }, NOW);
    expect(window!.percent).toBeCloseTo(0.125);
    expect(window!.resetsAt).toBe(new Date(1_752_600_000_000).toISOString());
  });

  test("windowEnd parses seconds, milliseconds and ISO strings", () => {
    const window = billingWindowOf("droid-monthly", "Monthly", { usedPercent: 1, windowEnd: "2026-07-10T00:00:00Z" }, NOW);
    expect(window!.resetsAt).toBe(new Date("2026-07-10T00:00:00Z").toISOString());
  });

  test("a window without usedPercent draws no meter", () => {
    expect(billingWindowOf("droid-5h", "5-hour", { secondsRemaining: 100 }, NOW)).toBeNull();
    expect(billingWindowOf("droid-5h", "5-hour", undefined, NOW)).toBeNull();
  });

  test("decodeBillingLimits builds the standard pool and only a real core pool", () => {
    const payload = {
      usesTokenRateLimitsBilling: true,
      limits: {
        standard: {
          fiveHour: { usedPercent: 10, secondsRemaining: 60 },
          weekly: { usedPercent: 30, secondsRemaining: 60 * 60 * 24 * 3 },
          monthly: { usedPercent: 0 },
        },
      },
    };
    expect(decodeBillingLimits(payload, NOW).map((w) => w.id)).toEqual(["droid-5h", "droid-weekly", "droid-monthly"]);

    const withCore = {
      ...payload,
      limits: {
        ...payload.limits,
        core: {
          fiveHour: { usedPercent: 5, secondsRemaining: 60 },
          weekly: { usedPercent: 2 },
          monthly: { usedPercent: 1 },
        },
      },
    };
    expect(decodeBillingLimits(withCore, NOW).map((w) => w.id)).toEqual([
      "droid-5h",
      "droid-weekly",
      "droid-monthly",
      "droid-core-5h",
      "droid-core-weekly",
      "droid-core-monthly",
    ]);
  });

  test("an empty core pool stays out of the report", () => {
    const payload = {
      limits: {
        standard: { fiveHour: { usedPercent: 1 }, weekly: {}, monthly: {} },
        core: {},
      },
    };
    expect(decodeBillingLimits(payload, NOW).map((w) => w.id)).toEqual(["droid-5h"]);
  });
});

describe("Legacy usage windows", () => {
  test("prefers the API's usedRatio over a local calculation", () => {
    const windows = decodeLegacyUsage(
      {
        usage: {
          endDate: 1_752_604_800_000,
          standard: { userTokens: 1000, totalAllowance: 1000, usedRatio: 0.4 },
        },
      },
      NOW,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ id: "droid-standard", percent: 0.4 });
    expect(windows[0]!.resetsAt).toBe(new Date(1_752_604_800_000).toISOString());
  });

  test("falls back to tokens/allowance when no ratio is present", () => {
    const windows = decodeLegacyUsage(
      { usage: { standard: { userTokens: 250, totalAllowance: 1000 } } },
      NOW,
    );
    expect(windows[0]!.percent).toBeCloseTo(0.25);
  });

  test("an unlimited allowance (past a trillion) draws no meter", () => {
    const windows = decodeLegacyUsage(
      { usage: { standard: { userTokens: 5_000_000, totalAllowance: 1_000_000_000_001 } } },
      NOW,
    );
    expect(windows).toEqual([]);
  });

  test("a missing usage payload draws no meters", () => {
    expect(decodeLegacyUsage({}, NOW)).toEqual([]);
    expect(decodeLegacyUsage(null, NOW)).toEqual([]);
  });
});

describe("Plan label from auth", () => {
  test("a plan name containing 'factory' keeps only the tier", () => {
    const body = {
      organization: {
        name: "Some Org",
        subscription: {
          factoryTier: "pro",
          orbSubscription: { plan: { name: "Factory Pro", id: "plan_x" } },
        },
      },
    };
    expect(planLabelFromAuth(body)).toBe("Factory Pro");
  });

  test("non-factory plan names are appended", () => {
    const body = {
      organization: {
        subscription: {
          factoryTier: "enterprise",
          orbSubscription: { plan: { name: "Scale", id: "plan_x" } },
        },
      },
    };
    expect(planLabelFromAuth(body)).toBe("Factory Enterprise · Scale");
  });

  test("no subscription data means no label", () => {
    expect(planLabelFromAuth({})).toBeNull();
  });
});

describe("fetchDroidQuota", () => {
  function jsonFetch(routes: Record<string, { status: number; body: unknown }>) {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      const route = routes[url];
      if (!route) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  test("a signed-in CLI without a key explains the API-key requirement", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-droid-login-only-"));
    writeFileSync(path.join(dir, "auth.v2.file"), "encrypted");
    process.env[DROID_HOME_ENV] = dir;
    try {
      const { report } = await fetchDroidQuota({});
      expect(report.connection).toBe("disconnected");
      expect(report.message).toContain("Factory API key");
    } finally {
      delete process.env[DROID_HOME_ENV];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rejected key is a terminal failure, not a retry", async () => {
    const deps = makeDeps({
      fetch: jsonFetch({
        "https://app.factory.ai/api/app/auth/me": { status: 401, body: {} },
      }),
      env: { [FACTORY_API_KEY_ENV]: "fk-bad" },
    });
    const { report } = await fetchDroidQuota({ deps });
    expect(report.connection).toBe("terminalFailure");
  });

  test("billing-limits billing drives the report; the usage endpoint is untouched", async () => {
    let usageCalled = false;
    const fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/app/auth/me")) {
        return new Response(JSON.stringify({ userProfile: { id: "user_1" }, organization: { subscription: { factoryTier: "pro" } } }), { status: 200 });
      }
      if (url.includes("/api/billing/limits")) {
        return new Response(JSON.stringify({
          usesTokenRateLimitsBilling: true,
          limits: {
            standard: {
              fiveHour: { usedPercent: 20, secondsRemaining: 60 },
              weekly: { usedPercent: 40, secondsRemaining: 60 * 60 * 24 },
              monthly: {},
            },
          },
        }), { status: 200 });
      }
      if (url.includes("/api/organization/subscription/usage")) {
        usageCalled = true;
        return new Response(JSON.stringify({ usage: {} }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const deps = makeDeps({ fetch, env: { [FACTORY_API_KEY_ENV]: "fk-ok" } });
    const { report } = await fetchDroidQuota({ deps });
    expect(report.connection).toBe("connected");
    expect(report.windows.map((w) => w.id)).toEqual(["droid-5h", "droid-weekly"]);
    expect(report.primary!.id).toBe("droid-weekly");
    expect(report.planLabel).toBe("Factory Pro");
    expect(usageCalled).toBe(false);
  });

  test("falls back to the legacy usage endpoint without token-rate-limit billing", async () => {
    const deps = makeDeps({
      fetch: jsonFetch({
        "https://app.factory.ai/api/app/auth/me": { status: 200, body: { userProfile: { id: "user_1" } } },
        "https://api.factory.ai/api/billing/limits": { status: 200, body: { usesTokenRateLimitsBilling: false } },
        "https://api.factory.ai/api/organization/subscription/usage?useCache=true&userId=user_1": {
          status: 200,
          body: { usage: { endDate: 1_752_604_800_000, standard: { userTokens: 100, totalAllowance: 1000 } } },
        },
      }),
      env: { [FACTORY_API_KEY_ENV]: "fk-ok" },
    });
    const { report } = await fetchDroidQuota({ deps });
    expect(report.connection).toBe("connected");
    expect(report.windows.map((w) => w.id)).toEqual(["droid-standard"]);
    expect(report.windows[0]!.percent).toBeCloseTo(0.1);
  });
});
