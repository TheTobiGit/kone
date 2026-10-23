<script setup lang="ts">
// Direction A — Models: the kept Models list, with its own refresh/add actions in
// the head and the user's added model ids as extra rows at the end.
import { computed, onBeforeUnmount, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Delete02Icon, PlusSignIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import MockModels from "~/mockups/providers-pane/MockModels.vue";
import { MOCK_CUSTOM_MODELS } from "~/mockups/providers-pane/sample";
import type { MockProvidersPane } from "~/mockups/providers-pane/useMockProvidersPane";
import { sessionBrand } from "~/utils/modelCatalog";

const props = defineProps<{ pane: MockProvidersPane }>();

const added = ref<string[]>([]);
const removed = ref<string[]>([]);
const adding = ref(false);
const draft = ref("");

const customModels = computed(() => {
  const base = MOCK_CUSTOM_MODELS[props.pane.current.value.provider] ?? [];
  return [...base, ...added.value].filter((id) => !removed.value.includes(id));
});

function brandFor(id: string) {
  const row = props.pane.current.value;
  return sessionBrand(row.provider, row.meta.brand, id);
}

function submitCustom() {
  const id = draft.value.trim();
  if (id && !customModels.value.includes(id)) added.value.push(id);
  draft.value = "";
  adding.value = false;
}

// Inert: the spinner answers the press, nothing is fetched.
const refreshing = ref(false);
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function refresh() {
  refreshing.value = true;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => (refreshing.value = false), 900);
}

onBeforeUnmount(() => {
  if (refreshTimer) clearTimeout(refreshTimer);
});
</script>

<template>
  <div class="pa__models">
    <MockModels :pane="pane" class="pa__modelsinner">
      <template #actions>
        <button
          type="button"
          class="pp__btn pa__iconbtn"
          aria-label="Refresh models"
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
        <button type="button" class="pp__btn" @click="adding = !adding">
          <HugeiconsIcon :icon="PlusSignIcon" :size="12" :stroke-width="2" aria-hidden="true" />
          Add model
        </button>
      </template>

      <template #after>
        <li v-for="id in customModels" :key="id" class="pa__customrow">
          <ProviderLogo :brand="brandFor(id)" :size="16" class="pa__custommark" />
          <span class="pa__customid">{{ id }}</span>
          <button
            type="button"
            class="pp__btn pa__iconbtn"
            aria-label="Remove"
            @click="removed.push(id)"
          >
            <HugeiconsIcon :icon="Delete02Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          </button>
        </li>

        <li v-if="adding" class="pa__customrow">
          <ProviderLogo :brand="pane.current.value.meta.brand" :size="16" class="pa__custommark" />
          <input
            v-model="draft"
            type="text"
            class="pp__input pa__custominput"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            placeholder="model-id"
            aria-label="Custom model id"
            @keydown.enter.prevent="submitCustom"
          />
          <button type="button" class="pp__btn pp__btn--outline" @click="submitCustom">Add</button>
        </li>
      </template>
    </MockModels>
  </div>
</template>

<style scoped>
.pa__models {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  max-width: 860px;
  min-height: 0;
}
.pa__modelsinner {
  flex: 1 1 auto;
  min-height: 0;
}
.pa__iconbtn {
  padding-inline: 7px;
}
.pa__customrow {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
  padding: 9px 4px;
  border-top: 1px solid var(--line-soft);
}
.pa__custommark {
  flex-shrink: 0;
}
.pa__customid {
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
.pa__custominput {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
