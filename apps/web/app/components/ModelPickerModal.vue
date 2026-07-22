<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion } from "motion-v";
import ProviderLogo from "~/components/ProviderLogo.vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon, FlashIcon, StarIcon, Settings02Icon } from "@hugeicons/core-free-icons";
import { EFFORT_META, type BrandKey, type EffortTier, type ModelOption } from "~/utils/modelCatalog";

// The model picker — a persistent left rail of providers next to a masked model
// list, wearing the same shell as our folder/location picker: a scrim + an
// elastic card anchored bottom-right. Click a provider to swap the list; click a
// model to select it outright — reasoning effort lives entirely in the
// composer's own brain-stack control (AgentComposer.vue), never here.
//
// Antigravity is the ACTUAL provider (its models come straight from the live
// catalog); the others are demo data so the shape of a multi-provider world is
// visible. Picking under a demo provider only focuses it (a quiet checkmark) —
// it can't apply, keeping the bring-your-own-subscription rule intact.

const props = defineProps<{
  /** The real Antigravity catalog (families with real efforts). */
  models: ModelOption[];
  /** The active raw model id (carries the effort) — marked as current. */
  modelId?: string;
}>();

const emit = defineEmits<{
  /** Commit a model + close the picker. */
  select: [id: string];
  /** Live-apply a tweak (reasoning effort) without closing — rides straight to
   *  the composer input so the setting takes effect and sticks as you adjust. */
  apply: [id: string];
  cancel: [];
}>();

// ── data model ────────────────────────────────────────────────────────────────
// Efforts still carry a tier (used to pick a sane default effort per model) but
// nothing display-y — the reasoning UI lives in the composer, not here.
type MEffort = { id: string; tier: EffortTier };
type MModel = {
  key: string;
  label: string;
  brand: BrandKey;
  vendor: string;
  efforts: MEffort[];
  /** Index into `efforts` a plain model click resolves to. */
  defaultEffortIndex: number;
  /**
   * Only set for rows shown under Favorites: the provider this favourite was
   * starred from. Its `ready` overrides the (pseudo) Favorites provider so a
   * favourited Antigravity model can still apply while a demo one stays
   * preview-only.
   */
  origin?: { label: string; ready: boolean };
};
type MProvider = {
  id: string;
  label: string;
  sub: string;
  brand: BrandKey;
  ready: boolean;
  models: MModel[];
  /**
   * A harness re-serves models from several vendors (Cursor, Copilot, …). When
   * one is selected the picker shows a top header of its vendors; the list then
   * filters to the chosen vendor. Non-harness providers skip the header.
   */
  harness?: boolean;
};

function effort(tier: EffortTier, id: string): MEffort {
  return { id, tier };
}
// Mirrors modelCatalog's rule: prefer the medium tier as the resting effort,
// else the middle of the ladder.
function pickDefaultEffortIndex(efforts: MEffort[]): number {
  const i = efforts.findIndex((e) => e.tier === "medium");
  return i >= 0 ? i : Math.floor((efforts.length - 1) / 2);
}
function demoModel(key: string, label: string, brand: BrandKey, vendor: string, efforts: MEffort[]): MModel {
  return { key, label, brand, vendor, efforts, defaultEffortIndex: pickDefaultEffortIndex(efforts) };
}

// Antigravity — the real thing, mapped from the live catalog.
const antigravity = computed<MProvider>(() => ({
  id: "antigravity",
  label: "Antigravity",
  sub: `Google · ${props.models.length} models`,
  brand: "antigravity",
  ready: true,
  models: props.models.map((o) => ({
    key: o.key,
    label: o.label,
    brand: o.brand,
    vendor: o.vendor,
    efforts: o.efforts.map((e) => ({ id: e.id, tier: e.tier })),
    defaultEffortIndex: o.defaultEffortIndex,
  })),
}));

// The rest — demo data, so the multi-provider shape reads. Ids are prefixed so
// they can never collide with (or be mistaken for) a real Antigravity id.
const DEMO: MProvider[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    sub: "Anthropic · Demo",
    brand: "claude",
    ready: false,
    models: [
      demoModel("demo-cc-fable", "Claude Fable 5", "claude", "Anthropic", [effort("thinking", "demo:cc-fable")]),
      demoModel("demo-cc-opus", "Claude Opus 4.8", "claude", "Anthropic", [effort("thinking", "demo:cc-opus")]),
      demoModel("demo-cc-sonnet", "Claude Sonnet 5", "claude", "Anthropic", [effort("thinking", "demo:cc-sonnet")]),
      demoModel("demo-cc-haiku", "Claude Haiku 4.5", "claude", "Anthropic", [effort("base", "demo:cc-haiku")]),
      demoModel("demo-cc-opus46", "Claude Opus 4.6", "claude", "Anthropic", [effort("thinking", "demo:cc-opus46")]),
      demoModel("demo-cc-sonnet46", "Claude Sonnet 4.6", "claude", "Anthropic", [effort("thinking", "demo:cc-sonnet46")]),
    ],
  },
  {
    id: "factory-droid",
    label: "Factory Droid",
    sub: "Factory · Demo",
    brand: "factory",
    ready: false,
    // Factory's Droid is itself multi-vendor (+ BYOK); its built-in roster.
    models: [
      demoModel("demo-fd-fable", "Claude Fable 5", "claude", "Anthropic", [effort("high", "demo:fd-fable")]),
      demoModel("demo-fd-opus", "Claude Opus 4.8", "claude", "Anthropic", [effort("high", "demo:fd-opus")]),
      demoModel("demo-fd-opus47", "Claude Opus 4.7", "claude", "Anthropic", [effort("high", "demo:fd-opus47")]),
      demoModel("demo-fd-opus46", "Claude Opus 4.6", "claude", "Anthropic", [effort("high", "demo:fd-opus46")]),
      demoModel("demo-fd-sonnet", "Claude Sonnet 4.6", "claude", "Anthropic", [effort("high", "demo:fd-sonnet")]),
      demoModel("demo-fd-sonnet45", "Claude Sonnet 4.5", "claude", "Anthropic", [effort("high", "demo:fd-sonnet45")]),
      demoModel("demo-fd-haiku", "Claude Haiku 4.5", "claude", "Anthropic", [effort("high", "demo:fd-haiku")]),
      demoModel("demo-fd-gpt-sol", "GPT-5.6 Sol", "gpt", "OpenAI", [effort("high", "demo:fd-gpt-sol")]),
      demoModel("demo-fd-gpt-terra", "GPT-5.6 Terra", "gpt", "OpenAI", [effort("medium", "demo:fd-gpt-terra")]),
      demoModel("demo-fd-gpt-luna", "GPT-5.6 Luna", "gpt", "OpenAI", [effort("low", "demo:fd-gpt-luna")]),
      demoModel("demo-fd-gpt-55", "GPT-5.5", "gpt", "OpenAI", [effort("medium", "demo:fd-gpt-55")]),
      demoModel("demo-fd-gpt-54", "GPT-5.4", "gpt", "OpenAI", [effort("medium", "demo:fd-gpt-54")]),
      demoModel("demo-fd-gpt-codex", "GPT-5.3 Codex", "gpt", "OpenAI", [effort("high", "demo:fd-gpt-codex")]),
      demoModel("demo-fd-gemini-pro", "Gemini 3.1 Pro", "gemini", "Google", [effort("high", "demo:fd-gemini-pro")]),
      demoModel("demo-fd-gemini-flash", "Gemini 3.5 Flash", "gemini", "Google", [effort("high", "demo:fd-gemini-flash")]),
      demoModel("demo-fd-grok", "Grok 4.5", "grok", "xAI", [effort("high", "demo:fd-grok")]),
      demoModel("demo-fd-glm", "GLM-5.2", "zai", "Z.ai", [effort("thinking", "demo:fd-glm")]),
      demoModel("demo-fd-glm51", "GLM-5.1", "zai", "Z.ai", [effort("thinking", "demo:fd-glm51")]),
      demoModel("demo-fd-nemotron", "Nemotron 3 Ultra", "nvidia", "NVIDIA", [effort("thinking", "demo:fd-nemotron")]),
      demoModel("demo-fd-kimi", "Kimi K2.7 Code", "moonshot", "Moonshot", [effort("thinking", "demo:fd-kimi")]),
      demoModel("demo-fd-deepseek", "DeepSeek V4 Pro", "deepseek", "DeepSeek", [effort("high", "demo:fd-deepseek")]),
      demoModel("demo-fd-minimax", "MiniMax M3", "minimax", "MiniMax", [effort("thinking", "demo:fd-minimax")]),
    ],
  },
  {
    id: "grok",
    label: "Grok",
    sub: "xAI · Demo",
    brand: "grok",
    ready: false,
    models: [
      demoModel("demo-grok-45", "Grok 4.5", "grok", "xAI", [effort("high", "demo:grok-45")]),
      demoModel("demo-grok-43", "Grok 4.3", "grok", "xAI", [effort("high", "demo:grok-43")]),
      demoModel("demo-grok-build", "Grok Build 0.1", "grok", "xAI", [effort("thinking", "demo:grok-build")]),
      demoModel("demo-grok-fast", "Grok Code Fast 1", "grok", "xAI", [effort("thinking", "demo:grok-fast")]),
      demoModel("demo-grok-420", "Grok 4.20", "grok", "xAI", [effort("base", "demo:grok-420")]),
      demoModel("demo-grok-420-ma", "Grok 4.20 Multi-Agent", "grok", "xAI", [effort("thinking", "demo:grok-420-ma")]),
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    sub: "Cursor · Demo",
    brand: "cursor",
    ready: false,
    harness: true,
    // A harness: Cursor re-serves models from many vendors under one login,
    // plus its own Composer/Auto. (Sub-provider grouping is paused for now.)
    models: [
      demoModel("demo-cur-composer", "Composer 2.5", "cursor", "Cursor", [effort("base", "demo:cur-composer")]),
      demoModel("demo-cur-auto", "Auto", "cursor", "Cursor", [effort("base", "demo:cur-auto")]),
      demoModel("demo-cur-fable", "Claude Fable 5", "claude", "Anthropic", [effort("thinking", "demo:cur-fable")]),
      demoModel("demo-cur-sonnet5", "Claude Sonnet 5", "claude", "Anthropic", [effort("thinking", "demo:cur-sonnet5")]),
      demoModel("demo-cur-opus", "Claude Opus 4.8", "claude", "Anthropic", [effort("thinking", "demo:cur-opus")]),
      demoModel("demo-cur-opus47", "Claude Opus 4.7", "claude", "Anthropic", [effort("thinking", "demo:cur-opus47")]),
      demoModel("demo-cur-sonnet46", "Claude Sonnet 4.6", "claude", "Anthropic", [effort("thinking", "demo:cur-sonnet46")]),
      demoModel("demo-cur-sonnet45", "Claude Sonnet 4.5", "claude", "Anthropic", [effort("thinking", "demo:cur-sonnet45")]),
      demoModel("demo-cur-haiku", "Claude Haiku 4.5", "claude", "Anthropic", [effort("base", "demo:cur-haiku")]),
      demoModel("demo-cur-gpt-sol", "GPT-5.6 Sol", "gpt", "OpenAI", [effort("high", "demo:cur-gpt-sol")]),
      demoModel("demo-cur-gpt-terra", "GPT-5.6 Terra", "gpt", "OpenAI", [effort("medium", "demo:cur-gpt-terra")]),
      demoModel("demo-cur-gpt-luna", "GPT-5.6 Luna", "gpt", "OpenAI", [effort("low", "demo:cur-gpt-luna")]),
      demoModel("demo-cur-gpt-55", "GPT-5.5", "gpt", "OpenAI", [effort("medium", "demo:cur-gpt-55")]),
      demoModel("demo-cur-gpt-54", "GPT-5.4", "gpt", "OpenAI", [effort("medium", "demo:cur-gpt-54")]),
      demoModel("demo-cur-gpt-mini", "GPT-5.4 Mini", "gpt", "OpenAI", [effort("low", "demo:cur-gpt-mini")]),
      demoModel("demo-cur-gpt-codex", "GPT-5.3 Codex", "gpt", "OpenAI", [effort("high", "demo:cur-gpt-codex")]),
      demoModel("demo-cur-gemini-flash6", "Gemini 3.6 Flash", "gemini", "Google", [effort("thinking", "demo:cur-gemini-flash6")]),
      demoModel("demo-cur-gemini-flash", "Gemini 3.5 Flash", "gemini", "Google", [effort("thinking", "demo:cur-gemini-flash")]),
      demoModel("demo-cur-gemini-pro", "Gemini 3.1 Pro", "gemini", "Google", [effort("thinking", "demo:cur-gemini-pro")]),
      demoModel("demo-cur-gemini-pro3", "Gemini 3 Pro", "gemini", "Google", [effort("thinking", "demo:cur-gemini-pro3")]),
      demoModel("demo-cur-grok", "Grok 4.5", "grok", "xAI", [effort("high", "demo:cur-grok")]),
      demoModel("demo-cur-grok43", "Grok 4.3", "grok", "xAI", [effort("high", "demo:cur-grok43")]),
      demoModel("demo-cur-deepseek", "DeepSeek V4 Pro", "deepseek", "DeepSeek", [effort("high", "demo:cur-deepseek")]),
      demoModel("demo-cur-deepseek-flash", "DeepSeek V4 Flash", "deepseek", "DeepSeek", [effort("base", "demo:cur-deepseek-flash")]),
      demoModel("demo-cur-glm", "GLM 5.2", "zai", "Z.ai", [effort("thinking", "demo:cur-glm")]),
      demoModel("demo-cur-kimi", "Kimi K2.7 Code", "moonshot", "Moonshot", [effort("base", "demo:cur-kimi")]),
    ],
  },
  {
    id: "codex",
    label: "Codex",
    sub: "OpenAI · Demo",
    brand: "codex",
    ready: false,
    models: [
      demoModel("demo-codex-sol", "GPT-5.6 Sol", "gpt", "OpenAI", [effort("high", "demo:codex-sol")]),
      demoModel("demo-codex-terra", "GPT-5.6 Terra", "gpt", "OpenAI", [effort("medium", "demo:codex-terra")]),
      demoModel("demo-codex-luna", "GPT-5.6 Luna", "gpt", "OpenAI", [effort("low", "demo:codex-luna")]),
      demoModel("demo-codex-55", "GPT-5.5", "gpt", "OpenAI", [effort("medium", "demo:codex-55")]),
      demoModel("demo-codex-54", "GPT-5.4", "gpt", "OpenAI", [effort("medium", "demo:codex-54")]),
      demoModel("demo-codex-mini", "GPT-5.4 Mini", "gpt", "OpenAI", [effort("low", "demo:codex-mini")]),
      demoModel("demo-codex-codex", "GPT-5.3 Codex", "gpt", "OpenAI", [effort("high", "demo:codex-codex")]),
    ],
  },
];

// Real providers first (Antigravity real, the rest demo) — this is also the
// order seedPending walks so the current model resolves to its real home.
const realProviders = computed<MProvider[]>(() => [antigravity.value, ...DEMO]);

// ── Favorites ───────────────────────────────────────────────────────────────
// A live shelf of the models the user has starred. Only real (ready) models can
// be favourited — so in today's world that's Antigravity's catalog — which keeps
// the bring-your-own-subscription rule intact: everything on this shelf actually
// applies. Each row keeps a handle on the provider it came from (its `origin`) so
// selecting it works exactly as it would in that provider's own list.
const favorites = computed<MProvider>(() => {
  const picks: MModel[] = [];
  for (const p of realProviders.value) {
    for (const m of p.models) {
      if (favoritedKeys.value.has(m.key)) {
        picks.push({ ...m, origin: { label: p.label, ready: p.ready } });
      }
    }
  }
  return {
    id: "favorites",
    label: "Favorites",
    sub: "Starred models",
    brand: "antigravity",
    ready: false,
    models: picks,
  };
});

// Favorites leads the rail — but only once something's been starred. With an
// empty shelf the tab would go nowhere, so it stays hidden until it has content.
const providers = computed<MProvider[]>(() =>
  favorites.value.models.length ? [favorites.value, ...realProviders.value] : realProviders.value,
);

// ── navigation ──────────────────────────────────────────────────────────────
const provider = ref<MProvider | null>(null);

// For a harness provider: which vendor lane is showing. Reset whenever the
// provider changes (see the watch below).
const vendorFilter = ref("");
const isHarness = computed(() => Boolean(provider.value?.harness));

/** The vendors a harness re-serves, in model order, each with its logo + count. */
const vendors = computed(() => {
  const p = provider.value;
  if (!p?.harness) return [] as Array<{ vendor: string; brand: BrandKey; count: number }>;
  const seen = new Map<string, { vendor: string; brand: BrandKey; count: number }>();
  const order: string[] = [];
  for (const m of p.models) {
    if (!seen.has(m.vendor)) {
      seen.set(m.vendor, { vendor: m.vendor, brand: m.brand, count: 0 });
      order.push(m.vendor);
    }
    seen.get(m.vendor)!.count += 1;
  }
  return order.map((v) => seen.get(v)!);
});

/** The rows to render: a harness filters to the active vendor lane. */
const visibleModels = computed<MModel[]>(() => {
  const p = provider.value;
  if (!p) return [];
  if (!p.harness) return p.models;
  return p.models.filter((m) => m.vendor === vendorFilter.value);
});

// Under a demo (not-ready) provider, a click only focuses — a quiet checkmark,
// never applied. Seeded from the current session model on open.
const pending = ref<{ provider: MProvider; model: MModel; effort: MEffort } | null>(null);
function seedPending() {
  // Walk the REAL providers so the active model resolves to its true home, not
  // its (duplicated) Favorites row.
  for (const p of realProviders.value) {
    for (const m of p.models) {
      const e = m.efforts.find((x) => x.id === props.modelId);
      if (e) {
        pending.value = { provider: p, model: m, effort: e };
        provider.value = p;
        return;
      }
    }
  }
  provider.value = realProviders.value[0] ?? null;
}
function openProvider(p: MProvider) {
  provider.value = p;
}
function focus(m: MModel, e: MEffort) {
  if (!provider.value) return;
  pending.value = { provider: provider.value, model: m, effort: e };
}
// Readiness is per-row under Favorites (each favourite carries its origin),
// otherwise it's the current provider's.
function modelReady(m: MModel): boolean {
  return m.origin ? m.origin.ready : (provider.value?.ready ?? false);
}
// A model click applies it. Effort precedence: a tweak in its open settings bar
// wins; else the effort already applied to this model (so re-picking the active
// model keeps its setting); else the family default. Only ready (real
// Antigravity) models can be selected; demo models do nothing.
function selectModel(m: MModel) {
  if (!modelReady(m)) return;
  const e =
    (pending.value?.model.key === m.key ? pending.value.effort : undefined) ??
    m.efforts.find((x) => x.id === props.modelId) ??
    m.efforts[m.defaultEffortIndex] ??
    m.efforts[0];
  if (!provider.value || !e) return;
  close(() => emit("select", e.id));
}

function isCurrent(id: string): boolean {
  return id === props.modelId;
}
function isCurrentModel(m: MModel): boolean {
  return m.efforts.some((e) => isCurrent(e.id));
}
function isPending(id: string): boolean {
  return pending.value?.effort.id === id;
}
function defaultEffortId(m: MModel): string {
  return (m.efforts[m.defaultEffortIndex] ?? m.efforts[0])?.id ?? "";
}

// The two spec-y things a row still shows: whether the model exposes a fast-mode
// switch and its context window. (Reasoning is handled separately — see
// reasoningMeta — and vision/other capability icons were dropped.) For the REAL
// Antigravity families these come from a verbatim table; demo providers fall
// through to the name heuristic.
//
// `isFast` means the model exposes a fast-mode switch — NOT just that it's a
// snappy model. Antigravity has no fast mode (`/fast` was removed from `agy`) and
// no context-window switch, so every entry is `isFast: false` with a single
// context; those controls simply don't render for it. Other providers (which do
// have those knobs) set them and the controls light up.
type ModelCaps = { isFast: boolean; contextWindow: string };
const ANTIGRAVITY_CAPS: Record<string, ModelCaps> = {
  "gemini-3.6-flash": { isFast: false, contextWindow: "1M" },
  "gemini-3.5-flash": { isFast: false, contextWindow: "1M" },
  "gemini-3.1-pro": { isFast: false, contextWindow: "1M" },
  "claude-sonnet-4-6": { isFast: false, contextWindow: "200k" },
  "claude-opus-4-6": { isFast: false, contextWindow: "200k" },
  "gpt-oss-120b": { isFast: false, contextWindow: "128k" },
};

function getModelBadges(m: MModel): ModelCaps {
  const exact = ANTIGRAVITY_CAPS[m.key];
  if (exact) return exact;

  const key = m.key.toLowerCase();
  const label = m.label.toLowerCase();

  const isFast =
    key.includes("flash") ||
    key.includes("haiku") ||
    key.includes("fast") ||
    key.includes("mini") ||
    key.includes("luna") ||
    label.includes("flash") ||
    label.includes("haiku") ||
    label.includes("fast") ||
    label.includes("mini") ||
    label.includes("luna");

  let contextWindow = "128k";
  if (key.includes("gemini") || label.includes("gemini")) {
    contextWindow = label.includes("pro") || key.includes("pro") ? "2M" : "1M";
  } else if (key.includes("claude") || label.includes("claude") || key.includes("cc-") || key.includes("fd-")) {
    contextWindow = "200k";
  } else if (label.includes("sol") || label.includes("opus 4.8") || label.includes("fable") || label.includes("grok 4.5")) {
    contextWindow = "256k";
  } else if (key.includes("kimi") || key.includes("glm") || key.includes("minimax")) {
    contextWindow = "200k";
  }

  return { isFast, contextWindow };
}

// The reasoning effort currently set for a model: the pending effort if this row
// is the one being tuned, else its resting default. Drives the row's brain-stack
// indicator — which matches the settings dial. Returns null for a `base`-tier
// model (no reasoning to set), so its row shows no reasoning indicator.
function reasoningMeta(m: MModel) {
  const e = pending.value?.model.key === m.key
    ? pending.value.effort
    : (m.efforts.find((x) => x.id === props.modelId) ?? m.efforts[m.defaultEffortIndex] ?? m.efforts[0]);
  if (!e || e.tier === "base") return null;
  return EFFORT_META[e.tier];
}

// Fast-mode + context-window state for the settings bar. Only providers whose
// models advertise these (via caps / heuristic) surface the controls — see
// getModelBadges.isFast and availableContextOptions.
const isFastModeOn = ref(false);
const activeContext = ref("128k");
// The set of favourited model keys. Only ready (real) models are ever added, so
// the Favorites shelf stays fully applicable. Seeded on open with the current /
// first Antigravity model so the shelf isn't empty on first sight.
const favoritedKeys = ref<Set<string>>(new Set());
const activeSettingsModelKey = ref<string | null>(null);

function isFavorited(key: string): boolean {
  return favoritedKeys.value.has(key);
}

// Star / unstar — real models only (a demo model can't apply, so it can't be a
// favourite). Reassign the Set so the Favorites computed recomputes.
function toggleFavorite(m: MModel) {
  if (!modelReady(m)) return;
  const next = new Set(favoritedKeys.value);
  if (next.has(m.key)) next.delete(m.key);
  else next.add(m.key);
  favoritedKeys.value = next;
}

function toggleSettings(m: MModel) {
  if (!modelReady(m)) return;
  if (activeSettingsModelKey.value === m.key) {
    activeSettingsModelKey.value = null;
  } else {
    activeSettingsModelKey.value = m.key;
    // Seed the dial from the effort CURRENTLY applied to this model (when it's
    // the active one), else its resting default — so the bar reflects reality.
    const current = m.efforts.find((e) => e.id === props.modelId);
    const e = current ?? m.efforts[m.defaultEffortIndex] ?? m.efforts[0];
    if (e && provider.value) {
      focus(m, e);
    }
  }
}

// Reasoning effort — Antigravity's real knob (`agy --effort`, baked into the id).
// Cycle through a family's real efforts. For a ready model this applies live:
// the composer's active model + input update immediately and the choice sticks,
// without closing the picker.
function cycleEffort() {
  if (!pending.value) return;
  const efforts = pending.value.model.efforts;
  if (efforts.length <= 1) return;
  const currentIndex = efforts.findIndex((e) => e.id === pending.value!.effort.id);
  const nextIndex = (currentIndex + 1) % efforts.length;
  const next = efforts[nextIndex]!;
  pending.value.effort = next;
  if (modelReady(pending.value.model)) emit("apply", next.id);
}

function brainStack(count?: number): number[] {
  return Array.from({ length: Math.max(1, count ?? 1) }, (_, i) => i);
}

// The context windows a model lets you switch between. A single value means no
// switch (Antigravity's real families); providers that offer a real choice list
// more than one and the switcher appears.
function availableContextOptions(m: MModel): string[] {
  const exact = ANTIGRAVITY_CAPS[m.key];
  if (exact) return [exact.contextWindow];

  const key = m.key.toLowerCase();
  if (key.includes("gemini")) return ["1M", "2M"];
  if (key.includes("claude")) return ["128k", "200k"];
  if (key.includes("gpt") || key.includes("grok") || key.includes("sol")) return ["128k", "256k"];
  return ["128k", "200k"];
}

function cycleContext() {
  if (!pending.value) return;
  const options = availableContextOptions(pending.value.model);
  if (options.length <= 1) return;
  const currentIndex = options.indexOf(activeContext.value);
  const nextIndex = (currentIndex + 1) % options.length;
  activeContext.value = options[nextIndex]!;
}

// Is there anything to configure? Drives whether the gear button shows, so it
// never opens an empty bar. A model with one effort, no fast mode and one context
// has no settings.
function hasSettings(m: MModel): boolean {
  return m.efforts.length > 1 || getModelBadges(m).isFast || availableContextOptions(m).length > 1;
}

watch(pending, (val) => {
  if (val) {
    const badges = getModelBadges(val.model);
    isFastModeOn.value = badges.isFast;
    activeContext.value = badges.contextWindow;
  }
}, { immediate: true });

// ── confirm / cancel with the card's exit ─────────────────────────────────────
const shown = ref(false);
const closing = ref(false);
function close(done: () => void) {
  if (closing.value) return;
  closing.value = true;
  shown.value = false;
  window.setTimeout(done, 240);
}
function cancel() {
  close(() => emit("cancel"));
}

// ── elastic height (mirrors FolderPickerModal) ────────────────────────────────
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;
function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}
// When the provider changes: seed the vendor lane (harness), close any open
// settings bar (it belongs to a row that's no longer shown), and re-measure.
watch(provider, (p) => {
  vendorFilter.value = p?.harness ? (p.models[0]?.vendor ?? "") : "";
  activeSettingsModelKey.value = null;
  void nextTick(syncHeight);
});
// Switching vendor lane swaps the list — re-measure for the height spring.
watch(vendorFilter, () => void nextTick(syncHeight));
// Unstarring the last favourite hides its tab — step off it if it's open.
watch(
  () => favorites.value.models.length,
  (n) => {
    if (n === 0 && provider.value?.id === "favorites") {
      provider.value = realProviders.value[0] ?? null;
    }
  },
);

let opener: HTMLElement | null = null;
onMounted(() => {
  opener = document.activeElement as HTMLElement | null;
  seedPending();
  // Seed the shelf with the current model (or the first real one) so Favorites
  // reads as a live place from the start rather than an empty tab.
  const seed = pending.value?.provider.ready ? pending.value.model.key : antigravity.value.models[0]?.key;
  if (seed) favoritedKeys.value = new Set([seed]);
  window.addEventListener("resize", syncHeight);
  void nextTick(() => {
    syncHeight();
    ro = new ResizeObserver(syncHeight);
    if (contentEl.value) ro.observe(contentEl.value);
    requestAnimationFrame(() => (shown.value = true));
  });
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", syncHeight);
  ro?.disconnect();
  opener?.focus();
});

const cardSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-end justify-end overflow-hidden p-6" @keydown.esc.stop.prevent="cancel">
    <motion.div
      class="mp-scrim absolute inset-0"
      :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
      :animate="{ opacity: shown ? 1 : 0, backdropFilter: shown ? 'blur(4px)' : 'blur(0px)' }"
      :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
      @click="cancel"
    />

    <motion.div
      class="mp-card relative z-20 w-full overflow-hidden"
      :style="{ height: cardHeight === null ? 'auto' : `${cardHeight}px` }"
      :initial="{ opacity: 0, y: 12, scale: 0.96 }"
      :animate="{ opacity: shown ? 1 : 0, y: shown ? 0 : 12, scale: shown ? 1 : 0.96 }"
      :transition="cardSpring"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a model"
    >
      <div
        ref="contentEl"
        class="mp shrink-0"
        :style="{ '--provider-count': providers.length }"
      >
        <div class="mp-body-grid">
          <aside class="mp-rail" aria-label="Model providers">
            <button
              v-for="p in providers"
              :key="p.id"
              type="button"
              class="mp-provider"
              :class="{ 'mp-provider--on': p.id === provider?.id }"
              :aria-label="p.label"
              :aria-pressed="p.id === provider?.id"
              :title="p.label"
              @click="openProvider(p)"
            >
              <svg v-if="p.id === 'favorites'" class="mp-star" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 3.6l2.42 4.9 5.41.79-3.92 3.82.93 5.39L12 15.98l-4.84 2.52.93-5.39L4.17 9.29l5.41-.79z"
                  fill="currentColor"
                  fill-opacity="0.16"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linejoin="round"
                />
              </svg>
              <ProviderLogo v-else :brand="p.brand" :size="20" />
            </button>
          </aside>

          <!-- The model list is the dark content well inside the lighter shell. -->
          <div class="mp-content relative">
            <Transition name="mp-swap" mode="out-in">
              <div v-if="provider" :key="provider.id" class="mp-scroll">
                <p v-if="!provider.models.length" class="mp-empty">
                  {{ provider.id === 'favorites'
                    ? 'No favorites yet — star a model to keep it here.'
                    : 'No models available.' }}
                </p>
                <button
                  v-for="m in provider.models"
                  :key="m.key"
                  type="button"
                  class="mp-row group"
                  :class="{ 'mp-row--on': isCurrentModel(m) || isPending(defaultEffortId(m)) }"
                  @click="selectModel(m)"
                >
                  <span class="mp-icon"><ProviderLogo :brand="m.brand" :size="17" /></span>
                  <span class="mp-body">
                    <span class="mp-label">{{ m.label }}</span>
                    <span class="mp-meta">
                      <span
                        v-if="reasoningMeta(m)"
                        class="mp-meta-brains"
                        :class="{ 'mp-stack--glow': reasoningMeta(m)!.glow }"
                        :title="`Reasoning effort: ${reasoningMeta(m)!.label}`"
                      >
                        <HugeiconsIcon
                          v-for="i in brainStack(reasoningMeta(m)!.brains)"
                          :key="i"
                          :icon="AiBrain01Icon"
                          :size="13"
                          :stroke-width="1.8"
                          :style="{ color: reasoningMeta(m)!.hue }"
                        />
                      </span>
                      <span
                        v-if="getModelBadges(m).isFast"
                        class="mp-meta-icon mp-meta-icon--fast"
                        title="Fast execution mode"
                      >
                        <HugeiconsIcon :icon="FlashIcon" :size="14" :stroke-width="1.8" />
                      </span>
                      <span class="mp-meta-context" title="Context window">
                        {{ getModelBadges(m).contextWindow }}
                      </span>
                    </span>
                  </span>
                  <!-- Actions: Favorite & Settings — real models only. The current
                       model keeps them shown; others reveal them on hover. -->
                  <span
                    v-if="modelReady(m)"
                    class="mp-actions"
                    :class="{ 'mp-actions--shown': isCurrentModel(m) }"
                    @click.stop
                  >
                    <button
                      type="button"
                      class="mp-action-btn"
                      :class="{ 'mp-action-btn--active': isFavorited(m.key) }"
                      :title="isFavorited(m.key) ? 'Unstar model' : 'Favorite model'"
                      @click.stop="toggleFavorite(m)"
                    >
                      <HugeiconsIcon :icon="StarIcon" :size="13" :stroke-width="1.8" />
                    </button>
                    <button
                      v-if="hasSettings(m)"
                      type="button"
                      class="mp-action-btn"
                      :class="{ 'mp-action-btn--active': activeSettingsModelKey === m.key }"
                      title="Model settings"
                      @click.stop="toggleSettings(m)"
                    >
                      <HugeiconsIcon :icon="Settings02Icon" :size="13" :stroke-width="1.8" />
                    </button>
                  </span>
                </button>
              </div>
            </Transition>
          </div>
        </div>

        <!-- Shell Bottom: Full-bleed control strip, revealed when clicking Settings on a model -->
        <div v-if="activeSettingsModelKey && pending" class="mp-shell-bottom">
          <!-- Reasoning Effort Chooser: Clickable brain-stack + effort level text -->
          <div v-if="pending.model.efforts.length > 1" class="mp-footer-group">
            <button
              type="button"
              class="mp-effort-toggle"
              :aria-label="`Reasoning effort: ${EFFORT_META[pending.effort.tier]?.label}. Click to cycle.`"
              @click.stop="cycleEffort"
            >
              <span class="mp-stack" :class="{ 'mp-stack--glow': EFFORT_META[pending.effort.tier]?.glow }">
                <HugeiconsIcon
                  v-for="i in brainStack(EFFORT_META[pending.effort.tier]?.brains)"
                  :key="i"
                  :icon="AiBrain01Icon"
                  :size="14"
                  :stroke-width="1.8"
                  :style="{ color: EFFORT_META[pending.effort.tier]?.hue ?? '#a78bfa' }"
                />
              </span>
              <span
                class="mp-effort-level-text"
                :style="{ color: EFFORT_META[pending.effort.tier]?.hue ?? 'var(--ink)' }"
              >
                {{ EFFORT_META[pending.effort.tier]?.label }}
              </span>
            </button>
          </div>

          <!-- Fast / Normal toggle — only for models that expose a fast mode. -->
          <div v-if="getModelBadges(pending.model).isFast" class="mp-footer-group">
            <button
              type="button"
              class="mp-fast-btn"
              :class="{ 'mp-fast-btn--on': isFastModeOn }"
              :aria-label="`Toggle speed mode: currently ${isFastModeOn ? 'Fast' : 'Normal'}`"
              @click.stop="isFastModeOn = !isFastModeOn"
            >
              <HugeiconsIcon
                :icon="FlashIcon"
                :size="14"
                :stroke-width="1.8"
                :style="{ color: isFastModeOn ? '#facc15' : 'var(--muted)' }"
              />
              <span :style="{ color: isFastModeOn ? '#facc15' : 'var(--muted)' }">
                {{ isFastModeOn ? "Fast" : "Normal" }}
              </span>
            </button>
          </div>

          <!-- Context-window switch — only when the model offers a real choice. -->
          <div v-if="availableContextOptions(pending.model).length > 1" class="mp-footer-group">
            <button
              type="button"
              class="mp-ctx-btn"
              :aria-label="`Context window size: ${activeContext}. Click to toggle.`"
              @click.stop="cycleContext"
            >
              <span>{{ activeContext }}</span>
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
.mp-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}
.mp-card {
  max-width: 500px;
  background: color-mix(in srgb, var(--ink) 7%, var(--surface, var(--ground)));
  border-radius: 22px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
.mp {
  display: flex;
  flex-direction: column;
}

.mp-body-grid {
  --provider-stack-height: calc(
    var(--provider-count) * 44px + (var(--provider-count) - 1) * 10px
  );
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  grid-template-rows: var(--provider-stack-height);
  padding: 0 0 0 8px;
}

.mp-rail {
  grid-column: 1;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 0 2px 0 0;
}
.mp-provider {
  position: relative;
  display: inline-flex;
  width: 44px;
  height: 44px;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  opacity: 0.48;
  transition:
    opacity 0.18s ease,
    transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.mp-provider:hover {
  opacity: 0.78;
  transform: translateY(-1px);
}
.mp-provider:active { transform: scale(0.96); }
.mp-provider--on {
  opacity: 1;
}
.mp-star {
  width: 20px;
  height: 20px;
  color: var(--accent);
}

/* ── List ─────────────────────────────────────────────────────────────────── */
.mp-content {
  grid-column: 2;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  height: var(--provider-stack-height);
  min-height: 0;
  overflow: hidden;
  border-radius: 18px;
  background: var(--ground);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 7%, transparent);
}
.mp-scroll {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px;
  scrollbar-width: none;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
}
.mp-scroll::-webkit-scrollbar { width: 0; height: 0; }

.mp-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 11px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  color: var(--ink);
  opacity: 0.72;
  transition:
    opacity 0.18s ease,
    background 0.16s ease,
    transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.mp-row:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.mp-row:active {
  transform: scale(0.985);
}
.mp-row--on {
  opacity: 1;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
}
.mp-row--on:hover {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}

.mp-meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 2px;
  flex-shrink: 0;
}

.mp-meta-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.65;
  transition: opacity 0.14s ease, transform 0.14s ease;
}
.mp-row:hover .mp-meta-icon {
  opacity: 0.95;
}

.mp-meta-icon--fast {
  color: #facc15;
}

/* The reasoning indicator: a compact brain-stack whose count / glow / hue match
   the effort currently set for the model (mirrors the settings dial). */
.mp-meta-brains {
  display: inline-flex;
  align-items: center;
  opacity: 0.8;
  transition: opacity 0.14s ease;
}
.mp-meta-brains > :deep(svg) { margin-left: -4px; }
.mp-meta-brains > :deep(svg:first-child) { margin-left: 0; }
.mp-meta-brains.mp-stack--glow > :deep(svg) { filter: drop-shadow(0 0 4px currentColor); }
.mp-row:hover .mp-meta-brains { opacity: 1; }

.mp-meta-context {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
  opacity: 0.65;
}
.mp-row:hover .mp-meta-context {
  opacity: 0.95;
}

.mp-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  flex-shrink: 0;
}

.mp-body { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; }
.mp-label { font-size: 15px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mp-empty {
  margin: auto;
  padding: 22px 14px;
  text-align: center;
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted);
  opacity: 0.7;
}

.mp-actions {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.16s ease;
}
.mp-row:hover .mp-actions,
.mp-actions--shown,
.mp-action-btn--active {
  opacity: 1;
}

.mp-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  opacity: 0.65;
  cursor: pointer;
  transition: color 0.14s ease, opacity 0.14s ease, transform 0.14s ease;
}
.mp-action-btn:hover {
  color: var(--ink);
  opacity: 1;
}
.mp-action-btn:active {
  transform: scale(0.92);
}
.mp-action-btn--active {
  color: var(--accent);
  opacity: 1;
}

/* ── Shell Bottom Controls ────────────────────────────────────────────────── */
.mp-shell-bottom {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  flex-wrap: wrap;
  padding: 4px 14px 8px 14px;
  margin-top: 2px;
}

.mp-footer-group {
  display: flex;
  align-items: center;
}

.mp-stack { display: inline-flex; align-items: center; }
.mp-stack > :deep(svg) { margin-left: -5px; }
.mp-stack > :deep(svg:first-child) { margin-left: 0; }
.mp-stack--glow > :deep(svg) { filter: drop-shadow(0 0 4px currentColor); }

.mp-effort-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  font-size: 15px;
  font-weight: 500;
  border: 0;
  background: transparent;
  cursor: pointer;
  opacity: 0.88;
  transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.mp-effort-toggle:hover {
  opacity: 1;
  transform: translateY(-1px);
}
.mp-effort-toggle:active {
  transform: translateY(0) scale(0.95);
}

.mp-effort-level-text {
  font-weight: 500;
  transition: color 0.18s ease;
}

.mp-fast-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  font-size: 15px;
  font-weight: 500;
  border: 0;
  background: transparent;
  cursor: pointer;
  opacity: 0.88;
  transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.mp-fast-btn:hover {
  opacity: 1;
  transform: translateY(-1px);
}
.mp-fast-btn:active {
  transform: translateY(0) scale(0.95);
}

.mp-ctx-btn {
  display: inline-flex;
  align-items: center;
  padding: 3px 6px;
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 500;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  opacity: 0.88;
  transition: opacity 0.18s ease, color 0.18s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.mp-ctx-btn:hover {
  color: var(--ink);
  opacity: 1;
  transform: translateY(-1px);
}
.mp-ctx-btn:active {
  transform: translateY(0) scale(0.95);
}

/* ── Provider swap ────────────────────────────────────────────────────────── */
.mp-swap-enter-active,
.mp-swap-leave-active {
  transition: opacity 0.2s ease, transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
.mp-swap-enter-from { opacity: 0; transform: translateX(-16px); }
.mp-swap-leave-to { opacity: 0; transform: translateX(16px); }

@media (prefers-reduced-motion: reduce) {
  .mp-swap-enter-active,
  .mp-swap-leave-active { transition-duration: 0.01s; }
  .mp-card { transition-duration: 0.01s; }
}
</style>
