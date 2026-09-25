<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Copy01Icon,
  Folder01Icon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { AssistantBlock, ThreadBlock } from "~/composables/useAgent";
import type {
  ChatAttachment,
  CompactionRecord,
  ForkContext,
  HandInRecord,
  TurnCheckpointRecord,
} from "~/types/desktop";
import { groupCompactionMarkers } from "~/utils/compactionMarkers";
import TurnThemeReceipts from "~/components/turn/TurnThemeReceipts.vue";
import ExchangeConnector from "~/components/ui/ExchangeConnector.vue";
import CompactionMarker from "~/components/conversation/CompactionMarker.vue";
import HandInMark from "~/components/conversation/HandInMark.vue";
import { collapseHandInMarks, deriveHandInMarks, handInHasLanded } from "~/utils/handInMarkers";
import TurnSettingMark from "~/components/conversation/TurnSettingMark.vue";
import HandoffMark from "~/components/conversation/HandoffMark.vue";
import JevMark from "~/components/conversation/JevMark.vue";
import AgentConnectedMark from "~/components/conversation/AgentConnectedMark.vue";
import { jevRouteFor } from "~/utils/jevRoutes";
import { useHandoffMarks } from "~/composables/useHandoffMarks";
import { groupMarks } from "~/utils/handoffMarkers";
import type { EffortTier } from "~/utils/modelCatalog";
import { deriveTurnSettingMarks, type TurnSettingChange } from "~/utils/turnSettingMarkers";
import TurnCheckpointRestore from "~/components/conversation/TurnCheckpointRestore.vue";
import { agentIdentity } from "~/utils/agentIdentity";
import { useSearchLanding } from "~/composables/useSearchLanding";
import { dayKey, formatDayDivider } from "~/utils/threadDates";
import type { ResponseDisplay } from "~/utils/responseDisplay";
import { STYLE_SPECS, type ConversationStyle } from "~/utils/conversationStyle";
import { formatFileSize } from "~/utils/formatFile";
import AssistantTurnBody from "~/components/conversation/AssistantTurnBody.vue";
import UserTurn from "~/components/conversation/UserTurn.vue";
import CodeGolfArt from "~/components/ui/CodeGolfArt.vue";
import TextSwap from "~/components/ui/TextSwap.vue";
import ReplyRef from "~/components/conversation/ReplyRef.vue";
import TurnActions from "~/components/conversation/TurnActions.vue";

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
  /** Settled compaction boundaries, oldest first — rendered as quiet centered
   *  markers where the context was compacted. Absent on surfaces that don't
   *  read them (history readers predate the markers table). */
  compactions?: CompactionRecord[];
  /** Pre-turn repository snapshots for the thread. A settled assistant turn
   *  whose turn id names a row here offers a file restore in its footer.
   *  Absent on surfaces without the checkpoint surface (read-only history,
   *  the house assistant) — no rows, no control, never a guess. */
  checkpoints?: TurnCheckpointRecord[];
  /** This thread's fork context, when it is a fork — a handoff names its
   *  source for the "Handed from" marker. Absent on surfaces that don't read
   *  it; the timeline then only shows "Handed to" links. */
  forkContext?: ForkContext | null;
  /** Render handoff markers inline with the exchanges, with both ends
   *  clickable into the linked thread. Off unless the host routes
   *  `open-thread` somewhere (the studio does; inbox readers and the house
   *  assistant don't) — an unrouted jump would be a button that goes nowhere. */
  linkHandoffs?: boolean;
  /** Every time this thread changed hands, oldest first. Owned by the session
   *  so the strip header and these markers never disagree; absent on surfaces
   *  that cannot hand a thread in. */
  handIns?: HandInRecord[];
  /** Offer the per-reply Fork control. Off unless the host can actually open
   *  the branch it mints (the studio can; inbox readers and the house
   *  assistant can't) — the same reasoning that gates `linkHandoffs`. */
  allowBranch?: boolean;
  /** Ticking clock from useAgent, so "working · Xs" counts up live. */
  now: number;
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
  hasOlder?: boolean;  /** A load-older request is in flight. */
  loadingOlder?: boolean;
  /** The last load-older attempt failed — the affordance shows a retry. */
  olderError?: string | null;
  /** How turns read here — the reader's choices for the surface this thread is
   *  on (useResponsePrefs), or the choice the Conversation settings page is
   *  previewing before it is made. */
  display: ResponseDisplay;
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
  /** Draw the thread in this style instead of the reader's — the Conversation
   *  settings page previews a style before it is picked. */
  conversationStyle?: ConversationStyle;
}>();

const emit = defineEmits<{
  "to-scratchpad": [text: string];
  /** Re-send the user request that precedes a failed turn. The host owns the
   *  send path (ThreadStrip forwards this to the session's `send`). */
  retry: [text: string];
  /** Edit-and-resend of the last user turn: send the edited text as a NEW
   *  user turn on this thread. */
  resend: [text: string];
  /** Edit-and-resend of an earlier user turn: fork the thread at that block
   *  (the source is never mutated) and start the fork's first turn from the
   *  edited text. The host owns the fork path. */
  "edit-fork": [blockId: string, text: string];
  /** A stored conversation failed to load its transcript — re-run the open. */
  "retry-load": [];
  /** Load the next older page of a windowed stored thread and prepend it. The
   *  host owns the fetch (session.loadOlder); the thread only asks. */
  "load-older": [];
  /** Branch a new thread off a settled assistant reply: the new thread ends
   *  with that reply, so the next turn continues from it. The source is never
   *  mutated. The host owns picking the target model and opening the branch. */
  "branch-fork": [blockId: string];
  /** Jump to a thread linked from the handoff footer. The host owns
   *  panes/sessions and opens (or focuses) it. */
  "open-thread": [threadId: string];
}>();

const { cue } = useSound();

/** This thread's agent. A blank column has no id yet, so it falls back to the
 *  house name until its session has one — which is also the name kone answers
 *  under on a surface that is kone itself, so the house case asks for it
 *  outright by seeding nothing. */
const agent = computed(() => agentIdentity(props.house ? null : props.agentSeed));
const allowScratchpad = computed(() => props.scratchpad ?? !props.house);
const allowBranch = computed(() => props.allowBranch ?? false);

// ── the look ─────────────────────────────────────────────────────────────────
// Which layout the turns are drawn in (utils/conversationStyle). The parts and
// their order never change with it — only where they sit and what ties a
// request to its reply — so almost all of a style is the stylesheet keyed off
// the root's `thread--style-*` class. The one row this style owns in
// STYLE_SPECS is the single authority the script and template read: your face
// and name over a request, the time inside a chat bubble, and the rest.
// Everything below `spec` is a projection of it — except the elbow (see
// showsElbow), the one switch the table cannot express.
const readerStyle = useConversationStyle().style;
const look = computed<ConversationStyle>(() => props.conversationStyle ?? readerStyle.value);
const spec = computed(() => STYLE_SPECS[look.value]);
/** Every style but kone's own family seats a turn's actions in its head line
 *  on hover rather than holding a row open under it — a row the size of a
 *  line, under every message, is most of what makes a flat transcript look
 *  loose. Replies dock into the speaker line, requests into the you-head —
 *  except the styles with no head: the prompt's sit at the end of its command
 *  line, the chat's beside its bubbles (see spec.userActs / spec.sideActs). */
const floatActs = computed(() => spec.value.floatActs);
const faceSize = computed(() => spec.value.face);
/** Whether the reply draws its speaker face — the style table's `face: 0`
 *  sentinel projected once, here, instead of a magic size check in the body. */
const showFace = computed(() => spec.value.face > 0);
/** The default style's elbow alone: kone-quiet is kone with the connector not
 *  mounted, so the two share a spec row and this is the one switch the table
 *  cannot express. */
const showsElbow = computed(() => look.value === "kone");
/** A message's time the way its style says it: Discord's "Today at 11:55 AM",
 *  everywhere else the bare clock. */
function stampFor(at: number): string {
  return spec.value.headStamp === "day-at-clock" ? `${formatDayDivider(at, props.now)} at ${clock(at)}` : clock(at);
}
/** The time a reply wears in its head — the styles whose actions float have no
 *  footer to carry it. A turn that didn't finish says how it ended beside it. */
function replyStamp(block: AssistantBlock): string | undefined {
  if (spec.value.headStamp === "none") return undefined;
  const at = stampFor(block.at);
  return block.state === "running" || block.state === "completed" ? at : `${at} · ${statusFor(block).text}`;
}
/** A chat bubble's corner: the time, and how the turn ended if it didn't. */
function bubbleStamp(block: AssistantBlock): string {
  const at = clock(block.at);
  return block.state === "completed" ? at : `${statusFor(block).text} · ${at}`;
}
/** A chat request's ticks: sent, delivered while the reply is being written,
 *  read once it has been. Derived once per exchange in `allExchanges` below
 *  (see `EnrichedExchange.receipt`) so the template reads `ex.receipt` O(1)
 *  instead of scanning `ex.blocks` per row per render. */
export type ReceiptState = "sent" | "delivered" | "read";

// Your face and name over a request (YouHead) and the channel's reply
// lead-in (ReplyRef) read identity but never resolve it: the lookup behind
// useUser is cached process-wide, so one warm per thread is enough — not one
// per head in a 60-turn thread. Re-warmed when the look changes under the
// thread (the settings stage probes styles through `conversationStyle`).
const profile = useProfile();
const needsHeads = computed(() => spec.value.youHead || spec.value.replyRef);
onMounted(() => {
  if (needsHeads.value) void profile.resolve();
});
watch(needsHeads, (needs) => {
  if (needs) void profile.resolve();
});

// Warm the Markdown parser on mount: markdown-it is code-split behind a dynamic
// import, so the very first streamed reply would otherwise flash raw source for a
// beat while it loads. Kicking the load off now means text renders formatted from
// the first chunk.
if (import.meta.client) void useMarkdown().parse("");

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
// One status object per assistant block, derived once per render (tracks
// `props.now` through `elapsed`). The template reads through `statusFor`
// — O(1) map gets — so a row never pays the 3x `statusOf` calls the footer
// plus its stamp used to make.
const statusById = computed(() => {
  const m = new Map<string, StatusLabel>();
  for (const b of props.blocks) {
    if (b.role === "assistant") m.set(b.id, statusOf(b));
  }
  return m;
});
function statusFor(block: AssistantBlock): StatusLabel {
  return statusById.value.get(block.id) ?? statusOf(block);
}
// The receipt on a settled turn's work fold. Duration is the whole turn's span
// (`elapsed` reads block.at → block.endedAt), phrased by how the turn ended.
function workLabel(block: AssistantBlock): string {
  const dur = elapsed(block);
  if (block.state === "interrupted") return `Stopped ${dur}`;
  if (block.state === "failed") return `Ended ${dur}`;
  return dur;
}
// Each turn's own toggle, once pressed — open shows the whole turn, closed folds
// it to the reply. Unset, the turn reads as the reader's choices start it. Held
// here rather than in the turn's body so it survives the body remounting.
const openFolds = reactive<Record<string, boolean>>({});
function toggleTurn(block: AssistantBlock, open: boolean): void {
  openFolds[block.id] = open;
  cue(open ? "expand" : "collapse");
}
function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
/** A settled reply with words to copy, save or fork from. */
function canActOn(block: AssistantBlock): boolean {
  return block.state === "completed" && !!assistantText(block);
}
/** A settled reply with a file restore to offer. */
function hasTurnCheckpoint(block: AssistantBlock): boolean {
  return block.state !== "running" && hasCheckpoint(block) && !!props.threadId;
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
export type AttachmentPartition = {
  images: ChatAttachment[];
  videos: ChatAttachment[];
  files: ChatAttachment[];
};
const EMPTY_PARTITION: AttachmentPartition = { images: [], videos: [], files: [] };
// One exchange = one request + the assistant turn(s) answering it, with the
// per-row lookups the template used to recompute (some twice, some 5x+ per
// render) derived once here: the request text (channel reply-ref + retry),
// the first assistant reply and its receipt ticks, and the partitioned
// attachments per user block. All O(1) reads from here on; grouping itself
// is the single O(n) pass.
type EnrichedExchange = {
  key: string;
  blocks: ThreadBlock[];
  requestText: string;
  reply: AssistantBlock | undefined;
  receipt: ReceiptState;
  parts: Map<string, AttachmentPartition>;
};
/** Pre-partitioned attachments for one user block in an enriched exchange —
 *  O(1); the template must never call `partitionAttachments` directly. */
function partsFor(ex: EnrichedExchange, block: ThreadBlock): AttachmentPartition {
  return ex.parts.get(block.id) ?? EMPTY_PARTITION;
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

// Whether a settled assistant turn offers a file restore: the session seeded
// a pre-turn snapshot for its turn id. The control itself previews and
// confirms — this is only the mount gate, keyed by turn id (not block id:
// re-sent retries share nothing, while one turn's blocks share its snapshot).
function hasCheckpoint(block: AssistantBlock): boolean {
  if (!props.threadId) return false;
  return (props.checkpoints ?? []).some((c) => c.turnId === block.turnId);
}

// ── retry / edit-and-resend / load-failure ────────────────────────────────────
// All of these reach the session through the host (ThreadStrip forwards them):
// `retry` re-sends the user request that precedes a failed turn, `resend` ships
// an edit of the last user turn as a NEW turn (the failed reply stays in the
// transcript), `edit-fork` ships an edit of an earlier turn as the first turn
// of a fork branched at that block, and `retry-load`
// re-runs the open of a stored conversation. The buttons here are pure intent —
// this component never touches the send path itself.
const dismissedTurnErrors = reactive<Record<string, boolean>>({});
/** The user request this assistant turn answers — the nearest user block above
 *  it. Retry re-sends that, so a failed turn gets exactly its own prompt back.
 *  Fallback for non-exchange callers only: the template and `retryTurn` read
 *  `ex.requestText` (O(1)) instead of scanning per row per render. */
function userRequestFor(block: AssistantBlock): string {
  for (let i = props.blocks.indexOf(block) - 1; i >= 0; i--) {
    const b = props.blocks[i];
    if (b && b.role === "user") return b.text;
  }
  return "";
}
function retryTurn(block: AssistantBlock, requestText: string): void {
  const text = requestText || userRequestFor(block);
  if (!text.trim() || props.busy) return;
  cue("press");
  emit("retry", text);
}
function dismissTurnError(block: AssistantBlock): void {
  dismissedTurnErrors[block.id] = true;
  cue("collapse");
}

// ── edit-and-resend ──────────────────────────────────────────────────────────
// The edit affordance lives on every user turn (see UserTurn, which owns the
// draft field and the expand state). Saving an edit of the LAST user turn
// ships the text through the host's send path as a new turn on this thread;
// saving an edit of any earlier turn forks the thread at that block instead
// (the transcript keeps the original either way — rolling it back would
// rewrite history the replies after it already answered).
const lastUserBlockId = computed(() => lastUserBlock()?.id ?? null);
function saveUserEdit(block: Extract<ThreadBlock, { role: "user" }>, text: string): void {
  const trimmed = text.trim();
  if (!trimmed || props.busy) return;
  cue("press");
  // The last user turn is still replaceable by a follow-up; anything earlier
  // has replies after it, so the edit branches the thread at that block.
  if (block.id === lastUserBlockId.value) emit("resend", trimmed);
  else emit("edit-fork", block.id, trimmed);
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
// The last user block — saving an edit of it resends on this thread, while
// saving an edit of any earlier block forks (`lastUserBlockId`).
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
// and the assistant turn(s) that follow it belong to that group. The request
// text, first reply, receipt, and per-user-block partitions are derived here
// once per blocks change — O(n) total, O(1) per row from here on. `requestText`
// is always derived (cheap O(1) slice of the grouping pass), so the channel
// style's reply-ref pays no scan and every other style pays nothing extra.
const allExchanges = computed<EnrichedExchange[]>(() => {
  const groups: EnrichedExchange[] = [];
  for (const b of props.blocks) {
    if (b.role === "user" || groups.length === 0) {
      const parts = new Map<string, AttachmentPartition>();
      if (b.role === "user" && b.attachments?.length) {
        parts.set(b.id, partitionAttachments(b.attachments));
      }
      groups.push({
        key: b.id,
        blocks: [b],
        requestText: b.role === "user" ? b.text : "",
        reply: undefined,
        receipt: "sent",
        parts,
      });
    } else groups[groups.length - 1]!.blocks.push(b);
  }
  for (const g of groups) {
    const reply = g.blocks.find((b): b is AssistantBlock => b.role === "assistant");
    g.reply = reply;
    g.receipt = !reply ? "sent" : reply.state === "running" ? "delivered" : "read";
    for (const b of g.blocks) {
      if (b.role === "user" && b.attachments?.length && !g.parts.has(b.id)) {
        g.parts.set(b.id, partitionAttachments(b.attachments));
      }
    }
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

/** Compaction markers grouped onto the exchange they precede: a marker belongs
 *  above the first exchange starting at or after it. Markers newer than every
 *  exchange trail the thread instead. Computed over the full grouping so a
 *  marker above the open window reappears with its exchange on reveal. */
const groupedMarkers = computed(() =>
  groupCompactionMarkers(
    props.compactions ?? [],
    allExchanges.value.map((ex) => ({ key: ex.key, firstAt: ex.blocks[0]?.at })),
  ),
);
const trailingMarkers = computed(() => groupedMarkers.value.trailing);
function markersFor(key: string): CompactionRecord[] {
  return groupedMarkers.value.byExchange.get(key) ?? [];
}

/** Handoff markers grouped onto the exchange they precede — same oldest-first
 *  march as the compaction markers above, over the full exchange list so a
 *  marker above the collapsed window reappears with its exchange on reveal.
 *  A handoff is its own turn row in the flow: later exchanges keep arriving
 *  below it. */
const handoffMarks = useHandoffMarks({
  threadId: () => props.threadId,
  forkContext: () => props.forkContext ?? null,
  enabled: () => props.linkHandoffs ?? false,
});
const groupedHandoffMarks = computed(() =>
  groupMarks(
    handoffMarks.marks.value,
    allExchanges.value.map((ex) => ({ key: ex.key, firstAt: ex.blocks[0]?.at })),
  ),
);
const trailingHandoffMarks = computed(() => groupedHandoffMarks.value.trailing);
function handoffMarksFor(key: string) {
  return groupedHandoffMarks.value.byExchange.get(key) ?? [];
}

/** Hand-in markers — where this thread changed hands without changing
 *  threads. Filed onto exchanges by the same march as the handoff marks, and
 *  gated on the same host capability: a surface that cannot hand a thread in
 *  has none to show. Only landed swaps count (see handInHasLanded — the same
 *  rule the header follows); unlanded ones stay invisible. */
const handInMarks = computed(() => {
  const blocks = allExchanges.value.flatMap((ex) => ex.blocks);
  return deriveHandInMarks(props.handIns ?? []).filter((mark) =>
    handInHasLanded(mark.at, blocks),
  );
});
const groupedHandInMarks = computed(() =>
  groupMarks(
    handInMarks.value,
    allExchanges.value.map((ex) => ({ key: ex.key, firstAt: ex.blocks[0]?.at })),
  ),
);
/** Deliberately no trailing bucket, unlike the handoff marks. A handoff has
 *  somewhere to point the moment it happens; a hand-in is a statement about
 *  the turns that follow it, so it stays invisible until one arrives — the
 *  same rule the per-request setting markers follow. */
function handInMarksFor(key: string) {
  return collapseHandInMarks(groupedHandInMarks.value.byExchange.get(key) ?? []);
}

/** Model and reasoning-effort switches derived from the per-request stamps
 *  the send path leaves on user blocks: a switch renders above the exchange
 *  whose request introduced it. Computed over the full exchange list so a
 *  baseline set above the collapsed window still carries forward — a marker
 *  above the open window reappears with its exchange on reveal. */
const turnSettingMarks = computed(() => deriveTurnSettingMarks(allExchanges.value));
/** Zero or one change per exchange, as a list so the template resolves it once
 *  — a `v-if` plus a non-null `:mark` would look it up twice per render. */
function turnSettingMarkFor(key: string): TurnSettingChange[] {
  const mark = turnSettingMarks.value.get(key);
  if (!mark) return [];
  // A hand-in row absorbs this exchange's switch entirely — it names both
  // models and carries the tier inside its own legs — so the setting marker
  // stands down rather than repeating it on a second line.
  return handInMarksFor(key).length > 0 ? [] : [mark];
}

/** The tier change a hand-in on this exchange should carry in its legs. Read
 *  from the same per-request stamps the setting marker uses, so the two can
 *  never disagree about what the turn ran at. */
function handInEffortFor(key: string): { from: EffortTier; to: EffortTier } | undefined {
  return turnSettingMarks.value.get(key)?.effort;
}

/**
 * The router's decision for this thread, when Jev staffed it — the record
 * behind the "Jev (…) → …" marker. Null for threads that were never routed,
 * which show no marker. The face and name resolve live in the marker itself, so
 * a rename renames history.
 *
 * Withheld while older pages are unread. The mark belongs at the head of the
 * conversation, and the first exchange on screen is only the conversation's
 * first once the whole history is here — drawn any earlier it would sit above
 * whichever page happens to be loaded and claim to precede a request that has
 * a hundred others in front of it. The "Load older" control holds that spot
 * until then, which is the honest answer: the beginning has not been reached.
 */
const jevMark = computed(() => (props.hasOlder ? null : jevRouteFor(props.threadId) ?? null));

/**
 * The agent to announce as connected at the head of the thread — once there is
 * one to name. kone's own conversations have no agent to connect, a routed
 * thread already names its agent in Jev's mark, and like that mark it waits
 * until the head of the conversation is actually on screen.
 */
const connectedSeed = computed(() =>
  props.house || props.hasOlder || jevMark.value ? null : props.agentSeed ?? null,
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

/** Whether an exchange arrived while the column was open, rather than being
 *  read back from storage — the marks above it only play their arrival then. */
function isLive(ex: { blocks: ThreadBlock[] }): boolean {
  return ex.blocks[0] ? !ex.blocks[0].historical : false;
}
/** The same question for marks trailing every exchange: they are as live as
 *  the turn they follow. */
const tailIsLive = computed(() => {
  const last = props.blocks[props.blocks.length - 1];
  return last ? !last.historical : false;
});

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

// ── arriving from conversation search ───────────────────────────────────────
// A search hit opens its thread and names one old row to land on. The state
// machine for getting there lives in useSearchLanding; this column only wires
// it up — element lookup, older-page requests, the window expand — and binds
// the flash class. Scroll ownership is single: doInitialScroll reads
// landing.scrollTarget, so a pending landing suppresses the scroll-to-newest
// without a second flag to arbitrate.
const landing = useSearchLanding({
  threadKey: () => threadKey(),
  isEmpty: () => props.blocks.length === 0,
  initialDoneFor: () => initialScrollDoneFor.value,
  findElement: (blockId: string) =>
    // SAFETY: querySelector takes a selector string; the id is escaped so a
    // hostile block id can only ever match nothing, never break out of it.
    root.value?.querySelector(`[data-turn-id="${CSS.escape(blockId)}"]`) ?? null,
  requestOlderPage: () => emit("load-older"),
  expandWindow: () => {
    // The target is old by definition — mount everything in hand before looking.
    showAllExchanges.value = true;
  },
});
const { searchFlash } = landing;

/** Look for the landing row once; a found row also retires the initial
 *  scroll for this key, so the newest-turn scroll below never yanks it away. */
function revealSearchBlock(): void {
  const outcome = landing.reveal({
    hasOlder: props.hasOlder ?? false,
    loadingOlder: props.loadingOlder ?? false,
  });
  if (outcome === "revealed") initialScrollDoneFor.value = threadKey();
}

function claimSearchJump(): void {
  if (!import.meta.client) return;
  if (landing.claim(props.threadId)) void nextTick(() => revealSearchBlock());
}

watch(
  () => props.threadId,
  () => {
    landing.reset();
    claimSearchJump();
  },
);

function doInitialScroll(): void {
  if (!import.meta.client) return;
  // A search arrival lands on its row, not on the newest turn — scrollTarget
  // names the one owner, so the initial scroll runs only when it is owed it.
  if (landing.scrollTarget.value?.kind !== "initial") return;
  const key = threadKey();
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
  claimSearchJump();
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
    // A paged-in older page may have carried the search target — look again.
    if (landing.scrollTarget.value?.kind === "jump") void nextTick(() => revealSearchBlock());
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
    :class="[
      `thread--style-${look}`,
      {
        'thread--empty': !hasBlocks,
        'thread--busy': hasRunningExchange,
        'thread--you-left': spec.youLeft,
        'thread--float-acts': spec.floatActs,
      },
    ]"
  >
    <!-- A stored conversation whose transcript never arrived — the session's
         read came back empty-handed and nothing is still loading. Retry
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
      <TextSwap
        :swap-key="
          loadingOlder
            ? 'Loading older turns…'
            : olderError
              ? 'Older turns failed — retry'
              : 'Load older turns'
        "
      />
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
      <div
        v-if="shouldShowDayDivider(index)"
        class="thread-mark thread-date"
        :class="{ 'thread-mark--enter': isLive(ex) }"
      >
        <span class="thread-date__text">{{ dayDividerLabel(ex) }}</span>
      </div>

      <!-- Jev's routing decision, under the day divider at the head of the
           conversation — the thread-level receipt for who staffed it. -->
      <JevMark
        v-if="index === 0 && jevMark"
        :route="jevMark"
        :class="{ 'thread-mark--enter': isLive(ex) }"
      />
      <!-- Otherwise the agent that picked the thread up, announced once. -->
      <AgentConnectedMark
        v-else-if="index === 0 && connectedSeed"
        :key="`connected-${connectedSeed}`"
        :seed="connectedSeed"
        :animate="!ex.blocks[0]?.historical"
      />

      <!-- Centered compaction markers settled since the previous exchange -->
      <CompactionMarker
        v-for="(m, mi) in markersFor(ex.key)"
        :key="`compact-${ex.key}-${mi}`"
        :class="{ 'thread-mark--enter': isLive(ex) }"
        :marker="m"
        :format-time="clock"
      />

      <!-- Handoff markers settled since the previous exchange: the handoff is
           its own row in the flow, and later turns arrive below it. -->
      <HandoffMark
        v-for="m in handoffMarksFor(ex.key)"
        :key="`handoff-${ex.key}-${m.key}`"
        :class="{ 'thread-mark--enter': isLive(ex) }"
        :mark="m"
        @open-thread="(id) => emit('open-thread', id)"
      />

      <!-- The switch the new request introduced: the model, the tier, or both
           changed before this request was sent, so the one marker that says so
           precedes the request. -->
      <HandInMark
        v-for="m in handInMarksFor(ex.key)"
        :key="`hand-in-${m.key}`"
        :class="{ 'thread-mark--enter': isLive(ex) }"
        :mark="m"
        :effort="handInEffortFor(ex.key)"
      />
      <TurnSettingMark
        v-for="mark in turnSettingMarkFor(ex.key)"
        :key="`turn-setting-${ex.key}`"
        :class="{ 'thread-mark--enter': isLive(ex) }"
        :mark="mark"
      />

      <div
        class="exchange"
        :class="{
          'exchange--running': ex.blocks.some((b) => b.role === 'assistant' && b.state === 'running'),
          'exchange--paired': ex.blocks.length > 1,
        }"
      >
      <!-- Thin elbow line: out of the request bubble's left edge, across to the avatar column, down to the reply.
           The default style's alone — every other style ties the two its own way, or not at all. -->
      <ExchangeConnector
        v-if="showsElbow && ex.blocks.length > 1 && ex.blocks.some((b) => b.role === 'user') && ex.blocks.some((b) => b.role === 'assistant')"
        :running="ex.blocks.some((b) => b.role === 'assistant' && b.state === 'running')"
      />

    <div
      v-for="block in ex.blocks"
      :key="block.id"
      :data-turn-id="block.id"
      class="turn"
      :class="[
        block.role === 'user' ? 'turn--you' : 'turn--kone',
        block.historical ? '' : 'turn--enter',
        block.role === 'assistant' && block.state !== 'running' ? 'turn--settled' : '',
        block.role === 'assistant' && flash[block.id] ? 'turn--flash' : '',
        block.id === searchFlash ? 'turn--search-flash' : '',
      ]"
    >
      <!-- ── User turn — right-aligned ─────────────────────────────────── -->
      <template v-if="block.role === 'user'">
        <!-- The whole request (bubble or edit field, head, corner time,
             attachments, footer) owns its presentation and edit state in
             UserTurn; the thread only routes what each button means. -->
        <UserTurn
          :block="block"
          :receipt="ex.receipt"
          :parts="partsFor(ex, block)"
          :show-head="spec.youHead"
          :head-stamp="stampFor(block.at)"
          :bubble-stamp="spec.bubbleStamp"
          :ticks="spec.ticks"
          :acts="floatActs ? spec.userActs : 'foot'"
          :copied="copied === block.id"
          :allow-scratchpad="allowScratchpad"
          :busy="busy"
          :copied-path-id="copiedPathId"
          :time="clock(block.at)"
          @save="(text) => saveUserEdit(block, text)"
          @copy="copyUserRequest(block)"
          @scratchpad="addUserRequestToScratchpad(block)"
          @preview="openLightbox"
          @copy-path="copyAttachmentPath"
          @show-in-folder="showInFolder"
        />
      </template>

      <!-- ── Assistant (kone) turn — parts, in the order they arrived ────── -->
      <template v-else>
        <!-- Discord's reply: which request this answers, as a line with a
             spine running into it from the reply's face. -->
        <ReplyRef
          v-if="spec.replyRef && ex.requestText"
          :text="ex.requestText"
        />
        <div class="stack selectable">
          <AssistantTurnBody
            :block="block"
            :display="display"
            :manual="openFolds[block.id]"
            :agent-name="agent.name"
            :agent-seed="agentSeed"
            :house="house"
            :work-label="workLabel(block)"
            :show-face="showFace"
            :face-size="faceSize"
            :stamp="replyStamp(block)"
            :now="now"
            :link-handoffs="linkHandoffs"
            @toggle="(open) => toggleTurn(block, open)"
            @open-thread="emit('open-thread', $event)"
          >
            <!-- The head-seated styles' actions, file restore included: it rests
                 as one more icon and only stays up while it is asking or
                 answering (see conversationStyles.css). -->
            <template
              v-if="floatActs && !spec.sideActs && (canActOn(block) || hasTurnCheckpoint(block))"
              #actions
            >
              <TurnActions
                v-if="canActOn(block)"
                kind="kone"
                :copied="copied === block.id"
                :allow-scratchpad="allowScratchpad"
                :allow-branch="allowBranch"
                :busy="busy"
                :can-act="true"
                @copy="copy(block)"
                @scratchpad="addToScratchpad(block)"
                @fork="emit('branch-fork', block.id)"
              />
              <TurnCheckpointRestore
                v-if="hasTurnCheckpoint(block) && props.threadId"
                :thread-id="props.threadId"
                :turn-id="block.turnId"
                :disabled="busy"
              />
            </template>
          </AssistantTurnBody>
          <!-- An appearance change the turn made is still in force whether or
               not its work is folded away, and the control that takes it back
               belongs with the reply that announced it — so it stands here in
               any settled read. The step row reads the same change the other
               way, against the call that made it. -->
          <TurnThemeReceipts
            v-if="block.state !== 'running'"
            class="turn-themes"
            :items="block.items"
          />

          <!-- Failure note — the error plus Retry (re-sends the request that
               preceded it) and Dismiss (presentational: the block stays failed
               in the transcript, this just stops showing the red note). -->
          <div
            v-if="block.state === 'failed' && block.error && !dismissedTurnErrors[block.id]"
            class="turn-fail"
            :class="{ 'turn-fail--enter': !block.historical }"
          >
            <p class="body body--error">{{ block.error }}</p>
            <div class="turn-fail__actions">
              <button type="button" class="foot__copy" :disabled="busy" @click="retryTurn(block, ex.requestText)">
                <HugeiconsIcon :icon="RefreshIcon" :size="13" :stroke-width="2" />
                <span>Retry</span>
              </button>
              <button type="button" class="foot__copy" @click="dismissTurnError(block)">
                <HugeiconsIcon :icon="Cancel01Icon" :size="13" :stroke-width="2" />
                <span>Dismiss</span>
              </button>
            </div>
          </div>

          <!-- The chat bubble's corner time (ticks imply the chat: the only
               bubble-stamped style with them). -->
          <span v-if="spec.ticks && block.state !== 'running'" class="kone-stamp" aria-hidden="true">{{
            bubbleStamp(block)
          }}</span>

          <!-- Turn footer — kone's family only. The time and a row of icon
               actions, quiet until the turn settles / you hover it. Hidden
               entirely while running (the live header carries the status
               then). Every other style seats its actions in the head line
               instead (and its file restore in the in-flow row below), so it
               never mounts this. -->
          <div v-if="block.state !== 'running' && !floatActs" class="foot">
            <span class="foot__time">{{ clock(block.at) }}</span>
            <span
              v-if="block.state !== 'completed'"
              class="foot__status"
              :class="`foot__status--${statusFor(block).tone}`"
              >{{ statusFor(block).text }}</span
            >
            <TurnActions
              v-if="block.state === 'completed' && assistantText(block)"
              kind="kone"
              :copied="copied === block.id"
              :allow-scratchpad="allowScratchpad"
              :allow-branch="allowBranch"
              :busy="busy"
              :can-act="true"
              @copy="copy(block)"
              @scratchpad="addToScratchpad(block)"
              @fork="emit('branch-fork', block.id)"
            />
            <TurnCheckpointRestore
              v-if="hasCheckpoint(block) && props.threadId"
              :thread-id="props.threadId"
              :turn-id="block.turnId"
              :disabled="busy"
            />
          </div>
          <!-- The chat's seat: beside the bubble, level with its time. -->
          <span
            v-if="spec.sideActs && block.state !== 'running' && (canActOn(block) || hasTurnCheckpoint(block))"
            class="side-acts"
          >
            <TurnActions
              v-if="canActOn(block)"
              kind="kone"
              :copied="copied === block.id"
              :allow-scratchpad="allowScratchpad"
              :allow-branch="allowBranch"
              :busy="busy"
              :can-act="true"
              @copy="copy(block)"
              @scratchpad="addToScratchpad(block)"
              @fork="emit('branch-fork', block.id)"
            />
            <TurnCheckpointRestore
              v-if="hasTurnCheckpoint(block) && props.threadId"
              :thread-id="props.threadId"
              :turn-id="block.turnId"
              :disabled="busy"
            />
          </span>
        </div>
      </template>
    </div>
    </div>
    </template>
    <!-- Compaction markers newer than every exchange trail the thread. -->
    <CompactionMarker
      v-for="(m, mi) in trailingMarkers"
      :key="`compact-trailing-${mi}`"
      :class="{ 'thread-mark--enter': tailIsLive }"
      :marker="m"
      :format-time="clock"
    />
    <!-- Handoff markers newer than every exchange trail the thread. -->
    <HandoffMark
      v-for="m in trailingHandoffMarks"
      :key="`handoff-trailing-${m.key}`"
      :class="{ 'thread-mark--enter': tailIsLive }"
      :mark="m"
      @open-thread="(id) => emit('open-thread', id)"
    />
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
                <TextSwap :swap-key="copiedPathId === lightbox.attachment.id ? 'Copied' : 'Copy Path'">
                  <HugeiconsIcon
                    :icon="copiedPathId === lightbox.attachment.id ? Tick02Icon : Copy01Icon"
                    :size="14"
                    :stroke-width="2"
                  />
                  <span>{{ copiedPathId === lightbox.attachment.id ? "Copied" : "Copy Path" }}</span>
                </TextSwap>
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
  /* The thread's reading measure — the single authority on line length. The
     column caps itself at var(--thread-measure) below; every row inside (the
     settled answer, the work fold, the theme receipts, the spawn marks) fills
     the column at width:100% and carries no second cap of its own, so the
     measure changes in exactly one place. */
  --thread-measure: 720px;
  /* The space a settled reply's footer holds open below the answer. Declared
     rather than measured so it is a known quantity: the footer is invisible
     until the turn is hovered, and the marks between exchanges subtract it to
     sit centred in the band they divide. --turn-foot-lift is the footer's own
     upward pull, declared here rather than restated by hand so the footer and
     the correction can never drift apart. */
  --turn-foot: 22px;
  --turn-foot-lift: 7px;
  /* How much of the band a mark leaves below itself, so it stays clear of the
     footer a hovered turn reveals. */
  --turn-mark-clearance: 10px;
  /* The column's vertical rhythm: the space between exchanges, and between
     the marks at the head of a conversation and the first request. */
  --thread-gap: 24px;

  display: flex;
  flex-direction: column;
  gap: var(--thread-gap);
  width: 100%;
  max-width: var(--thread-measure);
  /* ── Flex containment, declared here for the whole column ─────────────────
     A flex item's automatic minimum size is its CONTENT's min-content width,
     not zero. One unbreakable thing deep in a reply — a wide table's spans, a
     long code line — therefore pushes every ancestor wider than the
     var(--thread-measure) cap,
     breaking the centered measure and pushing the overflow under the column's
     overflow-x:hidden, where it is clipped rather than scrolled.
     The floor has to be opted out of at EVERY flex link between here and that
     content, because one link without it re-imposes the whole chain: .thread →
     .exchange → .turn → .stack → .answer-wrap → .answer / .fold, each carrying
     its own `min-width: 0` for this reason and no other. Add a flex child in
     that path and it needs the same line — the scroller inside CodeBlock can
     only do its job once its box has stopped growing. */
  min-width: 0;
  margin: 0 auto;
}

/* No padding of its own: the column's --thread-gap is the single authority on
   vertical rhythm, and a divider that padded itself would space unevenly
   against the marks it stacks with at the head of a conversation. */
.thread-date {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
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

/* A mark between two exchanges — a day divider, a compaction, a handoff, a
   model or effort change — is centred in the band it divides, and the band is
   not symmetric: the exchange above it ends in a reply whose footer holds its
   space open while staying invisible, so the mark would otherwise sit that
   much too low. Trim the leading gap by the footer's reserve and the mark
   reads as evenly spaced from the reply above and the request below. Only a
   mark that directly follows an exchange pays this; one at the head of the
   conversation has no reply above it.

   `thread-mark` is the contract every mark root carries — the one class this
   rule names, so a new kind of mark is spaced right by being a mark, rather
   than by remembering to enlist itself in a selector list kept in a different
   file from the component. */
.exchange + .thread-mark {
  margin-top: calc(var(--turn-foot-lift) - var(--turn-foot) - var(--turn-mark-clearance));
}

/* Marks stacked at the head of a conversation — the day, then who picked the
   thread up — read as one caption, so they sit closer to each other than the
   column's rhythm spaces the rows around them. */
.thread-mark + .thread-mark {
  margin-top: calc(10px - var(--thread-gap));
}

/* A mark that lands live — a day turning over, a compaction, a handoff, a
   model switch — reads in as a `per-word-crossfade` over its parts: each word,
   logo or leg fades up in order, 70ms apart, so "Sonnet → Opus" is read left
   to right as the change it is. The 8px drift drops to 6px on a 12px line. A
   mark drawn from history is already true and plays nothing. Only children
   that animate as boxes are staggered; the delays cap at the sixth so a long
   mark never trails. */
.thread-mark--enter > :deep(*) {
  animation: mark-word-in 700ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
}
.thread-mark--enter > :deep(:nth-child(2)) { animation-delay: 70ms; }
.thread-mark--enter > :deep(:nth-child(3)) { animation-delay: 140ms; }
.thread-mark--enter > :deep(:nth-child(4)) { animation-delay: 210ms; }
.thread-mark--enter > :deep(:nth-child(5)) { animation-delay: 280ms; }
.thread-mark--enter > :deep(:nth-child(n + 6)) { animation-delay: 350ms; }
@keyframes mark-word-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .thread-mark--enter > :deep(*) {
    animation: none;
  }
}

/* An exchange = one request + its response, stacked with breathing room. */
.exchange {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 20px;
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
  min-width: 0;
  gap: 10px;
}
.turn--you {
  align-items: flex-end;
}
/* A live request settles in once as a `micro-scale-fade`: 600ms, 0.96 → 1,
   grown from the bubble's tail corner so it reads as leaving the composer
   below rather than dropping in from nowhere. The words inside stay still —
   the user just typed them, and replaying their own sentence back at them
   would be lag, not polish. Plain CSS rather than a motion component per
   turn: the animation ends and leaves nothing running. */
.turn--enter.turn--you {
  transform-origin: 100% 100%;
  animation: turn-you-enter 600ms cubic-bezier(0.32, 0.72, 0, 1) backwards;
}
@keyframes turn-you-enter {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
}
/* A live reply carries its own arrival — the speaker's face and name play it
   in AssistantTurnBody, and each word resolves as it streams — so the turn's
   box only fades, rather than moving under text that is already moving. */
.turn--enter.turn--kone {
  animation: turn-fade 320ms ease-out backwards;
}
@media (prefers-reduced-motion: reduce) {
  .turn--enter.turn--you {
    animation-name: turn-fade;
  }
}
@keyframes turn-fade {
  from {
    opacity: 0;
  }
}
/* The row a conversation-search hit landed on: a quiet accent ring that fades
   with the flash timer. An outline rather than a wash — the row keeps its own
   surface and the mark reads as an arrival, not a selection. */
.turn--search-flash {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: 6px;
  border-radius: 12px;
}

/* ── The turn's body stack ─────────────────────────────────────────────────── */
.stack {
  display: flex;
  flex-direction: column;
  gap: 15px;
  align-items: flex-start;
  width: 100%;
  /* `.selectable` carries the global prose measure (68ch, ~540px here), which
     would stop the reply well short of the column its request is aligned to.
     The thread's own var(--thread-measure) cap is the measure. */
  max-width: none;
  min-width: 0;
}
/* ── Message body ──────────────────────────────────────────────────────────── */
/* NOTE: the shared type primitives (.body, .body--error, .foot__copy) live in
   ./conversationStyles.css — the thread's unscoped visual layer — because
   both this file's banners and UserTurn's bubble render them, which a scoped
   block cannot reach. The request bubble's own surface (.body--you) and
   everything hung off a user turn live in UserTurn.vue. */
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
.turn-themes {
  margin-top: 1px;
}
/* A failure lands as a `scale-down-fade` — settling from a hair above its
   size, 8px up, 520ms — firm enough to be noticed, calm enough not to alarm.
   The load-failure card plays it too; a turn that failed in history doesn't. */
.turn-fail--enter,
.thread__error {
  animation: fail-in 520ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
@keyframes fail-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(1.04);
  }
}
@media (prefers-reduced-motion: reduce) {
  .turn-fail--enter,
  .thread__error {
    animation-name: turn-fade;
  }
}
.turn-fail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  width: 100%;
}
.turn-fail__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* NOTE: the edit field (.edit-box, .edit-input) lives in UserTurn.vue, which
   renders it; the worded action row (.foot__copy and its --primary/disabled
   states) lives in ./conversationStyles.css, shared by this file's failure
   actions and UserTurn's edit controls. */

/* ── Turn footer (meta) — editorial dotted leader ──────────────────────────── */
.foot {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: calc(-1 * var(--turn-foot-lift));
  /* Reserve, not a ceiling: the marks above subtract exactly this much, and
     content that outgrows it should push the row open rather than be clipped
     inside a footer nobody sees until they hover. */
  min-height: var(--turn-foot);
  width: 100%;
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  /* Chrome, not content — the "replied in 52s" status + timestamp shouldn't
     drag-highlight even though the turn body is .selectable. */
  -webkit-user-select: none;
  user-select: none;
  --foot-in-x: -8px;
}
.turn--flash .foot {
  --foot-shown: 0.92;
}
.turn--kone.turn--settled:hover .foot,
.foot:focus-within {
  --foot-shown: 1;
}

/* ── A turn's footer showing up ────────────────────────────────────────────────
   Both footers — a reply's and (in UserTurn.vue) a request's — arrive as a
   `short-slide-right`: the row glides in as one compact move from the side
   it hangs off, while its items come up one after another through opacity
   only, so the move reads as a single gesture rather than each button
   sliding on its own. The effect's 24px travel drops to 8px and its 92ms
   stagger to 45ms, since a footer holds up to five items and a hover should
   be answered at once. Leaving is one quick fade, no stagger — the row
   just goes. */
.foot {
  transform: translateX(var(--foot-in-x));
  transition: transform 320ms cubic-bezier(0.4, 0, 0.2, 1);
}
/* `.turn` in front for weight: an item's own rules (a button's hover
   transition, a disabled button's dimming) must not outrank the footer's
   say over whether it is shown. The hover colours ride along in the same
   transition list for that reason. */
.turn .foot > * {
  opacity: 0;
  transition:
    opacity 320ms cubic-bezier(0.4, 0, 0.2, 1),
    background-color 0.15s ease,
    color 0.15s ease;
}
.turn--flash .foot,
.turn--kone.turn--settled:hover .foot,
.foot:focus-within {
  transform: none;
  transition: transform 520ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.turn--flash .foot > *,
.turn--kone.turn--settled:hover .foot > *,
.foot:focus-within > * {
  opacity: calc(var(--foot-shown, 1) * var(--item-dim, 1));
  transition:
    opacity 520ms cubic-bezier(0.2, 0.8, 0.2, 1) var(--foot-delay, 0ms),
    background-color 0.15s ease,
    color 0.15s ease;
}
.foot > :nth-child(2) { --foot-delay: 45ms; }
.foot > :nth-child(3) { --foot-delay: 90ms; }
.foot > :nth-child(4) { --foot-delay: 135ms; }
.foot > :nth-child(n + 5) { --foot-delay: 180ms; }
@media (prefers-reduced-motion: reduce) {
  .foot {
    transform: none;
  }
}
/* The dotted rule that carried the eye from the timestamp to the status is
   gone — the meta row now reads as a row of quiet items, no leader line. */
.foot__status--live {
  color: var(--ink-soft);
}
.foot__status--error {
  color: var(--diff-del);
}
.foot__time,
.foot__status {
  margin-right: 8px;
}
/* NOTE: the worded action row (.foot__copy with its --primary and :disabled
   states) lives in ./conversationStyles.css, shared by the failure actions
   here and UserTurn's edit controls. */

/* The file restore sits in the same row, so its resting button takes the
   same icon-only shape as the canonical row (see TurnActions.vue); the
   steps after it keep their words. */
.foot :deep(.ckpt > .ckpt__btn:not(:disabled)) {
  width: 26px;
  height: 26px;
  justify-content: center;
  padding: 0;
}
.foot :deep(.ckpt > .ckpt__btn:not(:disabled) > span) {
  display: none;
}

/* ── Conversation styles ─────────────────────────────────────────────────────
   Lives in ./conversationStyles.css (imported below): every non-kone look   
   keyed off the root's `thread--style-*` class, plus the you-head /       
   reply-ref / ticks fragments they compose (YouHead / ReplyRef /          
   ReceiptTicks). Unscoped there on purpose — those fragments render in    
   child components, which a scoped block cannot reach. */

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
/* NOTE: attachment rich previews (.att-*) live in UserTurn.vue, which renders
   them. */

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

<style src="./conversationStyles.css"></style>
