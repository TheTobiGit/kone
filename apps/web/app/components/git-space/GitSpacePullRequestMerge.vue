<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { GitHubMergeMethod, GitHubPrAction, GitHubPullRequestDetail } from "~/types/desktop";

// What you can do to the open pull request, under its verdict: merge it, mark
// it ready, or reopen it, with a quieter way back to draft and a way to close.
//
// Merging and closing can't be quietly taken back, so each asks twice: the
// first press turns the button into the question ("Squash into main?") with a
// way out beside it, and only the second press acts. Left alone, the question
// stands down after a few seconds. Everything else acts on the first press.
//
// Merging needs write access. Its author can still mark it ready, send it back
// to draft, close it and reopen it, as GitHub allows; anyone else sees nothing,
// since GitHub would refuse them anyway.

const props = defineProps<{
  pr: GitHubPullRequestDetail;
  /** The person looking opened this pull request. */
  mine: boolean;
  /** Something else in the space is running; nothing here can start. */
  busy: boolean;
  /** The action in flight from here, for its button's word. */
  pending: GitHubPrAction | null;
  /** Why the last action failed, in GitHub's words. */
  error: string | null;
  /** What GitHub did instead of what was asked, such as queueing a merge. */
  notice?: string | null;
}>();

const emit = defineEmits<{
  act: [action: GitHubPrAction, method?: GitHubMergeMethod];
}>();

const METHOD = {
  merge: { label: "Merge commit", verb: "Merge", into: "Merge into" },
  squash: { label: "Squash", verb: "Squash and merge", into: "Squash into" },
  rebase: { label: "Rebase", verb: "Rebase and merge", into: "Rebase onto" },
} satisfies Record<GitHubMergeMethod, { label: string; verb: string; into: string }>;

const method = ref<GitHubMergeMethod>(props.pr.mergeMethods[0] ?? "merge");
watch(
  () => props.pr.mergeMethods,
  (methods) => {
    if (!methods.includes(method.value)) method.value = methods[0] ?? "merge";
  },
);

const open = computed(() => props.pr.state === "open");
const draft = computed(() => open.value && props.pr.isDraft);
const conflicting = computed(() => props.pr.mergeability === "conflicting");

// ── asking twice ─────────────────────────────────────────────────────────────

const armed = ref<"merge" | "close" | null>(null);
let disarmTimer: ReturnType<typeof setTimeout> | undefined;
function arm(what: "merge" | "close") {
  armed.value = what;
  clearTimeout(disarmTimer);
  disarmTimer = setTimeout(() => (armed.value = null), 5000);
}
function disarm() {
  armed.value = null;
  clearTimeout(disarmTimer);
}
onBeforeUnmount(() => clearTimeout(disarmTimer));
// A different pull request, or one that moved under you, asks again.
watch(() => [props.pr.number, props.pr.state, props.pr.isDraft], disarm);

function onMerge() {
  if (props.busy) return;
  if (armed.value !== "merge") return arm("merge");
  disarm();
  emit("act", "merge", method.value);
}
function onClose() {
  if (props.busy) return;
  if (armed.value !== "close") return arm("close");
  disarm();
  emit("act", "close");
}
function onPlain(action: "ready" | "draft" | "reopen") {
  if (props.busy) return;
  disarm();
  emit("act", action);
}

const mergeLabel = computed(() => {
  if (props.pending === "merge") return "Merging…";
  if (armed.value === "merge") return `${METHOD[method.value].into} ${props.pr.base}?`;
  return METHOD[method.value].verb;
});
</script>

<template>
  <div v-if="(pr.canWrite || mine) && pr.state !== 'merged'" class="gpm">
    <!-- An open, ready pull request: the merge, its method, and the way out. -->
    <template v-if="open && !draft && pr.canWrite">
      <div class="gpm__row">
        <button
          type="button"
          class="gpm__main"
          :class="{ 'gpm__main--armed': armed === 'merge' }"
          :disabled="busy || conflicting"
          :title="conflicting ? `Resolve the conflicts with ${pr.base} first` : undefined"
          @click="onMerge"
        >
          {{ mergeLabel }}
        </button>
        <button v-if="armed === 'merge'" type="button" class="gpm__quiet" @click="disarm">Cancel</button>
      </div>
      <div
        v-if="pr.mergeMethods.length > 1 && armed !== 'merge' && !conflicting"
        class="gpm__methods"
        role="radiogroup"
        aria-label="How to merge"
      >
        <button
          v-for="m in pr.mergeMethods"
          :key="m"
          type="button"
          role="radio"
          class="gpm__method"
          :class="{ 'gpm__method--on': method === m }"
          :aria-checked="method === m"
          :disabled="busy"
          @click="method = m"
        >
          {{ METHOD[m].label }}
        </button>
      </div>
    </template>

    <!-- A draft: the one step it's waiting on. -->
    <div v-else-if="draft" class="gpm__row">
      <button type="button" class="gpm__main" :disabled="busy" @click="onPlain('ready')">
        {{ pending === "ready" ? "Marking ready…" : "Mark ready for review" }}
      </button>
    </div>

    <!-- Closed without merging: it can come back. -->
    <div v-else-if="!open" class="gpm__row">
      <button type="button" class="gpm__main gpm__main--soft" :disabled="busy" @click="onPlain('reopen')">
        {{ pending === "reopen" ? "Reopening…" : "Reopen" }}
      </button>
    </div>

    <div v-if="open" class="gpm__links">
      <button v-if="!draft" type="button" class="gpm__quiet" :disabled="busy" @click="onPlain('draft')">
        {{ pending === "draft" ? "Returning to draft…" : "Back to draft" }}
      </button>
      <button
        type="button"
        class="gpm__quiet"
        :class="{ 'gpm__quiet--armed': armed === 'close' }"
        :disabled="busy"
        @click="onClose"
      >
        {{ pending === "close" ? "Closing…" : armed === "close" ? `Close #${pr.number} without merging?` : "Close" }}
      </button>
      <button v-if="armed === 'close'" type="button" class="gpm__quiet" @click="disarm">Keep it open</button>
    </div>

    <p v-if="error" class="gpm__error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="gpm__notice" role="status">{{ notice }}</p>
  </div>
</template>

<style scoped>
.gpm {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 16px;
}
.gpm__row,
.gpm__links {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.gpm__links {
  margin-left: -8px;
}
.gpm__main {
  height: 30px;
  padding-inline: 14px;
  border-radius: 9px;
  background-color: var(--ink);
  color: var(--ground);
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    opacity var(--gs-t-micro) var(--gs-ease),
    background-color var(--gs-t-micro) var(--gs-ease);
}
.gpm__main:hover:not(:disabled) {
  opacity: 0.88;
}
.gpm__main:disabled {
  opacity: 0.4;
  cursor: default;
}
/* The question wears the go colour, so the second press reads as the real one. */
.gpm__main--armed {
  background-color: var(--ok);
  color: var(--raised-high);
}
.gpm__main--soft {
  background-color: var(--hover);
  color: var(--ink);
}
.gpm__methods {
  display: inline-flex;
  align-self: flex-start;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background-color: var(--hover);
}
.gpm__method {
  height: 22px;
  padding-inline: 9px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gpm__method:hover:not(:disabled) {
  color: var(--ink);
}
.gpm__method--on {
  background-color: var(--raised-high);
  color: var(--ink);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
}
.gpm__quiet {
  height: 24px;
  padding-inline: 8px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gpm__quiet:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.gpm__quiet:disabled {
  opacity: 0.5;
  cursor: default;
}
.gpm__quiet--armed {
  color: var(--danger);
}
.gpm__quiet--armed:hover:not(:disabled) {
  color: var(--danger);
}
.gpm__main:focus-visible,
.gpm__method:focus-visible,
.gpm__quiet:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.gpm__notice {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-soft);
}
.gpm__error {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--danger);
}
@media (prefers-reduced-motion: reduce) {
  .gpm__main,
  .gpm__method,
  .gpm__quiet {
    transition: none;
  }
}
</style>
