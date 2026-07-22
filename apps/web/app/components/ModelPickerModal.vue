<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion } from "motion-v";
import ProviderLogo from "~/components/ProviderLogo.vue";
import { type BrandKey, type EffortTier, type ModelOption } from "~/utils/modelCatalog";

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

const emit = defineEmits<{ select: [id: string]; cancel: [] }>();

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

// ── Favorites (demo) ──────────────────────────────────────────────────────────
// A curated, cross-provider shelf of starred models — the shape of "your
// favourites, wherever they live". Each row keeps a handle on the provider it
// came from, so a favourited Antigravity model applies for real while demo ones
// stay preview-only. Demo data, but it stays in sync with the catalogs above.
const favorites = computed<MProvider>(() => {
  const picks: MModel[] = [];
  const star = (p: MProvider, key: string) => {
    const m = p.models.find((x) => x.key === key);
    if (m) picks.push({ ...m, origin: { label: p.label, ready: p.ready } });
  };
  // Top of the shelf: the first real Antigravity model (whatever the catalog
  // leads with) — a genuine, applicable favourite.
  const ag = antigravity.value.models[0];
  if (ag) picks.push({ ...ag, origin: { label: antigravity.value.label, ready: true } });
  // A spread across the demo providers, so the cross-provider idea reads.
  const demo = (id: string) => DEMO.find((d) => d.id === id);
  const cc = demo("claude-code");
  if (cc) star(cc, "demo-cc-opus");
  const gk = demo("grok");
  if (gk) star(gk, "demo-grok-45");
  const cx = demo("codex");
  if (cx) star(cx, "demo-codex-sol");
  return {
    id: "favorites",
    label: "Favorites",
    sub: "Starred across providers",
    brand: "antigravity",
    ready: false,
    models: picks,
  };
});

// Favorites leads the rail; the real providers follow.
const providers = computed<MProvider[]>(() => [favorites.value, ...realProviders.value]);

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
// A model click resolves straight to its default effort — no reasoning screen.
// A ready model applies and closes immediately; a demo one only focuses.
function selectModel(m: MModel) {
  const e = m.efforts[m.defaultEffortIndex] ?? m.efforts[0];
  if (!provider.value || !e) return;
  if (modelReady(m)) {
    close(() => emit("select", e.id));
  } else {
    focus(m, e);
  }
}

function isCurrent(id: string): boolean {
  return id === props.modelId;
}
function isPending(id: string): boolean {
  return pending.value?.effort.id === id;
}
function defaultEffortId(m: MModel): string {
  return (m.efforts[m.defaultEffortIndex] ?? m.efforts[0])?.id ?? "";
}

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
// When the provider changes: seed the vendor lane (harness) and re-measure.
watch(provider, (p) => {
  vendorFilter.value = p?.harness ? (p.models[0]?.vendor ?? "") : "";
  void nextTick(syncHeight);
});
// Switching vendor lane swaps the list — re-measure for the height spring.
watch(vendorFilter, () => void nextTick(syncHeight));

let opener: HTMLElement | null = null;
onMounted(() => {
  opener = document.activeElement as HTMLElement | null;
  seedPending();
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
              <button
                v-for="m in provider.models"
                :key="m.key"
                type="button"
                class="mp-row group"
                :class="{ 'mp-row--on': isPending(defaultEffortId(m)) }"
                @click="selectModel(m)"
              >
                <span class="mp-icon"><ProviderLogo :brand="m.brand" :size="17" /></span>
                <span class="mp-body">
                  <span class="mp-label">{{ m.label }}</span>
                  <span class="mp-sub">{{ m.origin ? m.origin.label : m.vendor }}</span>
                </span>
                <span v-if="m.efforts.some((e) => isCurrent(e.id))" class="mp-now">current</span>
                <svg v-else-if="isPending(defaultEffortId(m))" class="mp-check" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M3 7.5L6 10.5L11 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
          </Transition>
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
  transition: background-color 0.14s ease;
}
.mp-row:hover { background: var(--hover); }
.mp-row--on { background: var(--hover); }

.mp-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  flex-shrink: 0;
}

.mp-body { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }
.mp-label { font-size: 15px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp-sub { font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mp-now {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent);
}
.mp-check { width: 15px; height: 15px; flex-shrink: 0; color: var(--accent); }

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
