// Provider status and usage report tools: inspecting installed CLIs, model
// catalogs, reasoning effort tiers, versions, quotas, and token spend.

import type {
  ModelDescriptor,
  ProviderKind,
  ProviderMaintenance,
  ProviderSettingsMap,
  ProviderStatus,
  ProviderUpdateResult,
} from "../../types.js";
import type { ProviderSurfaceSnapshot } from "../../providerCache.js";
import { statusEnabled } from "../../providerHealth.js";
import { assertProviderEnabled } from "../../providerSettings.js";
import { quotaCapableProviders } from "../../quota/index.js";
import type { QuotaCapableProvider, QuotaProviderReport, QuotaWindow } from "../../quota/types.js";
import { formatPercent, formatTokens, formatUsd } from "@kone/protocol/usage-format";
import type { AgentUsageReport, UsageRange } from "../../usage/report.js";
import { compact } from "../helpers.js";
import {
  GetAppProviderStatusInputSchema,
  GetAppUsageReportInputSchema,
  GET_APP_PROVIDER_STATUS_JSON_SCHEMA,
  GET_APP_USAGE_REPORT_JSON_SCHEMA,
  SetAppProviderEnabledInputSchema,
  SET_APP_PROVIDER_ENABLED_JSON_SCHEMA,
  UpdateAppProviderInputSchema,
  UPDATE_APP_PROVIDER_JSON_SCHEMA,
  type GatewayRecord,
  type GetAppProviderStatusInput,
  type GetAppUsageReportInput,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";
import { resolveProject, type ProjectRosterEntry } from "./appProjects.js";

export interface AppProvidersToolOptions {
  readSurface?: () => ProviderSurfaceSnapshot;
  discover?: () => Promise<ProviderStatus[]>;
  listModels?: (provider: ProviderKind) => Promise<ModelDescriptor[]>;
  providerMaintenance?: (options?: {
    checkLatest?: boolean;
    force?: boolean;
  }) => Promise<ProviderMaintenance[]>;
  fetchQuota?: (
    provider: QuotaCapableProvider,
    options?: { allowKeychain?: boolean; force?: boolean },
  ) => Promise<QuotaProviderReport>;
  buildUsage?: (options: {
    range: UsageRange;
    projectPath?: string | null;
    forceRefresh?: boolean;
  }) => Promise<AgentUsageReport>;
  readProjects?: () => readonly ProjectRosterEntry[] | null;
  getProviderSettings?: () => ProviderSettingsMap;
  setProviderEnabled?: (
    provider: ProviderKind,
    enabled: boolean,
  ) => Promise<ProviderSettingsMap> | ProviderSettingsMap;
  updateProvider?: (provider: ProviderKind) => Promise<ProviderUpdateResult>;
}

function resolveProjectPath(
  projects: readonly ProjectRosterEntry[] | null | undefined,
  target: string | undefined,
): string | null {
  if (!target) return null;
  const trimmed = target.trim();
  if (projects && projects.length > 0) {
    try {
      return resolveProject(projects, trimmed).path;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function modelToRecord(model: ModelDescriptor): GatewayRecord {
  const rec: GatewayRecord = {
    id: model.id,
    label: model.label,
  };
  if (model.contextWindowTokens !== undefined) {
    rec.contextWindowTokens = model.contextWindowTokens;
  }
  if (model.reasoningEfforts && model.reasoningEfforts.length > 0) {
    rec.reasoningEfforts = model.reasoningEfforts;
  }
  if (model.defaultReasoningEffort) {
    rec.defaultReasoningEffort = model.defaultReasoningEffort;
  }
  if (model.serviceTiers && model.serviceTiers.length > 0) {
    rec.serviceTiers = model.serviceTiers.map((tier) => ({
      id: tier.id,
      label: tier.label,
      description: tier.description ?? "",
    }));
  }
  if (model.defaultServiceTier) {
    rec.defaultServiceTier = model.defaultServiceTier;
  }
  if (model.contextWindows && model.contextWindows.length > 0) {
    rec.contextWindows = model.contextWindows.map((cw) => ({
      id: cw.id,
      label: cw.label,
      tokens: cw.tokens,
      isDefault: cw.isDefault ?? false,
    }));
  }
  return compact(rec);
}

function windowToRecord(window: QuotaWindow): GatewayRecord {
  const rec: GatewayRecord = {
    id: window.id,
    label: window.label,
    percent: window.percent,
    state: window.state,
    used: {
      number: window.used.number,
      kind: window.used.kind,
      suffix: window.used.suffix ?? "",
    },
  };
  if (window.limit) {
    rec.limit = {
      number: window.limit.number,
      kind: window.limit.kind,
      suffix: window.limit.suffix ?? "",
    };
  }
  if (window.resetsAt) {
    rec.resetsAt = window.resetsAt;
  }
  return compact(rec);
}

export function createAppProviderTools(options: AppProvidersToolOptions): ToolEntry[] {
  // ── 1. app_get_provider_status ─────────────────────────────────────────────
  const statusHandler = async (
    _ctx: GatewayToolContext,
    params: GetAppProviderStatusInput,
  ): Promise<GatewayToolResult> => {
    let statuses: ProviderStatus[] = [];
    let surfaceModels: Partial<Record<ProviderKind, ModelDescriptor[]>> = {};

    if (options.readSurface) {
      const surface = options.readSurface();
      statuses = surface.statuses ?? [];
      surfaceModels = surface.models ?? {};
    }

    if (statuses.length === 0 && options.discover) {
      statuses = await options.discover();
    }

    const filterProvider = params.provider;
    const requested = filterProvider
      ? statuses.filter((s) => s.provider === filterProvider)
      : statuses;

    const checkLatest = params.checkLatest === true;
    const maintenanceMap = new Map<ProviderKind, ProviderMaintenance>();
    if (options.providerMaintenance) {
      try {
        const rows = await options.providerMaintenance({ checkLatest });
        for (const row of rows) {
          maintenanceMap.set(row.provider, row);
        }
      } catch {
        // Maintenance details are best-effort.
      }
    }

    const includeModels = params.includeModels !== false;
    const providerRecords: GatewayRecord[] = [];
    const textLines: string[] = ["### Provider Status\n"];

    for (const status of requested) {
      const maintenance = maintenanceMap.get(status.provider);
      const providerRec: GatewayRecord = {
        provider: status.provider,
        label: status.label,
        available: status.available,
        readiness: status.readiness,
        authStatus: status.authStatus,
        enabled: statusEnabled(status),
      };

      if (status.version) providerRec.version = status.version;
      if (status.authLabel) providerRec.authLabel = status.authLabel;
      if (status.message) providerRec.message = status.message;

      if (maintenance) {
        const maintRec: GatewayRecord = {
          standing: maintenance.standing,
          canUpdate: maintenance.canUpdate,
        };
        if (maintenance.installSource) maintRec.installSource = maintenance.installSource;
        if (maintenance.latestVersion) maintRec.latestVersion = maintenance.latestVersion;
        if (maintenance.updateCommand) maintRec.updateCommand = maintenance.updateCommand;
        providerRec.maintenance = compact(maintRec);
      }

      let models: ModelDescriptor[] = surfaceModels[status.provider] ?? [];
      if (models.length === 0 && options.listModels && status.available) {
        try {
          models = await options.listModels(status.provider);
        } catch {
          models = [];
        }
      }

      if (includeModels && models.length > 0) {
        providerRec.models = models.map(modelToRecord);
      }

      providerRecords.push(compact(providerRec));

      // Markdown line summary
      const availBadge = status.available ? "installed" : "missing";
      const readyBadge = status.readiness === "ready" ? "ready" : status.readiness;
      const ver = status.version ? `v${status.version}` : "version unknown";
      const auth = status.authLabel ? ` (${status.authLabel})` : "";
      const enabledBadge = statusEnabled(status) ? "" : " · disabled in settings";
      textLines.push(
        `- **${status.label}** (\`${status.provider}\`): ${readyBadge} · ${availBadge} · ${ver}${auth}${enabledBadge}`,
      );

      if (maintenance?.standing === "behind" && maintenance.latestVersion) {
        textLines.push(`  - Update available: v${maintenance.latestVersion} via \`${maintenance.updateCommand ?? "update"}\``);
      }

      if (includeModels && models.length > 0) {
        const modelNames = models.map((m) => {
          const effortTag = m.reasoningEfforts && m.reasoningEfforts.length > 0
            ? ` [effort: ${m.reasoningEfforts.join(",")}]`
            : "";
          const tierTag = m.serviceTiers && m.serviceTiers.length > 0
            ? ` [tiers: ${m.serviceTiers.map((t) => t.id).join(",")}]`
            : "";
          return `${m.label || m.id}${effortTag}${tierTag}`;
        });
        textLines.push(`  - Models (${models.length}): ${modelNames.slice(0, 8).join(" · ")}${models.length > 8 ? ` +${models.length - 8} more` : ""}`);
      }
    }

    if (requested.length === 0) {
      textLines.push("No matching providers found on this machine.");
    }

    return {
      content: [{ type: "text", text: textLines.join("\n") }],
      structuredContent: { providers: providerRecords },
    };
  };

  // ── 2. app_get_usage_report ───────────────────────────────────────────────
  const usageHandler = async (
    _ctx: GatewayToolContext,
    params: GetAppUsageReportInput,
  ): Promise<GatewayToolResult> => {
    const range: UsageRange = params.range ?? "7d";
    const projectPath = resolveProjectPath(options.readProjects?.(), params.project);

    let report: AgentUsageReport | null = null;
    if (options.buildUsage) {
      report = await options.buildUsage({ range, projectPath });
    }

    const includeQuota = params.includeQuota !== false;
    const filterProvider = params.provider;
    const activeQuotaReports: QuotaProviderReport[] = [];

    if (includeQuota && options.fetchQuota) {
      const capable = quotaCapableProviders();
      let candidateProviders: readonly QuotaCapableProvider[] = capable;
      if (filterProvider) {
        const match = capable.find((p) => p === filterProvider);
        candidateProviders = match ? [match] : [];
      }

      for (const p of candidateProviders) {
        try {
          const qr = await options.fetchQuota(p);
          if (qr && qr.connection !== "disconnected") {
            activeQuotaReports.push(qr);
          }
        } catch {
          // Quota probes are non-fatal.
        }
      }
    }

    const textLines: string[] = [
      `### Usage & Quota Briefing (${range.toUpperCase()}${projectPath ? ` · ${projectPath}` : " · Global"})\n`,
    ];

    const structuredTotals: GatewayRecord = {};
    const providerSlices: GatewayRecord[] = [];
    const modelSlices: GatewayRecord[] = [];

    if (report) {
      const totals = report.totals;
      structuredTotals.tokens = totals.tokens;
      structuredTotals.costUsd = totals.costUsd;
      structuredTotals.inputTokens = totals.inputTokens;
      structuredTotals.outputTokens = totals.outputTokens;
      structuredTotals.cacheReadTokens = totals.cacheReadTokens;
      structuredTotals.cacheCreationTokens = totals.cacheCreationTokens;
      structuredTotals.reasoningTokens = totals.reasoningTokens;
      structuredTotals.prompts = totals.prompts;
      structuredTotals.threads = totals.threads;

      textLines.push(`**Spend Totals:** ${formatUsd(totals.costUsd)} · ${formatTokens(totals.tokens)} tokens across ${totals.prompts} prompts (${totals.threads} threads)`);
      textLines.push(`- Token breakdown: ${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out · ${formatTokens(totals.cacheReadTokens)} cache read · ${formatTokens(totals.reasoningTokens)} reasoning`);

      const filteredProviders = filterProvider
        ? report.providers.filter((p) => p.provider === filterProvider || p.key === filterProvider)
        : report.providers;

      if (filteredProviders.length > 0) {
        textLines.push("\n**By Provider:**");
        for (const prov of filteredProviders) {
          textLines.push(`- **${prov.label}**: ${formatUsd(prov.costUsd)} · ${formatTokens(prov.tokens)} tokens (${prov.prompts} prompts)`);
          providerSlices.push({
            key: prov.key,
            label: prov.label,
            tokens: prov.tokens,
            costUsd: prov.costUsd,
            prompts: prov.prompts,
          });
        }
      }

      if (report.models.length > 0) {
        const topModels = report.models.slice(0, 5);
        textLines.push("\n**Top Models:**");
        for (const mod of topModels) {
          textLines.push(`- **${mod.label}**: ${formatTokens(mod.tokens)} tokens · ${formatUsd(mod.costUsd)}`);
          modelSlices.push({
            key: mod.key,
            label: mod.label,
            tokens: mod.tokens,
            costUsd: mod.costUsd,
          });
        }
      }
    } else {
      textLines.push("No local usage history recorded for this range.");
    }

    const structuredQuotas: GatewayRecord[] = [];
    if (activeQuotaReports.length > 0) {
      textLines.push("\n**Subscription Quotas & Rate Limits:**");
      for (const qr of activeQuotaReports) {
        const prov = qr.provider;
        const plan = qr.planLabel ? ` (${qr.planLabel})` : "";
        textLines.push(`- **${prov}**${plan}: connection ${qr.connection}`);
        for (const win of qr.windows) {
          const usedPct = win.percent === null ? "n/a" : formatPercent(win.percent);
          const resetNotice = win.resetsAt ? ` · resets at ${win.resetsAt}` : "";
          textLines.push(`  - ${win.label}: ${usedPct} consumed${resetNotice}`);
        }

        const qrRec: GatewayRecord = {
          provider: qr.provider,
          connection: qr.connection,
        };
        if (qr.planLabel) qrRec.planLabel = qr.planLabel;
        if (qr.windows.length > 0) {
          qrRec.windows = qr.windows.map(windowToRecord);
        }
        if (qr.spend.length > 0) {
          qrRec.spend = qr.spend.map((s) => ({
            id: s.id,
            label: s.label,
            dollars: s.dollars,
            tokens: s.tokens,
            estimated: s.estimated,
          }));
        }
        structuredQuotas.push(compact(qrRec));
      }
    }

    const structuredContent: GatewayRecord = {
      range,
      scope: projectPath ? "project" : "global",
      totals: structuredTotals,
      providers: providerSlices,
      models: modelSlices,
    };
    if (projectPath) structuredContent.projectPath = projectPath;
    if (structuredQuotas.length > 0) structuredContent.quotas = structuredQuotas;

    return {
      content: [{ type: "text", text: textLines.join("\n") }],
      structuredContent,
    };
  };

  const setEnabledHandler = async (
    _ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const parsed = SetAppProviderEnabledInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid input: ${parsed.error.message}` }],
        isError: true,
      };
    }

    if (!options.setProviderEnabled) {
      return {
        content: [
          {
            type: "text",
            text: "Cannot change provider settings in this environment (desktop settings hook not wired).",
          },
        ],
        isError: true,
      };
    }

    const { provider, enabled } = parsed.data;
    try {
      await options.setProviderEnabled(provider, enabled);
      const actionWord = enabled ? "enabled" : "disabled";
      return {
        content: [
          {
            type: "text",
            text: `Provider \`${provider}\` has been ${actionWord} across the app.`,
          },
        ],
        structuredContent: {
          provider,
          enabled,
          action: actionWord,
        },
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to set provider ${provider} enabled to ${enabled}: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  };

  const updateHandler = async (
    ctx: GatewayToolContext,
    rawInput: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const parsed = UpdateAppProviderInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `Invalid input: ${parsed.error.message}` }],
        isError: true,
      };
    }

    if (!options.updateProvider) {
      return {
        content: [
          {
            type: "text",
            text: "Cannot update providers in this environment (updater hook not wired).",
          },
        ],
        isError: true,
      };
    }

    const { provider } = parsed.data;
    try {
      assertProviderEnabled(
        options.getProviderSettings ? options.getProviderSettings() : {},
        provider,
      );
    } catch {
      return {
        content: [
          {
            type: "text",
            text: `Cannot update provider \`${provider}\`: provider is disabled in app settings. Enable it first using \`app_set_provider_enabled\`.`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await options.updateProvider(provider);
      const textParts: string[] = [];

      if (ctx.provider === provider) {
        textParts.push(
          `> **Notice**: Updated the provider (\`${provider}\`) currently running this thread. Future turns will use the updated CLI.\n`,
        );
      }

      switch (result.outcome) {
        case "succeeded":
          textParts.push(
            `Successfully updated **${provider}**${
              result.maintenance?.currentVersion ? ` to v${result.maintenance.currentVersion}` : ""
            }.`,
          );
          break;
        case "unchanged":
          textParts.push(
            `**${provider}** is already at the newest version${
              result.maintenance?.currentVersion ? ` (v${result.maintenance.currentVersion})` : ""
            }.`,
          );
          break;
        case "unsupported":
          textParts.push(
            `Update unsupported for **${provider}**: ${result.message ?? "no updater available."}`,
          );
          break;
        case "failed":
          textParts.push(
            `Update failed for **${provider}**: ${result.message ?? "installer returned an error."}`,
          );
          break;
      }

      if (result.output) {
        textParts.push(`\n**Installer transcript:**\n\`\`\`\n${result.output}\n\`\`\``);
      }

      const structured: GatewayRecord = {
        provider,
        outcome: result.outcome,
      };
      if (result.message) structured.message = result.message;
      if (result.output) structured.output = result.output;
      if (result.maintenance?.currentVersion) structured.currentVersion = result.maintenance.currentVersion;
      if (result.maintenance?.latestVersion) structured.latestVersion = result.maintenance.latestVersion;

      return {
        content: [{ type: "text", text: textParts.join("\n") }],
        isError: result.outcome === "failed",
        structuredContent: compact(structured),
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to update provider ${provider}: ${String(error)}`,
          },
        ],
        isError: true,
      };
    }
  };

  return [
    {
      name: "app_get_provider_status",
      description:
        "Inspect installed AI CLI providers, their readiness and authentication status, CLI versions, update availability, and supported model catalogs including reasoning effort tiers and service tiers.",
      inputSchema: GetAppProviderStatusInputSchema,
      jsonSchema: GET_APP_PROVIDER_STATUS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      target: "assistant",
      promptSnippet: "Inspect available AI providers, CLI versions, and model capabilities with reasoning tiers.",
      promptGuidelines: [
        "Call app_get_provider_status to see which providers (Codex, Claude, Cursor, OpenCode, Droid, Antigravity) are installed and authenticated.",
        "Set checkLatest: true only when the user explicitly asks about CLI updates or maintenance, as it performs network checks.",
      ],
      handler: statusHandler,
    },
    {
      name: "app_get_usage_report",
      description:
        "Retrieve token spend, cost estimates, and active subscription rate-limit/quota windows across providers and projects to guide cost- and quota-aware decisions.",
      inputSchema: GetAppUsageReportInputSchema,
      jsonSchema: GET_APP_USAGE_REPORT_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      target: "assistant",
      promptSnippet: "Retrieve daily token spend, costs, and subscription rate-limit windows.",
      promptGuidelines: [
        "Call app_get_usage_report to check token spend and remaining rate-limit quotas before initiating heavy multi-agent workflows.",
        "Use the range parameter ('1d', '7d', '30d') to inspect recent trends or overall spend.",
      ],
      handler: usageHandler,
    },
    {
      name: "app_set_provider_enabled",
      description:
        "Enable or disable an AI provider across the entire app. Disabling a provider blocks turn dispatch, subagent spawning, and background warming for that CLI.",
      inputSchema: SetAppProviderEnabledInputSchema,
      jsonSchema: SET_APP_PROVIDER_ENABLED_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      target: "assistant",
      promptSnippet: "Enable or disable an AI provider across the app.",
      promptGuidelines: [
        "Call app_set_provider_enabled when the user asks to turn off, disable, or re-enable a specific AI provider.",
        "Disabling a provider prevents all child agent spawning, turns, and model fallback chains targeting it.",
      ],
      handler: setEnabledHandler,
    },
    {
      name: "app_update_provider",
      description:
        "Update an AI CLI provider to the latest available version using its detected installation package manager (e.g. npm or brew).",
      inputSchema: UpdateAppProviderInputSchema,
      jsonSchema: UPDATE_APP_PROVIDER_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      target: "assistant",
      promptSnippet: "Update an installed AI CLI provider to the latest version.",
      promptGuidelines: [
        "Call app_update_provider only when the user explicitly asks to update a provider CLI, or confirms an update after an out-of-date notice.",
        "The operation runs the provider's native package manager updater and re-probes available models upon completion.",
      ],
      handler: updateHandler,
    },
  ];
}
