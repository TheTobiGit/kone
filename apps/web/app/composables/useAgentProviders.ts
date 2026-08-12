import { computed, ref } from "vue";
import type { ModelDescriptor, ProviderKind, ProviderStatus } from "~/types/desktop";
import { peelIpcError } from "~/utils/ipcError";

// Which agent CLIs the user has installed + logged into on this machine. This is
// the "bring your own subscription" surface: kone only *detects* a ready CLI, it
// never holds provider credentials. In `nuxt dev` (no bridge) it falls back to a
// mock so the provider picker stays demoable in the browser.
//
// Module-scope state so every surface that asks about providers shares one probe
// result — discovery shells out to real CLIs, so we don't want it running once
// per component.

const statuses = ref<ProviderStatus[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
let probed = false;

// Prettified model lists, cached per provider at module scope. Populated on the
// first `models()` call (or eagerly by `prepare()` at app open) so entering a
// project reads a warm list instead of re-shelling out to the CLI.
const modelCache = ref<Partial<Record<ProviderKind, ModelDescriptor[]>>>({});
let preparing: Promise<void> | null = null;
let refreshing: Promise<void> | null = null;
let hydrating: Promise<void> | null = null;
let hydrated = false;
/** True once a live probe (not just the disk snapshot) has answered. Surfaces
 *  can use this to tell "these are last-known models" from "these are
 *  confirmed" — the snapshot is trustworthy enough to type against, but a
 *  provider the user logged out of since last launch still reads as ready. */
const confirmed = ref(false);

const MOCK_STATUSES: ProviderStatus[] = [
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
const MOCK_MODELS: Record<ProviderKind, ModelDescriptor[]> = {
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
};

export function useAgentProviders() {
  const ready = computed(() => statuses.value.filter((s) => s.readiness === "ready"));
  const byProvider = (provider: ProviderKind) =>
    computed(() => statuses.value.find((s) => s.provider === provider) ?? null);

  const bridge = () => (import.meta.client ? window.koneDesktop?.agent : undefined);

  /** Probe the machine. Cached after the first successful run unless `force`. */
  async function discover(force = false): Promise<ProviderStatus[]> {
    if (probed && !force) return statuses.value;
    loading.value = true;
    loadError.value = null;
    try {
      const api = bridge();
      statuses.value = api ? await api.discover() : MOCK_STATUSES;
      probed = true;
      confirmed.value = true;
      return statuses.value;
    } catch (error) {
      loadError.value = peelIpcError(error, "Could not check your agent tools");
      return statuses.value;
    } finally {
      loading.value = false;
    }
  }

  /** Models a provider offers (its own `list models` surface). The label is
   *  whatever the CLI's own response called it (Codex's `model/list` returns a
   *  real `displayName` per model) — kone shows that verbatim rather than
   *  re-guessing a name from the id. Cached at module scope after the first
   *  fetch (bypass with `force`). */
  async function models(provider: ProviderKind, force = false): Promise<ModelDescriptor[]> {
    const cached = modelCache.value[provider];
    if (cached && !force) return cached;
    const api = bridge();
    let raw: ModelDescriptor[];
    if (!api) raw = MOCK_MODELS[provider] ?? [];
    else {
      try {
        raw = await api.models(provider);
      } catch {
        raw = [];
      }
    }
    // Only cache a real list — an empty result means the CLI errored or wasn't
    // reachable, and we want the next call to retry rather than serve the miss.
    if (raw.length) modelCache.value = { ...modelCache.value, [provider]: raw };
    return raw;
  }

  /** Seed statuses + catalogs from the main process's disk snapshot. This spawns
   *  no CLI, so it settles in about the time of one IPC round-trip — the whole
   *  point being that a cold launch has real provider and model ids in hand
   *  before the user can finish reaching for the composer. A first-ever run has
   *  nothing cached and resolves to a no-op. Deduped. */
  async function hydrate(): Promise<void> {
    if (hydrated) return;
    if (hydrating) return hydrating;
    hydrating = (async () => {
      const api = bridge();
      if (!api?.surface) {
        // Browser dev (no bridge): the mocks are the snapshot.
        statuses.value = MOCK_STATUSES;
        modelCache.value = { ...MOCK_MODELS };
        probed = true;
        hydrated = true;
        return;
      }
      try {
        const snapshot = await api.surface();
        if (snapshot.statuses.length) {
          statuses.value = snapshot.statuses;
          // Serve the snapshot rather than re-probing on demand; `refresh()`
          // corrects it in the background.
          probed = true;
        }
        const seeded = Object.entries(snapshot.models).filter(([, list]) => list?.length);
        if (seeded.length) {
          modelCache.value = { ...Object.fromEntries(seeded), ...modelCache.value };
        }
      } catch {
        // No snapshot is a soft failure — `refresh()` still has to run.
      } finally {
        hydrated = true;
      }
    })();
    try {
      await hydrating;
    } finally {
      hydrating = null;
    }
  }

  /** Re-probe the machine for real and refresh every installed provider's
   *  catalog, overwriting whatever the snapshot said. Deduped. */
  async function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const api = bridge();
      if (!api?.warm || !api?.surface) {
        const found = await discover(true);
        await Promise.all(found.filter((s) => s.available).map((s) => models(s.provider, true)));
        return;
      }
      // Let the main process do the probing: it dedupes its own warm run (which
      // already started at app launch), so asking here never doubles the CLI
      // spawns, and it writes the result through to the snapshot for next time.
      await api.warm();
      const snapshot = await api.surface();
      if (snapshot.statuses.length) {
        statuses.value = snapshot.statuses;
        probed = true;
        confirmed.value = true;
      }
      const fresh = Object.entries(snapshot.models).filter(([, list]) => list?.length);
      if (fresh.length) modelCache.value = { ...modelCache.value, ...Object.fromEntries(fresh) };
    })();
    try {
      await refreshing;
    } finally {
      refreshing = null;
    }
  }

  /** Make the provider surface usable. Hydrates from disk first and returns as
   *  soon as that lands, kicking the live re-probe off behind it — callers that
   *  `await prepare()` are gating UI on it, and a cold CLI handshake is not
   *  something the user should be made to watch. Only a first-ever run (nothing
   *  cached) actually waits for the probe, because there's nothing else to
   *  show. Deduped — concurrent callers await the same run. */
  async function prepare(): Promise<void> {
    if (preparing) return preparing;
    preparing = (async () => {
      await hydrate();
      if (statuses.value.length) void refresh().catch(() => {});
      else await refresh();
    })();
    try {
      await preparing;
    } finally {
      preparing = null;
    }
  }

  return {
    statuses,
    /** The raw per-provider catalogs, reactive — surfaces that derive from them
     *  (the picker's model list) watch this so a background `refresh()` lands
     *  without a reload. */
    modelCache,
    ready,
    loading,
    loadError,
    confirmed,
    byProvider,
    discover,
    models,
    hydrate,
    refresh,
    prepare,
  };
}
