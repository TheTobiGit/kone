// One provider-pane state for every layout mockup, so the three directions show
// the same world and differ only in layout. Mirrors SettingsProvidersPane's own
// derivations (rows, spine signal, card action, readiness, models) over the
// sample data; nothing here writes to a real store.

import { computed, reactive, ref } from "vue";
import type { ModelDescriptor, ProviderKind, ProviderMaintenance, ProviderStatus } from "~/types/desktop";
import { useAgentSettings } from "~/composables/useAgentSettings";
import { deckReadout, pctLabel, type DeckReadout } from "~/components/provider/ProviderDeckLimits.vue";
import { buildModelCatalog, type BrandKey, type ModelOption } from "~/utils/modelCatalog";
import { canSignIn, PROVIDER_LOGIN } from "~/utils/providerLogin";
import {
  MOCK_META,
  MOCK_MODEL_LIST,
  MOCK_ORDER,
  MOCK_QUOTAS,
  MOCK_STATUS,
  MOCK_UPKEEP,
  type MockProviderMeta,
} from "./sample";

export type SpineTone = "problem" | "attention" | "update";
export type SpineSignal = { tone: SpineTone; label: string };

export type MockRow = {
  provider: ProviderKind;
  meta: MockProviderMeta;
  status: ProviderStatus | null;
  upkeep: ProviderMaintenance | null;
  enabled: boolean;
  /** Kept in kone but left out of the model picker. */
  hidden: boolean;
  signal: SpineSignal | null;
  limits: DeckReadout;
};

export type HeroAction =
  | { kind: "update"; label: string }
  | { kind: "signin"; label: string }
  | { kind: "docs"; label: string; href: string }
  | { kind: "toggle"; label: string }
  | { kind: "busy" | "idle"; label: string };

export type ModelRow = {
  key: string;
  label: string;
  brand: BrandKey;
  model: ModelOption;
  contextTokens: number | undefined;
  hidden: boolean;
};

export function hasUpdate(status: ProviderStatus | null, m: ProviderMaintenance | null): boolean {
  return Boolean(m?.standing === "behind" && m.latestKnowable && status?.available);
}

function spineSignal(status: ProviderStatus | null, m: ProviderMaintenance | null): SpineSignal | null {
  if (status) {
    if (status.readiness === "disabled") return null;
    if (status.readiness === "needs-login") return { tone: "attention", label: "not signed in" };
    if (status.readiness !== "ready" && status.readiness !== "not-installed") {
      return { tone: "problem", label: "unavailable" };
    }
  }
  if (hasUpdate(status, m)) return { tone: "update", label: "update available" };
  return null;
}

export function readinessText(status: ProviderStatus | null): string {
  if (!status) return "Checking this machine…";
  switch (status.readiness) {
    case "ready":
      return status.authLabel ?? "Signed in and ready";
    case "needs-login":
      return "Installed, but not signed in";
    case "not-installed":
      return "Not installed on this machine";
    case "disabled":
      return "Disabled across the app";
    default:
      return "Unavailable";
  }
}

export const INSTALL_SOURCE_LABEL: Record<string, string> = {
  npm: "npm (global)",
  bun: "bun (global)",
  pnpm: "pnpm (global)",
  homebrew: "Homebrew",
  native: "the CLI's own channel",
  bundled: "bundled with kone",
  unknown: "unrecognised",
};

/** The limits "space" AgentSettingsLimits reads, seeded with sample reports. */
function useMockLimitsSpace() {
  const space = useAgentSettings(() => null);
  space.quotas.value = { ...MOCK_QUOTAS };
  for (const report of Object.values(MOCK_QUOTAS)) {
    space.credentialPresent.value[report.provider] = true;
  }
  // Cursor has a credential on disk but isn't connected: its card offers Connect.
  space.credentialPresent.value.cursor = true;
  return {
    ...space,
    isConnected: (p: Parameters<typeof space.isConnected>[0]) => p in MOCK_QUOTAS,
  } satisfies ReturnType<typeof useAgentSettings>;
}

export function useMockProvidersPane(initial: ProviderKind = "codex") {
  const order = ref<ProviderKind[]>([...MOCK_ORDER]);
  const selected = ref<ProviderKind>(initial);
  const enabled = reactive<Record<string, boolean>>(
    Object.fromEntries(MOCK_ORDER.map((p) => [p, MOCK_STATUS[p].readiness !== "disabled"])),
  );
  const hiddenProviders = reactive<Record<string, boolean>>({});
  const hiddenModels = reactive<Record<string, boolean>>({ "opencode:big-pickle": true });
  const resumeAtReset = reactive<Record<string, boolean>>({ codex: true, claudeAgent: true });
  const snoozeWhenLimited = reactive<Record<string, boolean>>({});
  const updateChecks = ref(true);
  const space = useMockLimitsSpace();

  const rows = computed<MockRow[]>(() =>
    order.value.map((provider) => {
      const status = MOCK_STATUS[provider];
      const upkeep = MOCK_UPKEEP[provider];
      const quota = space.isReadable(provider) ? space.quotas.value[provider] : null;
      return {
        provider,
        meta: MOCK_META[provider],
        status,
        upkeep,
        enabled: enabled[provider] ?? true,
        hidden: hiddenProviders[provider] ?? false,
        signal: spineSignal(status, upkeep),
        limits: deckReadout(quota),
      };
    }),
  );

  // SAFETY: MOCK_ORDER is a non-empty literal, so rows always has a first row.
  const current = computed<MockRow>(
    () => rows.value.find((r) => r.provider === selected.value) ?? (rows.value[0] as MockRow),
  );

  function select(provider: ProviderKind) {
    selected.value = provider;
  }

  function cardLabel(row: MockRow): string {
    const parts = [row.meta.label];
    if (row.signal) parts.push(row.signal.label);
    if (row.limits.spine) parts.push(`${row.limits.spine.label} ${pctLabel(row.limits.spine)} used`);
    return parts.join(" — ");
  }

  function heroActionFor(row: MockRow): HeroAction {
    const m = row.upkeep;
    if (row.status?.available && m?.canUpdate && m.standing === "behind" && m.latestKnowable) {
      return { kind: "update", label: m.latestVersion ? `Update to ${m.latestVersion}` : "Update" };
    }
    if (row.status?.readiness === "needs-login" && canSignIn(row.provider)) {
      return { kind: "signin", label: "Sign in" };
    }
    if (row.status?.readiness === "not-installed") {
      return row.meta.docs
        ? { kind: "docs", label: `Get ${row.meta.label}`, href: row.meta.docs.href }
        : { kind: "idle", label: "Not installed" };
    }
    return row.enabled
      ? { kind: "toggle", label: "Disable across app" }
      : { kind: "toggle", label: "Enable provider" };
  }

  function heroStatusFor(row: MockRow): string {
    const text = readinessText(row.status);
    if (row.status?.readiness === "ready" && !row.enabled) return `${text} · disabled across app`;
    return text;
  }

  function toggleEnabled(provider: ProviderKind = selected.value) {
    enabled[provider] = !(enabled[provider] ?? true);
  }

  function toggleHidden(provider: ProviderKind = selected.value) {
    hiddenProviders[provider] = !(hiddenProviders[provider] ?? false);
  }

  /** Move a provider one step up (-1) or down (+1) in the order. */
  function move(provider: ProviderKind, by: -1 | 1) {
    const list = [...order.value];
    const i = list.indexOf(provider);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return;
    const a = list[i];
    const b = list[j];
    if (!a || !b) return;
    list[i] = b;
    list[j] = a;
    order.value = list;
  }

  const loginDisplay = computed(() => PROVIDER_LOGIN[current.value.provider]?.display ?? "");

  const modelRows = computed<ModelRow[]>(() => {
    const provider = current.value.provider;
    const descriptors: ModelDescriptor[] = MOCK_MODEL_LIST[provider];
    const byId = new Map(descriptors.map((d) => [d.id, d]));
    return buildModelCatalog(descriptors, provider).map((fam) => {
      const rep = fam.efforts[0]?.modelId ? byId.get(fam.efforts[0].modelId) : undefined;
      return {
        key: fam.key,
        label: fam.label,
        brand: fam.brand,
        model: fam,
        contextTokens: rep?.contextWindowTokens,
        hidden: hiddenModels[`${provider}:${fam.key}`] ?? false,
      };
    });
  });

  const hiddenCount = computed(() => modelRows.value.filter((r) => r.hidden).length);

  const showVendor = computed(() => ["opencode", "cursor", "cline"].includes(current.value.provider));

  function toggleModel(key: string) {
    const k = `${current.value.provider}:${key}`;
    hiddenModels[k] = !(hiddenModels[k] ?? false);
  }

  return {
    order,
    selected,
    rows,
    current,
    select,
    cardLabel,
    heroActionFor,
    heroStatusFor,
    toggleEnabled,
    toggleHidden,
    move,
    loginDisplay,
    modelRows,
    hiddenCount,
    showVendor,
    toggleModel,
    space,
    resumeAtReset: (p: ProviderKind) => resumeAtReset[p] ?? false,
    toggleResumeAtReset: (p: ProviderKind) => {
      resumeAtReset[p] = !(resumeAtReset[p] ?? false);
    },
    snoozeWhenLimited: (p: ProviderKind) => snoozeWhenLimited[p] ?? false,
    toggleSnoozeWhenLimited: (p: ProviderKind) => {
      snoozeWhenLimited[p] = !(snoozeWhenLimited[p] ?? false);
    },
    updateChecks,
  };
}

export type MockProvidersPane = ReturnType<typeof useMockProvidersPane>;
