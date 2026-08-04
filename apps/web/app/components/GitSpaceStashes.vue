<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Archive02Icon } from "@hugeicons/core-free-icons";
import type { useGitSpace } from "~/composables/useGitSpace";
import type { useProjectGit } from "~/composables/useProjectGit";

// Work set aside.
//
// A stash is only ever useful if you can remember what it was, so the message
// gets the emphasis and everything else — which branch it came off, how long
// ago — sits underneath it in the quiet type. Applying keeps the stash, popping
// spends it, and dropping is a hold, because a dropped stash is genuinely gone.

const props = defineProps<{
  space: ReturnType<typeof useGitSpace>;
  git: ReturnType<typeof useProjectGit>;
}>();

const { cue } = useSound();

const naming = ref(false);
const message = ref("");
const messageEl = ref<HTMLInputElement | null>(null);

const busy = computed(() => props.space.op.value !== null);
const dirty = computed(() => !props.git.clean.value);

async function startStash() {
  cue("toggle");
  naming.value = true;
  message.value = "";
  await nextTick();
  messageEl.value?.focus();
}
function cancel() {
  naming.value = false;
  message.value = "";
}
async function submit() {
  cue("press");
  const ok = await props.space.stash({
    message: message.value.trim() || undefined,
    includeUntracked: true,
  });
  if (ok) cancel();
}

function apply(index: number, pop: boolean) {
  cue("press");
  void props.space.applyStash(index, pop);
}
function drop(index: number) {
  void props.space.dropStash(index);
}
</script>

<template>
  <section class="gss">
    <header class="gss__head">
      <span class="gss__eyebrow">Stashed</span>
      <span class="gss__count">{{ space.stashes.value.length }}</span>
      <span class="gss__fill" />
      <button
        v-if="dirty && !naming"
        type="button"
        class="gss__sweep"
        :disabled="busy"
        @click="startStash"
      >
        <HugeiconsIcon :icon="Archive02Icon" :size="12" :stroke-width="1.8" aria-hidden="true" />
        Stash {{ git.fileCount.value }} change{{ git.fileCount.value === 1 ? "" : "s" }}
      </button>
    </header>

    <div v-if="naming" class="gss__row gss__row--edit">
      <span class="gss__ref">new</span>
      <input
        ref="messageEl"
        v-model="message"
        class="gss__input"
        type="text"
        spellcheck="false"
        placeholder="What is this, in a few words?"
        :disabled="busy"
        @keydown.enter.prevent="submit"
        @keydown.esc.prevent="cancel"
      />
      <button type="button" class="gss__act" @click="cancel">Cancel</button>
      <button type="button" class="gss__act gss__act--go" :disabled="busy" @click="submit">
        Stash
      </button>
    </div>

    <div
      v-for="(s, i) in space.stashes.value"
      :key="s.ref"
      class="gss__row"
      :style="{ '--i': i }"
    >
      <span class="gss__ref">{{ s.index }}</span>
      <span class="gss__body">
        <span class="gss__message">{{ s.message || "(no message)" }}</span>
        <span class="gss__meta">
          <span v-if="s.branch">on {{ s.branch }}</span>
          <span>{{ s.relative }}</span>
        </span>
      </span>

      <div class="gss__actions">
        <HoldToConfirm
          :aria-label="`Hold to drop stash ${s.ref}`"
          title="Hold to drop"
          @confirm="drop(s.index)"
        >
          Drop
        </HoldToConfirm>
        <button type="button" class="gss__act" :disabled="busy" @click="apply(s.index, false)">
          Apply
        </button>
        <button
          type="button"
          class="gss__act gss__act--go"
          :disabled="busy"
          title="Apply and remove the stash"
          @click="apply(s.index, true)"
        >
          Pop
        </button>
      </div>
    </div>

    <p v-if="!space.stashes.value.length && !naming" class="gss__empty">
      Nothing stashed.
      <span class="gss__empty-sub">
        <template v-if="dirty">Set the current changes aside without committing them.</template>
        <template v-else>Work you set aside will wait here.</template>
      </span>
    </p>
  </section>
</template>

<style scoped>
.gss {
  display: flex;
  flex-direction: column;
  padding-bottom: 12px;
}

.gss__head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  margin-bottom: 6px;
  padding-inline: 8px;
}
.gss__eyebrow {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  line-height: 1;
  color: var(--muted);
}
.gss__count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  opacity: 0.65;
}
.gss__fill {
  flex: 1 1 auto;
}
.gss__sweep {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gss__sweep:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink-soft);
}
.gss__sweep:disabled {
  opacity: 0.4;
  cursor: default;
}
.gss__sweep:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.gss__row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 42px;
  padding: 5px 8px;
  border-radius: 9px;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
  animation: gss-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i), 7) * var(--gs-stagger));
}
@keyframes gss-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.gss__row:hover,
.gss__row:focus-within {
  background-color: var(--hover);
}
.gss__row--edit {
  animation: none;
}

.gss__ref {
  flex-shrink: 0;
  min-width: 3ch;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  opacity: 0.7;
}
.gss__body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1 1 auto;
  min-width: 0;
}
.gss__message {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  letter-spacing: -0.1px;
  color: var(--ink);
}
.gss__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  color: var(--muted);
}

.gss__input {
  flex: 1 1 auto;
  min-width: 0;
  height: 26px;
  padding-inline: 9px;
  border-radius: 7px;
  background-color: var(--sunken);
  border: none;
  outline: none;
  font-family: var(--font-sans);
  font-size: 12.5px;
  color: var(--ink);
}
.gss__input::placeholder {
  color: var(--muted);
}

.gss__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  flex-shrink: 0;
  min-width: 156px;
  opacity: 0;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.gss__row:hover .gss__actions,
.gss__row:focus-within .gss__actions {
  opacity: 1;
}
.gss__act {
  padding: 3px 6px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gss__act:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.gss__act--go {
  color: var(--ink-soft);
}
.gss__act:disabled {
  opacity: 0.4;
  cursor: default;
}
.gss__act:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
/* The edit row's buttons are the point of the row — always visible. */
.gss__row--edit .gss__act {
  opacity: 1;
}

.gss__empty {
  padding: 2px 8px;
  max-width: 52ch;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-soft);
}
.gss__empty-sub {
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .gss__row {
    animation: none;
  }
  .gss__row,
  .gss__actions,
  .gss__act,
  .gss__sweep {
    transition: none;
  }
}
</style>
