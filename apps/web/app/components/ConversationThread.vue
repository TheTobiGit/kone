<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { AnimatePresence, motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Copy01Icon,
  Note01Icon,
  PencilEdit01Icon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { AssistantBlock, QueuedTurnEntry, ThreadBlock } from "~/composables/useAgent";
import type { RuntimeItem } from "~/types/desktop";
import MarkdownMessage from "~/components/MarkdownMessage.vue";
import FileChip from "~/components/FileChip.vue";
import AgentActivity from "~/components/AgentActivity.vue";
import { renderGroups, segText, type RenderGroup, type Segment } from "~/utils/conversationSegments";
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
  /** The session is still starting / rehydrating — no retry while it is. */
  loading?: boolean;
  /** A turn is in flight — retry / resend are disabled while one is. */
  busy?: boolean;
  /** Follow-ups durably queued behind the running turn (useAgent's
   *  queuedTurns). User blocks whose id is in the queue get a small queued
   *  badge so a parked follow-up reads as waiting, not delivered. */
  queued?: QueuedTurnEntry[];
  /** A stored thread adopted windowed (keyset pagination): the store holds an
   *  older page beyond the window in hand. Absent for a full load / fresh
   *  thread. */
  hasOlder?: boolean;
  /** A load-older request is in flight. */
  loadingOlder?: boolean;
  /** The last load-older attempt failed — the affordance shows a retry. */
  olderError?: string | null;
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
type BlockView = { groups: RenderGroup[]; live: { segments: Segment[] } | null };

function buildView(block: AssistantBlock): BlockView {
  const all = renderGroups(block);
  const tail = all[all.length - 1];
  const tailIsSteps = tail?.kind === "steps";
  const live = block.state === "running" && (all.length === 0 || tailIsSteps);
  if (!live) return { groups: all, live: null };
  if (tailIsSteps) return { groups: all.slice(0, -1), live: { segments: tail.segments } };
  return { groups: all, live: { segments: [] } };
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

const EMPTY_VIEW: BlockView = { groups: [], live: null };
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
function statusOf(block: AssistantBlock): { text: string; tone: "live" | "muted" | "error" } {
  if (block.state === "running") return { text: `working · ${elapsed(block)}`, tone: "live" };
  if (block.state === "failed") return { text: "couldn't finish", tone: "error" };
  if (block.state === "interrupted") return { text: "stopped", tone: "muted" };
  return { text: `replied in ${elapsed(block)}`, tone: "muted" };
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
  cue("toggle");
}
async function copyUserRequest(block: Extract<ThreadBlock, { role: "user" }>) {
  if (!block.text || !import.meta.client) return;
  try {
    await navigator.clipboard.writeText(block.text);
    cue("toggle");
    copied.value = block.id;
    window.setTimeout(() => {
      if (copied.value === block.id) copied.value = null;
    }, 1600);
  } catch {
    // Clipboard blocked — nothing to do.
  }
}
function addUserRequestToScratchpad(block: Extract<ThreadBlock, { role: "user" }>) {
  if (!block.text?.trim()) return;
  emit("to-scratchpad", block.text);
  cue("press");
}
async function copy(block: AssistantBlock) {
  const text = assistantText(block);
  if (!text || !import.meta.client) return;
  try {
    await navigator.clipboard.writeText(text);
    cue("toggle");
    copied.value = block.id;
    window.setTimeout(() => {
      if (copied.value === block.id) copied.value = null;
    }, 1600);
  } catch {
    // Clipboard blocked — nothing to do.
  }
}

function addToScratchpad(block: AssistantBlock) {
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
  cue("toggle");
}

// ── edit-and-resend (last user turn only) ─────────────────────────────────────
// The edit affordance lives on the LAST user turn — the one a follow-up edit
// could still plausibly replace. Saving ships the text through the host's send
// path as a new turn; the transcript keeps the original and the reply after it.
const editingUser = ref<string | null>(null);
const editDraft = ref("");
const editInput = ref<HTMLTextAreaElement | null>(null);
const lastUserBlockId = computed(() => lastUserBlock()?.id ?? null);
/** userBlockId/anchored blockId → queue entry. The queued badge reads this:
 *  a user block whose prompt is waiting behind the running turn (rather than
 *  answered) carries its queue entry, so the transcript shows what is queued
 *  and where it sits in line. */
const queuedByBlockId = computed(() => {
  const map = new Map<string, QueuedTurnEntry>();
  for (const q of props.queued ?? []) {
    if (q.blockId) map.set(q.blockId, q);
    else map.set(q.userBlockId, q);
  }
  return map;
});
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
// threadId present + no blocks + nothing loading/running = the open failed
// (or the stored thread vanished mid-read). A fresh blank thread carries no
// threadId, so it can never hit this state. Dismiss is presentational — the
// banner comes back on the next reopen, which is honest: nothing was fixed.
const loadDismissed = ref(false);
const failedLoad = computed(
  () =>
    Boolean(props.threadId) &&
    !props.loading &&
    !props.busy &&
    props.blocks.length === 0 &&
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
  cue("toggle");
}

// ── auto-scroll ────────────────────────────────────────────────────────────────
const root = ref<HTMLElement | null>(null);
function tailSignature(): string {
  const last = props.blocks[props.blocks.length - 1];
  if (!last) return "";
  if (last.role === "user") return `${props.blocks.length}:u:${last.text.length}`;
  const chars = last.items.reduce((n, i) => n + i.text.length, 0);
  return `${props.blocks.length}:a:${last.items.length}:${chars}:${last.state}`;
}
// Anchor each new request to the top, then let the reply grow *down* into blank
// space — never shove the prior exchange up.
//
// The old model pinned the bottom every streamed frame. On a fresh thread that
// reads as calm (nothing above to move), but on the second turn the reply, to
// stay in view, drags the whole first exchange upward one line at a time — and
// the entering-turn spring transform fighting that per-frame scroll is the
// flashing / shaking you feel.
//
// Instead we do what a reader expects: when a new request lands we lift it to
// the top of the viewport and reserve a screen of empty space below it, so the
// answer streams downward into that space with everything above held perfectly
// still. As the reply grows we simply trim the reserve to exactly what's needed
// to keep the request pinned at the top — every one of those changes happens
// *below the fold*, so it's invisible and can't jitter. Only once a reply
// outgrows a full screen does the reserve reach zero and we fall back to a calm
// bottom-follow (unless you've scrolled up to read, which we leave alone).
// Where the request locks to the top. Must match the sticky `top` in .turn--you
// so the anchor scroll lands the request exactly on its sticky rail with no jump
// as it takes over.
const TOP_PAD = 14;
const tailSpacer = ref(0);
const tailSpacerEl = ref<HTMLElement | null>(null);
let reflowQueued = false;
let anchoredUserId: string | null = null;
let anchorAt = 0;
// The reserve lives *inside* `root`, which the ResizeObserver watches — so every
// time reflow trims it we'd re-trigger the observer, and reflow→resize→reflow
// spins a frame forever (the freeze). Route every reserve write through here so
// the observer can recognise and skip its own mutations.
let programmaticResize = false;
function setTailSpacer(px: number): void {
  const v = Math.max(0, Math.round(px));
  if (tailSpacer.value === v) return;
  programmaticResize = true;
  tailSpacer.value = v;
}
// `detached` = the reader has moved away from the live tail — scrolled up, arrow
// keys, an upward touch-swipe, or a text selection. While set we never yank the
// view; it re-arms only when the reader is back at the live edge (see onScroll).
const detached = ref(false);
function isLiveTail(): boolean {
  const last = props.blocks[props.blocks.length - 1];
  if (!last) return false;
  if (last.role === "user") return true;
  return last.role === "assistant" && last.state === "running";
}

function lastUserBlock(): ThreadBlock | null {
  for (let i = props.blocks.length - 1; i >= 0; i--) {
    const b = props.blocks[i];
    if (b && b.role === "user") return b;
  }
  return null;
}
function turnEl(id: string): HTMLElement | null {
  return root.value?.querySelector<HTMLElement>(`[data-turn-id="${id}"]`) ?? null;
}
// How much empty space we must reserve below so `userEl`'s top can rest TOP_PAD
// from the viewport top. Measured against the content height *without* our own
// reserve, so it's stable frame to frame.
function neededSpacer(sc: HTMLElement, userEl: HTMLElement): number {
  const userTop = sc.scrollTop + (userEl.getBoundingClientRect().top - sc.getBoundingClientRect().top);
  // Measure the reserve's *live* DOM height, not the reactive ref — Vue commits
  // the ref to the DOM a tick late, so subtracting the ref from `scrollHeight`
  // reads two different moments and makes `base` (and thus `needed`) jitter.
  const reserve = tailSpacerEl.value?.offsetHeight ?? 0;
  const base = sc.scrollHeight - reserve;
  return Math.max(0, userTop - TOP_PAD + sc.clientHeight - base);
}

// One pass per frame: the content-signature watch and the ResizeObserver (async
// image / code-fence growth that changes height AFTER the signature ticked) both
// funnel through here, so reflow never runs twice in the same frame.
function queueReflow(): void {
  if (!import.meta.client || reflowQueued) return;
  reflowQueued = true;
  requestAnimationFrame(() => {
    reflowQueued = false;
    reflow();
  });
}
function reflow(): void {
  const sc = scroller();
  if (!sc) return;
  const lu = lastUserBlock();

  // A brand-new request — lift it to the top with a screen of room below.
  if (lu && lu.id !== anchoredUserId) {
    anchoredUserId = lu.id;
    if (!isLiveTail()) return; // opening a settled thread — adopt the id, don't yank
    detached.value = false; // a fresh request — the reader wants to watch its reply
    anchorAt = performance.now();
    setTailSpacer(sc.clientHeight); // reserve first, so the row can reach the top
    requestAnimationFrame(() => {
      const el = turnEl(lu.id);
      if (!el) return;
      const target =
        sc.scrollTop + (el.getBoundingClientRect().top - sc.getBoundingClientRect().top) - TOP_PAD;
      sc.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    });
    return;
  }

  // Let the lift settle before we start trimming, so we don't fight the smooth
  // scroll toward the top with per-frame reserve changes.
  if (performance.now() - anchorAt < 450) return;

  // Mid-stream: hold the request at the top by trimming the reserve.
  const el = lu ? turnEl(lu.id) : null;
  const needed = el ? neededSpacer(sc, el) : 0;
  if (needed > 0) {
    setTailSpacer(needed);
    return;
  }
  // Reply outgrew the screen — release the reserve and calmly follow the tail.
  setTailSpacer(0);
  const gap = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
  if (gap > 260) return; // scrolled away to read — don't yank them back
  if (gap <= 1) return; // already pinned
  if (detached.value) return; // reading elsewhere — don't yank either
  sc.scrollTop = sc.scrollHeight;
}
watch(tailSignature, queueReflow);
function scroller(): HTMLElement | null {
  let el = root.value?.parentElement ?? null;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

// ── is the live request actually stuck? ────────────────────────────────────────
// The pinned request carries an OPAQUE sheet of paper above it — that's what
// makes the reply vanish under it instead of showing through. But a sticky
// element is only a header while it's *stuck*; the rest of the time it sits in
// normal flow, and there the sheet is just a slab of paper blanking whatever
// exchange happens to be above it. (Scroll up mid-stream to reread the previous
// answer and it's gone — that's this.) So the fog is gated on the request having
// actually reached its rail.
const stuckId = ref<string | null>(null);
let stuckQueued = false;
function measureStuck(): void {
  if (!import.meta.client) return;
  const sc = scroller();
  const lu = lastUserBlock();
  const el = sc && lu ? turnEl(lu.id) : null;
  if (!sc || !lu || !el) {
    stuckId.value = null;
    return;
  }
  const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  stuckId.value = top <= TOP_PAD + 1.5 ? lu.id : null;
}
function queueStuck(): void {
  if (stuckQueued) return;
  stuckQueued = true;
  requestAnimationFrame(() => {
    stuckQueued = false;
    measureStuck();
  });
}
// Interaction = intent: any of these means the reader is looking at something
// other than the live tail, so auto-follow hands over control (see `detached`).
let touchStartY = 0;
let touchUpward = false;
function onScroll(): void {
  if (!detached.value) return;
  const sc = scrollHost;
  if (!sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight > 8) return;
  detached.value = false; // back at the live edge — re-arm the follow
}
function onWheel(e: WheelEvent): void {
  if (e.deltaY < 0) detached.value = true;
}
function onKeydown(e: KeyboardEvent): void {
  const k = e.key;
  if (k !== "ArrowUp" && k !== "PageUp" && k !== "Home") return;
  if (scrollHost?.contains(e.target as Node)) detached.value = true;
}
function onTouchStart(e: TouchEvent): void {
  touchUpward = false;
  const t = e.touches[0] ?? e.changedTouches[0];
  if (t) touchStartY = t.clientY;
}
function onTouchMove(e: TouchEvent): void {
  if (touchUpward) return;
  const t = e.touches[0] ?? e.changedTouches[0];
  if (t && t.clientY < touchStartY) {
    touchUpward = true;
    detached.value = true;
  }
}
function onSelectionChange(): void {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const node = sel.anchorNode;
  if (node && root.value?.contains(node)) detached.value = true;
}
let scrollHost: HTMLElement | null = null;
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  scrollHost = scroller();
  scrollHost?.addEventListener("scroll", queueStuck, { passive: true });
  scrollHost?.addEventListener("scroll", onScroll, { passive: true });
  scrollHost?.addEventListener("wheel", onWheel, { passive: true });
  scrollHost?.addEventListener("keydown", onKeydown, { passive: true });
  scrollHost?.addEventListener("touchstart", onTouchStart, { passive: true });
  scrollHost?.addEventListener("touchmove", onTouchMove, { passive: true });
  document.addEventListener("selectionchange", onSelectionChange, { passive: true });
  // Content can change height long after a stream tick — images, code fences —
  // which would drift the pinned request. Only a live tail needs re-pinning, so
  // a settled transcript never re-enters the trim/follow path from here.
  if (root.value) {
    resizeObserver = new ResizeObserver(() => {
      // Ignore the resize our own reserve write just caused — otherwise
      // reflow→resize→reflow spins forever (the freeze).
      if (programmaticResize) {
        programmaticResize = false;
        return;
      }
      // Only re-pin a live tail, and never while the reader has scrolled away.
      if (isLiveTail() && !detached.value) queueReflow();
    });
    resizeObserver.observe(root.value);
  }
  queueStuck();
});
onBeforeUnmount(() => {
  scrollHost?.removeEventListener("scroll", queueStuck);
  scrollHost?.removeEventListener("scroll", onScroll);
  scrollHost?.removeEventListener("wheel", onWheel);
  scrollHost?.removeEventListener("keydown", onKeydown);
  scrollHost?.removeEventListener("touchstart", onTouchStart);
  scrollHost?.removeEventListener("touchmove", onTouchMove);
  document.removeEventListener("selectionchange", onSelectionChange);
  resizeObserver?.disconnect();
});
// The reply growing under a held request changes the answer too, not just the
// scroll position.
watch(tailSignature, queueStuck);
const hasBlocks = computed(() => props.blocks.length > 0);

// Group the flat block list into exchanges: each user request opens a new group
// and the assistant turn(s) that follow it belong to that group. The group is the
// sticky containing block for the request (see the template + .exchange CSS).
const allExchanges = computed(() => {
  const groups: { key: string; blocks: ThreadBlock[] }[] = [];
  for (const b of props.blocks) {
    if (b.role === "user" || groups.length === 0) groups.push({ key: b.id, blocks: [b] });
    else groups[groups.length - 1]!.blocks.push(b);
  }
  // `live` = the reply is still streaming (or just sent, response not started).
  // Only the live exchange pins its request to the top; once the reply settles
  // the whole exchange scrolls like ordinary content again.
  return groups.map((g, i) => {
    const asst = g.blocks.filter((b) => b.role === "assistant");
    const running = asst.some((b) => b.role === "assistant" && b.state === "running");
    const awaiting = asst.length === 0 && i === groups.length - 1;
    return { ...g, live: running || awaiting };
  });
});

// ── jump to latest ────────────────────────────────────────────────────────────
// A quiet pill that appears only while the live exchange is streaming/awaiting
// AND the reader has detached — i.e. the reply they want is somewhere below the
// fold. Clicking it drops the reader back on the live edge.
const liveNow = computed(() => {
  const g = allExchanges.value[allExchanges.value.length - 1];
  return g ? g.live : false;
});
const showJumpPill = computed(() => liveNow.value && detached.value);
function jumpToLatest(): void {
  cue("toggle");
  detached.value = false;
  const sc = scroller();
  sc?.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
}

// ── the open window ────────────────────────────────────────────────────────────
// Reopening a long conversation used to mount every exchange it ever had: every
// activity feed, every Markdown answer, and a Shiki tokenisation per code fence —
// all before the first frame, and all of it scrolled far off the top where nobody
// was going to look. So we mount the tail and offer the rest.
//
// A window, not virtualisation: real virtualisation would have to measure and
// recycle rows, and this transcript's sticky requests, reserved tail space and
// anchored auto-scroll all read live DOM geometry (see `neededSpacer`). Mounting
// a suffix keeps every one of those measurements exactly as true as before —
// the only thing that changes is how much history is above the fold.
const OPEN_WINDOW = 8;
const showAllExchanges = ref(false);
const earlierCount = computed(() =>
  showAllExchanges.value ? 0 : Math.max(0, allExchanges.value.length - OPEN_WINDOW),
);
const exchanges = computed(() =>
  earlierCount.value > 0 ? allExchanges.value.slice(earlierCount.value) : allExchanges.value,
);

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
  cue("toggle");
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
  cue("toggle");
  emit("load-older");
}
</script>

<template>
  <div ref="root" class="thread" :class="{ 'thread--empty': !hasBlocks }">
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

    <!-- A stored conversation whose transcript never arrived — threadId known,
         nothing loading, no blocks, no session error. Retry re-runs the open;
         dismiss hides the card for this session. -->
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
    <CodeGolfArt v-if="!hasBlocks" class="thread__art" />

    <div v-if="!hasBlocks" class="empty relative z-10 sr-only">
      <p>Nothing here yet — say something to begin.</p>
    </div>

    <!-- One request + its response form an "exchange" — the sticky containing
         block for the request. Grouping this way is what lets each new request
         push the previous one up and out of the sticky spot, instead of two
         sticky headers piling on top of each other. -->
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

    <div v-for="ex in exchanges" :key="ex.key" class="exchange">
    <motion.div
      v-for="block in ex.blocks"
      :key="block.id"
      :data-turn-id="block.id"
      class="turn"
      :class="[
        block.role === 'user' ? 'turn--you' : 'turn--kone',
        block.role === 'user' && ex.live ? 'turn--pinned' : '',
        block.role === 'user' && ex.live && stuckId === block.id ? 'turn--stuck' : '',
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
        <!-- What was attached to this turn — the same file chips the agent uses
             in prose. Metadata only (bytes live on disk), so images show their
             file-type glyph rather than a thumbnail. -->
        <div v-if="block.attachments?.length" class="you-attachments selectable">
          <FileChip
            v-for="att in block.attachments"
            :key="att.id"
            :path="att.name"
            :title="`${att.name} · ${att.mimeType}`"
          />
        </div>
        <!-- Queued — this prompt is durably queued behind the running turn,
             not yet answered. The badge is driven by the host's queue state
             (turn.queued / turn.promoted / turn.queued-cancelled); the number
             is its place in line (the running turn is slot 1). -->
        <div v-if="queuedByBlockId.get(block.id)" class="you-queued" role="status">
          <span class="you-queued__dot" aria-hidden="true" />
          <span>Queued · #{{ queuedByBlockId.get(block.id)?.position }}</span>
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
          <template v-for="grp in viewOf(block).groups" :key="grp.kind === 'text' ? grp.seg.key : grp.key">
            <!-- Steps — done batches only. The live tail (or the opening beat
                 before the first step lands) is a single AgentActivity below with
                 a stable key so the working orb never hands off; `viewOf` has
                 already lifted that batch out of this list. -->
            <AgentActivity
              v-if="grp.kind === 'steps'"
              :segments="grp.segments"
              :running="block.state === 'running'"
              :is-tail="false"
              :historical="block.historical"
            />

            <!-- Text — rendered as rich Markdown the whole way through, streaming
                 or settled, so the reply reads as a proper preview as it grows
                 (never a raw block that only formats once complete). -->
            <div
              v-else-if="grp.kind === 'text'"
              class="answer-wrap"
              :data-markdown-source="segText(grp.seg)"
            >
              <MarkdownMessage
                class="answer"
                :source="segText(grp.seg)"
                :historical="block.historical"
              />
            </div>
          </template>

          <!-- Live activity — one orb for the whole run: from send through every
               thinking step and tool call until text takes over. -->
          <AgentActivity
            v-if="viewOf(block).live"
            :key="`${block.id}:live-activity`"
            :segments="viewOf(block).live!.segments"
            :running="block.state === 'running'"
            :is-tail="true"
            :historical="block.historical"
          />

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
            <span class="foot__status" :class="`foot__status--${statusOf(block).tone}`">{{
              statusOf(block).text
            }}</span>
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
              v-if="block.state === 'completed' && assistantText(block)"
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

    <!-- Reserved room the live turn streams down into, so a new request can sit
         at the top of the viewport instead of shoving the last exchange up. -->
    <div
      v-if="tailSpacer > 0"
      ref="tailSpacerEl"
      class="thread__tail-spacer"
      :style="{ height: `${tailSpacer}px` }"
      aria-hidden="true"
    />

    <!-- Jump to latest — floats at the bottom-centre of the column while the live
         reply is out of view, so a reader who scrolled up gets back in one tap. -->
    <div class="jump">
      <AnimatePresence>
        <motion.button
          v-if="showJumpPill"
          key="jump-to-latest"
          type="button"
          class="jump__btn"
          aria-label="Jump to latest reply"
          :initial="{ opacity: 0, y: 8 }"
          :animate="{ opacity: 1, y: 0 }"
          :exit="{ opacity: 0, y: 8 }"
          :transition="{ type: 'spring', stiffness: 320, damping: 30, mass: 0.8 }"
          @click="jumpToLatest"
        >
          <HugeiconsIcon :icon="ArrowDown01Icon" :size="13" :stroke-width="2" aria-hidden="true" />
          <span>Jump to latest</span>
        </motion.button>
      </AnimatePresence>
    </div>
  </div>
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
  font-size: 15px;
  line-height: 1.5;
  color: var(--muted);
  text-wrap: pretty;
}

.thread__tail-spacer {
  flex: none;
  width: 100%;
  pointer-events: none;
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

/* Jump to latest — floats at the bottom-centre of the column while the live reply
   is below the fold and the reader has detached. Deliberately quiet, like .earlier:
   no border, a whisper of the agent accent over the panel surface, one soft shadow.
   The 200px bottom clears the column's bottom smoke (a 176px fade over a 208px
   pad — see .col__body in ThreadStrip) so the pill is never masked. */
.jump {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 200px;
  z-index: 20;
}
.jump__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in oklab, var(--accent) 9%, var(--ground));
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 12px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.jump__btn:hover {
  background: color-mix(in oklab, var(--accent) 15%, var(--ground));
  color: var(--ink);
}
.jump__btn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 30%, transparent);
  outline-offset: 2px;
}

/* An exchange = one request + its response. It's the sticky containing block for
   the request: the request sticks to the top only while its own exchange is on
   screen, so the next request cleanly takes over the rail as you scroll on. */
.exchange {
  display: flex;
  flex-direction: column;
  gap: 34px;
}
.turn {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* The request rides at the top of its exchange as its own opaque header while
   the response scrolls underneath — exactly like the thread body sliding under
   the thread header. The ::before is a full-bleed sheet of paper that reaches
   far above (hiding everything the reply scrolls up behind it, completely — not
   a translucent tint) and ends in a short blurred skirt where the reply emerges
   softly from under it. */
.turn--you {
  align-items: flex-end;
}
/* Only the live exchange pins its request as a header; a settled exchange drops
   the stickiness and scrolls away normally. */
.turn--you.turn--pinned {
  position: sticky;
  top: 14px; /* keep in sync with TOP_PAD */
  z-index: 4;
}
/* Only once it has actually reached the rail — in normal flow this opaque sheet
   would blank the exchange above it (see `measureStuck`). */
.turn--you.turn--pinned.turn--stuck::before {
  content: "";
  position: absolute;
  z-index: -1;
  top: -1200px; /* cover everything above — clipped by the scroller */
  /* The sheet is solid all the way to the request's bottom edge and then fades
     over a skirt that sits ENTIRELY below the request — so the reply is hidden
     the instant it passes under the request and only emerges (softly) in the gap
     beneath it. The bottom offset must equal the skirt height in the mask below;
     opaque region = top → (100% − skirt) lands exactly on the request's bottom. */
  bottom: -30px;
  left: -50vw;
  right: -50vw;
  background: var(--ground);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 calc(100% - 30px), transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 calc(100% - 30px), transparent 100%);
  pointer-events: none;
}

/* ── The turn's body stack ─────────────────────────────────────────────────── */
.stack {
  display: flex;
  flex-direction: column;
  gap: 15px;
  align-items: flex-start;
  width: 100%;
}

/* ── Message body ──────────────────────────────────────────────────────────── */
.body {
  margin: 0;
  font-size: 16px;
  line-height: 1.68;
  color: var(--ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* You — a warm, accent-tinted surface (not a flat grey chip); soft, no shadow. */
.body--you {
  text-align: left;
  max-width: 80%;
  padding: 12px 17px;
  border-radius: 18px 18px 6px 18px;
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
/* Queued badge — a follow-up parked behind the running turn. A quiet,
   right-aligned pill in the same ink-tinted language as the footer actions:
   the dot carries the "waiting" note, the number is the place in line. */
.you-queued {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 3px 9px 3px 7px;
  border: 1px solid var(--btn-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.you-queued__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 70%, var(--muted));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
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
  margin-top: 4px;
  width: 100%;
  max-width: 42rem;
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 0.45s ease, transform 0.3s ease;
}
.turn--flash .foot,
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
</style>
