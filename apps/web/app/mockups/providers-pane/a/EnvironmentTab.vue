<script setup lang="ts">
// Direction A — Environment: where this provider keeps its files, then the
// variables kone hands it at launch. Editable in the mockup, persisted nowhere.
import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  Delete02Icon,
  Folder01Icon,
  LockIcon,
  PlusSignIcon,
  SquareUnlock01Icon,
} from "@hugeicons/core-free-icons";
import { MOCK_ENV, MOCK_HOME } from "~/mockups/providers-pane/sample";
import type { MockProvidersPane } from "~/mockups/providers-pane/useMockProvidersPane";

const props = defineProps<{ pane: MockProvidersPane }>();

type VarRow = { name: string; value: string; secret: boolean };

const home = computed(() => MOCK_HOME[props.pane.current.value.provider] ?? "");
const vars = ref<VarRow[]>(
  (MOCK_ENV[props.pane.current.value.provider] ?? []).map((v) => ({ ...v })),
);

const MASK = "••••••••";

/** A secret's value never renders; unlocking shows the real string again. */
function shown(v: VarRow): string {
  return v.secret ? MASK : v.value;
}

function setValue(v: VarRow, e: Event) {
  if (v.secret || !(e.target instanceof HTMLInputElement)) return;
  v.value = e.target.value;
}

function addVar() {
  vars.value.push({ name: "", value: "", secret: false });
}
</script>

<template>
  <div class="pa__env">
    <section class="pa__home" aria-label="Home">
      <HugeiconsIcon :icon="Folder01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
      <span class="pa__homepath">{{ home }}</span>
      <button type="button" class="pp__btn">Open</button>
      <button type="button" class="pp__btn">Change</button>
    </section>

    <section class="pa__vars" aria-label="Variables">
      <div v-for="(v, i) in vars" :key="i" class="pa__var">
        <input
          v-model="v.name"
          type="text"
          class="pp__input"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          aria-label="Variable name"
        />
        <input
          :value="shown(v)"
          type="text"
          class="pp__input"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          :readonly="v.secret"
          aria-label="Variable value"
          @input="setValue(v, $event)"
        />
        <button
          type="button"
          class="pp__btn pa__iconbtn"
          :class="{ 'pa__iconbtn--on': v.secret }"
          :aria-pressed="v.secret"
          :aria-label="v.secret ? 'Make the variable visible' : 'Keep the variable secret'"
          @click="v.secret = !v.secret"
        >
          <HugeiconsIcon
            :icon="v.secret ? LockIcon : SquareUnlock01Icon"
            :size="13"
            :stroke-width="1.8"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          class="pp__btn pa__iconbtn"
          aria-label="Remove variable"
          @click="vars.splice(i, 1)"
        >
          <HugeiconsIcon :icon="Delete02Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
        </button>
      </div>

      <button type="button" class="pp__btn pp__btn--outline pa__addvar" @click="addVar">
        <HugeiconsIcon :icon="PlusSignIcon" :size="12" :stroke-width="2" aria-hidden="true" />
        Add variable
      </button>
    </section>
  </div>
</template>

<style scoped>
.pa__env {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: 760px;
}
.pa__home {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line-soft);
}
.pa__home > svg {
  flex-shrink: 0;
  color: var(--muted);
}
.pa__homepath {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pa__vars {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pa__var {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.pa__var .pp__input {
  min-width: 0;
}
.pa__iconbtn {
  padding-inline: 7px;
}
/* Locked reads as held: the padlock sits at full ink, an open field stays quiet. */
.pa__iconbtn--on {
  color: var(--ink);
}
.pa__addvar {
  align-self: flex-start;
  gap: 7px;
  margin-top: 4px;
}
</style>
