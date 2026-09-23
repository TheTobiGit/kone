<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  Alert02Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  failedWorkspaceStep,
  isWorkspaceCancellable,
  workspaceStepsSettled,
  type WorkspaceStepRow,
} from "~/utils/workspaceSteps";
import WorktreeIcon from "~/components/icons/WorktreeIcon.vue";

// Building the worktree this thread asked for, on a strip tucked under the
// composer's roof — the mirror of the context tray under its floor, which is
// where the worktree chip already says where the turn lands.
//
// One line at rest, so nothing moves while the build reports: the heading and,
// beside it, the step in hand or the sentence worth reading once it settles
// (where the worktree started from, or what git said when a step broke). The
// whole list opens on request, upwards, and only the strip grows.
//
// It stays until it is put away — by its own close, or by the next request,
// which the host takes care of — so a build that finished while nobody was
// looking is still there to be read.

const props = defineProps<{
  /** The steps and where each one stands. Empty draws nothing. */
  steps: WorkspaceStepRow[];
}>();

const emit = defineEmits<{
  /** Back out — undo whatever the build produces. */
  cancel: [];
  /** Put the strip away. */
  dismiss: [];
}>();

const failed = computed(() => failedWorkspaceStep(props.steps));
const settled = computed(() => workspaceStepsSettled(props.steps));
const cancellable = computed(() => isWorkspaceCancellable(props.steps));

const heading = computed(() => {
  if (failed.value) return "Couldn't prepare the worktree";
  if (settled.value) return "Worktree ready";
  return "Preparing worktree";
});

/** The half-line beside the heading: what is happening now while it builds,
 *  and afterwards the one message the build left, when it left one. */
const detail = computed(() => {
  if (failed.value) return failed.value.message ?? failed.value.label;
  if (settled.value) return props.steps.find((row) => row.message)?.message ?? "";
  const running = props.steps.find((row) => row.state === "running");
  return running ? `${running.label}…` : "";
});

const expanded = ref(false);
// A new build starts folded; one that breaks opens itself, because the list is
// where the broken step is marked.
watch(
  () => props.steps.every((row) => row.state === "pending"),
  (fresh) => {
    if (fresh) expanded.value = false;
  },
);
watch(failed, (row) => {
  if (row) expanded.value = true;
});
</script>

<template>
  <Transition name="ws-tray">
    <div
      v-if="steps.length > 0"
      class="ws-tray"
      :class="{ 'is-failed': failed }"
      role="status"
      :aria-label="heading"
    >
      <ol v-if="expanded" class="ws-tray__steps">
        <li
          v-for="row in steps"
          :key="row.step"
          class="ws-tray__step"
          :class="`ws-tray__step--${row.state}`"
        >
          <span class="ws-tray__mark" aria-hidden="true">
            <HugeiconsIcon v-if="row.state === 'done'" :icon="Tick02Icon" :size="11" :stroke-width="2.4" />
            <HugeiconsIcon v-else-if="row.state === 'failed'" :icon="Alert02Icon" :size="11" :stroke-width="2.2" />
            <span v-else-if="row.state === 'running'" class="ws-tray__spin" />
            <span v-else class="ws-tray__dot" />
          </span>
          <span class="ws-tray__label">
            {{ row.label }}
            <span v-if="row.message" class="ws-tray__why">{{ row.message }}</span>
          </span>
        </li>
      </ol>

      <div class="ws-tray__row">
        <button
          type="button"
          class="ws-tray__summary"
          :aria-expanded="expanded"
          :title="detail || undefined"
          @click.stop="expanded = !expanded"
        >
          <span class="ws-tray__lead" aria-hidden="true">
            <HugeiconsIcon v-if="failed" :icon="Alert02Icon" :size="12" :stroke-width="2" />
            <WorktreeIcon v-else-if="settled" :size="12" />
            <span v-else class="ws-tray__spin" />
          </span>
          <span class="ws-tray__heading">{{ heading }}</span>
          <span v-if="detail" class="ws-tray__detail">{{ detail }}</span>
          <HugeiconsIcon
            :icon="ArrowUp01Icon"
            :size="11"
            :stroke-width="2"
            class="ws-tray__chevron"
            :class="{ 'is-open': expanded }"
            aria-hidden="true"
          />
        </button>
        <button
          v-if="cancellable"
          type="button"
          class="ws-tray__action"
          @click.stop="emit('cancel')"
        >
          Cancel
        </button>
        <button
          v-else-if="settled || failed"
          type="button"
          class="ws-tray__close"
          aria-label="Dismiss"
          title="Dismiss"
          @click.stop="emit('dismiss')"
        >
          <HugeiconsIcon :icon="Cancel01Icon" :size="11" :stroke-width="2" />
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* The same sunken slab as the context tray, tucked under the card's roof
   rather than its floor: rounded top, pulled down behind the card's edge. */
.ws-tray {
  display: flex;
  flex-direction: column;
  width: calc(100% - 26px);
  overflow: hidden;
  margin-bottom: -14px;
  padding: 6px 8px 20px;
  border-radius: 18px 18px 0 0;
  background: var(--sunken);
  pointer-events: auto;
  font-family: var(--font-sans);
  font-size: 11.5px;
  line-height: 14px;
}

.ws-tray__row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.ws-tray__summary {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 3px 6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: start;
  white-space: nowrap;
  cursor: pointer;
}
.ws-tray__lead {
  display: grid;
  place-items: center;
  flex: none;
  width: 12px;
  color: var(--faint);
}
.is-failed .ws-tray__lead {
  color: var(--warn, var(--faint));
}
.ws-tray__heading {
  flex: none;
  opacity: 0.86;
}
.ws-tray__detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.42;
}
.ws-tray__summary:hover .ws-tray__detail {
  opacity: 0.6;
}
.ws-tray__chevron {
  flex: none;
  color: var(--faint);
  transition: transform 0.2s ease;
}
.ws-tray__chevron.is-open {
  transform: rotate(180deg);
}

.ws-tray__action,
.ws-tray__close {
  flex: none;
  padding: 3px 6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--ink);
  font: inherit;
  opacity: 0.62;
  cursor: pointer;
  transition: opacity 0.15s ease;
}
.ws-tray__close {
  display: grid;
  place-items: center;
  padding: 3px;
}
.ws-tray__action:hover,
.ws-tray__close:hover {
  opacity: 1;
}

/* The full list, above the line that summarises it, so opening it grows the
   strip upwards and leaves the card where it is. */
.ws-tray__steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 4px 6px 6px;
  list-style: none;
}
.ws-tray__step {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  line-height: 18px;
  color: var(--ink);
  opacity: 0.72;
}
.ws-tray__step--pending {
  opacity: 0.32;
}
.ws-tray__step--failed {
  color: var(--warn, var(--ink));
  opacity: 0.9;
}
.ws-tray__mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 12px;
  height: 18px;
}
.ws-tray__dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
}
.ws-tray__spin {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor;
  animation: ws-tray-spin 0.8s linear infinite;
}
@keyframes ws-tray-spin {
  to {
    transform: rotate(360deg);
  }
}
.ws-tray__label {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
/* The sentence a step left, wrapped rather than cut — this is the place it
   can be read in full. */
.ws-tray__why {
  opacity: 0.62;
  text-wrap: pretty;
  user-select: text;
}
.ws-tray__step--failed .ws-tray__why {
  font-family: var(--font-mono);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.ws-tray-enter-active,
.ws-tray-leave-active {
  transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.ws-tray-enter-from,
.ws-tray-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (prefers-reduced-motion: reduce) {
  .ws-tray__spin {
    animation-duration: 2.4s;
  }
  .ws-tray__chevron,
  .ws-tray-enter-active,
  .ws-tray-leave-active {
    transition: none;
  }
}
</style>
