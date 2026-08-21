<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import { useAgentProviders } from "~/composables/useAgentProviders";
import { useSound } from "~/composables/useSound";
import { buildModelCatalog, type BrandKey, type ModelOption } from "~/utils/modelCatalog";
import { PROVIDER_LABEL, PROVIDER_ORDER } from "~/utils/usageProviders";
import type { AgentModelRef, ProviderKind } from "~/types/desktop";

// The shared model-pin picker: pick a provider first, then a model off that
// provider's list. A provider rail on the left swaps the list on the right —
// the same shape as the composer's model picker — instead of laying every
// provider's models out as one flat wall of chips. Both the agent-capabilities
// editor and the preset editor mount this, so the drill-down lives in one place
// and the two surfaces can't drift apart.
//
// One model, or none. Picking the model already pinned clears it back to null
// (no preference); picking any other replaces it. There is never a fallback
// list and no separate provider axis — the provider is implied by the model.

const props = defineProps<{ model: AgentModelRef | null }>();
const emit = defineEmits<{ "update:model": [AgentModelRef | null] }>();

const { modelCache, prepare } = useAgentProviders();
const { cue } = useSound();

// The provider's own logomark for its rail entry (Codex's mark, Claude's mark,
// …) — the model rows below carry each model's true vendor mark instead.
const PROVIDER_BRAND = {
  codex: "codex",
  claudeAgent: "claude",
  opencode: "opencode",
  cursor: "cursor",
  droid: "droid",
  antigravity: "antigravity",
} satisfies Record<ProviderKind, BrandKey>;

// The catalog is shared module state, so a warm app already has it; a cold one
// fills in behind the first paint. Nothing here waits on it — an empty catalog
// just shows nothing to pick yet.
onMounted(() => {
  void prepare();
});

// A rail entry per provider whose catalog has actually loaded.
const providers = computed<ProviderKind[]>(() =>
  PROVIDER_ORDER.filter((p) => (modelCache.value[p]?.length ?? 0) > 0),
);

function catalogFor(p: ProviderKind): ModelOption[] {
  return buildModelCatalog(modelCache.value[p] ?? []);
}

// Which provider's list is open. Seeded to the pinned model's provider so the
// picker opens on the tab the current pin lives under; otherwise the first
// available. Kept valid as the catalog fills in behind the first paint.
const openProvider = ref<ProviderKind | null>(null);
watch(
  [providers, () => props.model],
  ([list, model]) => {
    if (openProvider.value && list.includes(openProvider.value)) return;
    openProvider.value = (model && list.includes(model.provider) ? model.provider : list[0]) ?? null;
  },
  { immediate: true },
);

const openCatalog = computed<ModelOption[]>(() =>
  openProvider.value ? catalogFor(openProvider.value) : [],
);

function modelOn(p: ProviderKind, key: string): boolean {
  return props.model?.provider === p && props.model?.model === key;
}

function selectProvider(p: ProviderKind) {
  if (p === openProvider.value) return;
  cue("select");
  openProvider.value = p;
}

// Single-select: picking the model already on clears it back to "no model",
// and picking any other replaces it. There is only ever one model.
function pickModel(p: ProviderKind, opt: ModelOption) {
  cue("toggle");
  if (modelOn(p, opt.key)) emit("update:model", null);
  else emit("update:model", { provider: p, model: opt.key, label: opt.label });
}
</script>

<template>
  <p v-if="providers.length === 0" class="pin__empty">No model catalogs loaded yet.</p>

  <div v-else class="pin">
    <aside class="pin__rail" aria-label="Providers">
      <button
        v-for="p in providers"
        :key="p"
        type="button"
        class="pin__tab"
        :class="{ 'pin__tab--on': p === openProvider }"
        :aria-pressed="p === openProvider"
        :title="PROVIDER_LABEL[p]"
        @click="selectProvider(p)"
      >
        <ProviderLogo :brand="PROVIDER_BRAND[p]" :size="18" />
        <span class="pin__tab-name">{{ PROVIDER_LABEL[p] }}</span>
      </button>
    </aside>

    <div class="pin__well">
      <p v-if="openCatalog.length === 0" class="pin__none">No models available.</p>
      <button
        v-for="opt in openCatalog"
        :key="opt.key"
        type="button"
        class="pin__row"
        :class="{ 'pin__row--on': openProvider && modelOn(openProvider, opt.key) }"
        :aria-pressed="openProvider ? modelOn(openProvider, opt.key) : false"
        @click="openProvider && pickModel(openProvider, opt)"
      >
        <span class="pin__mark"><ProviderLogo :brand="opt.brand" :size="16" /></span>
        <span class="pin__name">{{ opt.label }}</span>
        <span v-if="opt.vendor" class="pin__vendor">{{ opt.vendor }}</span>
        <HugeiconsIcon
          v-if="openProvider && modelOn(openProvider, opt.key)"
          :icon="Tick02Icon"
          :size="15"
          :stroke-width="2"
          class="pin__check"
        />
      </button>
    </div>
  </div>
</template>

<style scoped>
.pin {
  display: grid;
  grid-template-columns: minmax(0, 116px) minmax(0, 1fr);
  gap: 10px;
  min-height: 168px;
}

/* ── provider rail ──────────────────────────────────────────────────────── */
.pin__rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pin__tab {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  text-align: left;
  cursor: pointer;
  opacity: 0.7;
  transition:
    background-color 0.16s ease,
    color 0.16s ease,
    opacity 0.16s ease;
}
.pin__tab:hover {
  opacity: 1;
  background: var(--hover);
}
.pin__tab--on {
  opacity: 1;
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.pin__tab-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── model list ─────────────────────────────────────────────────────────── */
.pin__well {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 236px;
  overflow-y: auto;
  scrollbar-width: none;
  padding-right: 2px;
}
.pin__well::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.pin__row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--ink-soft);
  text-align: left;
  cursor: pointer;
  opacity: 0.82;
  transition:
    background-color 0.16s ease,
    color 0.16s ease,
    opacity 0.16s ease;
}
.pin__row:hover {
  opacity: 1;
  background: var(--hover);
}
.pin__row--on {
  opacity: 1;
  color: var(--ink);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.pin__mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 18px;
}
.pin__name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pin__vendor {
  flex: none;
  font-size: 11px;
  color: var(--faint);
  white-space: nowrap;
}
.pin__check {
  flex: none;
  color: var(--accent);
}

.pin__none,
.pin__empty {
  margin: 0;
  padding: 4px 2px;
  font-size: 12px;
  color: var(--muted);
}
</style>
