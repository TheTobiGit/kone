<script setup lang="ts">
// The ACP registry, in the one place a set of agents is managed: search, then
// one row per agent with the only two states that matter — Add, or Added.
import { computed, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { CheckmarkCircle02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { MOCK_REGISTRY } from "~/mockups/providers-pane/sample";

const query = ref("");
const search = ref<HTMLInputElement>();
const added = ref<string[]>([]);

const entries = computed(() => {
  const q = query.value.trim().toLowerCase();
  return MOCK_REGISTRY.filter((a) => !q || a.label.toLowerCase().includes(q));
});

function isAdded(id: string, installed: boolean): boolean {
  return installed || added.value.includes(id);
}

function add(id: string) {
  if (!added.value.includes(id)) added.value.push(id);
}

onMounted(() => search.value?.focus());
</script>

<template>
  <div class="pc__addpanel" role="dialog" aria-label="Add agent">
    <div class="pc__addsearch">
      <HugeiconsIcon :icon="Search01Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
      <input
        ref="search"
        v-model="query"
        type="text"
        class="pp__input pc__addinput"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        placeholder="Search"
        aria-label="Search agents"
      />
    </div>

    <ul class="pc__addlist">
      <li v-for="agent in entries" :key="agent.id" class="pc__addrow">
        <span class="pc__addlogo">
          <ProviderLogo :brand="agent.brand" :size="15" />
        </span>
        <span class="pc__addlabel">{{ agent.label }}</span>
        <span v-if="isAdded(agent.id, agent.installed)" class="pc__adddone">
          <HugeiconsIcon
            :icon="CheckmarkCircle02Icon"
            :size="12"
            :stroke-width="2"
            aria-hidden="true"
          />
          Added
        </span>
        <button
          v-else
          type="button"
          class="pp__btn pc__addbtn"
          :aria-label="`Add ${agent.label}`"
          @click="add(agent.id)"
        >
          Add
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.pc__addpanel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding: 10px;
  border-radius: 14px;
  background-color: var(--panel);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 16px 40px rgb(0 0 0 / 0.16);
  animation: pp-in 180ms var(--pp-ease) backwards;
}
.pc__addsearch {
  position: relative;
  display: flex;
  align-items: center;
}
.pc__addsearch > svg {
  position: absolute;
  left: 9px;
  color: var(--muted);
  pointer-events: none;
}
.pc__addinput {
  padding-left: 27px;
}
.pc__addlist {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 236px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
  list-style: none;
}
.pc__addlist::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.pc__addrow {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 4px 4px 4px 6px;
  border-radius: 8px;
  min-width: 0;
}
.pc__addrow:hover {
  background-color: var(--hover);
}
.pc__addlogo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background-color: var(--hover);
}
.pc__addlabel {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--ink);
}
.pc__addbtn {
  flex-shrink: 0;
  height: 24px;
  padding-inline: 8px;
}
.pc__adddone {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  height: 24px;
  padding-inline: 6px;
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
}
</style>
