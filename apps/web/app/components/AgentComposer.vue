<script setup lang="ts">
import { computed, h, nextTick, onMounted, onUnmounted, ref, render, watch } from "vue";
import { onClickOutside, onKeyStroke, useEventListener } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon, Attachment01Icon, FlashIcon } from "@hugeicons/core-free-icons";
import ProviderLogo from "~/components/ProviderLogo.vue";
import ParticleOrb from "~/components/ParticleOrb.vue";
import ProjectFileMentionMenu from "~/components/ProjectFileMentionMenu.vue";
import MentionChip from "~/components/MentionChip.vue";
import type { AttachmentKind, GitProjectFile, InteractionMode } from "~/types/desktop";
import { useProjectFiles } from "~/composables/useProjectFiles";
import {
  detectFileMentionTrigger,
  formatFileMention,
  splitComposerMentionSegments,
  type FileMentionTrigger,
} from "~/utils/composerMentions";
import {
  effortForTier,
  familyForId,
  hasEffortChoice,
  type EffortTier,
  type ModelOption,
} from "~/utils/modelCatalog";

// "Agent input — states" board. One object walks four states:
//   dormant  · a calm orb at rest, breathing
//   ready    · it EXPANDS into a pill; the sleeping face fades to the field
//   typing   · the pill grows to fit the text (auto-height, never a scrollbar)
//   composing· attach context and it widens into a card; chips ride the top
// The whole thing is one surface that morphs — it expands and collapses, it
// never swaps one element out for another.
//
// It's now wired: it sends the draft to the agent session (via @send), and the
// seed turns into a stop button while a turn is in flight. Both model controls
// sit on the RIGHT of the field: the model picker (each family with its own
// provider logomark) and — only when the chosen model exposes more than one —
// The effort has no dropdown: clicking the brain CYCLES to the next real effort
// for that model and wraps. The effort is encoded into the model id we emit, so
// the parent stays oblivious to whether a provider bakes it into ids or a flag.

const props = defineProps<{
  /** Absolute project root used by the @ file picker. */
  projectPath: string;
  /** A turn is running — the send seed becomes a stop, Enter is inert. */
  busy?: boolean;
  /** The full model picker is open (hosted by the parent, outside our dock).
   *  While it is, a click in it — or on its scrim — must NOT collapse us. */
  picking?: boolean;
  /** The provider's models, grouped into families with real efforts. */
  models?: ModelOption[];
  /** The selected raw model id (carries the effort for a baked-suffix provider),
   *  or undefined for default. */
  modelId?: string;
  /** The current reasoning-effort tier. For a flag-based provider (Codex) this
   *  is the ONLY thing that tells a family's synthetic ladder rungs apart —
   *  they all share one `modelId`. */
  reasoning?: EffortTier;
  /** The agent's permission mode — how much it may do without asking. */
  mode?: InteractionMode;
  /** Is the model's real "fast" service tier (Codex's `serviceTiers`) active
   *  for this turn? Only meaningful when the current model has one. */
  fastMode?: boolean;
  /** The chosen context-window id (Claude's "200k"/"1m" auto-compact window).
   *  Only meaningful when the current model exposes more than one window;
   *  undefined falls back to that model's default window. */
  contextWindow?: string;
}>();

const emit = defineEmits<{
  /** The draft, plus any picked files. The parent uploads the files (scoped to
   *  the final thread) and hands the resulting metadata to the agent turn. */
  send: [text: string, files?: File[]];
  interrupt: [];
  "update:modelId": [id: string];
  "update:reasoning": [tier: EffortTier];
  "update:mode": [mode: InteractionMode];
  "update:fastMode": [on: boolean];
  "update:contextWindow": [id: string];
  /** Ask the host to open the full providers→models→effort picker. */
  "open-models": [];
}>();

const { cue } = useSound();

// ── model + effort pickers (both on the right) ─────────────────────────────────
// The family comes from the model id; the effort within it comes from the
// reasoning tier (not the id — a synthetic ladder's rungs all share one id).
const catalog = computed<ModelOption[]>(() => props.models ?? []);
const currentFamily = computed(() => familyForId(catalog.value, props.modelId));
const currentEffort = computed(() => effortForTier(currentFamily.value, props.reasoning));
const showEffort = computed(() => hasEffortChoice(currentFamily.value));
// Fast mode — a plain on/off toggle for the current family's real "fast"
// service tier (Codex's `serviceTiers`), when it has one. Most models don't.
const fastTier = computed(() => currentFamily.value?.fastTier);
// Context window — a small cycle over the family's windows (Claude's 200k/1m
// auto-compact window), when it has a choice. The current one is the prop, else
// the family's own default, else the first.
const contextWindows = computed(() => currentFamily.value?.contextWindows);
const currentWindow = computed(() => {
  const windows = contextWindows.value;
  if (!windows?.length) return undefined;
  return (
    windows.find((w) => w.id === props.contextWindow) ??
    windows.find((w) => w.isDefault) ??
    windows[0]
  );
});

const modelName = computed(
  () => currentFamily.value?.label ?? props.modelId ?? "Default model",
);
const modelBrand = computed(() => currentFamily.value?.brand ?? "generic");

// The model name opens the full picker (hosted by the parent); the composer
// only displays the current family + brand.
function openModels() {
  emit("open-models");
  cue("toggle");
}
// Cycle the effort: each click steps to the next real effort for this model and
// wraps at the end. No dropdown — the brain-stack + label carry the state.
const bumping = ref(false);
function cycleEffort() {
  const fam = currentFamily.value;
  if (!fam || fam.efforts.length < 2) return;
  const idx = fam.efforts.findIndex((e) => e.tier === props.reasoning);
  const next = fam.efforts[(idx + 1) % fam.efforts.length];
  if (!next) return;
  emit("update:modelId", next.modelId);
  emit("update:reasoning", next.tier);
  cue("toggle");
  // A quick tactile bump so the step registers.
  bumping.value = false;
  void nextTick(() => {
    bumping.value = true;
    window.setTimeout(() => (bumping.value = false), 240);
  });
}
// Brain-stack: N glyphs whose count + fill climb with the tier.
function brainStack(n: number): number[] {
  return Array.from({ length: Math.max(1, n) }, (_, i) => i);
}
// Toggle the current family's fast tier on/off — a plain boolean, not a cycle.
function toggleFastMode() {
  if (!fastTier.value) return;
  emit("update:fastMode", !props.fastMode);
  cue("toggle");
}
// Cycle the context window: step to the next one for this family and wrap. Two
// windows (200k/1m) makes this a toggle; the label carries the state.
function cycleContextWindow() {
  const windows = contextWindows.value;
  if (!windows || windows.length < 2 || !currentWindow.value) return;
  const idx = windows.findIndex((w) => w.id === currentWindow.value!.id);
  const next = windows[(idx + 1) % windows.length];
  if (!next) return;
  emit("update:contextWindow", next.id);
  cue("toggle");
}

// ── permission mode (how much the agent may do without asking) ─────────────────
// This IS the approval policy — a climbing ladder of autonomy, cycled on click
// like the effort control — no dropdown. Each rung maps to a real Codex
// approval/sandbox pairing downstream (ask / accept-edits / full-access); the
// icon carries a soft hue cue, calm at the bottom and warm at the top. The
// label always names the current rung so the cycle stays discoverable. (Not
// to be confused with a provider's separate plan/build turn mode — kone
// doesn't expose that as its own toggle yet.)
type ModeMeta = { id: InteractionMode; label: string; title: string; hue: string };
const MODES: ModeMeta[] = [
  { id: "ask", label: "Ask", title: "Ask — reads and asks before any change", hue: "#6E8BEF" },
  { id: "accept-edits", label: "Edits", title: "Edits — auto-approves file edits, asks before commands", hue: "#5EAF8C" },
  { id: "full-access", label: "Full", title: "Full access — runs everything without prompting", hue: "#D08466" },
];
const currentMode = computed(
  () => MODES.find((m) => m.id === (props.mode ?? "accept-edits")) ?? MODES[1]!,
);
const modeBump = ref(false);
function cycleMode() {
  const idx = MODES.findIndex((m) => m.id === currentMode.value.id);
  const next = MODES[(idx + 1) % MODES.length]!;
  emit("update:mode", next.id);
  cue("toggle");
  modeBump.value = false;
  void nextTick(() => {
    modeBump.value = true;
    window.setTimeout(() => (modeBump.value = false), 240);
  });
}

const open = ref(false);
// `text` is the serialized value the composer sends: plain prose with each
// completed mention written back as its full @path token. The editable field is
// a contenteditable surface (below) whose DOM holds text nodes + atomic chip
// spans; `text` is derived from it, never bound to it.
const text = ref("");
const field = ref<HTMLElement | null>(null);
const surface = ref<HTMLElement | null>(null);
const dock = ref<HTMLElement | null>(null);
const mirror = ref<HTMLElement | null>(null);

// ── project file mentions ────────────────────────────────────────────────────
// @ opens a small project-scoped picker over the field. The field itself is a
// contenteditable surface: prose lives in plain text nodes, and a chosen file
// becomes an atomic <MentionChip> span (a type logo + the bare filename) that
// the browser deletes as one unit. On every edit we serialize the DOM back into
// `text` — chips write out as their full @path — so what the provider receives
// is unchanged even though the field shows only names.
const mentionTrigger = ref<FileMentionTrigger | null>(null);
const mentionActiveIndex = ref(0);
// The live DOM position of the active trigger (which text node, and the char
// range of the "@query" inside it) so a pick can splice a chip in exactly there.
type DomTrigger = { node: Text; start: number; end: number };
let domTrigger: DomTrigger | null = null;
const mentionQuery = computed(() => mentionTrigger.value?.query ?? "");
const mentionOpen = computed(() => open.value && mentionTrigger.value !== null && !props.busy);
const projectFiles = useProjectFiles(
  () => props.projectPath,
  () => mentionQuery.value,
);
const mentionFiles = computed(() => projectFiles.entries.value);
const mentionPending = computed(() => projectFiles.pending.value);
const mentionError = computed(() => projectFiles.error.value);

// Placeholder shows only when the field is truly empty (no prose, no chips).
const isEmpty = computed(() => text.value.trim().length === 0);
// The hidden mirror mirrors the field's rendered content — chips at their real
// (name-sized) width — so the pill sizes to what's shown, not to the @paths.
const mirrorSegments = computed(() => splitComposerMentionSegments(text.value));

// Mint a chip element by mounting a live MentionChip into a detached host and
// handing back its root node. It's mounted live (not cloned) because the file
// icon (@iconify/vue) fills its SVG in a tick after mount — a synchronous clone
// would freeze an empty placeholder. Each chip's host is tracked so its Vue
// scope can be torn down when the field is cleared or the composer unmounts.
const chipHosts = new Set<HTMLElement>();
function makeChipEl(path: string): HTMLElement {
  const host = document.createElement("div");
  render(h(MentionChip, { path }), host);
  const chip = host.firstElementChild as HTMLElement | null;
  if (!chip) {
    render(null, host);
    const span = document.createElement("span");
    span.textContent = path;
    span.setAttribute("contenteditable", "false");
    span.dataset.mentionPath = path;
    return span;
  }
  chip.setAttribute("contenteditable", "false");
  chip.dataset.mentionPath = path;
  chipHosts.add(host);
  return chip;
}
// Unmount every live chip's Vue scope (the DOM nodes are already gone once the
// field is wiped). Called on clear/send and unmount so nothing lingers.
function disposeChips(): void {
  for (const host of chipHosts) render(null, host);
  chipHosts.clear();
}

// Walk the field's DOM into the serialized draft: text nodes verbatim, chips as
// their full @path token, and line breaks (a native <br> / block split from
// Shift+Enter) as "\n".
function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  if (el.dataset.mentionPath !== undefined) return formatFileMention(el.dataset.mentionPath);
  if (el.tagName === "BR") return "\n";
  let inner = "";
  for (const child of Array.from(el.childNodes)) inner += serializeNode(child);
  return /^(DIV|P)$/.test(el.tagName) ? `\n${inner}` : inner;
}
function serializeEditor(): string {
  const el = field.value;
  if (!el) return "";
  let out = "";
  for (const child of Array.from(el.childNodes)) out += serializeNode(child);
  // A lone bogus <br> the browser keeps in an "empty" field serializes to "\n";
  // treat a value that is only whitespace as empty so the placeholder returns.
  return out.replace(/^\n/, "");
}

// Read `text` back off the DOM after any edit, refresh the mention trigger from
// the live caret, and re-measure the surface.
function onEditorChanged(): void {
  text.value = serializeEditor();
  refreshTrigger();
  void nextTick(sync);
}

// Find an active @token at the collapsed caret, scoped to the caret's own text
// node. Reuses the shared detector so the "@ only after whitespace" rule holds.
function readDomTrigger(): { trigger: FileMentionTrigger; dom: DomTrigger } | null {
  const root = field.value;
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;
  const textNode = node as Text;
  const trigger = detectFileMentionTrigger(textNode.data, range.startOffset);
  if (!trigger) return null;
  return { trigger, dom: { node: textNode, start: trigger.rangeStart, end: range.startOffset } };
}

function refreshTrigger(): void {
  const found = readDomTrigger();
  domTrigger = found?.dom ?? null;
  mentionTrigger.value = found?.trigger ?? null;
}

function placeCaret(node: Node, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function selectMention(file: GitProjectFile): void {
  const trig = domTrigger;
  const root = field.value;
  if (!trig || !root) return;

  // Split the trigger's text node into [before][query][after], drop the query
  // text, and drop a chip where it was. A trailing space keeps the next word off
  // the chip — reusing one already sitting after the caret so we never double it.
  const after = trig.node.splitText(trig.end);
  trig.node.splitText(trig.start);
  const parent = trig.node.parentNode;
  const queryNode = trig.node.nextSibling;
  if (!parent || !queryNode) return;
  parent.removeChild(queryNode);

  const chip = makeChipEl(file.path);
  parent.insertBefore(chip, after);

  let caretNode: Node;
  let caretOffset: number;
  if (after.nodeType === Node.TEXT_NODE && (after as Text).data.startsWith(" ")) {
    caretNode = after;
    caretOffset = 1;
  } else {
    const space = document.createTextNode(" ");
    parent.insertBefore(space, after);
    caretNode = space;
    caretOffset = 1;
  }

  root.focus();
  placeCaret(caretNode, caretOffset);
  mentionActiveIndex.value = 0;
  onEditorChanged();
}

function onFieldInput(): void {
  onEditorChanged();
}
function onFieldClick(): void {
  refreshTrigger();
}
function onFieldKeyup(): void {
  refreshTrigger();
}

function onFieldKeydown(e: KeyboardEvent): void {
  if (mentionOpen.value) {
    const count = projectFiles.entries.value.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (count) mentionActiveIndex.value = (mentionActiveIndex.value + 1) % count;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (count) mentionActiveIndex.value = (mentionActiveIndex.value - 1 + count) % count;
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const file = projectFiles.entries.value[mentionActiveIndex.value];
      if (file) {
        e.preventDefault();
        selectMention(file);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      mentionTrigger.value = null;
      domTrigger = null;
      return;
    }
  }
  // Plain Enter sends. Shift+Enter falls through to the browser's native
  // line-break (it manages the caret correctly), which serializes back as "\n".
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!props.busy) send();
  }
}

// Rebuild the field's DOM from a serialized draft, parsing completed @paths back
// into chips. Used to restore a draft and to clear on send.
function setEditorFromText(value: string): void {
  const el = field.value;
  if (!el) return;
  el.replaceChildren();
  disposeChips();
  for (const segment of splitComposerMentionSegments(value)) {
    if (segment.type === "mention") el.appendChild(makeChipEl(segment.path));
    else if (segment.text) el.appendChild(document.createTextNode(segment.text));
  }
  text.value = serializeEditor();
}

function clearEditor(): void {
  field.value?.replaceChildren();
  disposeChips();
  text.value = "";
  mentionTrigger.value = null;
  domTrigger = null;
}

function focusEditorEnd(): void {
  const el = field.value;
  if (!el) return;
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Insert plain text at the caret (used by paste + type-anywhere-to-focus),
// falling back to the field's end when there's no live selection inside it.
function insertTextAtCaret(value: string): void {
  const el = field.value;
  if (!el) return;
  const sel = window.getSelection();
  let range: Range;
  if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0);
    range.deleteContents();
  } else {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  const node = document.createTextNode(value);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// The surface is sized imperatively so it can animate (CSS can't transition to
// `auto`). It grows WIDE first — the pill widens to hold the text up to MAX_W —
// and only once it's capped does it grow TALL (the text wraps, height follows).
// The resting orb is the same height as the open single-line pill, so opening
// changes only width + corners, never height.
const REST = 55;
const MIN_W = 360;
const MAX_W = 720;
// Each side control slot (matches .side width in CSS) — reserved so the pill
// never grows wide enough to push them off the window. The trailing side now
// carries two controls (model + effort), so the reserve is wider.
const SIDE_W = 200;
// Horizontal budget around the text: left pad + gap + send seed + right pad + rim.
const EXTRAS = 78;
const surfaceH = ref(REST);
const surfaceW = ref(MIN_W);
// Multi-line — pin the send seed to the bottom instead of centring it.
const isTall = ref(false);
// True only during the wake expand, so the corner-lead stagger applies then but
// not on every keystroke width change.
const opening = ref(false);
// A big/structural size change (paste, drop, wrap toggle, pill↔card) springs;
// the small per-keystroke nudges of ordinary typing stay snappy so the field
// tracks the cursor instead of wobbling behind it.
const springy = ref(false);
// Size changes below this (px) read as incremental typing → snappy, not spring.
const SPRING_MIN = 64;
let lastCard = false;

// ── attachments ────────────────────────────────────────────────────────────
// The composer holds the picked File objects locally (with an object-URL
// preview for images) and emits them on send; the parent uploads them to disk
// so they're scoped to the final thread. Limits mirror the main-process store
// (see MAX_ATTACHMENTS_PER_TURN / *_BYTES in the agent contract) so an oversize
// or over-count pick is caught here before it ever reaches an IPC round-trip.
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

type PendingAttachment = {
  id: number;
  file: File;
  name: string;
  kind: AttachmentKind;
  sizeBytes: number;
  /** A short uppercase badge for non-image files, e.g. "PDF", "MD". */
  ext: string;
  /** An object URL for image previews; revoked on remove / unmount. */
  previewUrl?: string;
};
let attachSeq = 0;
const attachments = ref<PendingAttachment[]>([]);
// A brief, self-clearing note when a pick is rejected (too big / too many).
const notice = ref("");
let noticeTimer: number | undefined;
function flash(msg: string) {
  notice.value = msg;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (notice.value = ""), 3200);
}

const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
let dragDepth = 0;

function extFor(file: File): string {
  const dot = file.name.lastIndexOf(".");
  const raw = dot > 0 ? file.name.slice(dot + 1) : "";
  return (raw || "FILE").slice(0, 4).toUpperCase();
}

// Take a FileList (picker, drop, or paste) into pending attachments, enforcing
// the count + per-kind size caps. Rejected files are skipped with a note.
function addFiles(list: FileList | File[] | null | undefined) {
  if (!list) return;
  const incoming = Array.from(list);
  if (incoming.length === 0) return;
  let added = 0;
  for (const file of incoming) {
    if (attachments.value.length >= MAX_ATTACHMENTS) {
      flash(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
      break;
    }
    const kind: AttachmentKind = file.type.startsWith("image/") ? "image" : "file";
    const cap = kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (file.size > cap) {
      flash(`"${file.name}" is too large (max ${Math.round(cap / (1024 * 1024))} MB).`);
      continue;
    }
    attachments.value.push({
      id: ++attachSeq,
      file,
      name: file.name,
      kind,
      sizeBytes: file.size,
      ext: extFor(file),
      previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
    });
    added++;
  }
  if (added > 0) {
    cue("toggle");
    if (!open.value) void wake();
    syncSoon();
  }
}

function openFilePicker() {
  fileInput.value?.click();
}
function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  addFiles(input.files);
  // Clear so re-picking the same file fires `change` again.
  input.value = "";
}

function removeAttachment(id: number) {
  const at = attachments.value.find((a) => a.id === id);
  if (at?.previewUrl) URL.revokeObjectURL(at.previewUrl);
  attachments.value = attachments.value.filter((a) => a.id !== id);
  cue("toggle");
  syncSoon();
}
function clearAttachments() {
  for (const at of attachments.value) {
    if (at.previewUrl) URL.revokeObjectURL(at.previewUrl);
  }
  attachments.value = [];
}

// ── drag & drop (over the whole dock) ────────────────────────────────────────
function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}
function onDragEnter(e: DragEvent) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dragging.value = true;
}
function onDragOver(e: DragEvent) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}
function onDrop(e: DragEvent) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dragging.value = false;
  addFiles(e.dataTransfer?.files);
}

// Paste — grab any files off the clipboard (a screenshot, a copied file) and
// keep the plain-text paste working when there aren't any.
function onPaste(e: ClipboardEvent) {
  const files = e.clipboardData?.files;
  if (files && files.length > 0) {
    e.preventDefault();
    addFiles(files);
    return;
  }
  // Force a plain-text paste — the field is contenteditable, so the default
  // would drop styled markup into it. Insert the text ourselves, then re-read.
  const plain = e.clipboardData?.getData("text/plain");
  if (plain) {
    e.preventDefault();
    insertTextAtCaret(plain);
    onEditorChanged();
  }
}

const hasAttachments = computed(() => attachments.value.length > 0);
const hasText = computed(() => text.value.trim().length > 0);
const armed = computed(() => hasText.value || hasAttachments.value);
const card = computed(() => hasAttachments.value);

// The card keeps a fixed comfortable width (chips define it); the pill sizes to
// its text. `undefined` lets CSS own the width (52 at rest, clamp for the card).
const widthStyle = computed(() =>
  open.value && !card.value ? `${surfaceW.value}px` : undefined,
);

// The widest the pill may get: MAX_W, but never so wide the side controls would
// leave the window.
function maxW(): number {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  return Math.max(MIN_W, Math.min(MAX_W, vw - 2 * SIDE_W - 40));
}
// The hidden mirror carries the same text at the same type, unwrapped, so its
// width is how wide the pill *wants* to be. Clamp it into [MIN_W, cap].
function measureWidth(): number {
  const m = mirror.value;
  if (!m) return MIN_W;
  return Math.max(MIN_W, Math.min(maxW(), Math.round(m.offsetWidth) + EXTRAS));
}
// Read the surface's natural height at its current (settled) width.
function measure(): number {
  const el = surface.value;
  if (!el) return REST;
  const prev = el.style.height;
  el.style.height = "auto";
  const h = el.offsetHeight;
  el.style.height = prev;
  return h;
}
// Size the pill: width to fit the text first, then — with that width applied —
// grow the textarea and measure the height it needs.
function sync() {
  const el = surface.value;
  const ed = field.value;
  // Width first: the pill widens to fit the text, up to the cap.
  const cap = maxW();
  // Freeze the width transition around the measurement below. scrollHeight
  // depends on how the text wraps, so reading it while the width is still easing
  // (e.g. right after a paste jumps the pill open) over-wraps the text and locks
  // in a too-tall box — the empty gap under the text. We snap to the target
  // width with no transition, measure, then put the width back where it was
  // painting and re-enable the transition — all in one synchronous pass, so the
  // eased motion is the only thing the browser ever paints.
  const savedTransition = el ? el.style.transition : "";
  const paintedWidth = el ? getComputedStyle(el).width : "";
  if (el) el.style.transition = "none";

  const prevW = surfaceW.value;
  const prevH = surfaceH.value;

  // A pill drives its own width inline to fit the text; the card lets CSS own it.
  const pill = open.value && !card.value;
  let desired = cap;
  if (pill) {
    const m = mirror.value;
    desired = (m ? m.offsetWidth : 0) + EXTRAS;
    surfaceW.value = Math.max(MIN_W, Math.min(cap, Math.round(desired)));
    if (el) el.style.width = `${surfaceW.value}px`;
  }
  // Wrap (and grow tall) once the card is up, the pill has hit its cap, or the
  // editor has already flowed onto a second line (e.g. a Shift+Enter break) —
  // then the send seed drops to the bottom instead of centring on one line.
  const multiline = open.value && !!ed && ed.scrollHeight > 30;
  const wrap = card.value || (open.value && desired > cap) || multiline;
  isTall.value = wrap;
  // The contenteditable owns its own height (it grows with its content), so we
  // just read the surface's resulting natural height — no explicit sizing here.
  surfaceH.value = open.value ? measure() : REST;

  // Spring only for the big moves: a large width/height jump (paste, drop) or a
  // structural change (pill↔card, the wake expand). A keystroke — including the
  // one that first wraps a line — is a small change and stays snappy, so the
  // field keeps up with the cursor instead of wobbling behind it.
  const jumped =
    Math.abs(surfaceW.value - prevW) > SPRING_MIN ||
    Math.abs(surfaceH.value - prevH) > SPRING_MIN;
  const structural = card.value !== lastCard || opening.value;
  springy.value = jumped || structural;
  lastCard = card.value;

  if (el) {
    // Keep the imperative class in step with the ref so the synchronous width
    // reapply below eases on the right curve (Vue would only patch it next tick).
    el.classList.toggle("is-springy", springy.value);
    const target = pill ? `${surfaceW.value}px` : "";
    el.style.width = paintedWidth; // back to where it was painting…
    void el.offsetWidth; // …flush that before transitions come back…
    el.style.transition = savedTransition;
    el.style.width = target; // …then ease to the target from there.
  }
}
// A width change (open, pill↔card) is mid-flight when it fires, so measuring
// now would read the wrong wrap. Re-measure once the morph has settled.
function syncSoon() {
  void nextTick(sync);
  window.setTimeout(sync, 380);
}

async function wake() {
  if (open.value) return;
  open.value = true;
  opening.value = true;
  // Hold the single-line pill height through the expand; correct once landed.
  surfaceH.value = REST;
  await nextTick();
  surfaceW.value = measureWidth();
  field.value?.focus();
  if (card.value) {
    // Attachments are already pending → we open as a card, not a pill. Measure
    // and apply the full card height NOW so the orb expands straight into its
    // final shape (width + height together), instead of opening single-line and
    // then growing tall a beat later to reveal the chips.
    sync();
  } else {
    window.setTimeout(sync, 300);
  }
  window.setTimeout(() => (opening.value = false), 340);
}

// Collapse back to the resting orb. The draft (text + chips) stays in state, so
// waking again restores exactly what was there.
function close() {
  if (!open.value) return;
  open.value = false;
  surfaceH.value = REST;
}
onClickOutside(dock, () => {
  // The picker lives outside our dock, so its clicks read as "outside" — but it
  // is our own surface, one step removed. Don't collapse while it's up.
  if (props.picking) return;
  close();
});
onKeyStroke("Escape", () => {
  close();
});

function onSurfaceClick() {
  if (!open.value) {
    void wake();
    return;
  }
  field.value?.focus();
}

// Type anywhere on the project page and the input catches it: the first
// keystroke wakes the composer and lands in the field, so you can just start
// writing. We only claim a plain printable character — never a shortcut combo,
// a key pressed while another field is focused, or one hit while a file detail
// is up (the composer is inert then).
async function onGlobalKey(e: KeyboardEvent) {
  if (open.value || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  // Single printable char only — "a", "1", "?" pass; "Enter"/"Tab"/arrows don't.
  if (e.key.length !== 1) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
  // A file detail is open → the composer is inert; leave the keystroke alone.
  if (dock.value?.closest("[inert]")) return;
  e.preventDefault();
  await wake();
  focusEditorEnd();
  insertTextAtCaret(e.key);
  onEditorChanged();
}
useEventListener(window, "keydown", onGlobalKey);

function send() {
  // While a turn runs the seed is a stop button.
  if (props.busy) {
    emit("interrupt");
    cue("press");
    return;
  }
  if (!armed.value) {
    void wake();
    return;
  }
  const draft = text.value.trim();
  // A turn is valid with text, attachments, or both — an attachment-only send
  // (a screenshot with no words) is allowed.
  const files = attachments.value.map((a) => a.file);
  emit("send", draft, files.length ? files : undefined);
  cue("success");
  clearEditor();
  clearAttachments();
  syncSoon();
}

onMounted(sync);
onUnmounted(() => {
  window.clearTimeout(noticeTimer);
  disposeChips();
  for (const at of attachments.value) {
    if (at.previewUrl) URL.revokeObjectURL(at.previewUrl);
  }
});
watch(
  [mentionQuery, () => projectFiles.entries.value.length],
  () => {
    mentionActiveIndex.value = Math.min(
      mentionActiveIndex.value,
      Math.max(0, projectFiles.entries.value.length - 1),
    );
  },
);

async function setDraft(draft: string) {
  await wake();
  await nextTick();
  setEditorFromText(draft);
  focusEditorEnd();
  syncSoon();
}

defineExpose({ wake, setDraft });
</script>

<template>
  <div
    ref="dock"
    class="dock"
    :class="{ 'dock--tall': isTall, 'dock--drag': dragging }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Hidden twin of the field's content, unwrapped — its width is how wide
         the pill wants to be. It renders the SAME chips (via MentionChip) so the
         pill sizes to the shown names, not to the underlying @paths. -->
    <div ref="mirror" class="mirror" aria-hidden="true"><template
        v-if="text"
      ><template
          v-for="(segment, index) in mirrorSegments"
          :key="`${segment.type}-${index}`"
        ><MentionChip
            v-if="segment.type === 'mention'"
            :path="segment.path"
          /><template v-else>{{ segment.text }}</template></template><span> </span></template><template v-else>Ask anything…&nbsp;</template></div>

    <!-- Off-screen file picker, opened by the attach control. Accepts anything;
         images become vision blocks, everything else an on-disk path block. -->
    <input
      ref="fileInput"
      type="file"
      multiple
      class="file-input"
      aria-hidden="true"
      tabindex="-1"
      @change="onFilePicked"
    />

    <div v-if="mentionOpen" class="mention-picker" @mousedown.stop>
      <ProjectFileMentionMenu
        :files="mentionFiles"
        :query="mentionQuery"
        :active-index="mentionActiveIndex"
        :pending="mentionPending"
        :error="mentionError"
        @highlight="mentionActiveIndex = $event"
        @select="selectMention"
      />
    </div>

    <!-- Controls sit beside the input, not in it. They fade in as it opens and
         ride outward on the surface's growing edge. -->
    <div class="side side--lead" :class="{ 'is-shown': open }" :inert="!open">
      <!-- Permission mode — no dropdown. Clicking cycles up the autonomy ladder
           (Ask → Edits → Full) and wraps; the hued icon + label carry it. -->
      <button
        type="button"
        class="mode"
        :class="{ 'mode--bump': modeBump }"
        :style="{ '--mode-hue': currentMode.hue }"
        :aria-label="currentMode.title"
        :title="currentMode.title"
        @click.stop="cycleMode"
      >
        <svg class="mode__icon" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <!-- Ask · a chat bubble with a question (the agent asks first) -->
          <template v-if="currentMode.id === 'ask'">
            <path d="M3 5.2c0-.9.7-1.6 1.6-1.6h8.8c.9 0 1.6.7 1.6 1.6v4.6c0 .9-.7 1.6-1.6 1.6H8l-3 2.4V11.4H4.6c-.9 0-1.6-.7-1.6-1.6Z" />
            <path d="M7.6 6.7a1.4 1.4 0 1 1 1.9 1.3c-.5.3-.7.6-.7 1.1" />
            <path d="M8.8 10.7v.02" />
          </template>
          <!-- Edits · a pencil (auto-applies edits) -->
          <template v-else-if="currentMode.id === 'accept-edits'">
            <path d="M11.4 3.7 14.3 6.6 6.9 14H4v-2.9Z" />
            <path d="M10.4 4.7 13.3 7.6" />
          </template>
          <!-- Full access · a shield (no limits, nothing held back) -->
          <template v-else>
            <path d="M9 2.6 14 4.6V9C14 12 11.9 14 9 15.4 6.1 14 4 12 4 9V4.6Z" />
          </template>
        </svg>
        <span class="mode__label">{{ currentMode.label }}</span>
      </button>

      <!-- Attach — opens the file picker. Drag-drop and paste feed the same
           pending list. Borderless like the other side controls. -->
      <button
        type="button"
        class="attach"
        aria-label="Attach files"
        title="Attach files, documents, or images"
        @click.stop="openFilePicker"
      >
        <HugeiconsIcon :icon="Attachment01Icon" :size="18" :stroke-width="2" />
      </button>
    </div>

    <!-- One surface, morphing. Closed it's the orb; open it's the field. -->
    <div
      ref="surface"
      class="surface"
      :class="{ 'is-open': open, 'is-card': card, 'is-opening': opening, 'is-springy': springy }"
      :style="{ height: surfaceH + 'px', width: widthStyle }"
      role="button"
      :aria-label="open ? undefined : 'Wake the agent'"
      @click="onSurfaceClick"
    >
      <!-- Resting particle bead: the marble broken into a turning cloud of
           light. Fades out as the surface morphs into the field. -->
      <div class="orbfx" aria-hidden="true">
        <ParticleOrb :size="55" :energy="busy ? 1 : 0" :active="!open" />
      </div>

      <!-- Attachment chips ride the gradient rim at the top of the card.
           Images show a thumbnail; other files show an uppercase extension
           badge. Clicking a chip removes it. -->
      <Transition name="fade">
        <div v-if="open && (hasAttachments || notice)" class="chips">
          <div
            v-for="at in attachments"
            :key="at.id"
            class="chip"
            :class="{ 'chip--image': at.kind === 'image' }"
            :title="at.name"
          >
            <img
              v-if="at.kind === 'image' && at.previewUrl"
              class="chip__thumb"
              :src="at.previewUrl"
              :alt="at.name"
            />
            <span v-else class="chip__badge">{{ at.ext }}</span>
            <span class="chip__name">{{ at.name }}</span>
            <!-- The ✕ is the only remove target — the thumbnail and name are
                 inert, so clicking a chip's body never drops the attachment. -->
            <button
              type="button"
              class="chip__remove"
              :aria-label="`Remove ${at.name}`"
              :title="`Remove ${at.name}`"
              @click.stop="removeAttachment(at.id)"
            >
              <svg class="chip__x" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3.5 3.5L8.5 8.5M8.5 3.5L3.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </button>
          </div>
          <span v-if="notice" class="chips__notice">{{ notice }}</span>
        </div>
      </Transition>

      <!-- White panel: the sleeping face and the field share it, cross-fading. -->
      <div class="panel">
        <!-- Dormant face -->
        <div class="face" aria-hidden="true">
          <svg class="face__eyes" viewBox="0 0 104 104">
            <path d="M32 52 Q40 58 48 52" fill="none" stroke="#241C46" stroke-width="3" stroke-linecap="round" opacity="0.85" />
            <path d="M56 52 Q64 58 72 52" fill="none" stroke="#241C46" stroke-width="3" stroke-linecap="round" opacity="0.85" />
          </svg>
          <span class="face__z face__z--near">z</span>
          <span class="face__z face__z--far">z</span>
        </div>

        <!-- Field · just the text and the send seed; the +/image/model controls
             live beside the surface, not inside it. -->
        <div class="field" :class="{ 'field--tall': isTall }">
          <!-- The field is a contenteditable surface: prose lives in text nodes
               and each completed @mention is an atomic MentionChip span (a type
               logo + the bare filename) the browser deletes as one unit. What we
               send is serialized off this DOM — chips written back as full @paths
               — so display and value can differ without any twin/overlay. -->
          <div
            ref="field"
            class="field__input"
            :class="{ 'field__input--empty': isEmpty }"
            contenteditable="true"
            role="textbox"
            aria-multiline="true"
            aria-label="Ask anything"
            data-placeholder="Ask anything…"
            :tabindex="open ? 0 : -1"
            @keydown="onFieldKeydown"
            @input="onFieldInput"
            @click="onFieldClick"
            @keyup="onFieldKeyup"
            @focus="onFieldClick"
            @paste="onPaste"
          />
          <button
            type="button"
            class="seed"
            :class="{ 'seed--armed': armed || busy, 'seed--busy': busy }"
            :aria-label="busy ? 'Stop' : 'Send'"
            :tabindex="open ? 0 : -1"
            @mousedown.prevent
            @click.stop="send"
          >
            <!-- Stop square while a turn runs; the send arrow otherwise. -->
            <svg v-if="busy" class="seed__stop" viewBox="0 0 18 18" aria-hidden="true">
              <rect x="5" y="5" width="8" height="8" rx="2" fill="#FFFFFF" />
            </svg>
            <svg v-else class="seed__arrow" viewBox="0 0 18 18" aria-hidden="true">
              <path d="M9 14V4.2M9 4.2L4.3 8.9M9 4.2L13.7 8.9" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Both pickers sit beside the input on the right: the model (with its own
         provider logomark) and — when the model exposes more than one — the
         effort. -->
    <div class="side side--trail" :class="{ 'is-shown': open }" :inert="!open">
      <!-- Model — the name opens the full providers→models→effort picker. -->
      <button type="button" class="model" @click.stop="openModels">
        <ProviderLogo :brand="modelBrand" :size="15" />
        <span class="model__name">{{ modelName }}</span>
      </button>

      <!-- Effort — no dropdown. Clicking the brain steps to the next real effort
           for this model and wraps; the stack + label carry the state. -->
      <button
        v-if="showEffort && currentEffort"
        type="button"
        class="effort"
        :class="{ 'effort--bump': bumping }"
        :aria-label="`Reasoning effort: ${currentEffort.label}. Click to change.`"
        @click.stop="cycleEffort"
      >
        <span class="stack" :class="{ 'stack--glow': currentEffort.glow }">
          <HugeiconsIcon
            v-for="i in brainStack(currentEffort.brains)"
            :key="i"
            :icon="AiBrain01Icon"
            :size="15"
            :stroke-width="2"
            :style="{ color: currentEffort.hue }"
          />
        </span>
      </button>

      <!-- Fast mode — a plain on/off for the model's real "fast" service tier,
           when it has one. -->
      <button
        v-if="fastTier"
        type="button"
        class="fast"
        :class="{ 'fast--on': fastMode }"
        :aria-pressed="Boolean(fastMode)"
        :aria-label="`${fastTier.label}: ${fastMode ? 'on' : 'off'}. Click to toggle.`"
        @click.stop="toggleFastMode"
      >
        <HugeiconsIcon :icon="FlashIcon" :size="15" :stroke-width="2" />
      </button>

      <!-- Context window — a small cycle over the model's windows (Claude's
           200k/1m auto-compact window). The label carries the state; clicking
           steps to the next window and wraps. -->
      <button
        v-if="currentWindow"
        type="button"
        class="ctxwin"
        :aria-label="`Context window: ${currentWindow.label}. Click to change.`"
        :title="`Context window · ${currentWindow.label}`"
        @click.stop="cycleContextWindow"
      >
        {{ currentWindow.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Pill rim — one conic sweep through indigo → blue → teal → cream → coral,
   plus a sheen the send seed layers on top so it reads as a glossy marble. */
.dock {
  --pill-rim: conic-gradient(
    in oklab from 205deg at 50% 50%,
    oklab(65.3% 0.048 -0.161) 0%,
    oklab(65.5% -0.02 -0.155) 20%,
    oklab(79.6% -0.1 -0.046) 40%,
    oklab(89.9% 0.019 0.087) 60%,
    oklab(79.3% 0.1 0.069) 80%,
    oklab(65.3% 0.048 -0.161) 100%
  );
  --sheen: radial-gradient(
    ellipse 125% 125% at 30% 24% in oklab,
    oklab(100% 0 0 / 85%) 0%,
    oklab(100% 0 0 / 0%) 42%
  );
  --surface: #ffffff;
  --field-ink: #17171a;
  --placeholder: #b7b4ae;
  --btn: #ffffff;
  --btn-border: rgb(0 0 0 / 0.08);
  --btn-ink: #55555a;
  --chip: #fbfaf9;
  --chip-ink: #3a3a3e;
  --chip-x: #b0aea9;

  display: flex;
  flex-direction: row;
  align-items: center;
  position: relative;
  width: max-content;
  animation: dock-rise 440ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: var(--proj-enter-composer, 0ms);
}

/* The picker is anchored to the field rather than the viewport so it follows
   the composer's morph on both the overview and board surfaces. */
.mention-picker {
  position: absolute;
  z-index: 30;
  left: 200px;
  bottom: calc(100% + 12px);
  pointer-events: auto;
}
@keyframes dock-rise {
  from {
    opacity: 0;
    transform: translateY(28px) scale(0.88);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* When the pill grows tall, the side controls drop to the bottom with the send
   seed (the padding lines them up with the seed's inset). */
.dock--tall { align-items: flex-end; }
.dock--tall .side { padding-bottom: 12px; }

/* Dragging files over the dock: a soft indigo ring on the surface invites the
   drop. No border/heavy shadow — a low, calm glow in kone's idiom. */
.dock--drag .surface {
  box-shadow: rgb(139 124 240 / 0.30) 0 0 0 3px;
}

/* ── Side controls ────────────────────────────────────────────────────────── */
/* Equal-width slots flank the surface so it stays screen-centred; the controls
   hug the pill and fade/slide in as it opens. */
.side {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  width: 200px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.26s ease, transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}
.side--lead { justify-content: flex-end; gap: 8px; padding-right: 10px; transform: translateX(10px); }
.side--trail { justify-content: flex-start; gap: 2px; padding-left: 10px; transform: translateX(-10px); }
.side.is-shown {
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition: opacity 0.22s ease 0.1s, transform 0.28s cubic-bezier(0.22, 1, 0.36, 1) 0.1s;
}

@media (prefers-color-scheme: dark) {
  .dock {
    --surface: #161619;
    --field-ink: #f4f4f5;
    --placeholder: #6b6b72;
    --btn: #1f1f23;
    --btn-border: rgb(255 255 255 / 0.1);
    --btn-ink: #c4c4c8;
    --chip: #202024;
    --chip-ink: #e6e6e8;
    --chip-x: #7a7a80;
  }
}

/* ── The morphing surface ─────────────────────────────────────────────────── */
/* At rest it's a 52px orb. Open, it becomes the gradient rim around a white
   field. Width, corner radius, rim padding and height all ease together, so the
   orb visibly expands and collapses. */
.surface {
  position: relative;
  overflow: hidden;
  /* Own compositing layer — keeps the rounded-corner clip of the gradient rim
     crisp instead of aliased. */
  transform: translateZ(0);
  isolation: isolate;
  width: 55px;
  padding: 0;
  border-radius: 50%;
  cursor: pointer;
  pointer-events: auto;
  /* Collapse: it shrinks back to the orb first, then the corners round off into
     a circle last — the mirror of the expand's anticipation. */
  transition:
    width 0.4s cubic-bezier(0.22, 1, 0.36, 1),
    height 0.4s cubic-bezier(0.22, 1, 0.36, 1),
    padding 0.22s ease 0.16s,
    border-radius 0.26s ease 0.18s;
}
/* At rest the surface carries no gradient — the particle orb IS the mark, and it
   bleeds past the box (no circular clip). The rim returns only as the pill edge
   once it opens. */
.surface:not(.is-open) {
  overflow: visible;
  background-image: none;
}
.surface.is-open {
  width: 360px; /* fallback; the pill's real width is driven inline to fit text */
  padding: 2.5px;
  border-radius: 32px;
  background-image: var(--pill-rim);
  cursor: default;
  display: flex;
  flex-direction: column;
  /* Open + everyday sizing: width tracks the text and height follows. This is
     the typing curve — short and snappy with no overshoot, so per-keystroke
     nudges keep up with the cursor instead of wobbling behind it. */
  transition:
    border-radius 0.13s cubic-bezier(0.4, 0, 0.2, 1),
    padding 0.13s ease,
    width 0.12s cubic-bezier(0.4, 0, 0.2, 1),
    height 0.14s cubic-bezier(0.4, 0, 0.2, 1);
}
/* Big/structural moves (paste, drop, first/last wrap, pill↔card) overshoot and
   settle back — a little spring so a large size change feels physical. */
.surface.is-open.is-springy {
  transition:
    border-radius 0.13s cubic-bezier(0.4, 0, 0.2, 1),
    padding 0.13s ease,
    width 0.34s cubic-bezier(0.34, 1.56, 0.64, 1),
    height 0.42s cubic-bezier(0.34, 1.56, 0.64, 1);
}
/* Only through the wake expand: corners square off to the input's radius first,
   then the body stretches out — so it never passes through an ellipse. Placed
   after .is-springy so it wins during opening (both classes are on then). */
.surface.is-open.is-opening {
  transition:
    border-radius 0.13s cubic-bezier(0.4, 0, 0.2, 1),
    padding 0.13s ease,
    width 0.42s cubic-bezier(0.34, 1.56, 0.64, 1) 0.09s,
    height 0.42s cubic-bezier(0.34, 1.56, 0.64, 1) 0.09s;
}
/* Card geometry only holds while open — attachments persist in the draft, so
   `is-card` stays on through a collapse. Gating on `.is-open` lets the surface
   shed the card's width/radius the instant it closes and ease back to the bead,
   exactly like the no-attachment pill (whose width comes from the inline style
   that clears on close). Without this the closed surface stays a wide rounded
   box and the next open expands from that, not from the orb. */
.surface.is-open.is-card {
  width: clamp(400px, 56vw, 720px);
  border-radius: 26px;
}

/* White field body. Transparent at rest so the orb reads as a solid marble.
   Its corners track the surface's on the same curve so the gradient rim keeps an
   even thickness all the way through the morph. */
.panel {
  position: relative;
  height: 100%;
  border-radius: inherit;
  background: transparent;
  transition: background-color 0.28s ease, border-radius 0.13s cubic-bezier(0.4, 0, 0.2, 1);
}
.surface.is-open .panel {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: 29.5px;
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
}
.surface.is-open.is-card .panel { border-radius: 23.5px; }

/* ── Resting particle bead ────────────────────────────────────────────────── */
/* The turning cloud sits centred over the surface at rest. It fades and scales
   away the instant the surface starts to open, so the morph into the field
   isn't cluttered by a lingering orb. */
.orbfx {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  opacity: 1;
  transform: scale(1);
  transition: opacity 0.18s ease, transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 1;
}
.surface.is-open .orbfx {
  opacity: 0;
  transform: scale(0.7);
  transition: opacity 0.14s ease, transform 0.2s ease;
  pointer-events: none;
}

/* ── Dormant face ─────────────────────────────────────────────────────────── */
/* Retired: the particle globe is the resting mark now, so the sleeping eyes/z
   would only poke out past the orb. Kept in the DOM but hidden. */
.face {
  position: absolute;
  inset: 0;
  display: none;
  place-items: center;
  opacity: 1;
  transition: opacity 0.18s ease;
  pointer-events: none;
  animation: breathe 5.5s ease-in-out infinite;
}
.surface.is-open .face { opacity: 0; transition: opacity 0.16s ease; }
.face__eyes { width: 55px; height: 55px; }
.face__z {
  position: absolute;
  font-style: italic;
  font-weight: 600;
  color: #b4b0be;
}
.face__z--near { right: 8px; top: 6px; font-size: 12px; }
.face__z--far { right: 1px; top: -2px; font-size: 9px; color: #c8c4d0; }
@keyframes breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.04); }
}

/* ── Field ────────────────────────────────────────────────────────────────── */
/* Fades in a beat after the expand begins so text never appears mid-squeeze. */
.field {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 100%;
  padding: 8px 8px 8px 20px;
  opacity: 0;
  transition: opacity 0.18s ease;
}
/* In card mode the panel is a flex column, so the field should fill the
   remaining space after the chips row instead of stretching to 100 % of the
   panel (which would overflow past chips). */
.surface.is-open .field {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  opacity: 1;
  transition: opacity 0.2s ease 0.08s;
}
.surface:not(.is-open) .field { flex: none; }
/* Single line: text and seed sit centred. Once it wraps, the seed drops to the
   bottom while the text fills upward. */
.field--tall { align-items: flex-end; }
.surface.is-card .field {
  flex-direction: column;
  align-items: stretch;
  gap: 14px;
  padding: 14px 14px 14px 20px;
}
/* The contenteditable field. It flows text nodes + atomic chip spans on one
   line until it hits the pill's cap (or a Shift+Enter break), then wraps and
   grows its own height — no textarea, no overlay. The type ramp here must stay
   in step with .mirror below so the measured width matches what's painted. */
.field__input {
  flex: 1 1 0;
  width: 100%;
  min-width: 0;
  min-height: 20px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--field-ink);
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 20px;
  letter-spacing: normal;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
  cursor: text;
}
.field__input:focus { outline: 0; }
.surface.is-card .field__input { flex: 0 0 auto; line-height: 25px; }
/* Placeholder — shown only while the field is empty. */
.field__input--empty::before {
  content: attr(data-placeholder);
  color: var(--placeholder);
  pointer-events: none;
}

/* Off-screen twin of the field's content (same chips, same type) — measured to
   size the pill's width. Kept in sync with .field__input's font/size/line. */
.mirror {
  position: absolute;
  left: -9999px;
  top: 0;
  visibility: hidden;
  pointer-events: none;
  white-space: pre;
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 20px;
}

/* ── Send seed ────────────────────────────────────────────────────────────── */
.seed {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border: 0;
  padding: 0;
  border-radius: 50%;
  cursor: pointer;
  background-image: var(--sheen), var(--pill-rim);
  box-shadow: rgb(255 255 255 / 0.6) 0 1px 2px inset;
  transition: box-shadow 0.3s ease, transform 0.2s ease;
}
.surface.is-card .seed { width: 36px; height: 36px; align-self: flex-end; }
.seed--armed {
  box-shadow:
    rgb(255 255 255 / 0.6) 0 1px 2px inset,
    rgb(139 124 240 / 0.16) 0 0 0 4px;
}
.seed:hover { transform: scale(1.06); }
.seed:active { transform: scale(0.94); }
.seed__arrow { width: 15px; height: 15px; }
.surface.is-card .seed__arrow { width: 16px; height: 16px; }

/* ── Chips ────────────────────────────────────────────────────────────────── */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px 8px;
}
.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 5px 0 8px;
  border: 1px solid var(--btn-border);
  border-radius: 9px;
  background: var(--chip);
  color: var(--chip-x);
}
.chip--image { padding-left: 4px; }
/* Extension badge for non-image files — a soft neutral tile, no loud colour
   (kone stays calm and borderless). */
.chip__badge {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 20px;
  padding: 0 5px;
  border-radius: 6px;
  background: var(--btn-border);
  color: var(--chip-ink);
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 8.5px;
  letter-spacing: 0.02em;
  line-height: 1;
}
/* Image preview thumbnail. */
.chip__thumb {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: 6px;
  object-fit: cover;
  display: block;
}
.chip__name {
  color: var(--chip-ink);
  font-size: 13px;
  font-weight: 500;
  line-height: 16px;
  max-width: 104px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The remove target — a padded button around the ✕ so it's easy to hit and
   only it drops the attachment. Ink lifts and a soft tile appears on hover. */
.chip__remove {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--chip-x);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
}
.chip__remove:hover { background: var(--btn-border); color: var(--chip-ink); }
.chip__remove:active { transform: scale(0.9); }
.chip__x { width: 12px; height: 12px; flex-shrink: 0; }
.chips__notice {
  align-self: center;
  color: var(--chip-x);
  font-size: 12px;
  line-height: 16px;
}

/* ── Side control buttons (bare on the ground, beside the pill) ───────────── */
/* No pill, no border, no shadow — just the mark, in kone's borderless idiom.
   Hover only lifts the ink, it never draws a container. */
.ibtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--btn-ink);
  cursor: pointer;
  opacity: 0.72;
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.ibtn svg { width: 18px; height: 18px; }
.ibtn:hover { opacity: 1; transform: translateY(-1px); }
.ibtn:active { transform: translateY(0) scale(0.96); }
.model {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: #9a9a97;
  cursor: pointer;
  opacity: 0.82;
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.model:hover { opacity: 1; transform: translateY(-1px); }
.model__name {
  color: var(--chip-ink);
  font-size: 13px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
  max-width: 128px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Permission mode (autonomy ladder) ────────────────────────────────────── */
/* Borderless like the model/effort controls: the hued icon carries the rung, a
   neutral label names it. Cycles on click, with the same tactile pop. */
.mode {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 8px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--mode-hue, #9a9a97);
  cursor: pointer;
  opacity: 0.9;
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.mode:hover { opacity: 1; transform: translateY(-1px); }
.mode:active { transform: translateY(0) scale(0.96); }
.mode__icon { width: 16px; height: 16px; }
.mode__label {
  color: var(--chip-ink);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
}
.mode--bump .mode__icon { animation: effort-pop 0.24s cubic-bezier(0.34, 1.5, 0.64, 1); }

/* ── Attach control ───────────────────────────────────────────────────────── */
/* Borderless, matching the model/effort/mode idiom: just the mark, ink lifts on
   hover, no container. */
.attach {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 38px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--btn-ink);
  cursor: pointer;
  opacity: 0.78;
  transition: opacity 0.2s ease, transform 0.2s ease, color 0.2s ease;
}
.attach:hover { opacity: 1; transform: translateY(-1px); }
.attach:active { transform: translateY(0) scale(0.96); }
/* The real <input type=file> is off-screen; the attach button drives it. */
.file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ── Effort control (brain-stack) ─────────────────────────────────────────── */
.effort {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 38px;
  padding: 0 6px;
  border: 0;
  background: transparent;
  cursor: pointer;
  opacity: 0.88;
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.effort:hover { opacity: 1; transform: translateY(-1px); }
.effort:active { transform: translateY(0) scale(0.96); }
/* Each cycle step gives the stack a quick tactile pop. */
.effort--bump .stack { animation: effort-pop 0.24s cubic-bezier(0.34, 1.5, 0.64, 1); }
/* ── Fast mode toggle ─────────────────────────────────────────────────────── */
.fast {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 38px;
  width: 30px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--chip-ink);
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.2s ease, transform 0.2s ease, color 0.2s ease;
}
.fast:hover { opacity: 1; transform: translateY(-1px); }
.fast:active { transform: translateY(0) scale(0.96); }
.fast--on {
  color: #f5b300;
  opacity: 1;
  filter: drop-shadow(0 0 4px rgba(245, 179, 0, 0.5));
}
/* ── Context-window cycle ─────────────────────────────────────────────────── */
.ctxwin {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 38px;
  min-width: 34px;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: var(--chip-ink);
  font: 600 11px/1 var(--font-mono, ui-monospace, monospace);
  letter-spacing: 0.02em;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.2s ease, transform 0.2s ease, color 0.2s ease;
}
.ctxwin:hover { opacity: 1; transform: translateY(-1px); }
.ctxwin:active { transform: translateY(0) scale(0.96); }
@keyframes effort-pop {
  0% { transform: scale(0.82); }
  60% { transform: scale(1.12); }
  100% { transform: scale(1); }
}
/* The brains overlap into a tight cluster; a soft halo blooms at the top tier. */
.stack { display: inline-flex; align-items: center; }
.stack > :deep(svg) { margin-left: -6px; }
.stack > :deep(svg:first-child) { margin-left: 0; }
.stack--glow > :deep(svg) { filter: drop-shadow(0 0 3px currentColor); }

/* ── Popovers (model picker · reasoning dial) ─────────────────────────────── */
.pop { position: relative; display: flex; }
.menu {
  position: absolute;
  bottom: calc(100% + 10px);
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px;
  border-radius: 14px;
  background: var(--surface);
  box-shadow:
    rgb(0 0 0 / 0.10) 0 8px 28px -6px,
    rgb(0 0 0 / 0.06) 0 2px 8px -2px,
    var(--btn-border) 0 0 0 1px;
}
.menu--model { right: 0; min-width: 232px; max-width: 320px; max-height: 340px; overflow-y: auto; }
.menu__empty {
  margin: 0;
  padding: 10px 12px;
  color: var(--chip-x);
  font-size: 13px;
}
.opt {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.14s ease;
}
.opt:hover { background: var(--hover); }
.opt--on { background: var(--hover); }
.opt__logo {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--hover);
}
.opt__stack { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }
.opt__label { flex: 1 1 auto; color: var(--chip-ink); font-size: 13.5px; font-weight: 500; }
.opt__stack .opt__label { flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.opt__vendor { color: var(--chip-x); font-size: 11px; line-height: 1.2; }
.opt__hint { color: var(--chip-x); font-family: var(--font-mono); font-size: 11px; white-space: nowrap; }
.opt--model { align-items: center; }
.opt .stack { flex-shrink: 0; }
.opt__check { width: 14px; height: 14px; flex-shrink: 0; color: var(--accent); }

.menu-enter-active { transition: opacity 0.16s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1); }
.menu-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.menu-enter-from, .menu-leave-to { opacity: 0; transform: translateY(6px) scale(0.98); }

/* ── Stop glyph (seed while a turn runs) ──────────────────────────────────── */
.seed__stop { width: 15px; height: 15px; }
.surface.is-card .seed__stop { width: 16px; height: 16px; }
.seed--busy { animation: seed-pulse 1.8s ease-in-out infinite; }
@keyframes seed-pulse {
  0%, 100% { box-shadow: rgb(255 255 255 / 0.6) 0 1px 2px inset, rgb(139 124 240 / 0.10) 0 0 0 3px; }
  50% { box-shadow: rgb(255 255 255 / 0.6) 0 1px 2px inset, rgb(139 124 240 / 0.28) 0 0 0 6px; }
}

.fade-enter-active { transition: opacity 0.24s ease 0.08s; }
.fade-leave-active { transition: opacity 0.14s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .surface, .panel, .face, .field, .seed { transition-duration: 0.01s; transition-delay: 0s; }
  .dock { animation: none; }
  .face { animation: none; }
  .seed--busy { animation: none; }
  .side { transition-duration: 0.01s; transition-delay: 0s; }
  .fade-enter-active, .fade-leave-active { transition-duration: 0.01s; }
  .menu-enter-active, .menu-leave-active { transition-duration: 0.01s; }
}
</style>
