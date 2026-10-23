<script setup lang="ts">
// The models board: the kept Models list, with the two controls that belong to
// the list itself (refresh, add by id), and the models the user added themselves
// drawn as their own rows at the end.
import { ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Delete02Icon, Link01Icon, PlusSignIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import MockModels from "~/mockups/providers-pane/MockModels.vue";
import type { MockProvidersPane } from "~/mockups/providers-pane/useMockProvidersPane";
import { MOCK_CUSTOM_MODELS } from "~/mockups/providers-pane/sample";

const props = defineProps<{ pane: MockProvidersPane }>();

const customs = ref<string[]>([]);
const adding = ref(false);
const draft = ref("");
const refreshing = ref(false);

watch(
  () => props.pane.current.value.provider,
  (provider) => {
    customs.value = [...(MOCK_CUSTOM_MODELS[provider] ?? [])];
    adding.value = false;
    draft.value = "";
  },
  { immediate: true },
);

function addModel() {
  const id = draft.value.trim();
  if (id && !customs.value.includes(id)) customs.value.push(id);
  draft.value = "";
  adding.value = false;
}

function removeModel(id: string) {
  customs.value = customs.value.filter((m) => m !== id);
}

function refresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  setTimeout(() => {
    refreshing.value = false;
  }, 900);
}
</script>

<template>
  <MockModels :pane="pane">
    <template #actions>
      <button
        type="button"
        class="pp__btn pc__iconbtn"
        aria-label="Refresh models"
        :aria-busy="refreshing"
        @click="refresh"
      >
        <HugeiconsIcon
          :icon="RefreshIcon"
          :size="13"
          :stroke-width="1.8"
          :class="{ 'pp__spin': refreshing }"
          aria-hidden="true"
        />
      </button>
      <button type="button" class="pp__btn" @click="adding = !adding">Add model</button>
    </template>

    <template #after>
      <li v-for="id in customs" :key="id" class="pc__model pc__model--custom">
        <HugeiconsIcon
          :icon="Link01Icon"
          :size="14"
          :stroke-width="1.7"
          class="pc__modelmark"
          aria-hidden="true"
        />
        <span class="pc__modelname">{{ id }}</span>
        <button
          type="button"
          class="pc__remove"
          :aria-label="`Remove ${id}`"
          @click="removeModel(id)"
        >
          <HugeiconsIcon :icon="Delete02Icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
        </button>
      </li>

      <li v-if="adding" class="pc__model pc__model--new">
        <HugeiconsIcon
          :icon="PlusSignIcon"
          :size="14"
          :stroke-width="1.8"
          class="pc__modelmark"
          aria-hidden="true"
        />
        <input
          v-model="draft"
          type="text"
          class="pp__input pc__modelinput"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          placeholder="vendor/model"
          aria-label="New model id"
          @keydown.enter.prevent="addModel"
        />
        <button type="button" class="pp__btn" @click="addModel">Add</button>
      </li>
    </template>
  </MockModels>
</template>

<style scoped>
.pc__iconbtn {
  padding-inline: 6px;
}
/* A model the user added by id: same row rhythm as the catalog rows above it,
   but it names a string rather than a family, so it stays mono. */
.pc__model {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 4px;
  border-top: 1px solid var(--line-soft);
  min-width: 0;
}
.pc__modelmark {
  flex-shrink: 0;
  color: var(--muted);
}
.pc__modelname {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.3;
  color: var(--ink-soft);
}
.pc__remove {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  transition:
    color var(--pp-t-micro) ease,
    background-color var(--pp-t-micro) ease;
}
.pc__remove:hover {
  color: var(--danger);
  background-color: var(--hover);
}
.pc__remove:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.pc__modelinput {
  flex: 1 1 auto;
  min-width: 0;
  padding-block: 5px;
}
</style>
