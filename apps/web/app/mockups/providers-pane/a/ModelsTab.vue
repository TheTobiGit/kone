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

const removed = ref<string[]>([]);
const customModels = computed(() =>
  (MOCK_CUSTOM_MODELS[props.pane.current.value.provider] ?? []).filter(
    (id) => !removed.value.includes(id),
  ),
);

function brandFor(id: string) {
  const row = props.pane.current.value;
  return sessionBrand(row.provider, row.meta.brand, id);
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
        <button type="button" class="pp__btn">
          <HugeiconsIcon :icon="PlusSignIcon" :size="12" :stroke-width="2" aria-hidden="true" />
          Add model
        </button>
      </template>

      <template #after>
        <!-- Slot content keeps this component's scope, not MockModels', so the row
             repeats the list's own recipe rather than borrowing its class. -->
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
/* A model the user added by id, in the list's own row register: mark, id, and
   the one control that takes it away. */
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
/* The id itself is the name, so it wears the mono face the rest of the pane
   gives to things kone has to spell exactly. */
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
</style>
