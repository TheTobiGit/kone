<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Tick02Icon, Alert02Icon } from "@hugeicons/core-free-icons";
import { useModalExit } from "~/composables/useModalExit";
import {
  failedWorkspaceStep,
  isWorkspaceCancellable,
  workspaceStepsSettled,
  type WorkspaceStepRow,
} from "~/utils/workspaceSteps";

// Building the worktree a conversation asked for, while it happens.
//
// It wears the app's modal shell, which is a deliberate choice with a cost: this
// is setup, not a question, and the honest version of setup does not take the
// screen. So the scrim is there but nothing is trapped behind it — the card can
// be dismissed at any point, by the scrim, by Escape or by the button, and
// dismissing it during the create/link window is the cancel.
//
// The cancel is not "stop trying". By the time it can be pressed git is already
// writing a tree and there is nothing to interrupt; what it means is "undo
// whatever finishes", so the creation is still awaited and the directory it
// produces is removed afterwards. Saying "Stop" would promise something that
// cannot be delivered.
//
// Once the start step runs the worktree is linked and the session is coming up,
// so there is nothing left to undo. The Cancel affordance is then withheld on
// purpose — offering it would take a decision that can no longer be honoured —
// and dismissing the card from that point on is just putting it away, not
// backing out. A late cancel arriving behind a started session is ignored for
// the same reason: the directory exists and the session owns it now.
//
// A failed step stays, marked, with what git said under it. A stepper that
// vanished on failure would leave the user watching the thing that was going to
// explain the problem disappear.

const props = defineProps<{
  /** The three steps and where each one stands. */
  steps: WorkspaceStepRow[];
}>();

const emit = defineEmits<{
  /** Back out — undo whatever the build produces. */
  cancel: [];
  /** Put it away without undoing anything. Offered once the build has settled
   *  or failed, and while the session is starting — then there is nothing left
   *  to undo, only a card to put away. */
  dismiss: [];
}>();

const failed = computed(() => failedWorkspaceStep(props.steps));
const settled = computed(() => workspaceStepsSettled(props.steps));
/** Backing out is offered only while the worktree is not yet linked. Once the
 *  start step runs there is nothing left to undo, so the card only dismisses. */
const cancellable = computed(() => isWorkspaceCancellable(props.steps));

const heading = computed(() => {
  if (failed.value) return "Couldn't prepare the worktree";
  if (settled.value) return "Worktree ready";
  return "Preparing worktree…";
});

const { shown, closing, close } = useModalExit();

// A finished build has nothing left to say, so it says it for a moment and
// leaves. Long enough to register as an answer rather than a flicker, short
// enough that nobody has to dismiss a card confirming something that worked.
const SETTLED_LINGER_MS = 1100;
let lingerTimer: number | null = null;

watch(settled, (done) => {
  if (!done || lingerTimer !== null) return;
  lingerTimer = window.setTimeout(() => {
    lingerTimer = null;
    close(() => emit("dismiss"));
  }, SETTLED_LINGER_MS);
});

/** Every dismissal goes through here so the exit always plays, and so backing
 *  out mid-build and closing a finished card are one gesture with two meanings
 *  rather than two controls the user has to tell apart. Only a dismissal while
 *  the build is still cancellable backs out; later dismissals just put it away. */
function leave(): void {
  const undo = cancellable.value;
  close(() => {
    if (undo) emit("cancel");
    else emit("dismiss");
  });
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  e.preventDefault();
  leave();
}

let opener: HTMLElement | null = null;

onMounted(() => {
  // SAFETY: activeElement is the element focused just before open; null is
  // allowed by the type.
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
  requestAnimationFrame(() => {
    shown.value = true;
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  if (lingerTimer !== null) window.clearTimeout(lingerTimer);
  opener?.focus();
});

const cardSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-end justify-start overflow-hidden p-10">
    <motion.div
      class="modal-scrim absolute inset-0"
      :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
      :animate="{
        opacity: shown ? 1 : 0,
        backdropFilter: shown ? 'blur(4px)' : 'blur(0px)',
      }"
      :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
      @click="leave"
    />

    <motion.div
      class="prep relative z-20 w-fit max-w-md"
      :initial="{ opacity: 0, y: 12, scale: 0.96 }"
      :animate="{
        opacity: shown ? 1 : 0,
        y: shown ? 0 : 12,
        scale: shown ? 1 : 0.96,
      }"
      :transition="cardSpring"
      role="dialog"
      aria-modal="true"
      :aria-label="heading"
    >
      <div class="prep__inner">
        <!-- The same recessed band the pickers wear, with the arcs that flow
             into the card walls. -->
        <div class="prep__header">
          <span class="prep__title">{{ heading }}</span>
          <button
            type="button"
            class="prep__action text-muted"
            :disabled="closing"
            @click="leave"
          >
            {{ cancellable ? "Cancel" : "Close" }}
          </button>
        </div>

        <ol class="prep__steps" aria-live="polite">
          <li
            v-for="row in steps"
            :key="row.step"
            class="prep__step"
            :class="`prep__step--${row.state}`"
          >
            <span class="prep__mark" aria-hidden="true">
              <HugeiconsIcon
                v-if="row.state === 'done'"
                :icon="Tick02Icon"
                :size="12"
                :stroke-width="2.4"
              />
              <HugeiconsIcon
                v-else-if="row.state === 'failed'"
                :icon="Alert02Icon"
                :size="12"
                :stroke-width="2.2"
              />
              <span v-else-if="row.state === 'running'" class="prep__spin" />
              <span v-else class="prep__dot" />
            </span>
            <span class="prep__label">
              {{ row.label }}
              <!-- What git actually said, kept with the step it belongs to
                   rather than collected into a banner at the bottom. -->
              <span v-if="row.message" class="prep__why">{{ row.message }}</span>
            </span>
          </li>
        </ol>

        <!-- Said only while it can still be acted on. Once a build has failed
              there is nothing in flight to undo, and the steps above say the
              rest. Likewise once the session is starting: the worktree exists
              and dismissing the card only puts it away. -->
        <p v-if="cancellable" class="prep__note">
          Cancelling removes the worktree once it finishes. You can keep working
          in the meantime.
        </p>
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
.modal-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}

.prep {
  --band-bg: var(--band);
  --band-arc: 14px;
  background: var(--band-bg);
  border-radius: 20px;
  overflow: hidden;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 10%, transparent),
    0 16px 36px -8px rgb(0 0 0 / 0.36);
}
.prep__inner {
  display: flex;
  flex-direction: column;
}

.prep__header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 0.5rem 0.8rem;
  background-color: var(--band-bg);
}
.prep__header::before,
.prep__header::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}
.prep__header::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.prep__header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.prep__title {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}
.prep__action {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.prep__action:hover {
  opacity: 0.7;
}
.prep__action:disabled {
  cursor: default;
  opacity: 0.45;
}

/* The steps sit on the panel the pickers put their cards on, so the band reads
   as a header over content rather than as a tinted box. */
.prep__steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 1px;
  padding: 0.6rem 0.85rem 0.65rem;
  background: var(--panel);
  border-radius: 18px;
  list-style: none;
}
.prep__note {
  margin: 0;
  padding: 0.45rem 0.9rem 0.6rem;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--faint);
  max-width: 34ch;
}

.prep__step {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  font-size: 12.5px;
  line-height: 20px;
  letter-spacing: -0.005em;
  color: var(--muted);
  /* Each step lights as it is reached rather than all at once, so the list
     reads as progress rather than as a static checklist. */
  transition: color 0.28s ease;
}
/* Not yet reached: present, so the shape never changes under the reader, but
   not claiming any attention. */
.prep__step--pending {
  opacity: 0.45;
}
.prep__step--running,
.prep__step--done {
  color: var(--ink-soft);
}
.prep__step--failed {
  color: var(--warn, var(--ink-soft));
}

.prep__mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 14px;
  height: 20px;
}
.prep__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.5;
}
.prep__spin {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in oklab, currentColor 25%, transparent);
  border-top-color: currentColor;
  animation: prep-spin 0.7s linear infinite;
}
@keyframes prep-spin {
  to {
    transform: rotate(1turn);
  }
}

.prep__label {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.prep__why {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--faint);
  overflow-wrap: anywhere;
}

@media (prefers-reduced-motion: reduce) {
  .prep__spin {
    animation-duration: 2.4s;
  }
}
</style>
