// The provider side of the dev world: what `nuxt dev` reports as installed,
// which models each provider offers, and how each CLI came to be on the
// machine. Read only by the dev bridge (lib/devBridge), which the dev-only
// plugin loads — nothing here reaches a production build.

import type { ModelDescriptor, ProviderKind, ProviderMaintenance, ProviderStatus } from "~/types/desktop";

export const MOCK_STATUSES: ProviderStatus[] = [
  {
    provider: "codex",
    label: "Codex",
    available: true,
    authStatus: "authenticated",
    readiness: "ready",
    version: "0.48.0",
    authLabel: "ChatGPT Sign-In",
  },
  {
    provider: "claudeAgent",
    label: "Claude",
    available: true,
    authStatus: "authenticated",
    readiness: "ready",
    version: "2.1.0",
    authLabel: "Claude Max",
  },
  {
    provider: "opencode",
    label: "OpenCode",
    available: true,
    authStatus: "authenticated",
    readiness: "ready",
    version: "1.18.10",
    authLabel: "Connected providers",
  },
  {
    provider: "cursor",
    label: "Cursor",
    available: true,
    authStatus: "authenticated",
    readiness: "ready",
    version: "1.2.0",
    authLabel: "Cursor Pro",
  },
  {
    provider: "droid",
    label: "Factory Droid",
    available: true,
    authStatus: "authenticated",
    readiness: "ready",
    authLabel: "Factory account",
  },
  {
    provider: "antigravity",
    label: "Antigravity",
    available: true,
    authStatus: "authenticated",
    readiness: "ready",
    version: "1.0.12",
    authLabel: "Google Sign-In",
  },
];

// Real ids + display names + reasoning efforts, captured live from
// `codex app-server`'s `model/list` — no baked effort suffix, so browser dev
// exercises the same real-per-model ladder buildModelCatalog() builds.
export const MOCK_MODELS = {
  codex: [
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6-Terra",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "fast", label: "Fast", description: "Lower latency, same model" }],
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6-Luna",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4-Mini",
      reasoningEfforts: ["minimal", "low", "medium"],
      defaultReasoningEffort: "low",
    },
  ],
  // Real ids + effort ladders from the Claude Agent SDK's model list
  // (initializationResult().models). Effort is a spawn-time SDK option, so
  // picking a rung restarts the session (see ClaudeAdapter capabilities).
  claudeAgent: [
    {
      id: "claude-opus-5",
      label: "Claude Opus 5",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
      // Fast mode is an Opus-lane capability (Sonnet/Haiku lack it) — a session
      // Setting the adapter toggles live via the SDK's applyFlagSettings.
      serviceTiers: [{ id: "fast", label: "Fast", description: "Lower latency, same model" }],
    },
    {
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
  ],
  // OpenCode is a house of providers: one gateway, many upstream vendors. These
  // are real slugs/names/variants from `opencode models --verbose`, spread across
  // vendors on purpose so the picker's per-model logomarks are exercised in
  // browser-dev (see brandOf in utils/modelCatalog.ts). `mimo-v2.5` and
  // `big-pickle` genuinely report no variants — that's not an omission.
  opencode: [
    {
      id: "opencode-go/gpt-5.6-luna",
      label: "GPT-5.6 Luna (2x usage)",
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "opencode-go/deepseek-v4-flash",
      label: "DeepSeek V4 Flash (New)",
      reasoningEfforts: ["high", "max"],
      defaultReasoningEffort: "high",
    },
    { id: "opencode-go/glm-5.2", label: "GLM-5.2", reasoningEfforts: ["high", "max"], defaultReasoningEffort: "high" },
    { id: "opencode-go/kimi-k3", label: "Kimi K3", reasoningEfforts: ["max"], defaultReasoningEffort: "max" },
    {
      id: "opencode-go/qwen3.7-plus",
      label: "Qwen3.7 Plus",
      reasoningEfforts: ["high", "max"],
      defaultReasoningEffort: "high",
    },
    { id: "opencode-go/minimax-m3", label: "MiniMax-M3", reasoningEfforts: ["none", "thinking"] },
    { id: "opencode-go/mimo-v2.5", label: "MiMo V2.5" },
    {
      id: "opencode-go/grok-4.5",
      label: "Grok 4.5",
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
    { id: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra Free" },
    { id: "opencode/big-pickle", label: "Big Pickle" },
    {
      id: "cerebras/gemma-4-31b",
      label: "Gemma 4 31B IT",
      reasoningEfforts: ["none", "low", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
  ],
  // Cursor is a house of providers too: it re-sells claude/gpt/gemini/grok/kimi
  // and its own `composer-*` family. Real ids/labels from a live
  // `cursor-agent models` list. Effort is a bracketed turn parameter there, so
  // the ladders below mirror what the ACP session actually exposes per model
  // (Claude lane → low…max with high default; GPT lane → none…max with medium).
  // `kimi-k3-high` is the one baked-suffix id, so buildModelCatalog() exercises
  // the suffix path for cursor too. No `contextWindows` yet — the suffix
  // (`context=300k`) rides the id, which the mock leaves off for now.
  cursor: [
    { id: "auto", label: "Auto" },
    {
      id: "composer-2.5",
      label: "Composer 2.5",
      serviceTiers: [{ id: "fast", label: "Fast", description: "Lower latency, same model" }],
    },
    {
      id: "claude-opus-5",
      label: "Claude Opus 5",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
      serviceTiers: [{ id: "fast", label: "Fast", description: "Lower latency, same model" }],
    },
    {
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
    },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "fast", label: "Fast", description: "Lower latency, same model" }],
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "fast", label: "Fast", description: "Lower latency, same model" }],
    },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "fast", label: "Fast", description: "Lower latency, same model" }],
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "gpt-5.3-codex",
      label: "GPT-5.3 Codex",
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "fast", label: "Fast", description: "Lower latency, same model" }],
    },
    {
      id: "grok-4.5",
      label: "Grok 4.5",
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "fast", label: "Fast", description: "Lower latency, same model" }],
    },
    {
      id: "gemini-3.6-flash",
      label: "Gemini 3.6 Flash",
      reasoningEfforts: ["minimal", "low", "medium", "high"],
      defaultReasoningEffort: "high",
    },
    { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
    { id: "kimi-k3-high", label: "Kimi K3 High" },
  ],
  // Factory Droid is NOT a fixed catalog: its model list is fetched at runtime
  // from the user's ~/.factory/settings.json (per-user `custom:*` models), same
  // as every other CLI-backed provider — see `models()`. The one entry below is
  // a browser-dev stand-in ONLY (no bridge → no runtime fetch), illustrative and
  // not authoritative; it deliberately exercises the effort dial with values from
  // droid's accepted set and carries no service-tier / context-window axis.
  droid: [
    {
      id: "custom:default",
      label: "Custom (default)",
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
    },
  ],
  // Antigravity's catalog is discovered live from `agy models` (one row per
  // model/effort combination, collapsed to base models — see the desktop
  // adapter's parseAntigravityModelLines). The entries below mirror that shape
  // as a browser-dev stand-in: display-label ids with real effort ladders.
  antigravity: [
    {
      id: "Gemini 3.5 Flash",
      label: "Gemini 3.5 Flash",
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "Gemini 3.1 Pro",
      label: "Gemini 3.1 Pro",
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
    },
    {
      id: "Claude Sonnet 4.6",
      label: "Claude Sonnet 4.6",
      reasoningEfforts: ["thinking"],
      defaultReasoningEffort: "thinking",
    },
  ],
} satisfies Record<ProviderKind, ModelDescriptor[]>;

/** A plausible spread of install channels, so the maintenance pane's states —
 *  behind, current, self-updating, bundled, unrecognised — are all on screen. */
export const MOCK_MAINTENANCE = {
  codex: {
    provider: "codex",
    installSource: "npm",
    binary: "codex",
    resolvedPath: "/usr/local/bin/codex",
    realPath: "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
    packageName: "@openai/codex",
    currentVersion: "0.48.0",
    latestVersion: "0.52.1",
    latestKnowable: true,
    standing: "behind",
    updateCommand: "npm install -g --prefix /usr/local @openai/codex@latest",
    canUpdate: true,
    checkedAt: Date.now(),
  },
  claudeAgent: {
    provider: "claudeAgent",
    installSource: "bundled",
    binary: null,
    resolvedPath: null,
    realPath: null,
    packageName: "@anthropic-ai/claude-code",
    currentVersion: "2.1.0",
    latestVersion: null,
    latestKnowable: false,
    standing: "unknown",
    updateCommand: null,
    canUpdate: false,
    checkedAt: null,
  },
  cursor: {
    provider: "cursor",
    installSource: "native",
    binary: "cursor-agent",
    resolvedPath: "~/.local/bin/cursor-agent",
    realPath: "~/.local/share/cursor-agent/versions/2026.07.23-e383d2b/cursor-agent",
    packageName: null,
    currentVersion: "1.2.0",
    latestVersion: null,
    latestKnowable: false,
    standing: "unknown",
    updateCommand: "cursor-agent update",
    canUpdate: true,
    checkedAt: null,
  },
  opencode: {
    provider: "opencode",
    installSource: "bun",
    binary: "opencode",
    resolvedPath: "~/.bun/bin/opencode",
    realPath: "~/.bun/install/global/node_modules/opencode-ai/bin/opencode",
    packageName: "opencode-ai",
    currentVersion: "1.18.10",
    latestVersion: "1.18.10",
    latestKnowable: true,
    standing: "current",
    updateCommand: "opencode upgrade --method bun",
    canUpdate: true,
    checkedAt: Date.now(),
  },
  droid: {
    provider: "droid",
    installSource: "unknown",
    binary: "droid",
    resolvedPath: "~/.local/bin/droid",
    realPath: null,
    packageName: "@factory/cli",
    currentVersion: null,
    latestVersion: "0.19.4",
    latestKnowable: true,
    standing: "unknown",
    updateCommand: "droid update",
    canUpdate: true,
    checkedAt: Date.now(),
  },
  antigravity: {
    provider: "antigravity",
    installSource: "unknown",
    binary: "agy",
    resolvedPath: "~/.local/bin/agy",
    realPath: null,
    packageName: null,
    currentVersion: "1.0.12",
    latestVersion: null,
    latestKnowable: false,
    standing: "unknown",
    updateCommand: "agy update",
    canUpdate: true,
    checkedAt: Date.now(),
  },
} satisfies Record<ProviderKind, ProviderMaintenance>;

