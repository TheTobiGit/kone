<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { formatCount, formatTokens } from "~/utils/usageFormat";
import ModalShell from "~/components/ui/ModalShell.vue";
import { useModalExit } from "~/composables/useModalExit";
import type { AssistantBlock, UserBlock } from "~/composables/agentTypes";
import type { TurnTraceRecord } from "~/types/desktop";
import { desktopBridge } from "~/utils/desktopBridge";
import { TRACE_TONES, type TraceTokenKind } from "~/utils/traceTones";

// A request's trace: what the message sent, opened over the thread
// from the request itself. It grows out of the bubble and shrinks back into
// it, like every card in kone, so the conversation stays put under the scrim.
//
// The card quotes the request, leads with how many tokens it sent, then
// shows where they came from as one proportional bar, itemized beneath it.
// The date and thread sit quietly in the foot band.
// It is the request's trace, so the answer's side (output, reasoning, cost,
// and who answered) stays in the data for the response's trace.
//
// Tokens belong to the turn the request started, not to the words typed: the
// provider bills the whole prompt the turn sent (instructions, history, tool
// results) and reports it once per turn. So the big number is everything the
// message sent, and its own words are noted as the small share they are.

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

async function load(): Promise<void> {
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
}
onMounted(load);
// Opened while the turn was still answering: read again once it settles, so
// the card fills in rather than holding the partial numbers it opened with.
watch(
  () => props.reply?.state,
  (now, was) => {
    if (was === "running" && now !== "running") void load();
  },
);

const input = computed(() => trace.value?.inputTokens ?? 0);
const cacheRead = computed(() => trace.value?.cacheReadTokens ?? 0);
const cacheWrite = computed(() => trace.value?.cacheCreationTokens ?? 0);
const freshInput = computed(() => Math.max(0, input.value - cacheRead.value - cacheWrite.value));
/** The share of what was sent that came back from the cache. */
const cachedShare = computed(() => (input.value ? Math.round((cacheRead.value / input.value) * 100) : 0));

/** The words typed, as tokens: about four characters each. An estimate, and
 *  labelled one — no provider reports a single message's share. */
const ownTokens = computed(() => (props.block.text ? Math.max(1, Math.round(props.block.text.length / 4)) : 0));

// ── where the sent tokens came from: one bar ──────────────────────────────────────────
type Kind = TraceTokenKind;
type Part = { kind: Kind; label: string; tokens: number };
const parts = computed<Part[]>(() =>
  (
    [
      { kind: "cached", label: "From cache", tokens: cacheRead.value },
      { kind: "written", label: "Saved to cache", tokens: cacheWrite.value },
      { kind: "fresh", label: "New input", tokens: freshInput.value },
    ] satisfies Part[]
  ).filter((p) => p.tokens > 0),
);
const partTotal = computed(() => parts.value.reduce((sum, p) => sum + p.tokens, 0));

/** The row under the pointer; the bar dims every other kind. */
const focus = ref<Kind | null>(null);

// ── when ───────────────────────────────────────────────────────────────────
const sentDate = computed(() =>
  new Date(props.block.at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }),
);

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

// ── the palette ─────────────────────────────────────────────────────────────
const { scheme } = useTheme();
const tones = computed(() => {
  const t = TRACE_TONES[scheme.value === "dark" ? "dark" : "light"];
  return {
    "--t-cached": t.cached,
    "--t-written": t.written,
    "--t-fresh": t.fresh,
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
            <!-- The headline: how much the message sent, and how much of it the cache carried. -->
            <div class="tr-figs">
              <div class="fig">
                <span class="fig__v">{{ formatTokens(input) }}</span>
                <span class="fig__k">tokens sent</span>
              </div>
              <div v-if="cacheRead" class="fig">
                <span class="fig__v">{{ cachedShare }}%</span>
                <span class="fig__k">from cache</span>
              </div>
            </div>

            <!-- Where the sent tokens came from: one bar, each kind its share of it. -->
            <section class="tr-sec" aria-label="Where the sent tokens came from">
              <div
                class="bar"
                :class="{ 'bar--focus': focus }"
                role="img"
                :aria-label="parts.map((p) => `${p.label} ${formatCount(p.tokens)}`).join(', ')"
              >
                <i
                  v-for="(p, i) in parts"
                  :key="p.kind"
                  class="seg"
                  :class="[`k--${p.kind}`, { 'is-on': focus === p.kind }]"
                  :style="{ flexGrow: p.tokens, '--i': i }"
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
                  <i class="row__dot" :class="`k--${p.kind}`" aria-hidden="true" />
                  <span class="row__k">{{ p.label }}</span>
                  <span class="row__v">{{ formatCount(p.tokens) }}</span>
                  <span class="row__pct">{{ share(p.tokens) }}</span>
                </li>
              </ul>
              <p v-if="ownTokens" class="tr-own">
                Your words were about <b>{{ formatCount(ownTokens) }}</b> of the {{ formatTokens(input) }} tokens sent.
                The rest is the thread so far, instructions and tool results.
              </p>
            </section>
          </template>
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
  /* Focus rings: enough ink to clear 3:1 against the panel in both schemes. */
  --tr-ring: color-mix(in srgb, var(--ink) 55%, var(--panel));
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
  /* The band is a shade darker than the panel, so its quiet text takes a
     little more ink to keep 4.5:1. */
  --tr-quiet-band: color-mix(in srgb, var(--ink) 70%, var(--band-bg));
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
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--tr-quiet-band);
}
.tr-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-inline-end: -4px;
  border-radius: 8px;
  color: var(--tr-quiet-band);
  cursor: pointer;
  transition: background-color 0.14s ease, color 0.14s ease;
}
@media (hover: hover) {
  .tr-close:hover {
    background: var(--hover);
    color: var(--ink);
  }
}
.tr-close:focus-visible {
  outline: 2px solid var(--tr-ring);
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
.fig__k {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--tr-quiet);
}

.tr-sec { margin-top: 26px; }

/* ── bar ── the turn's tokens as one proportional bar, each kind its tone. */
.bar {
  display: flex;
  gap: 3px;
  height: 10px;
}
.seg {
  min-width: 4px;
  border-radius: 3px;
  background: var(--c);
  transition: opacity 0.2s ease;
}
@media (prefers-reduced-motion: no-preference) {
  .seg {
    transform-origin: left center;
    animation: seg-in 520ms var(--tr-ease) backwards;
    animation-delay: calc(120ms + var(--i, 0) * 60ms);
  }
}
@keyframes seg-in {
  from { transform: scaleX(0); opacity: 0; }
}
.k--cached { --c: var(--t-cached); }
.k--written { --c: var(--t-written); }
.k--fresh { --c: var(--t-fresh); }
.bar--focus .seg:not(.is-on) { opacity: 0.2; }

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
  outline: 2px solid var(--tr-ring);
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
  margin-top: 14px;
  text-wrap: pretty;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--tr-quiet);
}
.tr-own b {
  font-weight: 500;
  color: var(--ink);
}

/* ── foot ── the facts, one quiet line. */
.tr-foot {
  flex-wrap: wrap;
  gap: 2px 14px;
  min-height: 38px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--tr-quiet-band);
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
  .fig__v { font-size: 26px; }
}

@media (prefers-reduced-motion: reduce) {
  .tr.is-in { animation: tr-fade-in 200ms ease-out backwards; }
  .tr.is-out { animation: tr-fade-out var(--modal-exit) ease-out forwards; }
}
@keyframes tr-fade-in {
  from { opacity: 0; }
}
@keyframes tr-fade-out {
  to { opacity: 0; }
}
</style>
