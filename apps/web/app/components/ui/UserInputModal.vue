<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import type {
  ChatAttachment,
  UserInputAnswerAttachments,
  UserInputAnswers,
  UserInputQuestion,
} from "~/types/desktop";
import type { UserInputOwner } from "~/composables/agentTypes";
import { useUserInputAttachments } from "~/composables/useUserInputAttachments";
import { useModalExit } from "~/composables/useModalExit";
import { useSound } from "~/composables/useSound";
import UserInputAnswerFiles from "~/components/ui/UserInputAnswerFiles.vue";
import UserInputQuestionMedia from "~/components/ui/UserInputQuestionMedia.vue";
import {
  buildUserInputAnswers,
  emptyUserInputDraft,
  USER_INPUT_ATTACHMENT_LIMIT,
  type UserInputDraft,
} from "~/utils/userInputAnswers";

// The agent's mid-turn question, in the same scrim + elastic card shell the
// folder/model/branch pickers wear — but anchored bottom-centre where the agent
// composer sits, since it takes the composer's place while a question is up.
// Each question renders as either a list of selectable options (single- or
// multi-select) or, when it carries none, a free-text field. Whatever the agent
// attached — images from its attachment store, or a live visual — sits under
// the prompt, and the user may attach files of their own to the answer.
// Answering hands the picked/typed values, with those files, back keyed by
// question id; the parked tool call resolves and the turn continues.

const props = defineProps<{
  requestId: string;
  questions: UserInputQuestion[];
  /** Contain the shell to the host pane (absolute) instead of the viewport
   *  (fixed), so the scrim dims only the thread and the card lands in its
   *  bottom-centre over the composer's spot. */
  contained?: boolean;
  /** Upload one picked/dropped/pasted answer file and resolve to its stored
   *  metadata. Absent hides every attach affordance — a host with nowhere to
   *  put the bytes offers no button that would fail. */
  upload?: (file: File) => Promise<ChatAttachment>;
  /** The session that asked. Handed back with the answer, so it reaches that
   *  session even when the focus moved on during the exit. */
  owner?: UserInputOwner;
  /** Forget an answer file the user removed, or one this dialog closes without
   *  sending. Absent leaves those bytes to the startup sweep. */
  discard?: (attachment: ChatAttachment) => Promise<void>;
}>();

const { cue } = useSound();

const emit = defineEmits<{
  /** Answers keyed by question id, plus the files that rode each answer (only
   *  questions that actually carry files appear in the third argument). */
  answer: [
    requestId: string,
    answers: UserInputAnswers,
    attachments: UserInputAnswerAttachments | undefined,
    owner: UserInputOwner | undefined,
  ];
  cancel: [requestId: string, owner: UserInputOwner | undefined];
}>();

// Per-question working state, keyed by question id (see UserInputDraft): the
// picked option labels, whether "write your own" is on, and the typed text.
const drafts = reactive<Record<string, UserInputDraft>>({});
for (const q of props.questions) drafts[q.id] = emptyUserInputDraft();

// Answer files live in their own lifecycle: uploads start as each file arrives,
// and the dialog's outcome either hands them to the answer or takes them back.
const {
  attachments,
  uploading,
  uploadErrors,
  dragTarget,
  attachedTotal,
  uploadingAny,
  attachmentAnswers,
  hasAnswerAttachments,
  attachFiles,
  removeAttachment,
  onPaste,
  onDragOver,
  onDragLeave,
  onDrop,
  clearDragTarget,
  transferToAnswer,
  discardAll,
  dispose,
} = useUserInputAttachments({ upload: props.upload, discard: props.discard });

/** Any question carrying agent media earns a wider card and a taller scroll
 *  area, so a visual gets the same room it has in a reply. */
const hasAgentMedia = computed(() =>
  props.questions.some((q) => Boolean(q.images?.length || q.visual)),
);

function draft(q: UserInputQuestion): UserInputDraft {
  return drafts[q.id] ?? (drafts[q.id] = emptyUserInputDraft());
}

function isPicked(q: UserInputQuestion, label: string): boolean {
  return draft(q).picks.includes(label);
}

// Single-select latches one option (and clears any custom answer); multi-select
// toggles it alongside the others.
function toggle(q: UserInputQuestion, label: string): void {
  const d = draft(q);
  if (q.multiSelect) {
    d.picks = d.picks.includes(label) ? d.picks.filter((l) => l !== label) : [...d.picks, label];
  } else {
    d.picks = d.picks.includes(label) ? [] : [label];
    d.other = false;
  }
}

// "Write your own" — reveal the text field. For single-select it's exclusive with
// the option rows; for multi it rides alongside them.
function toggleOther(q: UserInputQuestion): void {
  const d = draft(q);
  d.other = !d.other;
  if (d.other && !q.multiSelect) d.picks = [];
}

// Focusing the inline field switches its answer on (exclusive with the option
// rows for single-select).
function activateOther(q: UserInputQuestion): void {
  if (!draft(q).other) toggleOther(q);
}

// Every question must have an answer before the turn can continue — a file or
// two counts as one even when nothing is typed or picked. Uploads still in
// flight hold the send back so the answer leaves with everything on it.
const answers = computed(() =>
  buildUserInputAnswers(props.questions, drafts, attachments),
);
const canSubmit = computed(() => answers.value !== null && !uploadingAny.value);

// The shell's header-band title: the lone question's header reads best there;
// with several, a neutral label and each question keeps its own inline header.
const bandTitle = computed(() =>
  props.questions.length === 1 ? props.questions[0]!.header : "The agent is asking",
);

function submit(): void {
  const ready = answers.value;
  if (!ready || closing.value || uploadingAny.value) return;
  cue("press");
  // Everything on the answer is handed over with it: the files are the agent's
  // now, so the unmount must not discard them.
  transferToAnswer();
  // Taken now, not when the exit ends: the asking session is this click's.
  const owner = props.owner;
  close(() =>
    emit(
      "answer",
      props.requestId,
      ready,
      hasAnswerAttachments.value ? attachmentAnswers.value : undefined,
      owner,
    ),
  );
}

// Dismiss the question — hands the parked tool call an empty answer, which the
// adapter treats as "declined" so the turn can carry on.
function cancel(): void {
  if (closing.value) return;
  discardAll();
  const owner = props.owner;
  dismiss(() => emit("cancel", props.requestId, owner));
}

// surface, but bottom-centre over the composer's spot ───────────────────────────
const { shown, closing, close, dismiss } = useModalExit();
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
  // The dialog went away without an answer (the host unmounted it, or the
  // request was withdrawn): whatever was uploaded for it is unreferenced.
  dispose();
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", syncHeight);
  ro?.disconnect();
  opener?.focus();
});
</script>

<template>
  <UiModalShell
    v-slot="{ card }"
    :shown="shown"
    scrim="inert"
    :contained="props.contained"
    class="z-40 items-end justify-center p-6 pb-8"
  >
    <div
      v-bind="card"
      class="modal-card relative z-20 w-full overflow-hidden"
      :class="hasAgentMedia ? 'max-w-2xl' : 'max-w-lg'"
      :style="{ height: cardHeight === null ? 'auto' : `${cardHeight}px` }"
      role="dialog"
      aria-modal="true"
      aria-label="The agent is asking a question"
      @dragover.prevent
      @drop.prevent="clearDragTarget"
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
          class="picker-scroll flex flex-col gap-5 overflow-y-auto overflow-x-hidden px-4 pt-4 pb-2"
          :class="hasAgentMedia ? 'max-h-[68vh]' : 'max-h-[52vh]'"
        >
          <div
            v-for="q in questions"
            :key="q.id"
            class="ask-question flex flex-col gap-2.5"
            :class="{ 'is-dragging': dragTarget === q.id }"
            @dragover="onDragOver(q, $event)"
            @dragleave="onDragLeave(q, $event)"
            @drop.prevent="onDrop(q, $event)"
          >
            <span v-if="questions.length > 1" class="ask-header">{{ q.header }}</span>
            <p class="ask-prompt">{{ q.question }}</p>

            <!-- What the agent attached: images from its own attachment store,
                 opened large in the shared viewer, and a live visual drawn by
                 the same frame a reply uses (theme, height reports, expand). -->
            <UserInputQuestionMedia :images="q.images" :visual="q.visual" />

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

              <!-- Offer a way out of the presets: an inline "write your own" row
                   whose typed value replaces (single) or joins (multi) the
                   picked options. A fixed-choice question takes only an option
                   back, so it has none. -->
              <div
                v-if="!q.fixedChoice"
                class="ask-option ask-option--inline"
                :class="{ 'is-picked': draft(q).other }"
              >
                <button
                  type="button"
                  class="ask-mark-btn"
                  :aria-pressed="draft(q).other"
                  aria-label="Write your own answer"
                  @click="toggleOther(q)"
                >
                  <span
                    class="ask-mark"
                    :class="q.multiSelect ? 'ask-mark--box' : 'ask-mark--dot'"
                  >
                    <HugeiconsIcon
                      v-if="draft(q).other"
                      :icon="Tick02Icon"
                      :size="12"
                      :stroke-width="2.5"
                    />
                  </span>
                </button>
                <input
                  v-model="draft(q).text"
                  type="text"
                  class="ask-inline-input"
                  placeholder="Write your own…"
                  @focus="activateOther(q)"
                  @paste="onPaste(q, $event)"
                  @keydown.enter.prevent="submit"
                />
              </div>
            </div>

            <!-- No options → free-text answer. -->
            <textarea
              v-else
              v-model="draft(q).text"
              class="ask-input"
              rows="2"
              placeholder="Type your answer…"
              @paste="onPaste(q, $event)"
              @keydown.enter.exact.stop
            />

            <!-- Files the user attaches to this answer. The button and its
                 hidden picker exist only when the host can store them; drop
                 and paste land on the whole question. Chips show what will
                 ride the answer, with in-flight rows and a last-error line. -->
            <UserInputAnswerFiles
              v-if="props.upload && !q.fixedChoice"
              :attachments="attachments[q.id] ?? []"
              :uploading="uploading[q.id] ?? []"
              :error="uploadErrors[q.id]"
              :total="attachedTotal"
              :limit="USER_INPUT_ATTACHMENT_LIMIT"
              @files="attachFiles(q, $event)"
              @remove="removeAttachment(q.id, $event)"
            />
          </div>
        </div>

        <!-- Footer band (scoops up into the card walls) — text-button actions to
             match the folder/model pickers, no filled pill. -->
        <div class="picker-footer flex items-center justify-end gap-6">
          <span v-if="uploadingAny" class="ask-upload-note" role="status">Uploading…</span>
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
    </div>
  </UiModalShell>
</template>

<style scoped>
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

/* The footer's upload status line. */
.ask-upload-note {
  color: var(--muted);
  font-size: 11px;
}
/* The whole question is the drop target, so a file dragged over any part of it
   reads as landing here. */
.ask-question.is-dragging {
  border-radius: 10px;
  outline: 1.5px dashed color-mix(in srgb, var(--ink) 24%, transparent);
  outline-offset: 4px;
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
