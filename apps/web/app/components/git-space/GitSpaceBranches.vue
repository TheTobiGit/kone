<script setup lang="ts">
import { computed, nextTick, ref, type ComponentPublicInstance } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Add01Icon } from "@hugeicons/core-free-icons";
import type { useGitSpace } from "~/composables/useGitSpace";
import HoldToConfirm from "~/components/ui/HoldToConfirm.vue";

// Every branch, local and remote, and what you can do to each.
//
// The current branch is the only one that gets colour, so the answer to "where
// am I" is pre-attention. Everything else is a name, its upstream, and how far
// it has drifted — the three facts that decide whether you want to switch to it,
// merge it, or be rid of it.

const props = defineProps<{ space: ReturnType<typeof useGitSpace> }>();

const { cue } = useSound();

const filter = ref("");
const creating = ref(false);
const newName = ref("");
const newNameEl = ref<HTMLInputElement | null>(null);
const renaming = ref<string | null>(null);
const renameTo = ref("");
// A plain `ref` inside a v-for collects into an array; only one row is ever in
// rename, so take the element by hand instead.
const renameEl = ref<HTMLInputElement | null>(null);
function setRenameEl(el: Element | ComponentPublicInstance | null) {
  renameEl.value = el instanceof HTMLInputElement ? el : null;
}

const busy = computed(() => props.space.op.value !== null);
const current = computed(() => props.space.branches.value.find((b) => b.current) ?? null);

function match(name: string) {
  const q = filter.value.trim().toLowerCase();
  return !q || name.toLowerCase().includes(q);
}
const local = computed(() =>
  props.space.branches.value.filter((b) => !b.remote && match(b.name)),
);
const remote = computed(() =>
  props.space.branches.value.filter((b) => b.remote && match(b.name)),
);
// The filter earns its place only once scanning is actually work.
const filterable = computed(() => props.space.branches.value.length > 8);

/** "origin/feature/x" → "feature/x" */
function localNameOf(remoteRef: string) {
  const i = remoteRef.indexOf("/");
  return i === -1 ? remoteRef : remoteRef.slice(i + 1);
}
/** A remote branch already checked out locally is a switch, not a new branch. */
function hasLocal(remoteRef: string) {
  const name = localNameOf(remoteRef);
  return props.space.branches.value.some((b) => !b.remote && b.name === name);
}

async function startCreate() {
  cue("toggle");
  creating.value = true;
  newName.value = "";
  await nextTick();
  newNameEl.value?.focus();
}
function cancelCreate() {
  creating.value = false;
  newName.value = "";
}
async function submitCreate() {
  const name = newName.value.trim();
  if (!name) return cancelCreate();
  cue("press");
  const ok = await props.space.createBranch(name, { checkout: true });
  if (ok) cancelCreate();
}

async function startRename(name: string) {
  cue("toggle");
  renaming.value = name;
  renameTo.value = name;
  await nextTick();
  renameEl.value?.select();
}
function cancelRename() {
  renaming.value = null;
  renameTo.value = "";
}
async function submitRename(from: string) {
  const to = renameTo.value.trim();
  if (!to || to === from) return cancelRename();
  const ok = await props.space.renameBranch(from, to);
  if (ok) cancelRename();
}

function switchTo(name: string) {
  cue("press");
  void props.space.switchBranch(name);
}
function merge(name: string) {
  cue("press");
  void props.space.mergeBranch(name);
}
function remove(name: string) {
  void props.space.deleteBranch(name);
}
function removeRemote(remoteRef: string) {
  void props.space.deleteBranch(localNameOf(remoteRef), { remote: true });
}
function checkoutRemote(remoteRef: string) {
  cue("press");
  const name = localNameOf(remoteRef);
  if (hasLocal(remoteRef)) void props.space.switchBranch(name);
  else void props.space.createBranch(name, { from: remoteRef, checkout: true });
}
</script>

<template>
  <section class="gsb">
    <div class="gsb__lane">
      <header class="gsb__lanehead">
        <span class="gsb__eyebrow">Local</span>
        <span class="gsb__count">{{ local.length }}</span>
        <span class="gsb__fill" />
        <input
          v-if="filterable"
          v-model="filter"
          class="gsb__filter"
          type="text"
          spellcheck="false"
          placeholder="Filter"
          aria-label="Filter branches"
        />
        <button type="button" class="gsb__sweep" :disabled="busy" @click="startCreate">
          <HugeiconsIcon :icon="Add01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
          New branch
        </button>
      </header>

      <!-- The new-branch field is a row in the list, not a dialog over it. -->
      <div v-if="creating" class="gsb__row gsb__row--edit">
        <span class="gsb__marker" aria-hidden="true"><i class="gsb__dot" /></span>
        <input
          ref="newNameEl"
          v-model="newName"
          class="gsb__input"
          type="text"
          spellcheck="false"
          placeholder="branch name"
          :disabled="busy"
          @keydown.enter.prevent="submitCreate"
          @keydown.esc.prevent="cancelCreate"
        />
        <span class="gsb__hint">from {{ current?.name ?? "HEAD" }} · Enter to create</span>
        <button type="button" class="gsb__act" @click="cancelCreate">Cancel</button>
      </div>

      <div
        v-for="(b, i) in local"
        :key="b.name"
        class="gsb__row"
        :class="{ 'gsb__row--current': b.current }"
        :style="{ '--i': i }"
      >
        <span class="gsb__marker" aria-hidden="true"><i class="gsb__dot" /></span>

        <template v-if="renaming === b.name">
          <input
            :ref="setRenameEl"
            v-model="renameTo"
            class="gsb__input"
            type="text"
            spellcheck="false"
            :disabled="busy"
            @keydown.enter.prevent="submitRename(b.name)"
            @keydown.esc.prevent="cancelRename"
          />
          <span class="gsb__hint">Enter to rename</span>
          <button type="button" class="gsb__act" @click="cancelRename">Cancel</button>
        </template>

        <template v-else>
          <span class="gsb__name">{{ b.name }}</span>
          <span v-if="b.upstream" class="gsb__upstream">{{ b.upstream }}</span>
          <span class="gsb__drift">
            <span v-if="b.ahead" class="gsb__ahead">↑{{ b.ahead }}</span>
            <span v-if="b.behind" class="gsb__behind">↓{{ b.behind }}</span>
          </span>

          <div class="gsb__actions">
            <template v-if="!b.current">
              <HoldToConfirm
                :aria-label="`Hold to delete branch ${b.name}`"
                title="Hold to delete"
                @confirm="remove(b.name)"
              >
                Delete
              </HoldToConfirm>
              <button
                type="button"
                class="gsb__act"
                :disabled="busy"
                @click="startRename(b.name)"
              >
                Rename
              </button>
              <button
                type="button"
                class="gsb__act"
                :disabled="busy"
                :title="`Merge ${b.name} into ${current?.name ?? 'HEAD'}`"
                @click="merge(b.name)"
              >
                Merge
              </button>
              <button
                type="button"
                class="gsb__act gsb__act--go"
                :disabled="busy"
                @click="switchTo(b.name)"
              >
                Switch
              </button>
            </template>
            <button
              v-else
              type="button"
              class="gsb__act"
              :disabled="busy"
              @click="startRename(b.name)"
            >
              Rename
            </button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="remote.length" class="gsb__lane">
      <header class="gsb__lanehead">
        <span class="gsb__eyebrow">Remote</span>
        <span class="gsb__count">{{ remote.length }}</span>
        <span class="gsb__fill" />
      </header>

      <div
        v-for="(b, i) in remote"
        :key="b.name"
        class="gsb__row gsb__row--remote"
        :style="{ '--i': i }"
      >
        <span class="gsb__marker" aria-hidden="true"><i class="gsb__dot" /></span>
        <span class="gsb__name">{{ b.name }}</span>
        <span v-if="hasLocal(b.name)" class="gsb__upstream">tracked</span>
        <span class="gsb__drift" />

        <div class="gsb__actions">
          <HoldToConfirm
            :aria-label="`Hold to delete remote branch ${b.name}`"
            title="Hold to delete on the remote"
            @confirm="removeRemote(b.name)"
          >
            Delete
          </HoldToConfirm>
          <button
            type="button"
            class="gsb__act gsb__act--go"
            :disabled="busy"
            @click="checkoutRemote(b.name)"
          >
            {{ hasLocal(b.name) ? "Switch" : "Check out" }}
          </button>
        </div>
      </div>
    </div>

    <p v-if="!local.length && !remote.length && filter" class="gsb__empty">
      No branch matches “{{ filter }}”.
    </p>
  </section>
</template>

<style scoped>
.gsb {
  display: flex;
  flex-direction: column;
  padding-bottom: 12px;
}
.gsb__lane + .gsb__lane {
  margin-top: 26px;
}

.gsb__lanehead {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  margin-bottom: 6px;
  padding-inline: 8px;
}
.gsb__eyebrow {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  line-height: 1;
  color: var(--muted);
}
.gsb__count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  opacity: 0.65;
}
.gsb__fill {
  flex: 1 1 auto;
}
/* Bare until you reach for it — an always-filled pill up here would read as the
   heaviest thing in a section made of quiet rows. */
.gsb__filter {
  width: 120px;
  height: 22px;
  padding-inline: 8px;
  border-radius: 7px;
  background-color: transparent;
  border: none;
  outline: none;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink);
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.gsb__filter:hover,
.gsb__filter:focus {
  background-color: var(--sunken);
}
.gsb__filter::placeholder {
  color: var(--muted);
}
.gsb__sweep {
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
.gsb__sweep:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink-soft);
}
.gsb__sweep:disabled {
  opacity: 0.4;
  cursor: default;
}
.gsb__sweep:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── row ──────────────────────────────────────────────────────────────────── */
.gsb__row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding-inline: 8px;
  border-radius: 8px;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
  animation: gsb-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i), 7) * var(--gs-stagger));
}
@keyframes gsb-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.gsb__row:hover,
.gsb__row:focus-within {
  background-color: var(--hover);
}
.gsb__row--edit {
  animation: none;
}

/* A fixed gutter again, so the current-branch dot never nudges the names. */
.gsb__marker {
  flex-shrink: 0;
  width: 6px;
  display: flex;
  justify-content: center;
}
.gsb__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background-color: var(--accent);
  opacity: 0;
}
.gsb__row--current .gsb__dot {
  opacity: 1;
}

.gsb__name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1;
  color: var(--ink);
}
.gsb__row--current .gsb__name {
  color: var(--accent);
}
.gsb__row--remote .gsb__name {
  color: var(--ink-soft);
}
.gsb__upstream,
.gsb__hint {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  color: var(--muted);
}
.gsb__hint {
  flex: 1 1 auto;
}
.gsb__drift {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 60px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.gsb__ahead {
  color: var(--ink-soft);
}
.gsb__behind {
  color: var(--muted);
}

.gsb__input {
  flex: 0 1 260px;
  height: 24px;
  padding-inline: 8px;
  border-radius: 7px;
  background-color: var(--sunken);
  border: none;
  outline: none;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink);
}
.gsb__input::placeholder {
  color: var(--muted);
}

.gsb__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  flex-shrink: 0;
  min-width: 210px;
  opacity: 0;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.gsb__row:hover .gsb__actions,
.gsb__row:focus-within .gsb__actions {
  opacity: 1;
}
.gsb__act {
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
.gsb__act:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
/* The one action per row you most likely came for. */
.gsb__act--go {
  color: var(--ink-soft);
}
.gsb__act:disabled {
  opacity: 0.4;
  cursor: default;
}
.gsb__act:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.gsb__empty {
  padding: 6px 8px;
  font-size: 12.5px;
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .gsb__row {
    animation: none;
  }
  .gsb__row,
  .gsb__filter,
  .gsb__sweep,
  .gsb__actions,
  .gsb__act {
    transition: none;
  }
}
</style>
