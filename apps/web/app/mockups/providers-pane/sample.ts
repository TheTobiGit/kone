// Sample world for the providers-pane layout mockups (pages/mockups/providers-pane-*).
// Dev-only: the routes that import this are dropped from production builds (see
// the mockups module in nuxt.config.ts). Built on the dev bridge's own provider
// fixtures, with a few states changed so every card state is on screen.

import type {
  ModelDescriptor,
  ProviderKind,
  ProviderMaintenance,
  ProviderStatus,
  QuotaProviderReport,
  QuotaWindow,
} from "~/types/desktop";
import type { BrandKey } from "~/utils/modelCatalog";
import { PROVIDER_BRAND } from "~/utils/modelPicker";
import { MOCK_MAINTENANCE, MOCK_MODELS, MOCK_STATUSES } from "~/lib/devProviders";

export type MockProviderMeta = {
  label: string;
  vendor: string;
  brand: BrandKey;
  grad: string;
  binary: string | null;
  docs: { href: string; label: string } | null;
};

/** Copied from SettingsProvidersPane's PROVIDER_META (blurbs dropped: unused). */
export const MOCK_META = {
  codex: {
    label: "Codex",
    vendor: "OpenAI",
    brand: PROVIDER_BRAND.codex,
    grad: "linear-gradient(152deg, #14b98d 0%, #0c8a68 100%)",
    binary: "codex",
    docs: { href: "https://platform.openai.com/usage", label: "OpenAI usage" },
  },
  claudeAgent: {
    label: "Claude",
    vendor: "Anthropic",
    brand: PROVIDER_BRAND.claudeAgent,
    grad: "linear-gradient(152deg, #e79269 0%, #cf6238 100%)",
    binary: null,
    docs: { href: "https://docs.anthropic.com", label: "Anthropic limits" },
  },
  cursor: {
    label: "Cursor",
    vendor: "Cursor",
    brand: PROVIDER_BRAND.cursor,
    grad: "linear-gradient(152deg, #4c4c55 0%, #191920 100%)",
    binary: "cursor-agent",
    docs: { href: "https://cursor.com/dashboard", label: "Cursor dashboard" },
  },
  opencode: {
    label: "OpenCode",
    vendor: "OpenCode",
    brand: PROVIDER_BRAND.opencode,
    grad: "linear-gradient(152deg, #4a4642 0%, #201d1d 100%)",
    binary: "opencode",
    docs: { href: "https://opencode.ai/docs", label: "OpenCode docs" },
  },
  droid: {
    label: "Factory Droid",
    vendor: "Factory",
    brand: PROVIDER_BRAND.droid,
    grad: "linear-gradient(152deg, #52525b 0%, #27272a 100%)",
    binary: "droid",
    docs: null,
  },
  antigravity: {
    label: "Antigravity",
    vendor: "Google",
    brand: PROVIDER_BRAND.antigravity,
    grad: "linear-gradient(152deg, #6ea8fe 0%, #4285f4 100%)",
    binary: "agy",
    docs: { href: "https://antigravity.google", label: "Antigravity" },
  },
  cline: {
    label: "Cline",
    vendor: "Cline",
    brand: PROVIDER_BRAND.cline,
    grad: "linear-gradient(152deg, #bd8bfc 0%, #9f58fa 100%)",
    binary: "cline",
    docs: { href: "https://cline.bot", label: "Cline docs" },
  },
} satisfies Record<ProviderKind, MockProviderMeta>;

/** The providers on the mockup's deck, in their default order: the four kone
 *  offers today plus two ACP agents, so navigation is tested past four. */
export const MOCK_ORDER: ProviderKind[] = ["codex", "claudeAgent", "cursor", "opencode", "droid", "cline"];

const base = (p: ProviderKind): ProviderStatus => {
  const s = MOCK_STATUSES.find((x) => x.provider === p);
  if (!s) throw new Error(`no dev status for ${p}`);
  return { ...s };
};

/** Codex is behind, Cursor is signed out, Droid is disabled, Cline isn't installed. */
export const MOCK_STATUS = {
  codex: base("codex"),
  claudeAgent: base("claudeAgent"),
  cursor: { ...base("cursor"), authStatus: "unauthenticated", readiness: "needs-login", authLabel: undefined },
  opencode: base("opencode"),
  droid: { ...base("droid"), readiness: "disabled", enabled: false },
  antigravity: base("antigravity"),
  cline: { ...base("cline"), available: false, authStatus: "unknown", readiness: "not-installed", authLabel: undefined },
} satisfies Record<ProviderKind, ProviderStatus>;

/** Cline isn't installed here, so nothing resolves and no version is read. */
export const MOCK_UPKEEP = {
  ...MOCK_MAINTENANCE,
  cline: {
    ...MOCK_MAINTENANCE.cline,
    resolvedPath: null,
    realPath: null,
    currentVersion: null,
    standing: "unknown",
  },
} satisfies Record<ProviderKind, ProviderMaintenance>;

export const MOCK_MODEL_LIST = {
  codex: MOCK_MODELS.codex,
  claudeAgent: MOCK_MODELS.claudeAgent,
  cursor: MOCK_MODELS.cursor,
  opencode: MOCK_MODELS.opencode,
  droid: MOCK_MODELS.droid,
  cline: [],
  antigravity: MOCK_MODELS.antigravity,
} satisfies Record<ProviderKind, ModelDescriptor[]>;

// ── limits ──────────────────────────────────────────────────────────────────
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function pctWindow(id: string, label: string, p: number, resetH: number): QuotaWindow {
  return {
    id,
    label,
    used: { number: p * 100, kind: "percent" },
    limit: { number: 100, kind: "percent" },
    percent: p,
    state: "active",
    resetsAt: hours(resetH),
  };
}

function report(
  provider: QuotaProviderReport["provider"],
  windows: QuotaWindow[],
  planLabel: string,
): QuotaProviderReport {
  return {
    provider,
    connection: "connected",
    primary: windows[0] ?? null,
    windows,
    spend: [],
    trend: [],
    planLabel,
    excludedModels: [],
    fetchedAt: Date.now(),
  };
}

/** Sample quota reports, keyed by the quota-capable provider they describe. */
export type MockQuotas = { [P in QuotaProviderReport["provider"]]?: QuotaProviderReport };
export const MOCK_QUOTAS = {
  codex: report("codex", [pctWindow("5h", "5-hour", 0.42, 2.5), pctWindow("week", "Weekly", 0.81, 61)], "Plus"),
  claudeAgent: report(
    "claudeAgent",
    [pctWindow("5h", "5-hour", 0.18, 3.2), pctWindow("week", "Weekly", 0.57, 98), pctWindow("opus", "Opus weekly", 0.93, 98)],
    "Max 20x",
  ),
  opencode: report("opencode", [pctWindow("month", "Monthly", 0.34, 240)], "Go"),
} satisfies MockQuotas;

// ── items the pane doesn't have yet (inert in the mockups) ──────────────────

export type MockAccount = { id: string; label: string; detail: string; active: boolean };
export const MOCK_ACCOUNTS = {
  codex: [
    { id: "a1", label: "ChatGPT Plus", detail: "gideon@kone.dev", active: true },
    { id: "a2", label: "ChatGPT Team", detail: "work@acme.co", active: false },
  ],
  claudeAgent: [{ id: "c1", label: "Claude Max", detail: "gideon@kone.dev", active: true }],
  opencode: [{ id: "o1", label: "OpenCode Go", detail: "gideon", active: true }],
  droid: [{ id: "d1", label: "Factory", detail: "API key", active: true }],
  cursor: [],
  antigravity: [],
  cline: [],
} satisfies Record<ProviderKind, MockAccount[]>;

export type MockEnvVar = { name: string; value: string; secret: boolean };
export const MOCK_ENV = {
  codex: [
    { name: "OPENAI_BASE_URL", value: "https://api.openai.com/v1", secret: false },
    { name: "OPENAI_API_KEY", value: "sk-proj-••••••••••••", secret: true },
  ],
  opencode: [{ name: "OPENCODE_CONFIG", value: "~/.config/opencode/kone.json", secret: false }],
  claudeAgent: [],
  cursor: [],
  droid: [],
  antigravity: [],
  cline: [],
} satisfies Record<ProviderKind, MockEnvVar[]>;

/** Each provider's home / config folder. */
export const MOCK_HOME = {
  codex: "~/.codex",
  claudeAgent: "~/.claude",
  cursor: "~/.cursor",
  opencode: "~/.config/opencode",
  droid: "~/.factory",
  cline: "~/.cline",
  antigravity: "~/.gemini/antigravity",
} satisfies Record<ProviderKind, string>;

/** Result of the inline binary-path check. */
export type MockPathCheck = { state: "ok" | "missing"; version: string | null };
export const MOCK_PATH_CHECK = {
  codex: { state: "ok", version: "0.48.0" },
  cursor: { state: "ok", version: "1.2.0" },
  opencode: { state: "ok", version: "1.18.10" },
  droid: { state: "ok", version: null },
  cline: { state: "missing", version: null },
  claudeAgent: null,
  antigravity: { state: "ok", version: "1.0.12" },
} satisfies Record<ProviderKind, MockPathCheck | null>;

/** Last health check per provider. */
export type MockHealth = { state: "ok" | "warn" | "fail"; label: string; checked: string };
export const MOCK_HEALTH = {
  codex: { state: "ok", label: "Healthy", checked: "2 min ago" },
  claudeAgent: { state: "ok", label: "Healthy", checked: "2 min ago" },
  cursor: { state: "warn", label: "Not signed in", checked: "2 min ago" },
  opencode: { state: "ok", label: "Healthy", checked: "2 min ago" },
  droid: { state: "warn", label: "Disabled", checked: "1 h ago" },
  antigravity: { state: "ok", label: "Healthy", checked: "2 min ago" },
  cline: { state: "fail", label: "cline not found", checked: "2 min ago" },
} satisfies Record<ProviderKind, MockHealth>;

/** Custom models the user added by id. */
export const MOCK_CUSTOM_MODELS = {
  opencode: ["openrouter/qwen3-coder-plus"],
  codex: ["o3-pro"],
  claudeAgent: [],
  cursor: [],
  droid: [],
  antigravity: [],
  cline: [],
} satisfies Record<ProviderKind, string[]>;

/** ACP registry entries for "Add agent". */
export type MockRegistryAgent = { id: string; label: string; brand: BrandKey; installed: boolean };
export const MOCK_REGISTRY: MockRegistryAgent[] = [
  { id: "gemini", label: "Gemini CLI", brand: "gemini", installed: false },
  { id: "antigravity", label: "Antigravity", brand: PROVIDER_BRAND.antigravity, installed: false },
  { id: "goose", label: "Goose", brand: "generic", installed: false },
  { id: "droid", label: "Factory Droid", brand: PROVIDER_BRAND.droid, installed: true },
  { id: "cline", label: "Cline", brand: PROVIDER_BRAND.cline, installed: true },
];
