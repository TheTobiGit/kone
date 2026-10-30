<script setup lang="ts">
// Kept Models list with Refresh models (surfacing discovery errors), + Add model,
// and user-added custom model rows at the end.
import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AlertCircleIcon,
  Delete02Icon,
  PlusSignIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import ProviderModelMeta from "~/components/provider/ProviderModelMeta.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import { sessionBrand, type BrandKey, type ModelOption } from "~/utils/modelCatalog";
import type { ProviderPaneRow } from "./types";

export type ProviderModelRow = {
  key: string;
  label: string;
  brand: BrandKey;
  model: ModelOption;
  contextTokens: number | undefined;
  hidden: boolean;
};

const props = defineProps<{
  row: ProviderPaneRow;
  open: boolean;
  modelRows: ProviderModelRow[];
  hiddenCount: number;
  customModels: string[];
  refreshing: boolean;
  refreshError: string | null;
}>();

const emit = defineEmits<{
  toggleModel: [key: string];
  refresh: [];
  addCustomModel: [slug: string];
  removeCustomModel: [slug: string];
}>();

const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

const adding = ref(false);
const draft = ref("");

const showVendor = computed(() =>
  ["opencode", "cursor", "cline"].includes(props.row.provider),
);

function brandFor(id: string): BrandKey {
  return sessionBrand(props.row.provider, props.row.meta.brand, id);
}

function submitCustom() {
  const slug = draft.value.trim();
  if (slug) emit("addCustomModel", slug);
  draft.value = "";
  adding.value = false;
}
</script>

<template>
  <section class="pp__models" aria-label="Models">
    <div class="pp__modelshead">
      <p class="pp__blocklabel">Models</p>
      <div class="pp__modelsend">
        <p v-if="modelRows.length" class="pp__modelscount">
          {{ modelRows.length }} offered<template v-if="hiddenCount">
            · {{ hiddenCount }} hidden</template
          >
        </p>
        <button
          type="button"
          class="pp__btn pp__iconbtn"
          aria-label="Refresh models"
          :disabled="refreshing"
          :tabindex="open ? 0 : -1"
          @click="emit('refresh')"
        >
          <HugeiconsIcon
            :icon="RefreshIcon"
            :size="13"
            :stroke-width="1.8"
            :class="{ 'pp__spin': refreshing }"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          class="pp__btn pp__tinybtn"
          :tabindex="open ? 0 : -1"
          @click="adding = !adding"
        >
          <HugeiconsIcon :icon="PlusSignIcon" :size="11" :stroke-width="2" aria-hidden="true" />
          Add model
        </button>
      </div>
    </div>

    <p v-if="refreshError" class="pp__modelserr" role="alert">
      <HugeiconsIcon :icon="AlertCircleIcon" :size="13" :stroke-width="1.8" aria-hidden="true" />
      {{ refreshError }}
    </p>

    <ul
      v-if="modelRows.length || customModels.length || adding"
      ref="scroller"
      class="pp__modellist"
      :style="maskStyle"
      @scroll.passive="measure"
    >
      <li
        v-for="m in modelRows"
        :key="m.key"
        class="pp__model"
        :class="{ 'pp__model--off': m.hidden }"
      >
        <ProviderLogo :brand="m.brand" :size="16" class="pp__modelmark" />
        <span class="pp__modeltext">
          <span class="pp__modelname">{{ m.label }}</span>
          <ProviderModelMeta
            :model="m.model"
            :fallback-tokens="m.contextTokens"
            :show-vendor="showVendor"
          />
        </span>
        <button
          type="button"
          role="switch"
          class="pp__switch pp__modelswitch"
          :class="{ 'pp__switch--on': !m.hidden }"
          :aria-checked="!m.hidden"
          :aria-label="`Show ${m.label} in the picker`"
          :tabindex="open ? 0 : -1"
          @click="emit('toggleModel', m.key)"
        >
          <i class="pp__knob" />
        </button>
      </li>

      <li v-for="slug in customModels" :key="`custom-${slug}`" class="pp__model pp__customrow">
        <ProviderLogo :brand="brandFor(slug)" :size="16" class="pp__modelmark" />
        <span class="pp__customid">{{ slug }}</span>
        <button
          type="button"
          class="pp__btn pp__iconbtn"
          :aria-label="`Remove ${slug}`"
          :tabindex="open ? 0 : -1"
          @click="emit('removeCustomModel', slug)"
        >
          <HugeiconsIcon :icon="Delete02Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
        </button>
      </li>

      <li v-if="adding" class="pp__model pp__customrow">
        <ProviderLogo :brand="row.meta.brand" :size="16" class="pp__modelmark" />
        <input
          v-model="draft"
          type="text"
          class="pp__input pp__custominput"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          placeholder="model-id"
          aria-label="Custom model id"
          @keydown.enter.prevent="submitCustom"
          @keydown.esc.prevent="adding = false"
        />
        <button type="button" class="pp__btn pp__btn--outline pp__tinybtn" @click="submitCustom">
          Add
        </button>
      </li>
    </ul>

    <p v-else class="pp__hint">
      {{
        row.status?.readiness === "ready"
          ? "No models reported."
          : "Sign in to load available models."
      }}
    </p>
  </section>
</template>

<style scoped>
.pp__models {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
}
.pp__modelshead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}
.pp__modelsend {
  display: flex;
  align-items: center;
  gap: 6px;
}
.pp__modelscount {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.pp__iconbtn {
  padding-inline: 6px;
  height: 24px;
}
.pp__tinybtn {
  height: 24px;
  padding-inline: 8px;
  font-size: 11px;
}
.pp__modelserr {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--danger);
}
.pp__modellist {
  display: flex;
  flex-direction: column;
  list-style: none;
  margin: 0;
  max-height: 360px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 4px 0 0;
  scrollbar-width: none;
}
.pp__modellist::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.pp__model {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 8px 4px;
  min-width: 0;
  border-top: 1px solid var(--line-soft);
}
.pp__model:first-child {
  border-top: none;
}
.pp__modelmark {
  flex-shrink: 0;
  transition: opacity var(--pp-t-micro) ease;
}
.pp__modeltext {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1 1 auto;
}
.pp__modelname {
  font-size: 12.5px;
  line-height: 1.25;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pp__modelswitch {
  cursor: pointer;
}
.pp__model--off .pp__modelmark {
  opacity: 0.4;
}
.pp__model--off .pp__modelname {
  color: var(--muted);
}
.pp__customid {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.25;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pp__custominput {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 8px;
  font-size: 11.5px;
}
</style>
