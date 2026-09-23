<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Magnet } from "~/components/ui/magnet";
import type { GitBranch } from "~/types/desktop";
import type { WorkspaceChoice } from "~/utils/threadWorkspace";
import { useModalExit } from "~/composables/useModalExit";

// The branch overlay — the same scrim + elastic card shell the folder and model
// pickers use (bottom-left anchored, a hairline ring, a springy height that
// settles as the list loads), wrapped around a list of the project's local
// branches.
//
// It answers two different questions, and the difference matters because one of
// them moves the user's files.
//
// `checkout` is the project's own "Switch branch": picking a branch checks it
// out, then waits (spinner up, scrim locked) for the app's git model to re-read
// — so the card only leaves once the new branch's changes are on screen.
//
// `select` is a new conversation choosing where its work will land. Nothing is
// checked out and nothing is created: it reports a choice, and the directory is
// built later, on the first send, so a user who opens this and changes their
// mind leaves nothing behind. A conversation that takes a branch of its own gets
// a working tree of its own, which is the only way two conversations in one
// project can be on two branches at once.

type PickerMode = "checkout" | "select";

const props = withDefaults(
  defineProps<{
    projectPath: string;
    mode?: PickerMode;
    // Re-reads the open project's git model. Awaited after the checkout so the
    // picker doesn't leave until the new branch's changes have actually landed on
    // screen — a big tree can take a beat, and closing early would flash stale
    // counts behind the fading scrim.
    refresh?: () => Promise<void>;
    /** `select` only: what the conversation has already chosen, so reopening
     *  the picker shows it instead of starting over. */
    chosen?: WorkspaceChoice;
  }>(),
  { mode: "checkout", refresh: undefined, chosen: undefined },
);

const emit = defineEmits<{
  switched: [branch: string];
  /** `select` only. `local` shares the project's checkout and its branch;
   *  `worktree` gets a new branch of its own, starting from `base` (null for
   *  the project's current branch). */
  picked: [choice: WorkspaceChoice];
  cancel: [];
}>();

const selecting = computed(() => props.mode === "select");
/** `select` only: which half of the question is on screen. The branch list is
 *  the second step, because it only means anything once the conversation has
 *  said it wants somewhere of its own. */
const step = ref<"where" | "branch">("where");
/** Which way the last step change went, so the content slides the way the user
 *  is moving: onward to the branch list, back to the first question. */
const stepMotion = ref<"step-on" | "step-back">("step-on");
function goStep(next: "where" | "branch") {
  stepMotion.value = next === "branch" ? "step-on" : "step-back";
  step.value = next;
}
const chosenMode = computed(() => props.chosen?.mode ?? "local");

const title = computed(() => {
  if (!selecting.value) return "Switch branch";
  return step.value === "where" ? "Work in" : "Start from";
});

const git = useGit();

// ── branch data ───────────────────────────────────────────────────────────────
const branches = ref<GitBranch[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const switchingTo = ref<string | null>(null);
const switchError = ref<string | null>(null);

/** The branch the project's own folder is on — named in the copy so "your
 *  project" and "from main" say which branch they mean. */
const projectBranch = computed(() => branches.value.find((b) => b.current)?.name ?? null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const all = await git.branches(props.projectPath);
    // Local branches only — checking out a remote-tracking ref detaches HEAD.
    // The current one leads: it is where a new worktree starts unless told
    // otherwise, so it is the row most picks land on.
    branches.value = all
      .filter((b) => !b.remote)
      .sort((a, b) => Number(b.current) - Number(a.current));
  } catch {
    loadError.value = "Couldn’t load branches";
  } finally {
    loading.value = false;
  }
}

async function choose(b: GitBranch) {
  if (switchingTo.value) return;
  if (selecting.value) {
    // Nothing happens here but a decision: no branch is made, no directory is
    // built, and the conversation can still be abandoned. The current branch is
    // the default starting point, so picking it records no base at all.
    pick({ mode: "worktree", base: b.current ? null : b.name });
    return;
  }
  if (b.current) return;
  switchingTo.value = b.name;
  switchError.value = null;
  try {
    await git.checkout(props.projectPath, b.name);
  } catch {
    switchingTo.value = null;
    switchError.value = "Couldn’t switch — commit or stash changes first";
    return;
  }
  // The checkout landed — keep the spinner up and the scrim locked while the app
  // re-reads git, so we only leave once the new branch's changes are on screen.
  // A refresh failure doesn't undo the switch, so fall through and close anyway.
  try {
    await props.refresh?.();
  } catch {
    /* the branch still moved; the live watcher will reconcile the read */
  }
  close(() => emit("switched", b.name));
}

function pick(choice: WorkspaceChoice) {
  close(() => emit("picked", choice));
}

/** Whether a step-two row is the starting point: the one already chosen, or
 *  the project's current branch, which is where a new worktree starts when
 *  nothing else was picked. */
function isChosenBase(name: string): boolean {
  const base = chosenMode.value === "worktree" ? (props.chosen?.base ?? null) : null;
  return (base ?? projectBranch.value) === name;
}

// read as one surface ─────────────────────────────────────────────────────────
const { shown, closing, close } = useModalExit();
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}

function onCancel() {
  // Locked while a checkout is in flight — dismissing here (scrim, Cancel or
  // Escape) would drop the scrim and hand the app back mid-switch.
  if (switchingTo.value) return;
  close(() => emit("cancel"));
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    onCancel();
  }
}

let opener: HTMLElement | null = null;

onMounted(async () => {
  // SAFETY: activeElement is the element focused just before open; null is allowed by the type.
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", syncHeight);
  // Reveal with the loading state, then let the ResizeObserver spring the card's
  // height as the list lands (and reflows on a switch error).
  await nextTick();
  syncHeight();
  ro = new ResizeObserver(syncHeight);
  if (contentEl.value) ro.observe(contentEl.value);
  requestAnimationFrame(() => {
    shown.value = true;
  });
  void load();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", syncHeight);
  ro?.disconnect();
  opener?.focus();
});

const cardSpring = {
  type: "spring",
  stiffness: 300,
  damping: 22,
  mass: 0.9,
} as const;
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
      @click="onCancel"
    />

    <motion.div
      class="modal-card relative z-20 w-fit max-w-md overflow-hidden"
      :class="{ 'is-select': selecting }"
      :style="{ height: cardHeight === null ? 'auto' : `${cardHeight}px` }"
      :initial="{ opacity: 0, y: 12, scale: 0.96 }"
      :animate="{
        opacity: shown ? 1 : 0,
        y: shown ? 0 : 12,
        scale: shown ? 1 : 0.96,
      }"
      :transition="cardSpring"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <div ref="contentEl" class="branch-browser flex shrink-0 flex-col px-3 pb-3">
        <!-- Header band: title + dismiss, the same recessed band the folder
             browser wears. -->
        <div class="picker-header -mx-3 mb-3 flex items-center justify-between gap-4">
          <div class="flex min-w-0 items-center gap-1">
            <button
              v-if="selecting && step === 'branch'"
              type="button"
              class="step-back"
              aria-label="Back"
              @click="goStep('where')"
            >
              <HugeiconsIcon :icon="ArrowLeft01Icon" :size="16" :stroke-width="1.8" />
            </button>
            <span class="branch-title">{{ title }}</span>
          </div>
          <div class="flex shrink-0 items-center gap-3">
            <!-- Two steps, so two marks: where the user is and how far is left. -->
            <span
              v-if="selecting"
              class="step-meter"
              role="img"
              :aria-label="step === 'where' ? 'Step 1 of 2' : 'Step 2 of 2'"
            >
              <span class="step-meter__mark is-on" />
              <span class="step-meter__mark" :class="{ 'is-on': step === 'branch' }" />
            </span>
            <button
              type="button"
              class="picker-action text-muted"
              :disabled="!!switchingTo"
              @click="onCancel"
            >
              Cancel
            </button>
          </div>
        </div>

        <!-- Step one, asked only for a new conversation: does the work land in
             the user's own folder, or in a separate copy of the project. Each
             row is named for what it is, so the word matches the badge the
             composer shows afterwards; what that means for the user's files is
             on hover, for whoever needs it. -->
        <Transition :name="stepMotion" mode="out-in">
        <div
          v-if="selecting && step === 'where'"
          key="where"
          class="flex w-full flex-col gap-0.5"
          role="radiogroup"
          :aria-label="title"
        >
          <button
            type="button"
            role="radio"
            :aria-checked="chosenMode === 'local'"
            class="choice-row"
            title="Work in your project's own folder, on its current branch"
            @click="pick({ mode: 'local', base: null })"
          >
            <span class="choice-dot" :class="{ 'is-on': chosenMode === 'local' }" aria-hidden="true" />
            <span class="choice-label">Local</span>
            <span v-if="projectBranch" class="choice-tag">{{ projectBranch }}</span>
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="chosenMode === 'worktree'"
            class="choice-row"
            title="Work in a separate copy of the project, on a new branch. Your files stay untouched."
            @click="goStep('branch')"
          >
            <span class="choice-dot" :class="{ 'is-on': chosenMode === 'worktree' }" aria-hidden="true" />
            <span class="choice-label">New worktree</span>
            <!-- This row asks a second question rather than answering the first. -->
            <HugeiconsIcon
              class="choice-next"
              :icon="ArrowRight01Icon"
              :size="16"
              :stroke-width="1.8"
              aria-hidden="true"
            />
          </button>
        </div>

        <!-- Step two: where the new worktree's branch starts. It always gets a
             branch of its own — two folders cannot share one — so this only
             picks the starting point. The current branch leads and is the
             default. -->
        <div
          v-else-if="selecting"
          key="branch"
          class="picker-scroll relative flex max-h-[48vh] w-full flex-col gap-0.5 overflow-y-auto overflow-x-hidden"
          role="radiogroup"
          :aria-label="title"
        >
          <p v-if="loading" class="branch-note">Loading branches…</p>
          <p v-else-if="loadError" class="branch-note">{{ loadError }}</p>
          <button
            v-for="b in branches"
            v-else
            :key="b.name"
            type="button"
            role="radio"
            :aria-checked="isChosenBase(b.name)"
            class="choice-row"
            :title="b.current ? `${b.name} — your current branch` : b.name"
            @click="choose(b)"
          >
            <span class="choice-dot" :class="{ 'is-on': isChosenBase(b.name) }" aria-hidden="true" />
            <span class="choice-label choice-label--branch">{{ b.name }}</span>
            <span v-if="b.current" class="choice-tag">current</span>
          </button>
        </div>
        </Transition>

        <div
          v-if="!selecting"
          class="picker-scroll relative flex max-h-[48vh] w-full flex-col items-start gap-0.5 overflow-y-auto overflow-x-hidden py-1"
        >
          <p v-if="loading" class="branch-note">Loading…</p>
          <p v-else-if="loadError" class="branch-note">{{ loadError }}</p>
          <p v-else-if="branches.length === 0" class="branch-note">No other branches</p>

          <Magnet
            v-for="b in branches"
            v-else
            :key="b.name"
            class="w-fit"
            inner-class="w-fit"
            :padding="12"
            :magnet-strength="9"
            :disabled="!!switchingTo"
            active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
            inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
          >
            <button
              type="button"
              role="menuitemradio"
              :aria-checked="b.current"
              :disabled="(b.current && !selecting) || !!switchingTo"
              class="picker-row"
              :class="{ 'is-current': b.current }"
              @click="choose(b)"
            >
              <span v-if="switchingTo === b.name" class="branch-mark">
                <span class="branch-spin" aria-hidden="true" />
              </span>
              <span class="picker-label" :title="b.name">{{ b.name }}</span>
              <span v-if="b.current" class="branch-tag">current</span>
            </button>
          </Magnet>

          <p v-if="switchError" class="branch-note branch-note--err">{{ switchError }}</p>
        </div>
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
.modal-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}
.modal-card {
  background: var(--panel);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.branch-browser {
  --band-bg: var(--band);
  --band-arc: 14px;
}

/* Recessed header band with the arc scoops that flow into the card walls. */
.picker-header {
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.picker-header::before,
.picker-header::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}
.picker-header::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.picker-header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

/* The modal's type scale, three sizes and no more:
     14px — the question in the header, and each choice's label
     13px — the header action, and a loading or error note
     12px — a tag at the row's far edge
   The title outranks the labels by weight and by sitting in the band, not by
   size; the action is a size down so it never competes with the question. */
.branch-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
  color: var(--ink);
  white-space: nowrap;
}

.picker-action {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.picker-action:hover {
  opacity: 0.7;
}
.picker-action:disabled {
  cursor: default;
  opacity: 0.4;
}

/* Branch rows — quiet hover fill that hugs the content like the folder rows,
   so the row lights up as one readable line, not a full-width swath. */
.picker-row {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  width: fit-content;
  max-width: 100%;
  cursor: pointer;
  border-radius: 10px;
  padding: 0.625rem 0.75rem;
  text-align: left;
  color: var(--ink);
  transition:
    background-color 0.18s ease,
    color 0.25s ease;
}
.picker-row:hover {
  background-color: var(--hover);
}
.picker-row:focus-visible {
  outline: none;
  background-color: var(--hover);
}
.picker-row.is-current {
  cursor: default;
}
.picker-row:disabled:not(.is-current) {
  cursor: default;
  opacity: 0.5;
}

.branch-mark {
  display: inline-flex;
  width: 16px;
  height: 16px;
  flex: none;
  align-items: center;
  justify-content: center;
  color: var(--accent);
}
.picker-label {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: -0.005em;
  line-height: 1.3;
}
.branch-tag {
  flex: none;
  margin-inline-start: auto;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
}

/* ── select mode ──────────────────────────────────────────────────────────────
   One line per choice: the dot, the label, and whatever qualifies it — a
   branch tag or the next-step chevron — pushed to the far edge. */
.modal-card.is-select {
  width: 20rem;
}
.choice-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.625rem 0.75rem;
  border-radius: 10px;
  text-align: start;
  color: var(--ink);
  cursor: pointer;
  user-select: none;
  transition: background-color 0.18s ease;
}
.choice-row:hover,
.choice-row:focus-visible {
  outline: none;
  background-color: var(--hover);
}

.choice-dot {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 9999px;
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 28%, transparent);
  transition:
    background-color 0.18s ease,
    box-shadow 0.18s ease;
}
.choice-dot.is-on {
  background-color: var(--accent);
  box-shadow:
    inset 0 0 0 1.5px var(--accent),
    inset 0 0 0 4px var(--panel);
}
.choice-label {
  font-size: 14px;
  font-weight: 500;
  letter-spacing: -0.005em;
  line-height: 1.3;
}
.choice-label--branch {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.choice-tag {
  min-width: 0;
  margin-inline-start: auto;
  padding-inline-start: 0.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--muted);
}
.choice-label--branch + .choice-tag {
  flex: none;
}
.choice-next {
  flex: none;
  align-self: center;
  margin-inline-start: auto;
  color: var(--muted);
  transition: transform 0.18s ease, color 0.18s ease;
}
.choice-row:hover .choice-next {
  color: var(--ink-soft);
  transform: translateX(2px);
}

.step-back {
  display: inline-flex;
  width: 22px;
  height: 22px;
  margin-inline-start: -4px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background-color 0.18s ease;
}
.step-back:hover,
.step-back:focus-visible {
  outline: none;
  background-color: var(--hover);
}

.step-meter {
  display: inline-flex;
  gap: 3px;
}
.step-meter__mark {
  width: 12px;
  height: 3px;
  border-radius: 9999px;
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  transition: background-color 0.24s ease;
}
.step-meter__mark.is-on {
  background-color: var(--ink-soft);
}

/* Steps slide the way the user is going. Short, so it reads as movement rather
   than as a wait; the card's height springs on its own underneath. */
.step-on-enter-active,
.step-on-leave-active,
.step-back-enter-active,
.step-back-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
}
.step-on-enter-from,
.step-back-leave-to {
  opacity: 0;
  transform: translateX(10px);
}
.step-on-leave-to,
.step-back-enter-from {
  opacity: 0;
  transform: translateX(-10px);
}
@media (prefers-reduced-motion: reduce) {
  .step-on-enter-from,
  .step-on-leave-to,
  .step-back-enter-from,
  .step-back-leave-to {
    transform: none;
  }
}

.branch-note {
  padding: 0.625rem 0.75rem;
  font-size: 13px;
  line-height: 1.35;
  color: var(--muted);
}
.branch-note--err {
  font-size: 13px;
  color: var(--diff-del-soft);
}

.branch-spin {
  width: 13px;
  height: 13px;
  border-radius: 9999px;
  border: 1.6px solid color-mix(in srgb, var(--ink) 22%, transparent);
  border-top-color: var(--accent);
  animation: branch-spin 0.6s linear infinite;
}
@keyframes branch-spin {
  to {
    transform: rotate(360deg);
  }
}

/* The list scrollbar matches the folder browser's — a quiet thumb that firms on
   hover, over a stable gutter so rows never shift. */
.picker-scroll {
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 16%, transparent) transparent;
}
.picker-scroll::-webkit-scrollbar {
  width: 10px;
}
.picker-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.picker-scroll::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
  border: 3px solid transparent;
  background-clip: content-box;
}
.picker-scroll:hover::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
}
</style>
