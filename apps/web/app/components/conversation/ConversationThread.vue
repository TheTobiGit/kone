<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Copy01Icon,
  Folder01Icon,
  Note01Icon,
  PencilEdit01Icon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { AssistantBlock, ThreadBlock } from "~/composables/useAgent";
import type { ChatAttachment, RuntimeItem } from "~/types/desktop";
import MarkdownMessage from "~/components/markdown/MarkdownMessage.vue";
import FileChip from "~/components/git-space/FileChip.vue";
import AgentActivity from "~/components/agent/AgentActivity.vue";
import TurnWorkFold from "~/components/turn/TurnWorkFold.vue";
import TurnStatusLine from "~/components/turn/TurnStatusLine.vue";
import AgentFace from "~/components/agent/AgentFace.vue";
import SphereFace from "~/components/agent/SphereFace.vue";
import ExchangeConnector from "~/components/ui/ExchangeConnector.vue";
import { agentIdentity } from "~/utils/agentIdentity";
import { dayKey, formatDayDivider } from "~/utils/threadDates";
import { renderGroups, segText, type RenderGroup, type Segment } from "~/utils/conversationSegments";
import type { TranscriptMode } from "~/utils/transcriptMode";
import CodeGolfArt from "~/components/ui/CodeGolfArt.vue";

// The live conversation — where the agent's turns become a timeline.
//
// The rule (the convention every serious agent UI + every provider wire format
// converges on): a turn is a single ORDERED list of parts — thinking, tool
// calls, and text — rendered strictly in the order they arrived. We never regroup
// by kind. Our provider stream already hands `block.items` in arrival order; we
// coalesce *adjacent* same-kind items into segments and split the turn into
// groups (a run of thinking + tool calls → an Agent Activity feed; text → a rich
// Markdown answer), then render the groups in place — so tools-at-the-start, a
// tool-after-text, and interleaved thinking all read correctly.
//
// The look is an editorial transcript: a calm warm-paper base with generous
// rhythm, colour and motion held back for the *live* moments so the dynamism
// feels earned.
//
//   · a batch of thinking + tool calls renders inline as an <AgentActivity>
//     item — one working orb heads the batch from send through every step;
//     once the agent moves on to text the batch folds into a horizontal strip;
//   · text renders as rich Markdown the whole way through — streaming or settled
//     — so a reply reads as a proper preview as it grows, never a raw block;
//
// Purely presentational — it reads the reduced blocks from useAgent and never
// learns which CLI is underneath.

const props = defineProps<{
  blocks: ThreadBlock[];
  /** Ticking clock from useAgent, so "working · Xs" counts up live. */
  now: number;
  /** A session-level error (start failure, crashed process) — shown as a
   *  single banner above the thread when set. */
  sessionError?: string | null;
  /** Strip column key — forwarded with scratchpad captures. */
  sourceKey?: string;
  /** The provider thread id, when this column is anchored to a stored
   *  conversation. Its presence is what distinguishes "transcript didn't load"
   *  from a fresh blank thread (which carries no id yet). */
  threadId?: string | null;
  /** The session's stored-transcript read came back empty-handed — the only
   *  thing that puts the "didn't load" banner up. */
  loadFailed?: boolean;
  /** The session's own durable thread id — what this thread's agent is derived
   *  from. Distinct from `threadId` above, which is deliberately absent on a
   *  blank column; the agent has to have a face before its first reply, so it
   *  is seeded from the id the session carries from the moment it exists. */
  agentSeed?: string | null;
  /** The session is still starting / rehydrating — no retry while it is. */
  loading?: boolean;
  /** A turn is in flight — retry / resend are disabled while one is. */
  busy?: boolean;
  /** A stored thread adopted windowed (keyset pagination): the store holds an
   *  older page beyond the window in hand. Absent for a full load / fresh
   *  thread. */
  hasOlder?: boolean;
  /** A load-older request is in flight. */
  loadingOlder?: boolean;
  /** The last load-older attempt failed — the affordance shows a retry. */
  olderError?: string | null;
  /** How much of a running turn this reading shows — the working transcript
   *  (every part, as it arrives) or the quiet reply (one status line while the
   *  agent works, then the answer). Defaults to the transcript; a surface that
   *  wants the quiet read has to ask for it. See utils/transcriptMode. */
  mode?: TranscriptMode;
  /** Keep an empty thread empty — no standing art. The art is an invitation to
   *  type, so it belongs where there is a composer under it and the blankness
   *  is a beginning. Somewhere you can only read, the same blankness means the
   *  transcript is still arriving or there is nothing to read, and filling it
   *  with an invitation would be offering a gesture that is not on the table.
   *
   *  Stated as the exception rather than as an `emptyArt: true` default,
   *  because Vue hands an absent boolean prop `false` rather than `undefined`:
   *  a default-on flag is off at every call site that doesn't mention it, which
   *  is how the art went missing from the board it was written for. */
  hideEmptyArt?: boolean;
  /** The replies here are kone's own rather than an agent's. The global
   *  assistant is one agent for every conversation it ever has, so its turns
   *  are spoken by the app's own face and name instead of an identity rolled
   *  from the thread's id — a new face every chat would be reporting a change
   *  of hands that never happened. */
  house?: boolean;
  /** Whether turn hovers offer scratchpad capture actions. Scratchpads belong
   *  to project studio rows, so threads not anchored to a specific project
   *  (such as the global assistant modal) omit them. Defaults to true unless
   *  explicitly false or when `house` is set. */
  scratchpad?: boolean;
}>();

const emit = defineEmits<{
  "to-scratchpad": [text: string];
  /** Re-send the user request that precedes a failed turn. The host owns the
   *  send path (ThreadStrip forwards this to the session's `send`). */
  retry: [text: string];
  /** Edit-and-resend: send the edited text as a NEW user turn. */
  resend: [text: string];
  /** A stored conversation failed to load its transcript — re-run the open. */
  "retry-load": [];
  /** The session start failed — re-run the session start. */
  "retry-session": [];
  /** Load the next older page of a windowed stored thread and prepend it. The
   *  host owns the fetch (session.loadOlder); the thread only asks. */
  "load-older": [];
}>();

const { cue } = useSound();

/** This thread's agent. A blank column has no id yet, so it falls back to the
 *  house name until its session has one — which is also the name kone answers
 *  under on a surface that is kone itself, so the house case asks for it
 *  outright by seeding nothing. */
const agent = computed(() => agentIdentity(props.house ? null : props.agentSeed));
const allowScratchpad = computed(() => props.scratchpad ?? !props.house);

// Warm the Markdown parser on mount: markdown-it is code-split behind a dynamic
// import, so the very first streamed reply would otherwise flash raw source for a
// beat while it loads. Kicking the load off now means text renders formatted from
// the first chunk.
if (import.meta.client) void useMarkdown().parse("");

// ── per-turn view, built once ──────────────────────────────────────────────────
// What the template needs to render one assistant turn: the settled groups, plus
// the live activity batch (if the turn is still running).
//
// One working orb per turn, anchored in AgentActivity from the first moment the
// turn runs. It stays mounted (stable key) while steps stream in — orb → line →
// thinking — instead of a stack-level orb handing off to a second one. So the
// *last* steps group is lifted out of `groups` while it's live and handed back as
// `live`; once text takes over (or the turn ends) it rejoins the list and folds
// into its horizontal strip.
// `groups` + `live` drive a RUNNING turn — the settled batches inline plus the
// one live tail.
//
// `foldedGroups` + `replyGroups` drive a SETTLED turn. Everything the agent did
// AND said on the way to its answer — tool calls, thinking, and the narration
// text between them — collapses behind a single "Worked for {duration}" fold;
// only the turn's final reply stays open. The reply is the turn's trailing text
// group (the last thing it said with no tool call after it). A turn that ends on
// a tool call has no trailing reply, so everything folds and the fold opens by
// default rather than collapsing to nothing.
type TextGroup = Extract<RenderGroup, { kind: "text" }>;
type BlockView = {
  groups: RenderGroup[];
  live: { segments: Segment[] } | null;
  foldedGroups: RenderGroup[];
  replyGroups: TextGroup[];
};

function buildView(block: AssistantBlock): BlockView {
  const all = renderGroups(block);
  const last = all[all.length - 1];
  const replyIsTrailingText = last?.kind === "text";
  const foldedGroups = replyIsTrailingText ? all.slice(0, -1) : all;
  // SAFETY: replyIsTrailingText means last.kind === "text", which is a TextGroup.
  const replyGroups = replyIsTrailingText ? [last as TextGroup] : [];
  const tail = all[all.length - 1];
  const tailIsSteps = tail?.kind === "steps";
  const live = block.state === "running" && (all.length === 0 || tailIsSteps);
  if (!live) return { groups: all, live: null, foldedGroups, replyGroups };
  if (tailIsSteps)
    return { groups: all.slice(0, -1), live: { segments: tail.segments }, foldedGroups, replyGroups };
  return { groups: all, live: { segments: [] }, foldedGroups, replyGroups };
}

// Built once per turn and kept until that turn's content actually changes.
//
// This used to be three bare `renderGroups(block)` calls in the template, so every
// turn on screen re-walked all its items on every re-render — and `now` ticks once
// a second for the whole of a running turn, which made that a per-second
// O(turns × items) sweep of the entire transcript. Worse, the rebuilt group
// objects were new every time, so each AgentActivity saw a changed `segments`
// prop and re-ran its own computeds. Holding identity steady is most of the win.
//
// The cache key is the `items` array's own identity, which is exact rather than
// merely usually-right: useAgent's reducer reassigns `block.items` (never mutates
// it in place) for every append, replace and subagent update, so a changed array
// means changed content and an unchanged one means there is nothing to rebuild.
// The tempting key — "rebuild only while state is 'running'" — reads true of the
// adapters today, but it makes the memo silently depend on no provider ever
// emitting a straggler item after its turn.completed, and the failure mode is a
// turn frozen permanently mid-render rather than one late row.
const viewCache = new Map<
  string,
  { items: RuntimeItem[]; state: AssistantBlock["state"]; view: BlockView }
>();
const viewByBlock = computed(() => {
  const out = new Map<string, BlockView>();
  for (const b of props.blocks) {
    if (b.role !== "assistant") continue;
    const hit = viewCache.get(b.id);
    // `state` too: it decides whether the tail batch is the live one, and a turn
    // can settle without its items changing at all.
    if (hit && hit.items === b.items && hit.state === b.state) {
      out.set(b.id, hit.view);
      continue;
    }
    const view = buildView(b);
    viewCache.set(b.id, { items: b.items, state: b.state, view });
    out.set(b.id, view);
  }
  for (const id of viewCache.keys()) if (!out.has(id)) viewCache.delete(id);
  return out;
});

// The quiet read: the agent's work never renders while the turn is running —
// one status line stands in for all of it, and the reply replaces the line when
// the turn settles. Everything the turn did is still reachable afterwards through
// the same work fold a transcript reading uses; this only decides what happens
// without being asked.
const quiet = computed(() => props.mode === "reply");

const EMPTY_VIEW: BlockView = { groups: [], live: null, foldedGroups: [], replyGroups: [] };
function viewOf(block: AssistantBlock): BlockView {
  return viewByBlock.value.get(block.id) ?? EMPTY_VIEW;
}

// ── timing / status ────────────────────────────────────────────────────────────
function fmt(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
function elapsed(block: AssistantBlock): string {
  const end = block.endedAt ?? props.now;
  return fmt(Math.max(0, Math.round((end - block.at) / 1000)));
}
type StatusLabel = {
  text: string;
  tone: "live" | "muted" | "error";
};
function statusOf(block: AssistantBlock): StatusLabel {
  if (block.state === "running") return { text: `working · ${elapsed(block)}`, tone: "live" };
  if (block.state === "failed") return { text: "couldn't finish", tone: "error" };
  if (block.state === "interrupted") return { text: "stopped", tone: "muted" };
  return { text: `replied in ${elapsed(block)}`, tone: "muted" };
}
// The receipt on a settled turn's work fold. Duration is the whole turn's span
// (`elapsed` reads block.at → block.endedAt), phrased by how the turn ended.
function workLabel(block: AssistantBlock): string {
  const dur = elapsed(block);
  if (block.state === "interrupted") return `Stopped ${dur}`;
  if (block.state === "failed") return `Ended ${dur}`;
  return dur;
}
const openFolds = reactive<Record<string, boolean>>({});
function isFoldOpen(blockId: string, defaultOpen = false): boolean {
  return openFolds[blockId] ?? defaultOpen;
}
function toggleFold(blockId: string, defaultOpen = false): void {
  const next = !isFoldOpen(blockId, defaultOpen);
  openFolds[blockId] = next;
  cue(next ? "expand" : "collapse");
}
function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function assistantText(block: AssistantBlock): string {
  return block.items
    .filter((i) => i.kind === "assistant_text" || i.kind === "plan_text")
    .map((i) => i.text)
    .join("\n\n")
    .trim();
}

// The turn meta flashes in the moment a turn settles, then fades — back on hover.
const flash = reactive<Record<string, boolean>>({});
const flashed = new Set<string>();
watch(
  () => props.blocks.map((b) => (b.role === "assistant" ? `${b.id}:${b.state}` : b.id)).join(","),
  () => {
    for (const b of props.blocks) {
      if (b.role !== "assistant" || b.state === "running" || flashed.has(b.id)) continue;
      flashed.add(b.id);
      flash[b.id] = true;
      if (import.meta.client) window.setTimeout(() => (flash[b.id] = false), 3000);
    }
  },
  { immediate: true },
);

// ── attachments & lightbox ───────────────────────────────────────────────────
const desktopAgent = () => (import.meta.client ? window.koneDesktop?.agent : undefined);

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function isImageAttachment(att: ChatAttachment): boolean {
  return att.type === "image" || att.mimeType.toLowerCase().startsWith("image/");
}

function isVideoAttachment(att: ChatAttachment): boolean {
  return att.mimeType.toLowerCase().startsWith("video/");
}

function partitionAttachments(attachments?: ChatAttachment[]) {
  const images: ChatAttachment[] = [];
  const videos: ChatAttachment[] = [];
  const files: ChatAttachment[] = [];
  for (const att of attachments ?? []) {
    if (isImageAttachment(att)) {
      images.push(att);
    } else if (isVideoAttachment(att)) {
      videos.push(att);
    } else {
      files.push(att);
    }
  }
  return { images, videos, files };
}

const copiedPathId = ref<string | null>(null);
let copiedPathTimer: number | undefined;

async function copyAttachmentPath(attachmentId: string) {
  const path = await desktopAgent()?.getAttachmentPath(attachmentId);
  if (path && navigator.clipboard) {
    await navigator.clipboard.writeText(path);
    copiedPathId.value = attachmentId;
    window.clearTimeout(copiedPathTimer);
    copiedPathTimer = window.setTimeout(() => (copiedPathId.value = null), 2000);
  }
}

async function showInFolder(attachmentId: string) {
  await desktopAgent()?.showAttachmentInFolder(attachmentId);
}

type LightboxState = {
  open: boolean;
  attachment: ChatAttachment;
  allImages: ChatAttachment[];
  index: number;
} | null;

const lightbox = ref<LightboxState>(null);

function openLightbox(att: ChatAttachment, turnAttachments?: ChatAttachment[]) {
  const images = (turnAttachments ?? []).filter(isImageAttachment);
  const idx = images.findIndex((a) => a.id === att.id);
  lightbox.value = {
    open: true,
    attachment: att,
    allImages: images.length ? images : [att],
    index: Math.max(0, idx),
  };
  cue("toggle");
}

function closeLightbox() {
  lightbox.value = null;
}

function nextLightboxImage() {
  if (!lightbox.value || lightbox.value.allImages.length <= 1) return;
  const nextIdx = (lightbox.value.index + 1) % lightbox.value.allImages.length;
  const nextAtt = lightbox.value.allImages[nextIdx];
  if (nextAtt) {
    lightbox.value.index = nextIdx;
    lightbox.value.attachment = nextAtt;
  }
}

function prevLightboxImage() {
  if (!lightbox.value || lightbox.value.allImages.length <= 1) return;
  const prevIdx = (lightbox.value.index - 1 + lightbox.value.allImages.length) % lightbox.value.allImages.length;
  const prevAtt = lightbox.value.allImages[prevIdx];
  if (prevAtt) {
    lightbox.value.index = prevIdx;
    lightbox.value.attachment = prevAtt;
  }
}

function onLightboxKeydown(e: KeyboardEvent) {
  if (!lightbox.value) return;
  if (e.key === "Escape") {
    closeLightbox();
  } else if (e.key === "ArrowRight") {
    nextLightboxImage();
  } else if (e.key === "ArrowLeft") {
    prevLightboxImage();
  }
}
// ── copy ──────────────────────────────────────────────────────────────────────
const copied = ref<string | null>(null);
const USER_REQUEST_LIMIT = 900;
const expandedUserRequests = reactive<Record<string, boolean>>({});
function isLongUserRequest(block: Extract<ThreadBlock, { role: "user" }>): boolean {
  return block.text.length > USER_REQUEST_LIMIT;
}
function userRequestText(block: Extract<ThreadBlock, { role: "user" }>): string {
  if (!isLongUserRequest(block) || expandedUserRequests[block.id]) return block.text;
  return `${block.text.slice(0, USER_REQUEST_LIMIT).trimEnd()}…`;
}
function toggleUserRequest(block: Extract<ThreadBlock, { role: "user" }>): void {
  expandedUserRequests[block.id] = !expandedUserRequests[block.id];
  cue(expandedUserRequests[block.id] ? "expand" : "collapse");
}
async function copyUserRequest(block: Extract<ThreadBlock, { role: "user" }>) {
  if (!block.text || !import.meta.client) return;
  try {
    await navigator.clipboard.writeText(block.text);
    cue("success");
    copied.value = block.id;
    window.setTimeout(() => {
      if (copied.value === block.id) copied.value = null;
    }, 1600);
  } catch {
    // Clipboard blocked — nothing to do.
  }
}
function addUserRequestToScratchpad(block: Extract<ThreadBlock, { role: "user" }>) {
  if (!allowScratchpad.value || !block.text?.trim()) return;
  emit("to-scratchpad", block.text);
  cue("press");
}
async function copy(block: AssistantBlock) {
  const text = assistantText(block);
  if (!text || !import.meta.client) return;
  try {
    await navigator.clipboard.writeText(text);
    cue("success");
    copied.value = block.id;
    window.setTimeout(() => {
      if (copied.value === block.id) copied.value = null;
    }, 1600);
  } catch {
    // Clipboard blocked — nothing to do.
  }
}

function addToScratchpad(block: AssistantBlock) {
  if (!allowScratchpad.value) return;
  const text = assistantText(block);
  if (!text.trim()) return;
  emit("to-scratchpad", text);
  cue("press");
}

// ── retry / edit-and-resend / load-failure ────────────────────────────────────
// All of these reach the session through the host (ThreadStrip forwards them):
// `retry` re-sends the user request that precedes a failed turn, `resend` ships
// the edited text as a NEW user turn (the failed reply stays in the transcript —
// rolling it back needs store support and is out of scope), and the two
// retry-load paths re-run the open or the session start. The buttons here are
// pure intent — this component never touches the send path itself.
const dismissedTurnErrors = reactive<Record<string, boolean>>({});
const sessionErrorDismissed = ref(false);
const showSessionError = computed(() => Boolean(props.sessionError) && !sessionErrorDismissed.value);
const copiedError = ref(false);
async function copySessionError(): Promise<void> {
  if (!props.sessionError || !import.meta.client) return;
  try {
    await navigator.clipboard.writeText(props.sessionError);
    copiedError.value = true;
    window.setTimeout(() => (copiedError.value = false), 1600);
  } catch {
    // Clipboard blocked — nothing to do.
  }
}
function retrySession(): void {
  sessionErrorDismissed.value = false;
  cue("press");
  emit("retry-session");
}
/** The user request this assistant turn answers — the nearest user block above
 *  it. Retry re-sends that, so a failed turn gets exactly its own prompt back. */
function userRequestFor(block: AssistantBlock): string {
  for (let i = props.blocks.indexOf(block) - 1; i >= 0; i--) {
    const b = props.blocks[i];
    if (b && b.role === "user") return b.text;
  }
  return "";
}
function retryTurn(block: AssistantBlock): void {
  const text = userRequestFor(block);
  if (!text.trim() || props.busy) return;
  cue("press");
  emit("retry", text);
}
function dismissTurnError(block: AssistantBlock): void {
  dismissedTurnErrors[block.id] = true;
  cue("collapse");
}

// ── edit-and-resend (last user turn only) ─────────────────────────────────────
// The edit affordance lives on the LAST user turn — the one a follow-up edit
// could still plausibly replace. Saving ships the text through the host's send
// path as a new turn; the transcript keeps the original and the reply after it.
const editingUser = ref<string | null>(null);
const editDraft = ref("");
const editInput = ref<HTMLTextAreaElement | null>(null);
const lastUserBlockId = computed(() => lastUserBlock()?.id ?? null);
function startEditUser(block: Extract<ThreadBlock, { role: "user" }>): void {
  editingUser.value = block.id;
  editDraft.value = block.text;
  cue("toggle");
  void nextTick(() => {
    editInput.value?.focus();
    editInput.value?.select();
    sizeEdit();
  });
}
// Seamless auto-grow: the field never scrolls or shows a resize grabber — it
// takes exactly the height of its text, so the bubble simply grows with it.
function sizeEdit(): void {
  const el = editInput.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
function autoGrowEdit(): void {
  sizeEdit();
}
function cancelEditUser(): void {
  editingUser.value = null;
  editDraft.value = "";
}
function saveEditUser(): void {
  const text = editDraft.value.trim();
  if (!text || props.busy) return;
  editingUser.value = null;
  editDraft.value = "";
  cue("press");
  emit("resend", text);
}

// ── a stored conversation whose transcript never arrived ─────────────────────
// The host tells us the read failed (`loadFailed`) — we never infer it from an
// empty timeline. An empty timeline is a legitimate state: a side chat hides
// its whole imported transcript, so emptiness would accuse every fresh one of
// a failure that never happened. Dismiss is presentational — the banner comes
// back on the next reopen, which is honest: nothing was fixed.
const loadDismissed = ref(false);
const failedLoad = computed(
  () =>
    Boolean(props.loadFailed) &&
    Boolean(props.threadId) &&
    !props.loading &&
    !props.busy &&
    !props.sessionError &&
    !loadDismissed.value,
);
function retryLoad(): void {
  loadDismissed.value = false;
  cue("press");
  emit("retry-load");
}
function dismissLoad(): void {
  loadDismissed.value = true;
  cue("collapse");
}

// ── helpers ─────────────────────────────────────────────────────────────────────
// The column's own root — `scroller` anchors on it to find the scroll container.
const root = ref<HTMLElement | null>(null);
// The last user block — the edit affordance keys off it (`lastUserBlockId`).
function lastUserBlock(): ThreadBlock | null {
  for (let i = props.blocks.length - 1; i >= 0; i--) {
    const b = props.blocks[i];
    if (b && b.role === "user") return b;
  }
  return null;
}
// The nearest scrollable container above the column — used to pin scroll offsets
// across the history reveal / older-page prepend.
function scroller(): HTMLElement | null {
  let el = root.value?.parentElement ?? null;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  // SAFETY: scrollingElement is document.documentElement or document.body — both HTMLElements.
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

const hasBlocks = computed(() => props.blocks.length > 0);
const hasRunningExchange = computed(
  () => props.busy || props.blocks.some((b) => b.role === "assistant" && b.state === "running"),
);

// Group the flat block list into exchanges: each user request opens a new group
// and the assistant turn(s) that follow it belong to that group.
const allExchanges = computed(() => {
  const groups: { key: string; blocks: ThreadBlock[] }[] = [];
  for (const b of props.blocks) {
    if (b.role === "user" || groups.length === 0) groups.push({ key: b.id, blocks: [b] });
    else groups[groups.length - 1]!.blocks.push(b);
  }
  return groups;
});

// ── the open window ────────────────────────────────────────────────────────────
// Reopening a long conversation used to mount every exchange it ever had: every
// activity feed, every Markdown answer, and a Shiki tokenisation per code fence —
// all before the first frame, and all of it scrolled far off the top where nobody
// was going to look. So we mount the tail and offer the rest.
//
// A window, not virtualisation: real virtualisation would have to measure and
// recycle rows. Mounting a suffix keeps the DOM simple and the scroll stable —
// the only thing that changes is how much history is above the fold.
const OPEN_WINDOW = 8;
const showAllExchanges = ref(false);
const earlierCount = computed(() =>
  showAllExchanges.value ? 0 : Math.max(0, allExchanges.value.length - OPEN_WINDOW),
);
const exchanges = computed(() =>
  earlierCount.value > 0 ? allExchanges.value.slice(earlierCount.value) : allExchanges.value,
);

/** Show a centered date divider on the first visible exchange, and whenever
 *  consecutive exchanges cross midnight into a new calendar day. */
function shouldShowDayDivider(index: number): boolean {
  const current = exchanges.value[index];
  if (!current || current.blocks.length === 0) return false;
  const currentAt = current.blocks[0]?.at;
  if (!currentAt) return false;

  if (index === 0) return true;

  const prev = exchanges.value[index - 1];
  const prevAt = prev?.blocks[0]?.at;
  if (!prevAt) return false;

  return dayKey(currentAt) !== dayKey(prevAt);
}

function dayDividerLabel(ex: { key: string; blocks: ThreadBlock[] }): string {
  const at = ex.blocks[0]?.at;
  if (!at) return "Today";
  return formatDayDivider(at, props.now);
}

// Re-collapse when the column is pointed at a different conversation — the
// component is reused across threads, and inheriting "expanded" would hand the
// next long transcript the very cost this avoids.
watch(
  () => props.sourceKey,
  () => (showAllExchanges.value = false),
);

// Reveal without moving the ground: history mounts *above* the viewport, so pin
// the distance to the bottom and let the scroll offset absorb the new content.
async function revealEarlier(): Promise<void> {
  cue("expand");
  const sc = import.meta.client ? scroller() : null;
  const fromBottom = sc ? sc.scrollHeight - sc.scrollTop : 0;
  showAllExchanges.value = true;
  if (!sc) return;
  await nextTick();
  sc.scrollTop = sc.scrollHeight - fromBottom;
}

// ── paging older history in (store-side window, useAgent's loadOlder) ────────
// A loaded older page lands ABOVE the viewport, so pin the distance to the
// bottom and let the scroll offset absorb the new content — the same
// ground-pinning idiom as revealEarlier. The trigger is a *prepend*: the
// first block id changed while the previous first block is still in the list.
// (A thread switch replaces the whole list; a live append touches the tail.)
// The newly fetched exchanges are also revealed: the OPEN_WINDOW is a
// mount-time cost guard, not a paging policy — the user asked for this
// history, so mount it.
let prependAnchor: number | null = null;
watch(
  () => props.blocks[0]?.id ?? null,
  (first, prev) => {
    if (!prev || first === prev) return;
    if (!props.blocks.slice(1).some((b) => b.id === prev)) return; // not a prepend
    const sc = import.meta.client ? scroller() : null;
    prependAnchor = sc ? sc.scrollHeight - sc.scrollTop : null;
    showAllExchanges.value = true;
    if (prependAnchor === null) return;
    // The watcher runs before the DOM patch, so the captured height is the
    // pre-prepend one; re-pin once the new content is in.
    void nextTick(() => {
      const s = scroller();
      if (s && prependAnchor !== null) s.scrollTop = s.scrollHeight - prependAnchor;
      prependAnchor = null;
    });
  },
);

/** Ask the host to fetch the next older page (session.loadOlder). The fetch
 *  and the prepend are the session's; this is the affordance for it. */
function requestOlder(): void {
  if (props.loadingOlder) return;
  cue("expand");
  emit("load-older");
}

// ── top-anchored turn staging & streaming follow ──────────────────────────────
// When the user submits a new request in a thread with history, we stage that
// new exchange right at the top of the viewport (where the first request of a
// thread sits). This leaves the entire open canvas below for the incoming
// response, thinking steps, and tool calls to stream down without page shifting.
const userScrolledAway = ref(false);
let scrollCleanup: (() => void) | null = null;

function isNearBottom(sc: HTMLElement, threshold = 96): boolean {
  return sc.scrollHeight - sc.clientHeight - sc.scrollTop <= threshold;
}

function scrollToLastExchangeTop(smooth = true): void {
  if (!import.meta.client) return;
  const sc = scroller();
  if (!sc) return;
  // SAFETY: querySelector returns the trailing .exchange element rendered by the template.
  const lastEx = root.value?.querySelector(".exchange:last-child") as HTMLElement | null;
  if (!lastEx) return;

  const scRect = sc.getBoundingClientRect();
  const exRect = lastEx.getBoundingClientRect();
  // 14px aligns with the container top padding / mask fade
  const targetTop = sc.scrollTop + (exRect.top - scRect.top) - 14;

  sc.scrollTo({
    top: Math.max(0, targetTop),
    behavior: smooth ? "smooth" : "auto",
  });
}

function followStreamingBottom(): void {
  if (!import.meta.client || userScrolledAway.value) return;
  const sc = scroller();
  if (!sc) return;
  if (isNearBottom(sc, 140)) {
    sc.scrollTo({
      top: sc.scrollHeight - sc.clientHeight,
      behavior: "smooth",
    });
  }
}

function scrollToBottom(): void {
  if (!import.meta.client) return;
  const sc = scroller();
  if (!sc) return;
  sc.scrollTop = sc.scrollHeight;
}

const initialScrollDoneFor = ref<string | null>(null);

function threadKey(): string {
  return props.sourceKey ?? props.threadId ?? "__blank__";
}

function doInitialScroll(): void {
  if (!import.meta.client) return;
  const key = threadKey();
  if (initialScrollDoneFor.value === key) return;
  if (props.blocks.length === 0) return;
  initialScrollDoneFor.value = key;
  void nextTick(() => {
    void nextTick(() => {
      if (!import.meta.client) return;
      requestAnimationFrame(() => scrollToBottom());
    });
  });
}

onMounted(() => {
  if (import.meta.client) {
    window.addEventListener("keydown", onLightboxKeydown);
  }
  const sc = scroller();
  if (!sc) return;
  const handler = () => {
    userScrolledAway.value = !isNearBottom(sc, 140);
  };
  sc.addEventListener("scroll", handler, { passive: true });
  scrollCleanup = () => {
    sc.removeEventListener("scroll", handler);
    if (import.meta.client) {
      window.removeEventListener("keydown", onLightboxKeydown);
    }
  };
  doInitialScroll();
});

watch(
  () => threadKey(),
  () => {
    void nextTick(() => doInitialScroll());
  },
);

watch(
  () => props.blocks.length,
  () => {
    doInitialScroll();
  },
);

onBeforeUnmount(() => {
  scrollCleanup?.();
});

watch(
  () => lastUserBlock()?.id ?? null,
  async (newId, oldId) => {
    if (!newId || newId === oldId) return;
    userScrolledAway.value = false;
    if (oldId !== null || (props.blocks.length > 0 && !props.blocks[0]?.historical)) {
      await nextTick();
      scrollToLastExchangeTop(true);
    }
  },
);

watch(
  () => {
    const last = props.blocks[props.blocks.length - 1];
    return last?.role === "assistant" && last.state === "running" ? last.items.length : 0;
  },
  async (len, oldLen) => {
    if (len > oldLen) {
      await nextTick();
      followStreamingBottom();
    }
  },
);
</script>

<template>
  <div
    ref="root"
    class="thread"
    :class="{
      'thread--empty': !hasBlocks,
      'thread--busy': hasRunningExchange,
    }"
  >
    <!-- Session-start failure (or a crashed process): a soft red card with the
         error, plus copy / retry / dismiss. Retry re-runs the session start;
         dismiss hides the card until the next session error arrives. -->
    <div v-if="showSessionError" class="thread__error" role="alert">
      <p class="body body--error">{{ sessionError }}</p>
      <div class="thread__error-actions">
        <button type="button" class="error-act" aria-label="Copy error" @click="copySessionError()">
          <HugeiconsIcon :icon="copiedError ? Tick02Icon : Copy01Icon" :size="13" :stroke-width="2" />
          <span>{{ copiedError ? "Copied" : "Copy" }}</span>
        </button>
        <button type="button" class="error-act" @click="retrySession()">
          <HugeiconsIcon :icon="RefreshIcon" :size="13" :stroke-width="2" />
          <span>Retry</span>
        </button>
        <button type="button" class="error-act" @click="sessionErrorDismissed = true">
          <HugeiconsIcon :icon="Cancel01Icon" :size="13" :stroke-width="2" />
          <span>Dismiss</span>
        </button>
      </div>
    </div>

    <!-- A stored conversation whose transcript never arrived — the session's
         read came back empty-handed, nothing loading, no session error. Retry
         re-runs the open; dismiss hides the card for this session. -->
    <div v-if="failedLoad" class="thread__error" role="alert">
      <p class="body body--error">
        This conversation didn't load — its transcript may have been removed or
        moved.
      </p>
      <div class="thread__error-actions">
        <button type="button" class="error-act" @click="retryLoad()">
          <HugeiconsIcon :icon="RefreshIcon" :size="13" :stroke-width="2" />
          <span>Retry</span>
        </button>
        <button type="button" class="error-act" @click="dismissLoad()">
          <HugeiconsIcon :icon="Cancel01Icon" :size="13" :stroke-width="2" />
          <span>Dismiss</span>
        </button>
      </div>
    </div>

    <!-- Background generative art in the empty state -->
    <CodeGolfArt v-if="!hasBlocks && !hideEmptyArt" class="thread__art" />

    <div v-if="!hasBlocks && !hideEmptyArt" class="empty relative z-10 sr-only">
      <p>Nothing here yet — say something to begin.</p>
    </div>

    <!-- One request + its response form an "exchange" — grouped so the response
         always sits directly under the request it answers. -->
    <!-- A stored thread adopted windowed (keyset pagination): the store holds
         older blocks than the window in hand — fetch the next page and prepend
         it above (session.loadOlder). Distinct from the "N earlier exchanges"
         reveal below, which mounts blocks already in hand. -->
    <button
      v-if="hasOlder"
      type="button"
      class="load-older"
      :class="{ 'is-loading': loadingOlder }"
      :disabled="loadingOlder"
      :title="olderError ?? undefined"
      @click="requestOlder"
    >
      <HugeiconsIcon
        :icon="loadingOlder ? RefreshIcon : ArrowUp01Icon"
        :size="13"
        :stroke-width="2"
        aria-hidden="true"
      />
      <span>{{
        loadingOlder
          ? "Loading older turns…"
          : olderError
            ? "Older turns failed — retry"
            : "Load older turns"
      }}</span>
    </button>
    <button
      v-if="earlierCount > 0"
      type="button"
      class="earlier"
      @click="revealEarlier"
    >
      <HugeiconsIcon :icon="ArrowUp01Icon" :size="13" :stroke-width="2" />
      <span>{{ earlierCount }} earlier {{ earlierCount === 1 ? "exchange" : "exchanges" }}</span>
    </button>

    <template v-for="(ex, index) in exchanges" :key="ex.key">
      <!-- Centered date divider at top of thread and between different calendar days -->
      <div v-if="shouldShowDayDivider(index)" class="thread-date">
        <span class="thread-date__text">{{ dayDividerLabel(ex) }}</span>
      </div>

      <div
        class="exchange"
        :class="{
          'exchange--running': ex.blocks.some((b) => b.role === 'assistant' && b.state === 'running'),
          'exchange--paired': ex.blocks.length > 1,
        }"
      >
      <!-- Thin elbow line: out of the request bubble's left edge, across to the avatar column, down to the reply -->
      <ExchangeConnector
        v-if="ex.blocks.length > 1 && ex.blocks.some((b) => b.role === 'user') && ex.blocks.some((b) => b.role === 'assistant')"
        :running="ex.blocks.some((b) => b.role === 'assistant' && b.state === 'running')"
      />

    <motion.div
      v-for="block in ex.blocks"
      :key="block.id"
      :data-turn-id="block.id"
      class="turn"
      :class="[
        block.role === 'user' ? 'turn--you' : 'turn--kone',
        block.role === 'assistant' && block.state !== 'running' ? 'turn--settled' : '',
        block.role === 'assistant' && flash[block.id] ? 'turn--flash' : '',
      ]"
      :initial="block.historical ? false : { opacity: 0, y: 14, x: block.role === 'user' ? 18 : -6 }"
      :animate="{ opacity: 1, y: 0, x: 0 }"
      :transition="{ type: 'spring', stiffness: 320, damping: 30, mass: 0.8 }"
    >
      <!-- ── User turn — right-aligned ─────────────────────────────────── -->
      <template v-if="block.role === 'user'">

         <!-- Edit-and-resend: the request bubble stays the bubble — its text
              becomes a seamless auto-growing field (Enter saves, Shift+Enter
              newlines, Esc cancels). The actions live in the one footer below,
              not inside the bubble. Saving ships a NEW user turn. -->
         <div v-if="block.id === editingUser" class="body body--you edit-box">
           <textarea
             ref="editInput"
             v-model="editDraft"
             class="edit-input you-text"
             aria-label="Edit request"
             rows="1"
             @input="autoGrowEdit"
             @keydown.enter.exact.prevent="saveEditUser()"
             @keydown.esc.prevent="cancelEditUser()"
           ></textarea>
         </div>
         <div v-else-if="block.text" class="body body--you selectable" :class="{ 'body--you-expanded': expandedUserRequests[block.id] }">
           <p class="you-text">{{ userRequestText(block) }}</p>
           <button
             v-if="isLongUserRequest(block)"
             type="button"
             class="you-expand"
             :aria-expanded="expandedUserRequests[block.id] ? 'true' : 'false'"
             :aria-label="expandedUserRequests[block.id] ? 'Collapse request' : 'Show full request'"
             @click="toggleUserRequest(block)"
           >
             <HugeiconsIcon
               :icon="expandedUserRequests[block.id] ? ArrowUp01Icon : ArrowDown01Icon"
               :size="14"
               :stroke-width="2"
             />
           </button>
         </div>
        <!-- What was attached to this turn -->
        <div v-if="block.attachments?.length" class="you-attachments selectable">
          <!-- Images thumbnail grid -->
          <div
            v-if="partitionAttachments(block.attachments).images.length"
            class="att-grid"
            :class="{ 'att-grid--multi': partitionAttachments(block.attachments).images.length > 1 }"
          >
            <button
              v-for="img in partitionAttachments(block.attachments).images"
              :key="img.id"
              type="button"
              class="att-thumb-btn"
              :title="`Preview ${img.name}`"
              @click="openLightbox(img, block.attachments)"
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

          <!-- Videos -->
          <div
            v-if="partitionAttachments(block.attachments).videos.length"
            class="att-videos"
          >
            <div
              v-for="vid in partitionAttachments(block.attachments).videos"
              :key="vid.id"
              class="att-video-card"
            >
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
          <div
            v-if="partitionAttachments(block.attachments).files.length"
            class="att-files-row"
          >
            <div
              v-for="file in partitionAttachments(block.attachments).files"
              :key="file.id"
              class="att-file-pill"
            >
              <FileChip
                :path="file.name"
                :title="`${file.name} · ${file.mimeType} (${formatFileSize(file.sizeBytes)})`"
              />
              <span class="att-file-pill__size">{{ formatFileSize(file.sizeBytes) }}</span>
              <button
                type="button"
                class="att-action-btn"
                title="Copy path"
                @click="copyAttachmentPath(file.id)"
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
                @click="showInFolder(file.id)"
              >
                <HugeiconsIcon :icon="Folder01Icon" :size="12" :stroke-width="2" />
              </button>
            </div>
          </div>
        </div>
        <div v-if="block.text" class="you-foot">
          <!-- While editing this turn the footer is the edit's controls; otherwise
               it's the quiet Edit / Copy / Scratchpad row. One footer, never two. -->
          <template v-if="block.id === editingUser">
            <button type="button" class="foot__copy" @click="cancelEditUser()">
              <HugeiconsIcon :icon="Cancel01Icon" :size="13" :stroke-width="2" />
              <span>Cancel</span>
            </button>
            <button
              type="button"
              class="foot__copy foot__copy--primary"
              :disabled="!editDraft.trim() || busy"
              @click="saveEditUser()"
            >
              <HugeiconsIcon :icon="Tick02Icon" :size="13" :stroke-width="2" />
              <span>Save &amp; resend</span>
            </button>
          </template>
          <template v-else>
            <button
              v-if="block.id === lastUserBlockId"
              type="button"
              class="foot__copy"
              aria-label="Edit request"
              @click="startEditUser(block)"
            >
              <HugeiconsIcon :icon="PencilEdit01Icon" :size="13" :stroke-width="2" />
              <span>Edit</span>
            </button>
            <button
              type="button"
              class="foot__copy"
              :aria-label="copied === block.id ? 'Copied' : 'Copy request'"
              @click="copyUserRequest(block)"
            >
              <HugeiconsIcon :icon="copied === block.id ? Tick02Icon : Copy01Icon" :size="13" :stroke-width="2" />
              <span>{{ copied === block.id ? "Copied" : "Copy" }}</span>
            </button>
            <button
              v-if="allowScratchpad"
              type="button"
              class="foot__copy"
              aria-label="Add request to scratchpad"
              @click="addUserRequestToScratchpad(block)"
            >
              <HugeiconsIcon :icon="Note01Icon" :size="13" :stroke-width="2" />
              <span>Scratchpad</span>
            </button>
          </template>
        </div>
      </template>

      <!-- ── Assistant (kone) turn — parts, in the order they arrived ────── -->
      <template v-else>
        <div class="stack selectable">
          <!-- Who answered. Agent turns only — giving the user's own turns a
               face would make the transcript a group chat instead of a
               document, and the asymmetry is what keeps it one. -->
          <div class="speaker">
            <SphereFace
              v-if="house"
              class="speaker__sphere"
              :size="26"
              :follow="false"
              :still="block.state !== 'running'"
            />
            <AgentFace v-else :seed="agentSeed" :size="26" class="speaker__face" />
            <button
              v-if="block.state !== 'running' && viewOf(block).foldedGroups.length"
              type="button"
              class="speaker__head speaker__head--toggle"
              :aria-expanded="isFoldOpen(block.id, viewOf(block).replyGroups.length === 0)"
              :aria-label="`${isFoldOpen(block.id, viewOf(block).replyGroups.length === 0) ? 'Hide' : 'Show'} agent work (${workLabel(block)})`"
              @click="toggleFold(block.id, viewOf(block).replyGroups.length === 0)"
            >
              <span class="speaker__name">{{ agent.name }}</span>
              <span class="speaker__meta">
                <span class="speaker__label">{{ workLabel(block) }}</span>
                <HugeiconsIcon
                  class="speaker__chev"
                  :class="{ 'speaker__chev--open': isFoldOpen(block.id, viewOf(block).replyGroups.length === 0) }"
                  :icon="ArrowDown01Icon"
                  :size="12"
                  :stroke-width="2"
                />
              </span>
            </button>
            <div v-else class="speaker__head">
              <span class="speaker__name">{{ agent.name }}</span>
            </div>
          </div>

          <!-- RUNNING, quiet read — the work stays out of sight and the turn
               says one sentence about itself ("Reading useAgent.ts", "Thinking"),
               until it settles and its reply takes the line's place. -->
          <TurnStatusLine
            v-if="block.state === 'running' && quiet"
            :key="`${block.id}:status`"
            :block="block"
            :now="now"
          />

          <!-- RUNNING — the live read: settled batches inline, in arrival order,
               plus the one live tail orb below. Steps and text interleave exactly
               as they land so tools-after-text read correctly while the turn is
               in flight. -->
          <template v-else-if="block.state === 'running'">
            <template
              v-for="grp in viewOf(block).groups"
              :key="grp.kind === 'text' ? grp.seg.key : grp.key"
            >
              <AgentActivity
                v-if="grp.kind === 'steps'"
                :segments="grp.segments"
                :running="true"
                :is-tail="false"
                :historical="block.historical"
              />
              <div
                v-else-if="grp.kind === 'text'"
                class="answer-wrap"
                :data-markdown-source="segText(grp.seg)"
              >
                <MarkdownMessage class="answer" :source="segText(grp.seg)" :historical="block.historical" />
              </div>
            </template>

            <!-- Live activity — one orb for the whole run: from send through every
                 thinking step and tool call until text takes over. -->
            <AgentActivity
              v-if="viewOf(block).live"
              :key="`${block.id}:live-activity`"
              :segments="viewOf(block).live!.segments"
              :running="true"
              :is-tail="true"
              :historical="block.historical"
            />
          </template>

          <!-- SETTLED — the calm read: everything the agent did and said on the
               way to its answer (tool calls, thinking, and the narration between
               them) collapses behind the agent-name toggler, and only the final
               reply stays open. A turn that ended on a tool call has no trailing
               reply, so the fold opens by default rather than collapsing to nothing. -->
          <template v-else>
            <TurnWorkFold
              v-if="viewOf(block).foldedGroups.length"
              :groups="viewOf(block).foldedGroups"
              :open="isFoldOpen(block.id, viewOf(block).replyGroups.length === 0)"
              :historical="block.historical"
            />
            <div
              v-for="grp in viewOf(block).replyGroups"
              :key="grp.seg.key"
              class="answer-wrap"
              :data-markdown-source="segText(grp.seg)"
            >
              <MarkdownMessage class="answer" :source="segText(grp.seg)" :historical="block.historical" />
            </div>
          </template>

          <!-- Failure note — the error plus Retry (re-sends the request that
               preceded it) and Dismiss (presentational: the block stays failed
               in the transcript, this just stops showing the red note). -->
          <div
            v-if="block.state === 'failed' && block.error && !dismissedTurnErrors[block.id]"
            class="turn-fail"
          >
            <p class="body body--error">{{ block.error }}</p>
            <div class="turn-fail__actions">
              <button type="button" class="foot__copy" :disabled="busy" @click="retryTurn(block)">
                <HugeiconsIcon :icon="RefreshIcon" :size="13" :stroke-width="2" />
                <span>Retry</span>
              </button>
              <button type="button" class="foot__copy" @click="dismissTurnError(block)">
                <HugeiconsIcon :icon="Cancel01Icon" :size="13" :stroke-width="2" />
                <span>Dismiss</span>
              </button>
            </div>
          </div>

          <!-- Turn footer — an editorial dotted-leader meta line, quiet until the
               turn settles / you hover it. Hidden entirely while running (the live
               header carries the status then). -->
          <div v-if="block.state !== 'running'" class="foot">
            <span class="foot__time">{{ clock(block.at) }}</span>
            <span
              v-if="block.state !== 'completed'"
              class="foot__status"
              :class="`foot__status--${statusOf(block).tone}`"
              >{{ statusOf(block).text }}</span
            >
            <button
              v-if="block.state === 'completed' && assistantText(block)"
              type="button"
              class="foot__copy"
              :aria-label="copied === block.id ? 'Copied' : 'Copy reply'"
              @click="copy(block)"
            >
              <HugeiconsIcon :icon="copied === block.id ? Tick02Icon : Copy01Icon" :size="13" :stroke-width="2" />
              <span>{{ copied === block.id ? "Copied" : "Copy" }}</span>
            </button>
            <button
              v-if="allowScratchpad && block.state === 'completed' && assistantText(block)"
              type="button"
              class="foot__copy"
              aria-label="Add to scratchpad"
              @click="addToScratchpad(block)"
            >
              <HugeiconsIcon :icon="Note01Icon" :size="13" :stroke-width="2" />
              <span>Scratchpad</span>
            </button>
          </div>
        </div>
      </template>
    </motion.div>
    </div>
    </template>
  </div>
    <!-- Image Lightbox Modal -->
    <Teleport to="body">
      <Transition name="lightbox-fade">
        <div
          v-if="lightbox"
          class="lightbox-backdrop"
          role="dialog"
          aria-modal="true"
          :aria-label="lightbox.attachment.name"
          @click.self="closeLightbox()"
        >
          <div class="lightbox-toolbar">
            <div class="lightbox-meta">
              <span class="lightbox-title">{{ lightbox.attachment.name }}</span>
              <span class="lightbox-sub">
                {{ formatFileSize(lightbox.attachment.sizeBytes) }}
                <template v-if="lightbox.allImages.length > 1">
                  · {{ lightbox.index + 1 }} of {{ lightbox.allImages.length }}
                </template>
              </span>
            </div>
            <div class="lightbox-actions">
              <button
                type="button"
                class="lightbox-btn"
                title="Copy absolute path"
                @click="copyAttachmentPath(lightbox.attachment.id)"
              >
                <HugeiconsIcon
                  :icon="copiedPathId === lightbox.attachment.id ? Tick02Icon : Copy01Icon"
                  :size="14"
                  :stroke-width="2"
                />
                <span>{{ copiedPathId === lightbox.attachment.id ? "Copied" : "Copy Path" }}</span>
              </button>
              <button
                type="button"
                class="lightbox-btn"
                title="Show in Finder / File Explorer"
                @click="showInFolder(lightbox.attachment.id)"
              >
                <HugeiconsIcon :icon="Folder01Icon" :size="14" :stroke-width="2" />
                <span>Show in Folder</span>
              </button>
              <button
                type="button"
                class="lightbox-btn lightbox-btn--close"
                title="Close (Esc)"
                @click="closeLightbox()"
              >
                <HugeiconsIcon :icon="Cancel01Icon" :size="16" :stroke-width="2" />
              </button>
            </div>
          </div>

          <div class="lightbox-content" @click.self="closeLightbox()">
            <button
              v-if="lightbox.allImages.length > 1"
              type="button"
              class="lightbox-nav-btn lightbox-nav-btn--prev"
              title="Previous (Left Arrow)"
              @click="prevLightboxImage()"
            >
              <HugeiconsIcon :icon="ArrowUp01Icon" class="lightbox-arrow-left" :size="20" :stroke-width="2" />
            </button>

            <img
              :src="`attachment://${lightbox.attachment.id}`"
              :alt="lightbox.attachment.name"
              class="lightbox-image"
            />

            <button
              v-if="lightbox.allImages.length > 1"
              type="button"
              class="lightbox-nav-btn lightbox-nav-btn--next"
              title="Next (Right Arrow)"
              @click="nextLightboxImage()"
            >
              <HugeiconsIcon :icon="ArrowDown01Icon" class="lightbox-arrow-right" :size="20" :stroke-width="2" />
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
</template>

<style scoped>
.thread {
  --rail: color-mix(in srgb, var(--ink) 12%, transparent);

  display: flex;
  flex-direction: column;
  gap: 34px;
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
}

.thread-date {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 6px 0 2px;
  user-select: none;
  pointer-events: none;
}
.thread-date__text {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  line-height: 16px;
}
.thread--empty {
  position: relative;
  flex: 1;
  width: 100%;
  min-height: 100%;
  align-items: center;
  justify-content: center;
}
.thread__art {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 0;
  width: 100%;
  height: min(72vh, 580px);
  pointer-events: none;
  opacity: 0.4;
  transform: translate(-50%, -50%);
}

/* ── Empty state ───────────────────────────────────────────────────────────── */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.empty__bead {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
  opacity: 0.6;
  animation: bead-breathe 3.2s ease-in-out infinite;
}
.empty__line {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--muted);
  text-wrap: pretty;
}
/* The way back into a long conversation's history. Deliberately the quietest
   thing on the page — it sits above the oldest mounted request, where the eye
   only lands if it's already reading upward. */
.earlier {
  display: inline-flex;
  align-self: center;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.earlier:hover {
  background: var(--hover);
  color: var(--ink);
}
/* Fetching more of a windowed stored thread. Same quiet pill language as
   .earlier, with the agent accent held for the loading beat — and a warmer
   tint when the last attempt failed, so the retry reads as one. */
.load-older {
  display: inline-flex;
  align-self: center;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.load-older:hover:not(:disabled) {
  background: var(--hover);
  color: var(--ink);
}
.load-older.is-loading {
  color: color-mix(in oklab, var(--accent) 75%, var(--muted));
  cursor: default;
}
.load-older.is-loading svg {
  animation: load-older-spin 0.9s linear infinite;
}
.load-older:disabled {
  opacity: 0.75;
}
@keyframes load-older-spin {
  to {
    transform: rotate(360deg);
  }
}

/* An exchange = one request + its response, stacked with breathing room. */
.exchange {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 34px;
  transition:
    opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    filter 0.45s cubic-bezier(0.22, 1, 0.36, 1);
}
/* When a turn is running, earlier exchanges dissolve softly into the background
   to keep the eye focused on the live response, and smoothly restore when hovered
   or once the answer settles. */
.thread--busy .exchange:not(.exchange--running) {
  opacity: 0.52;
  filter: saturate(0.85);
}
.thread--busy .exchange:not(.exchange--running):hover,
.thread--busy .exchange:not(.exchange--running):focus-within {
  opacity: 0.96;
  filter: saturate(1);
}
.exchange--running {
  opacity: 1;
  filter: none;
}
/* The trailing exchange has clearance so a newly-sent request stages cleanly
   at the top of the viewport with ample open space beneath for streaming. */
.exchange:last-child {
  min-height: min(72vh, 620px);
}
.turn {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.turn--you {
  align-items: flex-end;
}

/* ── The turn's body stack ─────────────────────────────────────────────────── */
.stack {
  display: flex;
  flex-direction: column;
  gap: 15px;
  align-items: flex-start;
  width: 100%;
}

/* ── Speaker line — who answered ───────────────────────────────────────────── */
.speaker {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
  line-height: 1;
  /* Chrome, not content: the reply body opts into selection via .selectable, but
     the speaker line (name + duration) shouldn't drag-highlight. */
  -webkit-user-select: none;
  user-select: none;
  /* Pulled back in from the stack's 15px: the line belongs to the reply beneath
     it, and at full gap it floats between two turns instead. */
  margin-bottom: -6px;
}
.speaker__face {
  position: relative;
  z-index: 1;
  border-radius: 50%;
  background: var(--ground);
}
/* kone's own mark, in the slot an agent's tile would take. It is a silhouette
   rather than a tile, so it gets the layer and the footprint without the disc
   behind it — a circle under this face would read as a badge it is sitting in. */
.speaker__sphere {
  position: relative;
  z-index: 1;
  flex: none;
}
.speaker__head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  line-height: 1;
}
.speaker__head--toggle {
  padding: 3px 6px;
  margin-left: -5px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
  line-height: 1;
  transition: background-color 0.15s ease;
}
.speaker__head--toggle:hover {
  background: var(--hover);
}
.speaker__head--toggle:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 30%, transparent);
  outline-offset: 1px;
}
.speaker__name {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  color: var(--ink-soft);
  transition: color 0.15s ease;
}
.speaker__head--toggle:hover .speaker__name {
  color: var(--ink);
}
.speaker__meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--muted);
  transition: color 0.15s ease, opacity 0.3s ease;
  animation: speaker-meta-in 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes speaker-meta-in {
  from {
    opacity: 0;
    transform: translateY(2px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.speaker__head--toggle:hover .speaker__meta {
  color: var(--ink-soft);
}
.speaker__label {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  line-height: 1;
}
.speaker__chev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 13px;
  height: 13px;
  opacity: 0.75;
  transition: transform 0.24s ease, opacity 0.15s ease;
}
.speaker__head--toggle:hover .speaker__chev {
  opacity: 1;
}
.speaker__chev--open {
  transform: rotate(180deg);
}
@media (prefers-reduced-motion: reduce) {
  .speaker__chev {
    transition: none;
  }
}

/* ── Message body ──────────────────────────────────────────────────────────── */
.body {
  margin: 0;
  font-size: 14px;
  line-height: 1.62;
  color: var(--ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
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
  width: 100%;
  max-width: 80%;
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 0.45s ease, transform 0.3s ease;
}
.turn--you:hover .you-foot,
.turn--you:focus-within .you-foot {
  opacity: 1;
  transform: none;
}
@media (hover: none) {
  .you-foot {
    opacity: 1;
    transform: none;
  }
}
.body--error {
  color: var(--diff-del);
  font-size: 14px;
  line-height: 1.55;
}
/* Session-start / transcript-load failure banner — a soft red card with a
   hairline ring (no heavy shadow), the error text and a quiet mono action row.
   Red is earned here: something actually failed, and this is the only red card
   the thread knows. */
.thread__error {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--diff-del) 5%, var(--ground));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--diff-del) 22%, transparent);
}
.thread__error-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.error-act {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.error-act:hover,
.error-act:focus-visible {
  background: color-mix(in srgb, var(--diff-del) 10%, transparent);
  color: var(--diff-del);
}
.error-act:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--diff-del) 40%, transparent);
  outline-offset: 1px;
}

/* Failed turn — the red note plus its action row, mirroring the turn footer's
   quiet mono actions. */
.turn-fail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  width: 100%;
  max-width: 42rem;
}
.turn-fail__actions {
  display: flex;
  align-items: center;
  gap: 4px;
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
.foot__copy:disabled {
  opacity: 0.45;
  cursor: default;
}
.foot__copy--primary {
  color: var(--ink-soft);
}
.foot__copy--primary:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--ink);
}

/* The settled rich answer — capped to a comfortable measure (~66ch) so long
   replies stay readable; its internals live in MarkdownMessage. */
.answer {
  width: 100%;
  max-width: 42rem;
}

/* ── Turn footer (meta) — editorial dotted leader ──────────────────────────── */
.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: -7px;
  width: 100%;
  max-width: 42rem;
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  /* Chrome, not content — the "replied in 52s" status + timestamp shouldn't
     drag-highlight even though the turn body is .selectable. */
  -webkit-user-select: none;
  user-select: none;
  opacity: 0;
  transform: translateY(-2px);
  transition:
    opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
}
.turn--flash .foot {
  opacity: 0.92;
  transform: none;
}
.turn--kone.turn--settled:hover .foot,
.foot:focus-within {
  opacity: 1;
  transform: none;
}
/* The dotted rule that carried the eye from the timestamp to the status is
   gone — the meta row now reads as a row of quiet items, no leader line. */
.foot__status--live {
  color: var(--ink-soft);
}
.foot__status--error {
  color: var(--diff-del);
}
.foot__copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.foot__copy:hover {
  background: var(--hover);
  color: var(--ink);
}

/* ── Keyframes ─────────────────────────────────────────────────────────────── */
@keyframes bead-breathe {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.14);
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

/* ── Lightbox modal ───────────────────────────────────────────────────────── */
.lightbox-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0, 0, 0, 0.82);
  backdrop-filter: blur(14px);
  display: flex;
  flex-direction: column;
}
.lightbox-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  color: #fff;
  z-index: 10001;
}
.lightbox-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.lightbox-title {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lightbox-sub {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.6);
}
.lightbox-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.lightbox-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 0;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.lightbox-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}
.lightbox-btn--close {
  padding: 5px 7px;
}
.lightbox-content {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: 16px 24px 32px;
  min-height: 0;
}
.lightbox-image {
  max-width: 90vw;
  max-height: 84vh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.65);
  user-select: none;
}
.lightbox-nav-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 0;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color 0.15s ease;
  z-index: 10001;
}
.lightbox-nav-btn:hover {
  background: rgba(255, 255, 255, 0.26);
}
.lightbox-nav-btn--prev {
  left: 24px;
}
.lightbox-nav-btn--next {
  right: 24px;
}
.lightbox-arrow-left {
  transform: rotate(-90deg);
}
.lightbox-arrow-right {
  transform: rotate(90deg);
}

.lightbox-fade-enter-active,
.lightbox-fade-leave-active {
  transition: opacity 0.2s ease;
}
.lightbox-fade-enter-from,
.lightbox-fade-leave-to {
  opacity: 0;
}
</style>
