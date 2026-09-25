<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Copy01Icon,
  Folder01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { ThreadBlock } from "~/composables/useAgent";
import type { ChatAttachment } from "~/types/desktop";
import type {
  AttachmentPartition,
  ReceiptState,
} from "~/components/conversation/ConversationThread.vue";
import FileChip from "~/components/git-space/FileChip.vue";
import YouHead from "~/components/conversation/YouHead.vue";
import ReceiptTicks from "~/components/conversation/ReceiptTicks.vue";
import TurnActions from "~/components/conversation/TurnActions.vue";
import { formatFileSize } from "~/utils/formatFile";

// One user turn, extracted from ConversationThread: the request bubble (or its
// edit field), the head / corner time / ticks its style gives it, its
// attachments, and the one footer below it. The thread keeps timeline
// coordination (grouping, scroll, lightbox, clipboard timers); everything
// about presenting and editing this request lives here — including the edit
// draft and the expand/collapse state, which are per-turn and die with it.

type UserBlock = Extract<ThreadBlock, { role: "user" }>;

const props = defineProps<{
  block: UserBlock;
  /** Delivered/read state of this request (the chat's ticks). */
  receipt: ReceiptState;
  /** This turn's attachments, partitioned once by the thread. */
  parts: AttachmentPartition;
  /** The request wears your face, name and time, like a reply. */
  showHead: boolean;
  /** The head's time, phrased the style's way. */
  headStamp: string;
  /** The request carries its time in the bubble's corner. */
  bubbleStamp: boolean;
  /** The corner carries read ticks too. Only the chat. */
  ticks: boolean;
  /** Where this turn's actions sit: the head line, the command line, or the
   *  hover row under the bubble. The thread derives it from the style, so the
   *  old compound predicate (`editing || !floatActs || userActs === 'foot'`)
   *  dissolves — the footer shows while editing or when it owns the row. */
  acts: "head" | "inline" | "side" | "foot";
  /** This turn's text just landed on the clipboard. */
  copied: boolean;
  allowScratchpad: boolean;
  /** A turn is in flight — saving an edit is refused while one is. */
  busy: boolean;
  /** An attachment path just landed on the clipboard. */
  copiedPathId: string | null;
  /** The bubble's corner clock. */
  time: string;
}>();

const emit = defineEmits<{
  /** The edit was saved — the thread routes it (resend when last, fork when
   *  earlier). The draft stays open here until the thread's busy gate passes,
   *  mirroring the old save: an empty or busy save keeps editing. */
  save: [text: string];
  copy: [];
  scratchpad: [];
  preview: [att: ChatAttachment, turnAttachments: ChatAttachment[] | undefined];
  copyPath: [attachmentId: string];
  showInFolder: [attachmentId: string];
}>();

const { cue } = useSound();

// ── edit-and-resend ─────────────────────────────────────────────────────────
// The bubble stays the bubble — its text becomes a seamless auto-growing
// field (Enter saves, Shift+Enter newlines, Esc cancels).
const editing = ref(false);
const draft = ref("");
const editInput = ref<HTMLTextAreaElement | null>(null);

function startEdit(): void {
  editing.value = true;
  draft.value = props.block.text;
  cue("toggle");
  void nextTick(() => {
    editInput.value?.focus();
    editInput.value?.select();
    growEdit();
  });
}
// Seamless auto-grow: the field never scrolls or shows a resize grabber — it
// takes exactly the height of its text, so the bubble simply grows with it.
function growEdit(): void {
  const el = editInput.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
function cancelEdit(): void {
  editing.value = false;
  draft.value = "";
}
function saveEdit(): void {
  const text = draft.value.trim();
  if (!text || props.busy) return;
  editing.value = false;
  draft.value = "";
  cue("press");
  emit("save", text);
}

// ── long requests fold ──────────────────────────────────────────────────────
const USER_REQUEST_LIMIT = 900;
const expanded = ref(false);
const isLong = computed(() => props.block.text.length > USER_REQUEST_LIMIT);
const displayText = computed(() => {
  if (!isLong.value || expanded.value) return props.block.text;
  return `${props.block.text.slice(0, USER_REQUEST_LIMIT).trimEnd()}…`;
});
function toggleExpand(): void {
  expanded.value = !expanded.value;
  cue(expanded.value ? "expand" : "collapse");
}

// While editing the footer is the edit's controls; otherwise it's the actions
// row — but only when this style gives the footer the row (the head-seated
// styles dock into the head or the command line instead).
const showFoot = computed(() => props.block.text && (editing.value || props.acts === "foot"));
</script>

<template>
  <!-- Mirrors the thread's own `.turn--you` column one level down: the full
       row width, aligned and spaced exactly as that row is — so the bubble,
       head, attachments and footer keep the geometry they had as its direct
       flex items, in every style. -->
  <div class="user-turn">
    <!-- Who asked — the styles that sit the request among the replies
         give it the same face-and-name head a reply has. -->
    <YouHead v-if="showHead" :stamp="headStamp">
      <template v-if="acts === 'head' && !editing && block.text" #actions>
        <TurnActions
          kind="you"
          :copied="copied"
          :allow-scratchpad="allowScratchpad"
          :can-act="!!block.text"
          @edit="startEdit"
          @copy="emit('copy')"
          @scratchpad="emit('scratchpad')"
        />
      </template>
    </YouHead>

    <!-- Edit-and-resend: the request bubble stays the bubble — its text
         becomes a seamless auto-growing field. The actions live in the one
         footer below, not inside the bubble. Saving ships a NEW user turn. -->
    <div v-if="editing" class="body body--you edit-box">
      <textarea
        ref="editInput"
        v-model="draft"
        class="edit-input you-text"
        aria-label="Edit request"
        rows="1"
        @input="growEdit"
        @keydown.enter.exact.prevent="saveEdit()"
        @keydown.esc.prevent="cancelEdit()"
      ></textarea>
    </div>
    <div
      v-else-if="block.text"
      class="body body--you selectable"
      :class="{ 'body--you-expanded': expanded }"
    >
      <p class="you-text">{{ displayText }}</p>
      <!-- The chat's corner time and ticks; the prompt's right-hand clock. -->
      <span v-if="bubbleStamp" class="you-stamp" aria-hidden="true">
        {{ time }}
        <ReceiptTicks v-if="ticks" :receipt="receipt" />
      </span>
      <!-- The prompt has no head for its actions, so they sit at the end
           of its command line, next to the clock. -->
      <TurnActions
        v-if="acts === 'inline'"
        kind="you"
        :copied="copied"
        :allow-scratchpad="allowScratchpad"
        :can-act="!!block.text"
        @edit="startEdit"
        @copy="emit('copy')"
        @scratchpad="emit('scratchpad')"
      />
      <button
        v-if="isLong"
        type="button"
        class="you-expand"
        :aria-expanded="expanded ? 'true' : 'false'"
        :aria-label="expanded ? 'Collapse request' : 'Show full request'"
        @click="toggleExpand"
      >
        <HugeiconsIcon
          :icon="expanded ? ArrowUp01Icon : ArrowDown01Icon"
          :size="14"
          :stroke-width="2"
        />
      </button>
    </div>
    <!-- What was attached to this turn -->
    <div v-if="block.attachments?.length" class="you-attachments selectable">
      <!-- Images thumbnail grid -->
      <div
        v-if="parts.images.length"
        class="att-grid"
        :class="{ 'att-grid--multi': parts.images.length > 1 }"
      >
        <button
          v-for="img in parts.images"
          :key="img.id"
          type="button"
          class="att-thumb-btn"
          :title="`Preview ${img.name}`"
          @click="emit('preview', img, block.attachments)"
        >
          <img
            :src="`attachment://${img.id}`"
            :alt="img.name"
            class="att-thumb-img"
            loading="lazy"
          />
          <div class="att-thumb-scrim">
            <span class="att-thumb-title">{{ img.name }}</span>
            <span class="att-thumb-size">{{ formatFileSize(img.sizeBytes) }}</span>
          </div>
        </button>
      </div>

      <div v-if="parts.videos.length" class="att-videos">
        <div v-for="vid in parts.videos" :key="vid.id" class="att-video-card">
          <video
            :src="`attachment://${vid.id}`"
            controls
            preload="metadata"
            class="att-video-player"
          />
          <div class="att-video-meta">
            <span class="att-video-name">{{ vid.name }}</span>
            <span class="att-video-size">{{ formatFileSize(vid.sizeBytes) }}</span>
          </div>
        </div>
      </div>

      <!-- Generic files with action chips -->
      <div v-if="parts.files.length" class="att-files-row">
        <div v-for="file in parts.files" :key="file.id" class="att-file-pill">
          <FileChip
            :path="file.name"
            :title="`${file.name} · ${file.mimeType} (${formatFileSize(file.sizeBytes)})`"
          />
          <span class="att-file-pill__size">{{ formatFileSize(file.sizeBytes) }}</span>
          <button
            type="button"
            class="att-action-btn"
            title="Copy path"
            @click="emit('copyPath', file.id)"
          >
            <HugeiconsIcon
              :icon="copiedPathId === file.id ? Tick02Icon : Copy01Icon"
              :size="12"
              :stroke-width="2"
            />
          </button>
          <button
            type="button"
            class="att-action-btn"
            title="Show in Finder / File Explorer"
            @click="emit('showInFolder', file.id)"
          >
            <HugeiconsIcon :icon="Folder01Icon" :size="12" :stroke-width="2" />
          </button>
        </div>
      </div>
    </div>
    <!-- The chat's seat: beside the bubble, level with its time. -->
    <TurnActions
      v-if="acts === 'side' && !editing && block.text"
      class="side-acts"
      kind="you"
      :copied="copied"
      :allow-scratchpad="allowScratchpad"
      :can-act="!!block.text"
      @edit="startEdit"
      @copy="emit('copy')"
      @scratchpad="emit('scratchpad')"
    />
    <div v-if="showFoot" class="you-foot" :class="{ 'you-foot--editing': editing }">
      <!-- While editing this turn the footer is the edit's controls;
           otherwise it's the actions row. One footer, never two. -->
      <template v-if="editing">
        <button type="button" class="foot__copy" @click="cancelEdit()">
          <HugeiconsIcon :icon="Cancel01Icon" :size="13" :stroke-width="2" />
          <span>Cancel</span>
        </button>
        <button
          type="button"
          class="foot__copy foot__copy--primary"
          :disabled="!draft.trim() || busy"
          @click="saveEdit()"
        >
          <HugeiconsIcon :icon="Tick02Icon" :size="13" :stroke-width="2" />
          <span>Save &amp; resend</span>
        </button>
      </template>
      <TurnActions
        v-else
        kind="you"
        :copied="copied"
        :allow-scratchpad="allowScratchpad"
        :can-act="!!block.text"
        @edit="startEdit"
        @copy="emit('copy')"
        @scratchpad="emit('scratchpad')"
      />
    </div>
  </div>
</template>

<style scoped>
/* The column one level down: full row width, aligned and spaced by
   inheritance from the thread's `.turn--you` row — kone's right-hung column
   and every left-sitting style's alike. Restating either value here would pin
   every style to kone's: the left styles set `align-items` and their own head
   spacing on `.turn`, and this has to follow them. */
.user-turn {
  display: flex;
  flex-direction: column;
  align-items: inherit;
  gap: inherit;
  width: 100%;
  min-width: 0;
}
/* You — a warm, accent-tinted surface (not a flat grey chip); soft, no shadow. */
.body--you {
  position: relative;
  z-index: 1;
  text-align: left;
  max-width: 80%;
  padding: 10px 15px;
  border-radius: 16px 16px 5px 16px;
  background: linear-gradient(
    135deg,
    color-mix(in oklab, var(--accent) 12%, var(--ground)) 0%,
    color-mix(in oklab, var(--accent) 6%, var(--ground)) 100%
  );
  text-wrap: pretty;
}
.you-text {
  margin: 0;
  white-space: pre-wrap;
}
.you-expand {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 20px;
  margin: 5px -4px -5px auto;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.you-expand:hover,
.you-expand:focus-visible {
  background: var(--hover);
  color: var(--ink);
}
.you-expand:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 30%, transparent);
  outline-offset: 1px;
}
/* Attachments that rode this turn — a right-aligned wrap of file chips under
   the message (or standing alone on an attachment-only turn). */
.you-attachments {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  max-width: 80%;
}
.you-foot {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  width: 100%;
  max-width: 80%;
  /* It hangs off the right edge, so it glides in from there — see the
     footer arrival below. */
  --foot-in-x: 8px;
}

/* Edit-and-resend — the request bubble stays the bubble; only its text becomes
   editable. The field is seamless: no inner box, no border, no ring, no resize
   grabber — it inherits the bubble's type and auto-grows to its content, so the
   whole thing reads as the same request, now editable. Controls live in the one
   footer below (see .you-foot), never inside the bubble. */
.edit-box {
  /* Keep the request roomy enough to edit even when the original was one word,
     but never wider than the bubble's own cap. */
  min-width: min(28rem, 60vw);
}
.edit-input {
  display: block;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit; /* the bubble's own type — .body / .you-text */
  resize: none;
  overflow: hidden;
  outline: none;
}

/* ── The request's footer showing up ─────────────────────────────────────────
   The same gesture as a reply's (see ConversationThread): the row glides in
   as one compact move from the side it hangs off, items staggering up through
   opacity only. Leaving is one quick fade, no stagger. Hovering anywhere on
   the turn answers at once. */
.you-foot {
  transform: translateX(var(--foot-in-x));
  transition: transform 320ms cubic-bezier(0.4, 0, 0.2, 1);
}
.user-turn .you-foot > * {
  opacity: 0;
  transition:
    opacity 320ms cubic-bezier(0.4, 0, 0.2, 1),
    background-color 0.15s ease,
    color 0.15s ease;
}
.user-turn:hover .you-foot,
.user-turn:focus-within .you-foot {
  transform: none;
  transition: transform 520ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.user-turn:hover .you-foot > *,
.user-turn:focus-within .you-foot > * {
  opacity: calc(var(--foot-shown, 1) * var(--item-dim, 1));
  transition:
    opacity 520ms cubic-bezier(0.2, 0.8, 0.2, 1) var(--foot-delay, 0ms),
    background-color 0.15s ease,
    color 0.15s ease;
}
.you-foot > :nth-child(2) { --foot-delay: 45ms; }
.you-foot > :nth-child(3) { --foot-delay: 90ms; }
.you-foot > :nth-child(4) { --foot-delay: 135ms; }
.you-foot > :nth-child(n + 5) { --foot-delay: 180ms; }
@media (hover: none) {
  .you-foot {
    transform: none;
  }
  .user-turn .you-foot > * {
    opacity: var(--item-dim, 1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .you-foot {
    transform: none;
  }
}

/* ── Attachment rich previews ─────────────────────────────────────────────── */
.att-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  max-width: 320px;
  width: 100%;
}
.att-grid--multi {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  max-width: 440px;
}
.att-thumb-btn {
  position: relative;
  aspect-ratio: 4 / 3;
  width: 100%;
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid var(--btn-border);
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  padding: 0;
  margin: 0;
  cursor: zoom-in;
  display: block;
}
.att-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.att-thumb-btn:hover .att-thumb-img {
  transform: scale(1.04);
}
.att-thumb-scrim {
  position: absolute;
  inset: auto 0 0 0;
  padding: 16px 8px 6px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.65), transparent);
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  color: #fff;
  font-size: 11px;
  opacity: 0;
  transition: opacity 0.18s ease;
  pointer-events: none;
}
.att-thumb-btn:hover .att-thumb-scrim {
  opacity: 1;
}
.att-thumb-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  max-width: 70%;
}
.att-thumb-size {
  font-family: var(--font-mono);
  font-size: 10px;
  opacity: 0.85;
}

.att-videos {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 420px;
  width: 100%;
}
.att-video-card {
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid var(--btn-border);
  background: #000;
}
.att-video-player {
  width: 100%;
  max-height: 240px;
  display: block;
}
.att-video-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 8px;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  font-size: 11px;
  color: var(--muted);
}
.att-video-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att-video-size {
  font-family: var(--font-mono);
  font-size: 10px;
}
.att-files-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  width: 100%;
}
.att-file-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 2px;
  border-radius: 8px;
  border: 1px solid var(--btn-border);
  background: color-mix(in srgb, var(--ink) 3%, transparent);
}
.att-file-pill__size {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
  padding-right: 2px;
}
.att-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.att-action-btn:hover {
  background: var(--hover);
  color: var(--ink);
}
</style>
