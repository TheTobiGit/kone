<script setup lang="ts">
// Direction A — Add agent: the ACP registry, opened from the tile beside the deck.
// Inert: "Add" only marks the row in this panel.
import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Search01Icon } from "@hugeicons/core-free-icons";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import { MOCK_REGISTRY } from "~/mockups/providers-pane/sample";

const query = ref("");
const added = ref<string[]>(
  MOCK_REGISTRY.filter((agent) => agent.installed).map((agent) => agent.id),
);

const rows = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return MOCK_REGISTRY;
  return MOCK_REGISTRY.filter((agent) => agent.label.toLowerCase().includes(q));
});
</script>

<template>
  <div class="pa__addpop" role="dialog" aria-label="Add agent">
    <div class="pa__search">
      <HugeiconsIcon :icon="Search01Icon" :size="13" :stroke-width="1.9" aria-hidden="true" />
      <input
        v-model="query"
        type="text"
        class="pp__input"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        aria-label="Search agents"
      />
    </div>

    <ul class="pa__reglist">
      <li v-for="agent in rows" :key="agent.id" class="pa__regrow">
        <ProviderLogo :brand="agent.brand" :size="16" class="pa__regmark" />
        <span class="pa__reglabel">{{ agent.label }}</span>
        <span v-if="added.includes(agent.id)" class="pa__added">Added</span>
        <button
          v-else
          type="button"
          class="pp__btn pp__btn--outline pa__addbtn"
          @click="added.push(agent.id)"
        >
          Add
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.pa__addpop {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 296px;
  max-width: 70vw;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background-color: var(--panel);
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.1);
  animation: pp-in var(--pp-t-small) var(--pp-ease);
}
.pa__search {
  position: relative;
  display: flex;
  align-items: center;
}
.pa__search > svg {
  position: absolute;
  left: 9px;
  color: var(--muted);
  pointer-events: none;
}
.pa__search .pp__input {
  padding-left: 28px;
}
.pa__reglist {
  display: flex;
  flex-direction: column;
  max-height: 248px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.pa__regrow {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 5px 4px;
  border-top: 1px solid var(--line-soft);
}
.pa__regrow:first-child {
  border-top: none;
}
.pa__regmark {
  flex-shrink: 0;
}
.pa__reglabel {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 12.5px;
  line-height: 1.3;
  letter-spacing: -0.1px;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa__added {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
}
.pa__addbtn {
  flex-shrink: 0;
  padding: 3px 10px;
  font-size: 11.5px;
}
</style>
