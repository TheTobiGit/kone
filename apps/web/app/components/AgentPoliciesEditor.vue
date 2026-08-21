<script setup lang="ts">
import { ref } from "vue";
import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import { useSound } from "~/composables/useSound";
import type { AgentPolicies } from "~/utils/agents";

// The editable half of §1.4 policies: the standing prohibitions, the mirror of
// capabilities. A capability names what the agent may reach for; a policy names
// what it may never do. Both lists are freeform — a command line to block, a
// path to keep out of — so unlike the capability editor there is no inventory
// to pick from, just entries the user types and removes. An empty list forbids
// nothing. Both Create and the roster detail mount this, so the add/remove
// logic lives in one place.

const props = defineProps<{
  deniedCommands: string[];
  deniedPaths: string[];
}>();
const emit = defineEmits<{
  "update:deniedCommands": [string[]];
  "update:deniedPaths": [string[]];
}>();

const { cue } = useSound();

const commandDraft = ref("");
const pathDraft = ref("");

/** A typed entry, trimmed and de-duplicated against a list — null when there is
 *  nothing to add, so the field can be spammed with Enter without piling up
 *  blanks or repeats. */
function accept(list: string[], draft: string): string[] | null {
  const value = draft.trim();
  if (!value || list.includes(value)) return null;
  return [...list, value];
}

function addCommand() {
  const next = accept(props.deniedCommands, commandDraft.value);
  if (!next) return;
  cue("toggle");
  emit("update:deniedCommands", next);
  commandDraft.value = "";
}
function addPath() {
  const next = accept(props.deniedPaths, pathDraft.value);
  if (!next) return;
  cue("toggle");
  emit("update:deniedPaths", next);
  pathDraft.value = "";
}

function removeCommand(entry: string) {
  cue("toggle");
  emit("update:deniedCommands", props.deniedCommands.filter((c) => c !== entry));
}
function removePath(entry: string) {
  cue("toggle");
  emit("update:deniedPaths", props.deniedPaths.filter((p) => p !== entry));
}
</script>

<template>
  <div class="pol">
    <!-- Denied commands -->
    <section class="pol__block">
      <div class="pol__head">
        <span class="pol__label">Denied commands</span>
        <span class="pol__state">{{ deniedCommands.length || "None" }}{{ deniedCommands.length ? " blocked" : "" }}</span>
      </div>
      <p class="pol__hint">Command lines this agent may never run, matched anywhere in the command — <code>rm -rf</code> stops it however the path is dressed up.</p>

      <div v-if="deniedCommands.length" class="pol__chips">
        <span v-for="entry in deniedCommands" :key="entry" class="pol__chip">
          <code class="pol__mono">{{ entry }}</code>
          <button type="button" class="pol__x" :aria-label="`Remove ${entry}`" @click="removeCommand(entry)">
            <HugeiconsIcon :icon="Cancel01Icon" :size="11" :stroke-width="2" />
          </button>
        </span>
      </div>

      <form class="pol__add" @submit.prevent="addCommand">
        <input
          v-model="commandDraft"
          class="pol__input"
          type="text"
          placeholder="e.g. rm -rf, git push --force"
          spellcheck="false"
          autocapitalize="off"
        />
        <button type="submit" class="pol__addbtn" :disabled="!commandDraft.trim()" aria-label="Add command">
          <HugeiconsIcon :icon="PlusSignIcon" :size="13" :stroke-width="2" />
        </button>
      </form>
    </section>

    <!-- Denied paths -->
    <section class="pol__block">
      <div class="pol__head">
        <span class="pol__label">Denied paths</span>
        <span class="pol__state">{{ deniedPaths.length || "None" }}{{ deniedPaths.length ? " blocked" : "" }}</span>
      </div>
      <p class="pol__hint">Files and folders kept out of reach. A leaf like <code>.env</code> blocks it wherever it sits (and <code>.env.local</code> with it); a fragment like <code>secrets</code> blocks that whole folder; <code>*.pem</code> globs.</p>

      <div v-if="deniedPaths.length" class="pol__chips">
        <span v-for="entry in deniedPaths" :key="entry" class="pol__chip">
          <code class="pol__mono">{{ entry }}</code>
          <button type="button" class="pol__x" :aria-label="`Remove ${entry}`" @click="removePath(entry)">
            <HugeiconsIcon :icon="Cancel01Icon" :size="11" :stroke-width="2" />
          </button>
        </span>
      </div>

      <form class="pol__add" @submit.prevent="addPath">
        <input
          v-model="pathDraft"
          class="pol__input"
          type="text"
          placeholder="e.g. .env, secrets, *.pem"
          spellcheck="false"
          autocapitalize="off"
        />
        <button type="submit" class="pol__addbtn" :disabled="!pathDraft.trim()" aria-label="Add path">
          <HugeiconsIcon :icon="PlusSignIcon" :size="13" :stroke-width="2" />
        </button>
      </form>
    </section>
  </div>
</template>

<style scoped>
.pol {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.pol__block {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.pol__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.pol__label {
  font-size: 13px;
  color: var(--ink);
}
.pol__state {
  font-size: 11.5px;
  color: var(--muted);
  text-align: right;
}
.pol__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
  max-width: 60ch;
  text-wrap: pretty;
}
.pol__hint code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--ink-soft);
}
.pol__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pol__chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  padding: 5px 7px 5px 11px;
  border-radius: 999px;
}
.pol__mono {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11.5px;
}
.pol__x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border: 0;
  border-radius: 50%;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}
.pol__x:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 10%, transparent);
}
.pol__add {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.pol__input {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  padding: 7px 12px;
  border: 0;
  border-radius: 9px;
  outline: none;
  transition: box-shadow 0.16s ease;
}
.pol__input::placeholder {
  color: var(--faint);
}
.pol__input:focus {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 32%, transparent);
}
.pol__addbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 9px;
  color: var(--ink-soft);
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease,
    opacity 0.16s ease;
}
.pol__addbtn:hover:not(:disabled) {
  color: var(--ink);
  background: var(--hover);
}
.pol__addbtn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
