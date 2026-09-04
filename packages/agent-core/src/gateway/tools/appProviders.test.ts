import { describe, expect, it } from "bun:test";

import type {
  ModelDescriptor,
  ProviderKind,
  ProviderMaintenance,
  ProviderStatus,
  ProviderUpdateResult,
} from "../../types.js";
import type { QuotaProviderReport } from "../../quota/types.js";
import type { AgentUsageReport } from "../../usage/report.js";
import { createRegistry, type GatewayToolContext } from "../registry.js";
import type { GatewayRecord } from "../schemas.js";
import { createAppProviderTools, type AppProvidersToolOptions } from "./appProviders.js";
import type { ProjectRosterEntry } from "./appProjects.js";

function makeCtx(overrides: Partial<GatewayToolContext> = {}): GatewayToolContext {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    provider: "claudeAgent",
    cwd: process.cwd(),
    requestId: "req-1",
    ...overrides,
  };
}

const MOCK_STATUSES: ProviderStatus[] = [
  {
    provider: "codex",
    label: "Codex",
    available: true,
    authStatus: "logged-in",
    readiness: "ready",
    version: "0.8.0",
    authLabel: "ChatGPT Sign-In",
  },
  {
    provider: "claudeAgent",
    label: "Claude Code",
    available: true,
    authStatus: "logged-in",
    readiness: "ready",
    version: "1.2.0",
    authLabel: "Pro Plan",
  },
  {
    provider: "cursor",
    label: "Cursor",
    available: false,
    authStatus: "logged-out",
    readiness: "not-installed",
    message: "Cursor CLI is not installed on PATH",
  },
];

const MOCK_MODELS = {
  codex: [
    {
      id: "gpt-5",
      label: "GPT-5",
      contextWindowTokens: 128000,
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "fast", label: "Fast Mode" }],
      defaultServiceTier: "fast",
    },
    {
      id: "gpt-4.5",
      label: "GPT-4.5",
      contextWindowTokens: 128000,
    },
  ],
  claudeAgent: [
    {
      id: "claude-3-7-sonnet",
      label: "Claude 3.7 Sonnet",
      contextWindowTokens: 200000,
      contextWindows: [
        { id: "compact", label: "200k", tokens: 200000, isDefault: true },
        { id: "full", label: "1M", tokens: 1000000 },
      ],
    },
  ],
} satisfies Partial<Record<ProviderKind, ModelDescriptor[]>>;

const MOCK_MAINTENANCE: ProviderMaintenance[] = [
  {
    provider: "codex",
    installSource: "npm",
    binary: "codex",
    resolvedPath: "/usr/local/bin/codex",
    realPath: "/usr/local/bin/codex",
    packageName: "@openai/codex",
    currentVersion: "0.8.0",
    latestVersion: "0.9.1",
    latestKnowable: true,
    standing: "behind",
    updateCommand: "npm install -g @openai/codex",
    canUpdate: true,
    checkedAt: 1700000000000,
  },
  {
    provider: "claudeAgent",
    installSource: "npm",
    binary: "claude",
    resolvedPath: "/usr/local/bin/claude",
    realPath: "/usr/local/bin/claude",
    packageName: "@anthropic-ai/claude-code",
    currentVersion: "1.2.0",
    latestVersion: "1.2.0",
    latestKnowable: true,
    standing: "current",
    updateCommand: "npm install -g @anthropic-ai/claude-code",
    canUpdate: true,
    checkedAt: 1700000000000,
  },
];

const MOCK_USAGE_REPORT: AgentUsageReport = {
  generatedAt: 1700000000000,
  range: "7d",
  scope: "global",
  projectPath: null,
  totals: {
    tokens: 1500000,
    inputTokens: 1000000,
    outputTokens: 500000,
    cacheReadTokens: 400000,
    cacheCreationTokens: 100000,
    reasoningTokens: 150000,
    prompts: 42,
    threads: 8,
    costUsd: 12.5,
  },
  days: [],
  models: [
    {
      key: "gpt-5",
      label: "GPT-5",
      tokens: 900000,
      cacheReadTokens: 250000,
      cacheCreationTokens: 50000,
      reasoningTokens: 150000,
      prompts: 25,
      costUsd: 8.0,
    },
    {
      key: "claude-3-7-sonnet",
      label: "Claude 3.7 Sonnet",
      tokens: 600000,
      cacheReadTokens: 150000,
      cacheCreationTokens: 50000,
      reasoningTokens: 0,
      prompts: 17,
      costUsd: 4.5,
    },
  ],
  providers: [
    {
      key: "codex",
      label: "Codex",
      provider: "codex",
      tokens: 900000,
      cacheReadTokens: 250000,
      cacheCreationTokens: 50000,
      reasoningTokens: 150000,
      prompts: 25,
      costUsd: 8.0,
    },
    {
      key: "claudeAgent",
      label: "Claude Code",
      provider: "claudeAgent",
      tokens: 600000,
      cacheReadTokens: 150000,
      cacheCreationTokens: 50000,
      reasoningTokens: 0,
      prompts: 17,
      costUsd: 4.5,
    },
  ],
  projects: [],
};

const MOCK_QUOTA_REPORT: QuotaProviderReport = {
  provider: "claudeAgent",
  connection: "connected",
  planLabel: "Max 20x",
  primary: null,
  windows: [
    {
      id: "5h",
      label: "5-hour rolling",
      used: { number: 45, kind: "percent" },
      limit: { number: 100, kind: "percent" },
      percent: 0.45,
      state: "active",
      resetsAt: "2026-09-04T18:00:00Z",
    },
    {
      id: "7d",
      label: "Weekly limit",
      used: { number: 72, kind: "percent" },
      limit: { number: 100, kind: "percent" },
      percent: 0.72,
      state: "active",
      resetsAt: "2026-09-08T00:00:00Z",
    },
  ],
  spend: [
    { id: "today", label: "Today", dollars: 3.2, tokens: 250000, estimated: false },
  ],
  trend: [],
  unpricedModels: [],
};

const MOCK_PROJECTS: readonly ProjectRosterEntry[] = [
  {
    path: "/Users/dev/Developer/kone",
    name: "kone",
    active: true,
    pinned: true,
    lastOpenedAt: 1700000000000,
  },
  {
    path: "/Users/dev/Developer/site",
    name: "site",
    active: false,
    pinned: false,
    lastOpenedAt: 1699000000000,
  },
];

describe("app_get_provider_status", () => {
  it("inspects all available providers and models", async () => {
    const options: AppProvidersToolOptions = {
      readSurface: () => ({
        version: 1,
        savedAt: Date.now(),
        statuses: MOCK_STATUSES,
        models: MOCK_MODELS,
      }),
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_get_provider_status",
      {},
      "assistant",
    );

    expect(result.isError).toBeFalsy();
    // SAFETY: structuredContent is GatewayRecord containing providers array.
    const providers = result.structuredContent?.providers as GatewayRecord[];
    expect(providers).toHaveLength(3);

    const codex = providers.find((p) => p.provider === "codex");
    expect(codex?.label).toBe("Codex");
    expect(codex?.available).toBe(true);
    expect(codex?.version).toBe("0.8.0");
    // SAFETY: models is an array of GatewayRecord.
    const models = codex?.models as GatewayRecord[];
    expect(models).toHaveLength(2);
    expect(models[0]?.id).toBe("gpt-5");
    expect(models[0]?.reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(models[0]?.defaultReasoningEffort).toBe("medium");

    expect(result.content[0]?.text).toContain("Codex");
    expect(result.content[0]?.text).toContain("Claude Code");
  });

  it("filters to a single provider", async () => {
    const options: AppProvidersToolOptions = {
      readSurface: () => ({
        version: 1,
        savedAt: Date.now(),
        statuses: MOCK_STATUSES,
        models: MOCK_MODELS,
      }),
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_get_provider_status",
      { provider: "claudeAgent" },
      "assistant",
    );

    expect(result.isError).toBeFalsy();
    // SAFETY: structuredContent contains providers array.
    const providers = result.structuredContent?.providers as GatewayRecord[];
    expect(providers).toHaveLength(1);
    expect(providers[0]?.provider).toBe("claudeAgent");
    expect(result.content[0]?.text).toContain("Claude Code");
    expect(result.content[0]?.text).not.toContain("Codex");
  });

  it("respects includeModels: false", async () => {
    const options: AppProvidersToolOptions = {
      readSurface: () => ({
        version: 1,
        savedAt: Date.now(),
        statuses: MOCK_STATUSES,
        models: MOCK_MODELS,
      }),
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_get_provider_status",
      { includeModels: false },
      "assistant",
    );

    // SAFETY: structuredContent contains providers array.
    const providers = result.structuredContent?.providers as GatewayRecord[];
    expect(providers[0]?.models).toBeUndefined();
  });

  it("includes maintenance information when checkLatest is requested", async () => {
    const options: AppProvidersToolOptions = {
      readSurface: () => ({
        version: 1,
        savedAt: Date.now(),
        statuses: MOCK_STATUSES,
        models: MOCK_MODELS,
      }),
      providerMaintenance: async () => MOCK_MAINTENANCE,
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_get_provider_status",
      { checkLatest: true },
      "assistant",
    );

    // SAFETY: structuredContent contains providers array.
    const providers = result.structuredContent?.providers as GatewayRecord[];
    const codex = providers.find((p) => p.provider === "codex");
    // SAFETY: maintenance is GatewayRecord on provider record.
    const maint = codex?.maintenance as GatewayRecord;
    expect(maint.standing).toBe("behind");
    expect(maint.canUpdate).toBe(true);
    expect(maint.latestVersion).toBe("0.9.1");
    expect(result.content[0]?.text).toContain("Update available: v0.9.1");
  });

  it("falls back to discover() when cached surface is empty", async () => {
    let discovered = false;
    const options: AppProvidersToolOptions = {
      readSurface: () => ({
        version: 1,
        savedAt: 0,
        statuses: [],
        models: {},
      }),
      discover: async () => {
        discovered = true;
        return [MOCK_STATUSES[0]!];
      },
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_get_provider_status",
      {},
      "assistant",
    );

    expect(discovered).toBe(true);
    // SAFETY: structuredContent contains providers array.
    const providers = result.structuredContent?.providers as GatewayRecord[];
    expect(providers).toHaveLength(1);
    expect(providers[0]?.provider).toBe("codex");
  });
});

describe("app_get_usage_report", () => {
  it("reports spend totals, token breakdowns, and active quota windows", async () => {
    const options: AppProvidersToolOptions = {
      buildUsage: async () => MOCK_USAGE_REPORT,
      fetchQuota: async (provider) => {
        if (provider === "claudeAgent") return MOCK_QUOTA_REPORT;
        return {
          provider,
          connection: "disconnected",
          planLabel: null,
          primary: null,
          windows: [],
          spend: [],
          trend: [],
          unpricedModels: [],
        };
      },
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_get_usage_report",
      { range: "7d" },
      "assistant",
    );

    expect(result.isError).toBeFalsy();
    // SAFETY: structuredContent contains totals record.
    const totals = result.structuredContent?.totals as GatewayRecord;
    expect(totals.tokens).toBe(1500000);
    expect(totals.costUsd).toBe(12.5);
    expect(totals.prompts).toBe(42);

    // SAFETY: quotas is an array of GatewayRecord.
    const quotas = result.structuredContent?.quotas as GatewayRecord[];
    expect(quotas).toHaveLength(1);
    expect(quotas[0]?.provider).toBe("claudeAgent");
    expect(quotas[0]?.planLabel).toBe("Max 20x");

    // Text formatting
    expect(result.content[0]?.text).toContain("$12.50");
    expect(result.content[0]?.text).toContain("1.50M tokens");
    expect(result.content[0]?.text).toContain("5-hour rolling: 45.0% consumed");
  });

  it("scopes to a project by name", async () => {
    let queriedProject: string | null | undefined = undefined;
    const options: AppProvidersToolOptions = {
      readProjects: () => MOCK_PROJECTS,
      buildUsage: async ({ projectPath }) => {
        queriedProject = projectPath;
        return { ...MOCK_USAGE_REPORT, scope: "project", projectPath };
      },
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_get_usage_report",
      { project: "kone", includeQuota: false },
      "assistant",
    );

    expect(queriedProject).toBe("/Users/dev/Developer/kone");
    expect(result.structuredContent?.projectPath).toBe("/Users/dev/Developer/kone");
    expect(result.structuredContent?.quotas).toBeUndefined();
  });

  it("filters metrics to a single provider", async () => {
    const options: AppProvidersToolOptions = {
      buildUsage: async () => MOCK_USAGE_REPORT,
      fetchQuota: async (provider) => {
        if (provider === "claudeAgent") return MOCK_QUOTA_REPORT;
        throw new Error("unexpected provider query");
      },
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_get_usage_report",
      { provider: "claudeAgent" },
      "assistant",
    );

    // SAFETY: providers is an array of GatewayRecord.
    const providers = result.structuredContent?.providers as GatewayRecord[];
    expect(providers).toHaveLength(1);
    expect(providers[0]?.key).toBe("claudeAgent");
  });
});

describe("app_set_provider_enabled", () => {
  it("disables a provider across the app and records the change", async () => {
    let recordedProvider: ProviderKind | null = null;
    let recordedEnabled: boolean | null = null;
    const options: AppProvidersToolOptions = {
      setProviderEnabled: (provider, enabled) => {
        recordedProvider = provider;
        recordedEnabled = enabled;
        return { [provider]: { enabled } };
      },
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_set_provider_enabled",
      { provider: "codex", enabled: false },
      "assistant",
    );

    expect(result.isError).toBeFalsy();
    expect(recordedProvider).toBe("codex");
    expect(recordedEnabled).toBe(false);
    expect(result.structuredContent?.provider).toBe("codex");
    expect(result.structuredContent?.enabled).toBe(false);
    expect(result.structuredContent?.action).toBe("disabled");
    expect(result.content[0]?.text).toContain("Provider `codex` has been disabled across the app.");
  });

  it("re-enables a provider across the app", async () => {
    let recordedEnabled: boolean | null = null;
    const options: AppProvidersToolOptions = {
      setProviderEnabled: (_provider, enabled) => {
        recordedEnabled = enabled;
        return {};
      },
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_set_provider_enabled",
      { provider: "codex", enabled: true },
      "assistant",
    );

    expect(result.isError).toBeFalsy();
    expect(recordedEnabled).toBe(true);
    expect(result.structuredContent?.enabled).toBe(true);
    expect(result.structuredContent?.action).toBe("enabled");
    expect(result.content[0]?.text).toContain("Provider `codex` has been enabled across the app.");
  });

  it("returns error when setProviderEnabled is not wired", async () => {
    const registry = createRegistry(createAppProviderTools({}));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_set_provider_enabled",
      { provider: "codex", enabled: false },
      "assistant",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("desktop settings hook not wired");
  });
});

describe("app_update_provider", () => {
  it("updates a provider CLI and returns outcome with transcript", async () => {
    const updateResult: ProviderUpdateResult = {
      provider: "codex",
      outcome: "succeeded",
      message: null,
      output: "npm notice ... updated 1 package in 2.1s",
      maintenance: {
        ...MOCK_MAINTENANCE[0]!,
        currentVersion: "0.9.1",
        standing: "current",
      },
      statuses: [],
    };

    const options: AppProvidersToolOptions = {
      updateProvider: async () => updateResult,
      getProviderSettings: () => ({ codex: { enabled: true } }),
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_update_provider",
      { provider: "codex" },
      "assistant",
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.outcome).toBe("succeeded");
    expect(result.structuredContent?.currentVersion).toBe("0.9.1");
    expect(result.content[0]?.text).toContain("Successfully updated **codex** to v0.9.1.");
    expect(result.content[0]?.text).toContain("npm notice ... updated 1 package in 2.1s");
  });

  it("refuses update when target provider is disabled in app settings", async () => {
    let updateCalled = false;
    const options: AppProvidersToolOptions = {
      updateProvider: async (provider) => {
        updateCalled = true;
        return {
          provider,
          outcome: "succeeded",
          message: null,
          maintenance: MOCK_MAINTENANCE[0]!,
          statuses: [],
        };
      },
      getProviderSettings: () => ({ codex: { enabled: false } }),
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_update_provider",
      { provider: "codex" },
      "assistant",
    );

    expect(result.isError).toBe(true);
    expect(updateCalled).toBe(false);
    expect(result.content[0]?.text).toContain("provider is disabled in app settings");
  });

  it("reports failure and transcript when update command fails", async () => {
    const updateResult: ProviderUpdateResult = {
      provider: "codex",
      outcome: "failed",
      message: "npm ERR! code EACCES",
      output: "npm ERR! syscall access\nnpm ERR! Error: EACCES: permission denied",
      maintenance: MOCK_MAINTENANCE[0]!,
      statuses: [],
    };

    const options: AppProvidersToolOptions = {
      updateProvider: async () => updateResult,
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ turnId: null }),
      "app_update_provider",
      { provider: "codex" },
      "assistant",
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.outcome).toBe("failed");
    expect(result.content[0]?.text).toContain("Update failed for **codex**");
    expect(result.content[0]?.text).toContain("permission denied");
  });

  it("includes advisory notice when updating provider of the active turn", async () => {
    const updateResult: ProviderUpdateResult = {
      provider: "claudeAgent",
      outcome: "unchanged",
      message: null,
      maintenance: {
        ...MOCK_MAINTENANCE[1]!,
        currentVersion: "1.2.0",
      },
      statuses: [],
    };

    const options: AppProvidersToolOptions = {
      updateProvider: async () => updateResult,
    };

    const registry = createRegistry(createAppProviderTools(options));
    const result = await registry.call(
      makeCtx({ provider: "claudeAgent", turnId: null }),
      "app_update_provider",
      { provider: "claudeAgent" },
      "assistant",
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("Notice");
    expect(result.content[0]?.text).toContain("currently running this thread");
    expect(result.content[0]?.text).toContain("is already at the newest version");
  });
});

