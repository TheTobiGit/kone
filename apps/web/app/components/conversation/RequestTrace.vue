<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { formatCount, formatTokens, formatUsd } from "~/utils/usageFormat";
import ModalShell from "~/components/ui/ModalShell.vue";
import { useModalExit } from "~/composables/useModalExit";
import type { AssistantBlock, UserBlock } from "~/composables/agentTypes";
import type { TurnTraceRecord } from "~/types/desktop";
import { desktopBridge } from "~/utils/desktopBridge";

// A request's trace: what it cost and what carried it, opened over the thread
// from the request itself. It grows out of the bubble and shrinks back into
// it, like every card in kone, so the conversation stays put under the scrim.
//
// The card leads with the turn's size and price, then pictures: a grid of a
// hundred cells for where the tokens went, itemized beneath it, and a track
// for how the time was spent. The date and thread sit quietly in the foot band.
// It is the request's trace, so who answered (model, provider, effort) stays
// in the data for the response's trace and isn't drawn here.
//
// Tokens belong to the turn the request started, not to the words typed: the
// provider bills the whole prompt the turn sent (instructions, history, tool
// results) and reports it once per turn. So the big number is the turn's, and
// the request's own words are marked in the grid as the small share they are.

const props = defineProps<{
  block: UserBlock;
  /** The reply this request started (or was steered into), when there is one. */
  reply: AssistantBlock | undefined;
  /** The thread's durable id; null on a column that has never sent. */
  threadId: string | null;
  threadTitle: string;
  /** The bubble's viewport rect — the grow's origin. */
  origin: DOMRect | null;
}>();

const emit = defineEmits<{
  /** Its exit has finished; unmount it now. */
  close: [];
}>();

// ── the turn's numbers ──────────────────────────────────────────────────────
const trace = ref<TurnTraceRecord | null>(null);
const loading = ref(true);

onMounted(async () => {
  const turnId = props.reply?.turnId;
  const read = desktopBridge()?.agent.history?.turnTraces;
  if (!turnId || !props.threadId || !read) {
    loading.value = false;
    return;
  }
  try {
    const rows = await read(props.threadId);
    trace.value = rows.find((r) => r.turnId === turnId) ?? null;
  } catch {
    // An unread trace says so below; the facts that don't need it still show.
  }
  loading.value = false;
});

const input = computed(() => trace.value?.inputTokens ?? 0);
const output = computed(() => trace.value?.outputTokens ?? 0);
const cacheRead = computed(() => trace.value?.cacheReadTokens ?? 0);
const cacheWrite = computed(() => trace.value?.cacheCreationTokens ?? 0);
const freshInput = computed(() => Math.max(0, input.value - cacheRead.value - cacheWrite.value));
const reasoning = computed(() => Math.min(trace.value?.reasoningTokens ?? 0, output.value));
const total = computed(() => trace.value?.totalTokens ?? input.value + output.value);

/** The words typed, as tokens: about four characters each. An estimate, and
 *  labelled one — no provider reports a single message's share. */
const ownTokens = computed(() => Math.max(1, Math.round(props.block.text.length / 4)));

// ── where the tokens went: a hundred cells ──────────────────────────────────
type Kind = "cached" | "written" | "fresh" | "output" | "reasoning";
type Part = { kind: Kind; label: string; tokens: number };
const parts = computed<Part[]>(() =>
  (
    [
      { kind: "cached", label: "From cache", tokens: cacheRead.value },
      { kind: "written", label: "Saved to cache", tokens: cacheWrite.value },
      { kind: "fresh", label: "New input", tokens: freshInput.value },
      { kind: "output", label: "Output", tokens: output.value - reasoning.value },
      { kind: "reasoning", label: "Reasoning", tokens: reasoning.value },
    ] satisfies Part[]
  ).filter((p) => p.tokens > 0),
);
const partTotal = computed(() => parts.value.reduce((sum, p) => sum + p.tokens, 0));

const CELLS = 100;
/** Each part's share of the hundred cells, by largest remainder, with every
 *  part that has tokens keeping at least one cell so nothing real vanishes. */
const cells = computed<Kind[]>(() => {
  const sum = partTotal.value;
  if (!sum) return [];
  const raw = parts.value.map((p) => (p.tokens / sum) * CELLS);
  const counts = raw.map((r) => Math.max(1, Math.floor(r)));
  let left = CELLS - counts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left -= 1) counts[order[k]!.i]! += 1;
  for (let k = order.length - 1; left < 0; k = (k - 1 + order.length) % order.length) {
    const i = order[k]!.i;
    if (counts[i]! > 1) {
      counts[i]! -= 1;
      left += 1;
    }
  }
  return parts.value.flatMap((p, i) => Array.from({ length: counts[i]! }, () => p.kind));
});
/** The cell that stands for the words typed: the first cell of new input,
 *  where a request's text lands in the prompt. */
const ownCell = computed(() => cells.value.indexOf("fresh"));

/** The row under the pointer; the grid dims every other kind. */
const focus = ref<Kind | null>(null);

// ── how the time went: a track ──────────────────────────────────────────────
const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const sentDate = computed(() =>
  new Date(props.block.at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }),
);

/** How long the request sat in the queue before its turn started. Under a
 *  second is the send itself, not a wait. */
const waitMs = computed(() => {
  if (!props.reply || props.block.steered) return 0;
  const ms = props.reply.at - props.block.at;
  return ms >= 1000 ? ms : 0;
});
const workMs = computed(() => {
  const r = props.reply;
  if (!r) return 0;
  return Math.max(0, (r.endedAt ?? Date.now()) - Math.max(r.at, props.block.at));
});

const outcome = computed(() => {
  const r = props.reply;
  if (!r) return { label: "Not started", tone: "idle" };
  if (r.state === "running") return { label: "Answering", tone: "live" };
  if (r.state === "failed") return { label: "Failed", tone: "bad" };
  if (r.state === "interrupted") return { label: "Stopped", tone: "idle" };
  return { label: "Answered", tone: "ok" };
});

const attachments = computed(() => props.block.attachments?.length ?? 0);
const skills = computed(() => props.block.skills?.map((s) => s.name) ?? []);

/** Why there are no numbers, when there are none. */
const missing = computed(() => {
  if (loading.value || trace.value) return null;
  if (!props.reply) return "This request hasn't started a turn yet.";
  if (props.reply.state === "running") return "Still answering. The tokens land when the turn settles.";
  return "The provider didn't report usage for this turn.";
});

function share(tokens: number): string {
  const pct = partTotal.value ? (tokens / partTotal.value) * 100 : 0;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── the palette ─────────────────────────────────────────────────────────────
// Five token kinds, one hue each, validated against the card's own surface in
// both schemes (CVD separation and lightness band), so they are steps of the
// same five hues rather than a flip.
const { scheme } = useTheme();
const TONES = {
  light: { cached: "#2a9d8f", written: "#d9952b", fresh: "#3f6fd1", output: "#d97757", reasoning: "#8a63d2" },
  dark: { cached: "#21a08f", written: "#bd801c", fresh: "#5580e0", output: "#d8704f", reasoning: "#9277e0" },
} satisfies Record<"light" | "dark", Record<Kind, string>>;
const tones = computed(() => {
  const t = TONES[scheme.value === "dark" ? "dark" : "light"];
  return {
    "--t-cached": t.cached,
    "--t-written": t.written,
    "--t-fresh": t.fresh,
    "--t-output": t.output,
    "--t-reasoning": t.reasoning,
  };
});

// ── open and close ──────────────────────────────────────────────────────────
const cardEl = ref<HTMLElement | null>(null);
const closeEl = ref<HTMLButtonElement | null>(null);
const originVars = ref<Record<string, string>>({});
const { shown, dismiss } = useModalExit();
function onClose(): void {
  dismiss(() => emit("close"));
}

// The thread answers Escape too. Taken in the capture phase and consumed, so
// one press closes this card and nothing behind it.
function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  onClose();
}

// Keep Tab inside the card — it's modal.
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const items = [...(cardEl.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
  if (items.length <= 1) {
    e.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

let opener: HTMLElement | null = null;
onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener("keydown", onEscape, { capture: true });
  // The card is centred by the overlay, so its place is only known once it is
  // laid out: measure it, then aim the grow at the bubble from there.
  const card = cardEl.value?.getBoundingClientRect();
  const from = props.origin;
  if (card && from) {
    originVars.value = {
      "--ox": `${from.left + from.width / 2 - card.left}px`,
      "--oy": `${from.top + from.height / 2 - card.top}px`,
    };
  }
  requestAnimationFrame(() => (shown.value = true));
  closeEl.value?.focus();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onEscape, { capture: true });
  if (opener?.isConnected) opener.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <ModalShell v-slot="{ card }" :shown="shown" class="z-50" @dismiss="onClose">
      <div
        ref="cardEl"
        v-bind="card"
        class="tr"
        :style="[originVars, tones]"
        role="dialog"
        aria-modal="true"
        aria-label="Request trace"
        @keydown="onKeydown"
      >
        <!-- Header band: what this card is, and close. -->
        <div class="tr-band tr-head">
          <span class="tr-eyebrow">Request trace</span>
          <button ref="closeEl" type="button" class="tr-close" aria-label="Close trace" title="Close (Esc)" @click="onClose">
            <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" />
          </button>
        </div>

        <div class="tr-body">
          <p class="tr-quote selectable">{{ block.text || "Attachment" }}</p>
          <p v-if="block.steered" class="tr-aside">
            Sent while the agent was working. It joined that turn, so these are that turn's numbers.
          </p>

          <div v-if="loading" class="tr-skeleton" aria-hidden="true">
            <i /><i /><i />
          </div>

          <p v-else-if="missing" class="tr-empty">{{ missing }}</p>

          <template v-else-if="trace">
            <!-- The headline: the turn's size, price, and what went each way. -->
            <div class="tr-figs">
              <div class="fig">
                <span class="fig__v">{{ formatTokens(total) }}</span>
                <span class="fig__k">tokens</span>
              </div>
              <div v-if="trace.costUsd !== null" class="fig">
                <span class="fig__v">{{ formatUsd(trace.costUsd) }}</span>
                <span class="fig__k">cost</span>
              </div>
              <div class="fig">
                <span class="fig__v">{{ formatTokens(input) }}<span class="fig__sep">/</span>{{ formatTokens(output) }}</span>
                <span class="fig__k">in / out</span>
              </div>
            </div>

            <!-- Where the tokens went: one cell per percent. -->
            <section class="tr-sec" aria-labelledby="tr-where">
              <h3 id="tr-where" class="tr-sec__h">Where the tokens went</h3>
              <div
                class="waffle"
                :class="{ 'waffle--focus': focus }"
                role="img"
                :aria-label="parts.map((p) => `${p.label} ${formatCount(p.tokens)}`).join(', ')"
              >
                <i
                  v-for="(kind, i) in cells"
                  :key="i"
                  class="cell"
                  :class="[`cell--${kind}`, { 'cell--on': focus === kind, 'cell--own': i === ownCell }]"
                  :style="{ '--i': i }"
                />
              </div>
              <ul class="rows">
                <li
                  v-for="p in parts"
                  :key="p.kind"
                  class="row"
                  tabindex="0"
                  @mouseenter="focus = p.kind"
                  @mouseleave="focus = null"
                  @focus="focus = p.kind"
                  @blur="focus = null"
                >
                  <i class="row__dot" :class="`cell--${p.kind}`" />
                  <span class="row__k">{{ p.label }}</span>
                  <span class="row__v">{{ formatCount(p.tokens) }}</span>
                  <span class="row__pct">{{ share(p.tokens) }}</span>
                </li>
              </ul>
              <p class="tr-own">
                <i v-if="ownCell >= 0" class="tr-own__mark" aria-hidden="true" />
                <span>
                  Your words were about <b>{{ formatCount(ownTokens) }}</b> of the {{ formatTokens(input) }} tokens
                  sent<template v-if="ownCell >= 0">, the ringed cell</template>. The rest is the thread so far,
                  instructions and tool results.
                </span>
              </p>
            </section>
          </template>

          <!-- How the time went. Shown with or without numbers: it needs none. -->
          <section v-if="!loading" class="tr-sec" aria-labelledby="tr-time">
            <h3 id="tr-time" class="tr-sec__h">How the time went</h3>
            <div class="track">
              <div class="track__stop">
                <i class="track__dot" />
                <span class="track__k">Sent</span>
                <span class="track__v">{{ clock(block.at) }}</span>
              </div>
              <div v-if="waitMs" class="track__leg track__leg--wait" :style="{ flexGrow: Math.max(1, Math.sqrt(waitMs)) }">
                <span class="track__line" />
                <span class="track__d">queued {{ duration(waitMs) }}</span>
              </div>
              <div
                v-if="reply"
                class="track__leg track__leg--work"
                :class="{ 'is-live': reply.state === 'running' }"
                :style="{ flexGrow: Math.max(1, Math.sqrt(workMs)) }"
              >
                <span class="track__line" />
                <span class="track__d">{{ reply.state === "running" ? "working" : "worked" }} {{ duration(workMs) }}</span>
              </div>
              <div class="track__stop track__stop--end">
                <i class="track__dot" :class="`track__dot--${outcome.tone}`" />
                <span class="track__k">{{ outcome.label }}</span>
                <span v-if="reply?.endedAt" class="track__v">{{ clock(reply.endedAt) }}</span>
              </div>
            </div>
          </section>
        </div>

        <!-- Foot band: when and where, quiet. -->
        <div class="tr-band tr-foot">
          <span class="fact">{{ sentDate }}</span>
          <span class="fact fact--thread">{{ threadTitle || "Untitled thread" }}</span>
          <span v-if="attachments" class="fact">{{ attachments }} file{{ attachments === 1 ? "" : "s" }}</span>
          <span v-if="skills.length" class="fact">{{ skills.join(", ") }}</span>
        </div>
      </div>
    </ModalShell>
  </Teleport>
</template>

<style scoped>
/* The card: kone's modal shell — the panel fill, the 18px radius and a hairline
   ring, with only a breath of shadow under it. */
.tr {
  --tr-ease: cubic-bezier(0.22, 1, 0.36, 1);
  /* Quiet text: --muted is too faint to read at 11px on the panel, so labels
     here mix ink into it until it clears 4.5:1. */
  --tr-quiet: color-mix(in srgb, var(--ink) 64%, var(--panel));
  position: relative;
  z-index: 1;
  width: min(620px, calc(100% - 32px));
  max-height: calc(100% - 40px);
  margin: auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 18px;
  background: var(--panel);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 10px 30px -18px color-mix(in srgb, var(--ink) 12%, transparent);
}
/* Grow out of the request, and shrink back into it. */
.tr.is-in {
  animation: tr-grow 420ms cubic-bezier(0.34, 1.2, 0.64, 1) backwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
.tr.is-out {
  animation: tr-shrink var(--modal-exit) cubic-bezier(0.4, 0, 0.9, 1) forwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
@keyframes tr-grow {
  from { opacity: 0.35; transform: scale(0.2); }
  60% { opacity: 1; }
}
@keyframes tr-shrink {
  to { opacity: 0; transform: scale(0.2); }
}

/* ── bands ── the scooped recessed head and foot every kone modal wears. */
.tr-band {
  --band-bg: var(--band);
  --band-arc: 14px;
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  padding: 10px 16px;
  background-color: var(--band-bg);
}
.tr-band::before,
.tr-band::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.tr-head::before,
.tr-head::after { top: 100%; }
.tr-head::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.tr-head::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}
.tr-foot::before,
.tr-foot::after { bottom: 100%; }
.tr-foot::before {
  left: 0;
  background: radial-gradient(circle at top right, transparent var(--band-arc), var(--band-bg) 0);
}
.tr-foot::after {
  right: 0;
  background: radial-gradient(circle at top left, transparent var(--band-arc), var(--band-bg) 0);
}
.tr-eyebrow {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--tr-quiet);
}
.tr-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-inline-end: -4px;
  border-radius: 8px;
  color: var(--tr-quiet);
  cursor: pointer;
  transition: background-color 0.14s ease, color 0.14s ease;
}
.tr-close:hover {
  background: var(--hover);
  color: var(--ink);
}
.tr-close:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 30%, transparent);
  outline-offset: 1px;
}

/* ── body ─────────────────────────────────────────────────────────────────── */
.tr-body {
  min-height: 0;
  overflow-y: auto;
  padding: 22px 26px 26px;
  overscroll-behavior: contain;
  scrollbar-width: none;
}
.tr-quote {
  /* A long request scrolls in place rather than losing its end. */
  max-height: calc(14.5px * 1.55 * 4);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-inline-start: 14px;
  border-inline-start: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
  font-size: 14.5px;
  line-height: 1.55;
  color: var(--ink);
  white-space: pre-wrap;
  text-wrap: pretty;
}
.tr-aside {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--tr-quiet);
}
.tr-empty {
  margin-top: 22px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--tr-quiet);
}

.tr-figs {
  display: flex;
  flex-wrap: wrap;
  gap: 14px 40px;
  margin-top: 24px;
}
.fig { display: flex; flex-direction: column; gap: 6px; }
.fig__v {
  font-size: 30px;
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.fig__sep {
  margin-inline: 2px;
  color: var(--faint);
}
.fig__k,
.tr-sec__h {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--tr-quiet);
}

.tr-sec { margin-top: 28px; }
.tr-sec__h { margin-bottom: 12px; }

/* ── waffle ── a hundred cells, each a percent of the turn, filled in order
   so the kinds read as runs. */
.waffle {
  display: grid;
  grid-template-columns: repeat(25, minmax(0, 1fr));
  gap: 3px;
}
.cell {
  aspect-ratio: 1;
  border-radius: 3px;
  background: var(--c);
  animation: cell-in 380ms var(--tr-ease) backwards;
  animation-delay: calc(80ms + var(--i, 0) * 6ms);
  transition: opacity 0.2s ease, transform 0.2s var(--tr-ease);
}
@keyframes cell-in {
  from { opacity: 0; transform: scale(0.4); }
}
.cell--cached { --c: var(--t-cached); }
.cell--written { --c: var(--t-written); }
.cell--fresh { --c: var(--t-fresh); }
.cell--output { --c: var(--t-output); }
.cell--reasoning { --c: var(--t-reasoning); }
.waffle--focus .cell:not(.cell--on) { opacity: 0.18; }
.waffle--focus .cell--on { transform: scale(1.08); }
/* The words typed: one cell, ringed. */
.cell--own {
  box-shadow:
    0 0 0 2px var(--panel),
    0 0 0 3.5px var(--ink);
}

.rows {
  display: flex;
  flex-direction: column;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}
.row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto 3.4em;
  align-items: center;
  gap: 10px;
  min-height: 30px;
  padding-inline: 8px;
  margin-inline: -8px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--ink-soft);
  cursor: default;
  transition: background-color 0.15s ease;
}
@media (hover: hover) {
  .row:hover { background: var(--hover); }
}
.row:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 30%, transparent);
  outline-offset: 1px;
  background: var(--hover);
}
.row__dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--c);
}
.row__v,
.row__pct {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-align: end;
}
.row__v { color: var(--ink); }
.row__pct { color: var(--tr-quiet); }
.tr-own {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 14px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--tr-quiet);
}
.tr-own b {
  font-weight: 500;
  color: var(--ink);
}
.tr-own__mark {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  transform: translateY(-1px);
  background: var(--t-fresh);
  box-shadow:
    0 0 0 1.5px var(--panel),
    0 0 0 2.5px var(--ink);
}

/* ── track ── sent, queued, worked, settled. */
.track {
  display: flex;
  align-items: flex-start;
}
.track__stop {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}
.track__stop--end { align-items: flex-end; }
.track__dot {
  width: 9px;
  height: 9px;
  margin-bottom: 5px;
  border-radius: 50%;
  background: var(--ink-soft);
}
.track__dot--ok { background: var(--ok); }
.track__dot--bad { background: var(--danger); }
.track__dot--idle { background: var(--tr-quiet); }
.track__dot--live {
  background: var(--accent);
  animation: live 1.4s ease-in-out infinite;
}
@keyframes live {
  50% { opacity: 0.35; }
}
.track__k {
  font-size: 12px;
  color: var(--ink-soft);
}
.track__v {
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--tr-quiet);
}
.track__leg {
  flex: 1 1 0;
  min-width: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 3px 6px 0;
}
.track__line {
  width: 100%;
  height: 3px;
  border-radius: 2px;
  background: var(--ink-soft);
  transform-origin: left center;
  animation: line-in 520ms var(--tr-ease) backwards 260ms;
}
@keyframes line-in {
  from { transform: scaleX(0); }
}
.track__leg--wait .track__line {
  background: repeating-linear-gradient(
    90deg,
    var(--faint) 0 5px,
    transparent 5px 9px
  );
}
.track__leg--work .track__line { background: var(--t-output); }
.track__leg--work.is-live .track__line {
  background: linear-gradient(90deg, var(--t-output), color-mix(in srgb, var(--t-output) 25%, transparent));
}
.track__d {
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--tr-quiet);
  white-space: nowrap;
}

/* ── foot ── the facts, one quiet line. */
.tr-foot {
  flex-wrap: wrap;
  gap: 2px 14px;
  min-height: 38px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--tr-quiet);
}
.fact {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.fact--thread {
  white-space: normal;
  overflow-wrap: anywhere;
  color: var(--ink-soft);
}
.tr-skeleton {
  display: grid;
  gap: 10px;
  margin-top: 20px;
}
.tr-skeleton i {
  height: 12px;
  border-radius: 4px;
  background: var(--hover);
}
.tr-skeleton i:nth-child(1) { width: 34%; height: 36px; }
.tr-skeleton i:nth-child(2) { height: 64px; }
.tr-skeleton i:nth-child(3) { width: 70%; }

@media (max-width: 520px) {
  .tr-body { padding: 18px 18px 22px; }
  .waffle { grid-template-columns: repeat(20, minmax(0, 1fr)); }
  .fig__v { font-size: 26px; }
}

@media (prefers-reduced-motion: reduce) {
  .tr.is-in,
  .tr.is-out { animation-duration: 0.01s; }
  .cell,
  .track__line,
  .track__dot--live { animation: none; }
  .waffle--focus .cell--on { transform: none; }
}
</style>
