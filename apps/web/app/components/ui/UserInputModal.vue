<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import type { UserInputAnswers, UserInputQuestion } from "~/types/desktop";
import { useModalExit } from "~/composables/useModalExit";

// The agent's mid-turn question, in the same scrim + elastic card shell the
// folder/model/branch pickers wear — but anchored bottom-centre where the agent
// composer sits, since it takes the composer's place while a question is up.
// Each question renders as either a list of selectable options (single- or
// multi-select) or, when it carries none, a free-text field. Answering hands the
// picked/typed values back keyed by question id; the parked tool call resolves
// and the turn continues.

const props = defineProps<{
  requestId: string;
  questions: UserInputQuestion[];
}>();

const emit = defineEmits<{
  answer: [requestId: string, answers: UserInputAnswers];
  cancel: [requestId: string];
}>();

// Per-question working state, keyed by question id: `picks` holds selected option
// labels (one entry for single-select, many for multi); `other` flags that the
// "write your own" field is active; `texts` holds the typed answer — the whole
// answer for an option-less question, or the custom value when `other` is on.
const picks = reactive<Record<string, string[]>>({});
const other = reactive<Record<string, boolean>>({});
const texts = reactive<Record<string, string>>({});
for (const q of props.questions) {
  picks[q.id] = [];
  other[q.id] = false;
  texts[q.id] = "";
}

function isPicked(q: UserInputQuestion, label: string): boolean {
  return (picks[q.id] ?? []).includes(label);
}

// Single-select latches one option (and clears any custom answer); multi-select
function toggle(q: UserInputQuestion, label: string): void {
  const current = picks[q.id] ?? [];
  if (q.multiSelect) {
    picks[q.id] = current.includes(label)
      ? current.filter((l) => l !== label)
      : [...current, label];
  } else {
    picks[q.id] = current.includes(label) ? [] : [label];
    other[q.id] = false;
  }
}

// "Write your own" — reveal the text field. For single-select it's exclusive with
// the option rows; for multi it rides alongside them.
function toggleOther(q: UserInputQuestion): void {
  const next = !other[q.id];
  other[q.id] = next;
  if (next && !q.multiSelect) picks[q.id] = [];
}

// Focusing the inline field switches its answer on (exclusive with the option
// rows for single-select).
function activateOther(q: UserInputQuestion): void {
  if (!other[q.id]) toggleOther(q);
}

function answered(q: UserInputQuestion): boolean {
  if (q.options.length === 0) return texts[q.id]!.trim().length > 0;
  if (other[q.id] && texts[q.id]!.trim().length > 0) return true;
  return (picks[q.id] ?? []).length > 0;
}

// Every question must have an answer before the turn can continue.
const canSubmit = computed(() => props.questions.every(answered));

// The shell's header-band title: the lone question's header reads best there;
// with several, a neutral label and each question keeps its own inline header.
const bandTitle = computed(() =>
  props.questions.length === 1 ? props.questions[0]!.header : "The agent is asking",
);

function submit(): void {
  if (!canSubmit.value || closing.value) return;
  const answers: UserInputAnswers = {};
  for (const q of props.questions) {
    const custom = texts[q.id]!.trim();
    if (q.options.length === 0) {
      answers[q.id] = custom;
    } else if (q.multiSelect) {
      const selected = [...(picks[q.id] ?? [])];
      if (other[q.id] && custom) selected.push(custom);
      answers[q.id] = selected;
    } else {
      answers[q.id] = other[q.id] && custom ? custom : (picks[q.id]?.[0] ?? null);
    }
  }
  close(() => emit("answer", props.requestId, answers));
}

// Dismiss the question — hands the parked tool call an empty answer, which the
// adapter treats as "declined" so the turn can carry on.
function cancel(): void {
  close(() => emit("cancel", props.requestId));
}

// surface, but bottom-centre over the composer's spot ───────────────────────────
const { shown, closing, close } = useModalExit();
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}

// Cmd/Ctrl+Enter submits from anywhere (including a focused text field).
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submit();
  }
}

let opener: HTMLElement | null = null;

onMounted(async () => {
  // SAFETY: activeElement is null when nothing is focused; otherwise the
  // focused element is a focusable HTML control, and only opener?.focus()
  // ever reads it back — matching opener's declared type.
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", syncHeight);
  await nextTick();
  syncHeight();
  ro = new ResizeObserver(syncHeight);
  if (contentEl.value) ro.observe(contentEl.value);
  requestAnimationFrame(() => {
    shown.value = true;
  });
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
  <div class="fixed inset-0 z-40 flex items-end justify-center overflow-hidden p-6 pb-8">
    <!-- Scrim: a soft dim + blur, matching the pickers. A question is waiting on
         the turn, so the scrim is inert — the only way forward is to answer. -->
    <motion.div
      class="modal-scrim absolute inset-0"
      :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
      :animate="{
        opacity: shown ? 1 : 0,
        backdropFilter: shown ? 'blur(4px)' : 'blur(0px)',
      }"
      :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
    />

    <motion.div
      class="modal-card relative z-20 w-full max-w-lg overflow-hidden"
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
      aria-label="The agent is asking a question"
    >
      <div ref="contentEl" class="ask-body flex shrink-0 flex-col">
        <!-- Recessed header band with the arc scoops flowing into the card walls
             — the shared picker/insert shell signature. -->
        <div class="picker-header">
          <span class="picker-band-title">{{ bandTitle }}</span>
          <button type="button" class="picker-action text-muted" @click="cancel">
            Cancel
          </button>
        </div>

        <div
          class="picker-scroll flex max-h-[52vh] flex-col gap-5 overflow-y-auto overflow-x-hidden px-4 pt-4 pb-2"
        >
          <div v-for="q in questions" :key="q.id" class="ask-question flex flex-col gap-2.5">
            <span v-if="questions.length > 1" class="ask-header">{{ q.header }}</span>
            <p class="ask-prompt">{{ q.question }}</p>

            <!-- Option list: radio-like for single-select, checkbox-like for
                 multi. The mark fills with the accent once picked. -->
            <div v-if="q.options.length" class="flex flex-col gap-1">
              <button
                v-for="opt in q.options"
                :key="opt.label"
                type="button"
                :role="q.multiSelect ? 'menuitemcheckbox' : 'menuitemradio'"
                :aria-checked="isPicked(q, opt.label)"
                class="ask-option"
                :class="{ 'is-picked': isPicked(q, opt.label) }"
                @click="toggle(q, opt.label)"
              >
                <span
                  class="ask-mark"
                  :class="q.multiSelect ? 'ask-mark--box' : 'ask-mark--dot'"
                >
                  <HugeiconsIcon
                    v-if="isPicked(q, opt.label)"
                    :icon="Tick02Icon"
                    :size="12"
                    :stroke-width="2.5"
                  />
                </span>
                <span class="ask-option-text">
                  <span class="ask-option-label">{{ opt.label }}</span>
                  <span v-if="opt.description" class="ask-option-desc">{{ opt.description }}</span>
                </span>
              </button>

              <!-- Always offer a way out of the presets: an inline "write your
                   own" row whose typed value replaces (single) or joins (multi)
                   the picked options. -->
              <div class="ask-option ask-option--inline" :class="{ 'is-picked': other[q.id] }">
                <button
                  type="button"
                  class="ask-mark-btn"
                  :aria-pressed="other[q.id]"
                  aria-label="Write your own answer"
                  @click="toggleOther(q)"
                >
                  <span
                    class="ask-mark"
                    :class="q.multiSelect ? 'ask-mark--box' : 'ask-mark--dot'"
                  >
                    <HugeiconsIcon
                      v-if="other[q.id]"
                      :icon="Tick02Icon"
                      :size="12"
                      :stroke-width="2.5"
                    />
                  </span>
                </button>
                <input
                  v-model="texts[q.id]"
                  type="text"
                  class="ask-inline-input"
                  placeholder="Write your own…"
                  @focus="activateOther(q)"
                  @keydown.enter.prevent="submit"
                />
              </div>
            </div>

            <!-- No options → free-text answer. -->
            <textarea
              v-else
              v-model="texts[q.id]"
              class="ask-input"
              rows="2"
              placeholder="Type your answer…"
              @keydown.enter.exact.stop
            />
          </div>
        </div>

        <!-- Footer band (scoops up into the card walls) — text-button actions to
             match the folder/model pickers, no filled pill. -->
        <div class="picker-footer flex items-center justify-end gap-6">
          <button
            type="button"
            class="picker-action text-ink"
            :disabled="!canSubmit"
            @click="submit"
          >
            Send answer
          </button>
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

.ask-body {
  --band-bg: var(--band);
  --band-arc: 14px;
}

/* Recessed header band with the arc scoops that flow into the card walls —
   lifted from the folder/model/insert shells so this reads as one family. */
.picker-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
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
.picker-band-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

.ask-header {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
.ask-prompt {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.35;
  color: var(--ink);
}

/* Option rows — the quiet hover fill and pill radius the picker rows wear, with
   a leading mark that fills with the accent once selected. */
.ask-option {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  width: 100%;
  cursor: pointer;
  border-radius: 10px;
  padding: 0.5rem 0.625rem;
  text-align: left;
  color: var(--ink);
  transition: background-color 0.18s ease;
}
.ask-option:hover {
  background-color: var(--hover);
}
.ask-option:focus-visible {
  outline: none;
  background-color: var(--hover);
}
.ask-option.is-picked {
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}

.ask-mark {
  display: inline-flex;
  width: 18px;
  height: 18px;
  flex: none;
  margin-top: 1px;
  align-items: center;
  justify-content: center;
  color: var(--ground);
  background: transparent;
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 22%, transparent);
  transition:
    background-color 0.18s ease,
    box-shadow 0.18s ease;
}
.ask-mark--dot {
  border-radius: 9999px;
}
.ask-mark--box {
  border-radius: 6px;
}
.is-picked .ask-mark {
  background: var(--ink);
  box-shadow: inset 0 0 0 1.5px var(--ink);
}

.ask-option-text {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.125rem;
}
.ask-option-label {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.25;
}
.ask-option-desc {
  font-size: 12.5px;
  line-height: 1.35;
  color: var(--muted);
}

/* Free-text field — a soft tonal fill (no ring, no boxed input chrome), firming
   slightly on focus — the same treatment as the home search / command fields. */
.ask-input {
  width: 100%;
  resize: none;
  border-radius: 10px;
  padding: 0.625rem 0.75rem;
  font-size: 14px;
  line-height: 1.4;
  color: var(--ink);
  background: var(--hover, color-mix(in srgb, var(--ink) 4%, transparent));
  transition: background 0.18s ease;
}
.ask-input::placeholder {
  color: var(--muted);
}
.ask-input:focus {
  outline: none;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}

/* Inline "write your own" row — the option-row frame, but the label slot is a
   borderless text field so typing happens right in place. */
.ask-option--inline {
  align-items: center;
  cursor: text;
}
.ask-mark-btn {
  display: inline-flex;
  flex: none;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.ask-inline-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ink);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.25;
  outline: none;
}
.ask-inline-input::placeholder {
  color: var(--muted);
  font-weight: 600;
}

/* Footer band, welded to the card's lower edge with the arc scoops flowing UP
   into the walls (mirror of the header band) — the folder/model picker footer. */
.picker-footer {
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.picker-footer::before,
.picker-footer::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  bottom: 100%;
  pointer-events: none;
}
.picker-footer::before {
  left: 0;
  background: radial-gradient(
    circle at top right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.picker-footer::after {
  right: 0;
  background: radial-gradient(
    circle at top left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

/* Text-button actions — no fill, quiet hover fade — exactly the pickers'
   Cancel/confirm treatment. */
.picker-action {
  display: inline-flex;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.picker-action:hover:not(:disabled) {
  opacity: 0.7;
}
.picker-action:disabled {
  cursor: default;
  opacity: 0.4;
}

/* Match the pickers' quiet scrollbar. */
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
