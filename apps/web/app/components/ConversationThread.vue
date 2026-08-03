<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Copy01Icon,
  Tick02Icon,
  Note01Icon,
} from "@hugeicons/core-free-icons";
import type { AssistantBlock, ThreadBlock } from "~/composables/useAgent";
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
}>();

const emit = defineEmits<{
  "to-scratchpad": [text: string];
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
let scrollQueued = false;
let anchoredUserId: string | null = null;
let anchorAt = 0;

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

watch(tailSignature, () => {
  if (!import.meta.client || scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    const sc = scroller();
    if (!sc) return;
    const lu = lastUserBlock();

    // A brand-new request — lift it to the top with a screen of room below.
    if (lu && lu.id !== anchoredUserId) {
      anchoredUserId = lu.id;
      const last = props.blocks[props.blocks.length - 1];
      const live =
        last?.role === "user" ||
        (last?.role === "assistant" && last.state === "running");
      if (!live) return; // opening a settled thread — adopt the id, don't yank
      anchorAt = performance.now();
      tailSpacer.value = sc.clientHeight; // reserve first, so the row can reach the top
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
      tailSpacer.value = needed;
      return;
    }
    // Reply outgrew the screen — release the reserve and calmly follow the tail.
    tailSpacer.value = 0;
    const gap = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    if (gap > 260) return; // scrolled away to read — don't yank them back
    if (gap <= 1) return; // already pinned
    sc.scrollTop = sc.scrollHeight;
  });
});
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
let scrollHost: HTMLElement | null = null;
onMounted(() => {
  scrollHost = scroller();
  scrollHost?.addEventListener("scroll", queueStuck, { passive: true });
  queueStuck();
});
onBeforeUnmount(() => scrollHost?.removeEventListener("scroll", queueStuck));
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
</script>

<template>
  <div ref="root" class="thread" :class="{ 'thread--empty': !hasBlocks }">
    <p v-if="sessionError" class="body body--error thread__error">{{ sessionError }}</p>

    <!-- Background generative art in the empty state -->
    <CodeGolfArt v-if="!hasBlocks" class="thread__art" />

    <div v-if="!hasBlocks" class="empty relative z-10 sr-only">
      <p>Nothing here yet — say something to begin.</p>
    </div>

    <!-- One request + its response form an "exchange" — the sticky containing
         block for the request. Grouping this way is what lets each new request
         push the previous one up and out of the sticky spot, instead of two
         sticky headers piling on top of each other. -->
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
         <div v-if="block.text" class="body body--you selectable" :class="{ 'body--you-expanded': expandedUserRequests[block.id] }">
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
        <div v-if="block.text" class="you-foot">
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

          <!-- Failure note. -->
          <p v-if="block.state === 'failed' && block.error" class="body body--error">
            {{ block.error }}
          </p>

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
  bottom: -6px;
  left: -50vw;
  right: -50vw;
  background: linear-gradient(
    to bottom,
    var(--ground) 0%,
    var(--ground) calc(100% - 26px),
    transparent 100%
  );
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 calc(100% - 26px), transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 calc(100% - 26px), transparent 100%);
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
.body--error {
  color: var(--diff-del);
  font-size: 14px;
  line-height: 1.55;
}
.thread__error {
  align-self: stretch;
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
