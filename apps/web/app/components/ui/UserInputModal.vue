<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  type ComponentPublicInstance,
} from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Attachment01Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type {
  ChatAttachment,
  UserInputAnswerAttachments,
  UserInputAnswers,
  UserInputQuestion,
} from "~/types/desktop";
import type { UserInputOwner } from "~/composables/agentTypes";
import VisualFrame from "~/components/conversation/VisualFrame.vue";
import VisualImageViewer from "~/components/conversation/VisualImageViewer.vue";
import { formatFileSize } from "~/utils/formatFile";
import { useModalExit } from "~/composables/useModalExit";
import { useSound } from "~/composables/useSound";
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

// Files the user is attaching, keyed by question id. Uploads start the moment
// a file is picked, dropped or pasted; `attachments` holds the stored metadata
// once each one lands, `uploading` the rows still in flight, and `uploadErrors`
// the last failure so the question can say what went wrong.
const attachments = reactive<Record<string, ChatAttachment[]>>({});
type UploadingFile = { key: string; name: string };
const uploading = reactive<Record<string, UploadingFile[]>>({});
const uploadErrors = reactive<Record<string, string>>({});
const dragTarget = ref<string | null>(null);
let uploadSeq = 0;
/** The dialog's outcome is decided — answered, cancelled or unmounted. A file
 *  that lands after that belongs to nobody and goes back to the store. */
let settled = false;

/** Hand one stored answer file back. Fire-and-forget: the dialog is on its way
 *  out, and an orphaned upload is only the sweep's problem. */
function discardUpload(attachment: ChatAttachment): void {
  void props.discard?.(attachment).catch(() => {});
}

/** Every answer file still sitting on the dialog goes back — cancel and unmount
 *  both end with nothing of the user's left unattached. */
function discardAnswerAttachments(): void {
  for (const list of Object.values(attachments)) {
    for (const attachment of list) discardUpload(attachment);
  }
}

/** The hidden per-question file pickers, opened by each question's attach
 *  button so the button itself stays the one named control. */
const fileInputs = ref<Record<string, HTMLInputElement | null>>({});
function setFileInput(id: string, el: Element | ComponentPublicInstance | null): void {
  fileInputs.value[id] = el instanceof HTMLInputElement ? el : null;
}

function pickFiles(q: UserInputQuestion): void {
  fileInputs.value[q.id]?.click();
}

/** How many files are attached across the whole dialog, in-flight ones
 *  included — the backend caps the answer at eight in total. */
const attachedTotal = computed(
  () =>
    Object.values(attachments).reduce((sum, list) => sum + list.length, 0) +
    Object.values(uploading).reduce((sum, list) => sum + list.length, 0),
);

const uploadingAny = computed(() =>
  Object.values(uploading).some((list) => list.length > 0),
);

/** Only questions that actually carry files are sent — an empty map would
 *  read as "these questions had attachments" to nothing, but the backend's
 *  argument is optional, so leave it out entirely. */
const attachmentAnswers = computed<UserInputAnswerAttachments>(() => {
  const result: UserInputAnswerAttachments = {};
  for (const [id, list] of Object.entries(attachments)) {
    if (list.length > 0) result[id] = list;
  }
  return result;
});
const hasAnswerAttachments = computed(
  () => Object.keys(attachmentAnswers.value).length > 0,
);

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? name.slice(dot + 1, dot + 5).toUpperCase()
    : "FILE";
}

function isImage(att: ChatAttachment): boolean {
  return att.type === "image" || att.mimeType.toLowerCase().startsWith("image/");
}

/** Upload every file immediately, one request each, so a slow one never holds
 *  the others back. A failure leaves the rest alone and says why in the
 *  question's error line. */
function attachFiles(q: UserInputQuestion, files: Iterable<File>): void {
  const upload = props.upload;
  // A fixed-choice answer is one option and nothing else: no file can ride it.
  if (!upload || q.fixedChoice) return;
  for (const file of files) {
    if (attachedTotal.value >= USER_INPUT_ATTACHMENT_LIMIT) {
      uploadErrors[q.id] = `You can attach up to ${USER_INPUT_ATTACHMENT_LIMIT} files.`;
      break;
    }
    delete uploadErrors[q.id];
    const key = `upload-${++uploadSeq}`;
    const name = file.name || "attachment";
    (uploading[q.id] ??= []).push({ key, name });
    void upload(file)
      .then((attachment) => {
        uploading[q.id] = (uploading[q.id] ?? []).filter((row) => row.key !== key);
        // The dialog closed while this was in flight: nobody can send it now.
        if (settled) {
          discardUpload(attachment);
          return;
        }
        (attachments[q.id] ??= []).push(attachment);
      })
      .catch((error: Error) => {
        uploading[q.id] = (uploading[q.id] ?? []).filter((row) => row.key !== key);
        uploadErrors[q.id] = error?.message || `Could not attach ${name}.`;
      });
  }
}

function onFilesPicked(q: UserInputQuestion, event: Event): void {
  // SAFETY: bound via @change on the question's hidden file <input>, so the
  // target is that input.
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // Clear first so re-picking the same file still fires a change.
  input.value = "";
  attachFiles(q, files);
}

// Paste feeds the same list as the picker: a screenshot off the clipboard is
// an image file, and pasted documents ride as files.
function onPaste(q: UserInputQuestion, event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length === 0) return;
  event.preventDefault();
  attachFiles(q, files);
}

function onDragOver(q: UserInputQuestion, event: DragEvent): void {
  if (!props.upload || q.fixedChoice) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  dragTarget.value = q.id;
}

function onDragLeave(q: UserInputQuestion, event: DragEvent): void {
  // Crossing between the question's own children is not leaving it.
  const current = event.currentTarget;
  const next = event.relatedTarget;
  if (current instanceof Node && next instanceof Node && current.contains(next)) return;
  if (dragTarget.value === q.id) dragTarget.value = null;
}

function onDrop(q: UserInputQuestion, event: DragEvent): void {
  dragTarget.value = null;
  attachFiles(q, Array.from(event.dataTransfer?.files ?? []));
}

function removeAttachment(q: UserInputQuestion, id: string): void {
  const list = attachments[q.id] ?? [];
  const gone = list.find((att) => att.id === id);
  attachments[q.id] = list.filter((att) => att.id !== id);
  if (gone) discardUpload(gone);
}

// Clicking an agent image opens the shared image viewer over the dialog.
const viewedImage = ref<{ src: string; alt: string } | null>(null);
function openImage(image: ChatAttachment): void {
  viewedImage.value = { src: `attachment://${image.id}`, alt: image.name };
}

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
  settled = true;
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
  settled = true;
  discardAnswerAttachments();
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
  if (!settled) {
    settled = true;
    discardAnswerAttachments();
  }
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
      @drop.prevent="dragTarget = null"
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
            <div v-if="q.images?.length" class="ask-agent-images">
              <button
                v-for="img in q.images"
                :key="img.id"
                type="button"
                class="ask-agent-thumb"
                :title="`Preview ${img.name}`"
                :aria-label="`Preview ${img.name}`"
                @click="openImage(img)"
              >
                <img
                  :src="`attachment://${img.id}`"
                  :alt="img.name"
                  loading="lazy"
                />
              </button>
            </div>
            <VisualFrame v-if="q.visual" :visual="q.visual" />

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
            <div v-if="props.upload && !q.fixedChoice" class="ask-attach">
              <input
                :ref="(el) => setFileInput(q.id, el)"
                type="file"
                multiple
                class="ask-file-input"
                tabindex="-1"
                aria-hidden="true"
                @change="onFilesPicked(q, $event)"
              />
              <button
                type="button"
                class="ask-attach-btn"
                aria-label="Attach images or files"
                title="Attach images or files"
                @click="pickFiles(q)"
              >
                <HugeiconsIcon :icon="Attachment01Icon" :size="15" :stroke-width="1.8" />
              </button>

              <div
                v-if="attachments[q.id]?.length || uploading[q.id]?.length"
                class="ask-chips"
              >
                <span
                  v-for="att in attachments[q.id]"
                  :key="att.id"
                  class="ask-chip"
                  :title="`${att.name} (${formatFileSize(att.sizeBytes)})`"
                >
                  <img
                    v-if="isImage(att)"
                    class="ask-chip__thumb"
                    :src="`attachment://${att.id}`"
                    :alt="att.name"
                  />
                  <span v-else class="ask-chip__ext">{{ fileExtension(att.name) }}</span>
                  <span class="ask-chip__name">{{ att.name }}</span>
                  <button
                    type="button"
                    class="ask-chip__remove"
                    :aria-label="`Remove ${att.name}`"
                    :title="`Remove ${att.name}`"
                    @click="removeAttachment(q, att.id)"
                  >
                    <HugeiconsIcon :icon="Cancel01Icon" :size="11" :stroke-width="2.2" />
                  </button>
                </span>

                <span
                  v-for="file in uploading[q.id]"
                  :key="file.key"
                  class="ask-chip ask-chip--uploading"
                >
                  <span class="ask-chip__name">{{ file.name }}</span>
                  <span class="ask-chip__state">Uploading…</span>
                </span>
              </div>

              <span
                v-if="attachedTotal >= USER_INPUT_ATTACHMENT_LIMIT"
                class="ask-attach-hint"
              >
                {{ USER_INPUT_ATTACHMENT_LIMIT }} files max
              </span>
            </div>
            <p v-if="uploadErrors[q.id]" class="ask-attach-error" role="alert">
              {{ uploadErrors[q.id] }}
            </p>
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
  <!-- The agent's image opened over the dialog, in the same viewer the
       visuals use. -->
  <VisualImageViewer
    v-if="viewedImage"
    :src="viewedImage.src"
    :alt="viewedImage.alt"
    @close="viewedImage = null"
  />
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

/* What the agent attached to the prompt — a compact thumbnail row for images,
   and the reply's own visual frame below them, filling the card's width. */
.ask-agent-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ask-agent-thumb {
  width: 72px;
  height: 72px;
  flex: none;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--btn-border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  cursor: zoom-in;
  transition: border-color 0.18s ease;
}
.ask-agent-thumb:hover,
.ask-agent-thumb:focus-visible {
  border-color: color-mix(in srgb, var(--ink) 26%, transparent);
}
.ask-agent-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* The answer's own attachments: one quiet paperclip button, then a wrap of
   chips — image thumbnails or a file-type badge, the name, and a remove ✕. */
.ask-attach {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ask-file-input {
  display: none;
}
.ask-attach-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}
.ask-attach-btn:hover,
.ask-attach-btn:focus-visible {
  background: var(--hover);
  color: var(--ink);
}
.ask-chips {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 6px;
}
.ask-chip {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 6px;
  padding: 3px 4px 3px 3px;
  border: 1px solid var(--btn-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 3%, transparent);
  font-size: 12px;
  line-height: 1.2;
}
.ask-chip__thumb {
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 5px;
  object-fit: cover;
}
.ask-chip__ext {
  display: inline-flex;
  min-width: 22px;
  height: 22px;
  align-items: center;
  justify-content: center;
  padding: 0 3px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
}
.ask-chip__name {
  min-width: 0;
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-soft);
}
.ask-chip__state {
  flex: none;
  color: var(--muted);
  font-size: 11px;
}
.ask-chip--uploading {
  opacity: 0.75;
}
.ask-chip__remove {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}
.ask-chip__remove:hover,
.ask-chip__remove:focus-visible {
  background: var(--hover);
  color: var(--ink);
}
.ask-attach-hint,
.ask-upload-note {
  color: var(--muted);
  font-size: 11px;
}
.ask-attach-error {
  font-size: 12px;
  line-height: 1.35;
  color: var(--danger, #d9544f);
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
