<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Copy01Icon,
  Tick02Icon,
  Note01Icon,
} from "@hugeicons/core-free-icons";
import type { AssistantBlock, ThreadBlock } from "~/composables/useAgent";
import MarkdownMessage from "~/components/MarkdownMessage.vue";
import FileChip from "~/components/FileChip.vue";
import TurnOrb from "~/components/TurnOrb.vue";
import AgentActivity from "~/components/AgentActivity.vue";
import { renderGroups, segText } from "~/utils/conversationSegments";
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
//     item — while active it's a plain step list kept short by a sliding window;
//     once the agent moves on to text the batch folds into a horizontal strip;
//   · a general working orb holds any quiet gap — left-aligned particles that
//     grow longer and denser the longer the wait;
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

// The last "steps" batch of a turn is its *current* activity — it stays active
// for the whole running turn. An earlier batch (already overtaken by streamed
// text) is done and folds into its horizontal strip.
function lastStepsKey(block: AssistantBlock): string | null {
  const groups = renderGroups(block);
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    if (g.kind === "steps") return g.key;
  }
  return null;
}

// ── waiting ───────────────────────────────────────────────────────────────────
// A live turn with nothing currently in flight — the opening gap after send,
// or a lull between one step settling and the next starting. The working orb
// fills it; the activity feed and streaming text take over while those run.
//
// The gap has to be a REAL one. A turn is quiet for a beat between almost every
// pair of items — each text delta and each tool call settles before the next
// starts — so reading the raw "nothing in progress" flag made the orb mount and
// unmount ~38 times across a single reply, adding and removing a 20px row (plus
// the stack's 15px gap) each time. That is what made a streaming answer shudder.
// So: the turn must be quiet for QUIET_MS before the orb appears, and any new
// activity hides it immediately. Sub-second gaps now pass in silence.
const QUIET_MS = 700;
const waiting = reactive<Record<string, boolean>>({});
const quietTimers = new Map<string, number>();

function nothingInFlight(block: AssistantBlock): boolean {
  if (block.state !== "running") return false;
  const last = block.items[block.items.length - 1];
  return !last || last.status !== "in-progress";
}

function armQuiet(id: string) {
  quietTimers.set(
    id,
    window.setTimeout(() => {
      quietTimers.delete(id);
      const cur = props.blocks.find((b) => b.id === id);
      if (cur && cur.role === "assistant" && nothingInFlight(cur)) waiting[id] = true;
    }, QUIET_MS),
  );
}

watch(
  () =>
    props.blocks
      .map((b) =>
        b.role === "assistant"
          ? `${b.id}:${b.state}:${b.items.length}:${b.items[b.items.length - 1]?.status ?? ""}`
          : b.id,
      )
      .join("|"),
  () => {
    for (const b of props.blocks) {
      if (b.role !== "assistant") continue;
      if (!nothingInFlight(b)) {
        const t = quietTimers.get(b.id);
        if (t) {
          window.clearTimeout(t);
          quietTimers.delete(b.id);
        }
        waiting[b.id] = false;
        continue;
      }
      // Already showing, or already counting down — don't restart the clock.
      if (waiting[b.id] || quietTimers.has(b.id)) continue;
      if (import.meta.client) armQuiet(b.id);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  for (const t of quietTimers.values()) window.clearTimeout(t);
  quietTimers.clear();
});

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
// Follow the tail, calmly. The old version fired `scrollTo({behavior:"smooth"})`
// on every streamed chunk; each call RESTARTS the browser's easing curve toward
// a target that has already moved, so the scroller never settles into a steady
// rate — it crawled 1px some frames and lurched 37px on others. That uneven
// velocity is felt as the reply shaking, not scrolling.
//
// Instead: coalesce every update in the frame into one rAF, and pin the bottom
// instantly while a turn is streaming. Content grows a line at a time, so an
// instant pin *is* smooth — each new line slides the ones above it up by exactly
// its own height, once, with no easing to fight. A brand-new turn (the block
// count changed) still animates, because that's a real jump, not a follow.
let scrollQueued = false;
let lastCount = props.blocks.length;
watch(tailSignature, () => {
  if (!import.meta.client || scrollQueued) return;
  scrollQueued = true;
  const newTurn = props.blocks.length !== lastCount;
  lastCount = props.blocks.length;
  requestAnimationFrame(() => {
    scrollQueued = false;
    const sc = scroller();
    if (!sc) return;
    const gap = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    if (gap > 260) return; // scrolled away to read — don't yank them back
    if (gap <= 1) return; // already pinned
    if (newTurn) sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
    else sc.scrollTop = sc.scrollHeight;
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
const hasBlocks = computed(() => props.blocks.length > 0);
</script>

<template>
  <div ref="root" class="thread" :class="{ 'thread--empty': !hasBlocks }">
    <p v-if="sessionError" class="body body--error thread__error">{{ sessionError }}</p>

    <!-- Background generative art in the empty state -->
    <CodeGolfArt v-if="!hasBlocks" class="thread__art" />

    <div v-if="!hasBlocks" class="empty relative z-10 sr-only">
      <p>Nothing here yet — say something to begin.</p>
    </div>

    <motion.div
      v-for="block in blocks"
      :key="block.id"
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
          <template v-for="grp in renderGroups(block)" :key="grp.kind === 'text' ? grp.seg.key : grp.key">
            <!-- Steps — one batch of thinking + tool calls, inline. While active
                 it shows a sliding window (≤5 full rows + a horizontal strip of
                 older icons); once the agent moves on to text the whole batch
                 folds into the strip. -->
            <AgentActivity
              v-if="grp.kind === 'steps'"
              :segments="grp.segments"
              :running="block.state === 'running'"
              :is-tail="grp.key === lastStepsKey(block)"
              :historical="block.historical"
            />

            <!-- Text — rendered as rich Markdown the whole way through, streaming
                 or settled, so the reply reads as a proper preview as it grows
                 (never a raw block that only formats once complete). -->
            <div
              v-else
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

          <!-- Working orb — visible while the turn is alive but nothing is
               streaming (request just sent, or a quiet gap between steps). -->
          <AnimatePresence>
            <motion.div
              v-if="waiting[block.id]"
              class="waiting"
              :initial="{ opacity: 0, scale: 0.86 }"
              :animate="{ opacity: 1, scale: 1 }"
              :exit="{ opacity: 0, scale: 0.86 }"
              :transition="{ type: 'spring', stiffness: 300, damping: 26, mass: 0.7 }"
            >
              <TurnOrb state="working" :size="20" aria-label="Working" />
            </motion.div>
          </AnimatePresence>

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

.turn {
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

/* ── Waiting orb ───────────────────────────────────────────────────────────── */
.waiting {
  display: flex;
  align-items: center;
  margin: -2px 0;
  will-change: transform, opacity;
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
