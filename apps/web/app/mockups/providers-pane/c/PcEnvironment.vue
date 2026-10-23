<script setup lang="ts">
// Where the agent keeps its own files, and the variables kone passes it. A
// variable is three decisions in one row — its name, its value, whether the
// value is a secret — so they sit on one line, with the lock beside the value.
import { nextTick, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  Delete02Icon,
  Folder01Icon,
  LockIcon,
  PlusSignIcon,
  SquareUnlock01Icon,
} from "@hugeicons/core-free-icons";
import type { MockRow } from "~/mockups/providers-pane/useMockProvidersPane";
import { MOCK_ENV, MOCK_HOME, type MockEnvVar } from "~/mockups/providers-pane/sample";

const props = defineProps<{ row: MockRow }>();

const vars = ref<MockEnvVar[]>([]);
const list = ref<HTMLElement>();

watch(
  () => props.row.provider,
  (provider) => {
    vars.value = (MOCK_ENV[provider] ?? []).map((v) => ({ ...v }));
  },
  { immediate: true },
);

const home = () => MOCK_HOME[props.row.provider] ?? "";

async function addVar() {
  vars.value.push({ name: "", value: "", secret: false });
  await nextTick();
  const inputs = list.value?.querySelectorAll("input");
  inputs?.[inputs.length - 2]?.focus();
}

function removeVar(i: number) {
  vars.value.splice(i, 1);
}

/** A row that has no name yet still needs a spoken one. */
function varLabel(v: MockEnvVar, i: number): string {
  return v.name || `variable ${i + 1}`;
}
</script>

<template>
  <section class="pp__block" aria-label="Environment">
    <p class="pp__blocklabel">Environment</p>

    <div class="pc__home">
      <HugeiconsIcon :icon="Folder01Icon" :size="14" :stroke-width="1.7" aria-hidden="true" />
      <code class="pc__homepath">{{ home() }}</code>
      <button
        type="button"
        class="pp__btn"
        :aria-label="`Open the ${row.meta.label} config folder`"
      >
        Open
      </button>
      <button
        type="button"
        class="pp__btn"
        :aria-label="`Change the ${row.meta.label} config folder`"
      >
        Change
      </button>
    </div>

    <ul v-if="vars.length" ref="list" class="pc__envlist">
      <li v-for="(v, i) in vars" :key="i" class="pc__envrow">
        <input
          v-model="v.name"
          type="text"
          class="pp__input"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          placeholder="Name"
          :aria-label="`Variable ${i + 1} name`"
        />
        <input
          v-model="v.value"
          :type="v.secret ? 'password' : 'text'"
          class="pp__input"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          :placeholder="v.secret ? '••••' : 'Value'"
          :aria-label="`${varLabel(v, i)} value`"
        />
        <button
          type="button"
          role="switch"
          class="pc__envbtn"
          :class="{ 'pc__envbtn--on': v.secret }"
          :aria-checked="v.secret"
          :aria-label="`Secret ${varLabel(v, i)}`"
          @click="v.secret = !v.secret"
        >
          <HugeiconsIcon
            :icon="v.secret ? LockIcon : SquareUnlock01Icon"
            :size="14"
            :stroke-width="1.8"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          class="pc__envbtn pc__envbtn--remove"
          :aria-label="`Remove ${varLabel(v, i)}`"
          @click="removeVar(i)"
        >
          <HugeiconsIcon :icon="Delete02Icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
        </button>
      </li>
    </ul>

    <button type="button" class="pp__btn pp__btn--outline" @click="addVar">Add variable</button>
  </section>
</template>

<style scoped>
.pc__home {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 2px 0 9px;
}
.pc__home > svg {
  flex-shrink: 0;
  color: var(--muted);
}
.pc__homepath {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-soft);
}
.pc__home .pp__btn {
  flex-shrink: 0;
}

.pc__envlist {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}
.pc__envrow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.16fr) 26px 26px;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 8px 0;
  border-top: 1px solid var(--line-soft);
}
.pc__envbtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  color: var(--muted);
  cursor: pointer;
  transition:
    color var(--pp-t-micro) ease,
    background-color var(--pp-t-micro) ease;
}
.pc__envbtn:hover {
  color: var(--ink-soft);
  background-color: var(--hover);
}
.pc__envbtn--on {
  color: var(--ink-soft);
}
.pc__envbtn--remove:hover {
  color: var(--danger);
}
.pc__envbtn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
</style>
