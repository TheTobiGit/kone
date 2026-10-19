<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";
import { formatCount, formatTokens, formatUsd } from "~/utils/usageFormat";
import ModalShell from "~/components/ui/ModalShell.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import { useModalExit } from "~/composables/useModalExit";
import { useAgentProviders } from "~/composables/useAgentProviders";
import type { AssistantBlock, UserBlock } from "~/composables/agentTypes";
import type { TurnTraceRecord } from "~/types/desktop";
import { desktopBridge } from "~/utils/desktopBridge";
import { buildModelCatalog, describeModelId, effortMeta } from "~/utils/modelCatalog";
import { PROVIDER_LABEL, asProviderKind } from "~/utils/usageProviders";

// A request's trace: what it cost and what carried it, opened over the thread
// from the request itself. It grows out of the bubble and shrinks back into
// it, like every card in kone, so the conversation stays put under the scrim.
//
// Tokens belong to the turn the request started, not to the words typed: the
// provider bills the whole prompt the turn sent (instructions, history, tool
// results) and reports it once per turn. So the big number is the turn's, and
// the request's own words are named beside it as the small share they are.

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

type Part = { key: string; label: string; tokens: number; tone: string };
const parts = computed<Part[]>(() =>
  [
    { key: "cached", label: "Read from cache", tokens: cacheRead.value, tone: "cached" },
    { key: "written", label: "Written to cache", tokens: cacheWrite.value, tone: "written" },
    { key: "fresh", label: "New input", tokens: freshInput.value, tone: "fresh" },
    { key: "output", label: "Output", tokens: output.value - reasoning.value, tone: "output" },
    { key: "reasoning", label: "Reasoning", tokens: reasoning.value, tone: "reasoning" },
  ].filter((p) => p.tokens > 0),
);
const barTotal = computed(() => parts.value.reduce((sum, p) => sum + p.tokens, 0));

// ── who answered ────────────────────────────────────────────────────────────
const { modelCache } = useAgentProviders();
const catalog = computed(() => buildModelCatalog(Object.values(modelCache.value).flat()));
/** The model the request was sent with wins over the usage row's: the stamp is
 *  what the picker held at send time, the row may only know the thread's. */
const model = computed(() => {
  const id = props.block.model ?? trace.value?.model ?? undefined;
  return id ? describeModelId(id, catalog.value) : null;
});
const providerName = computed(() => {
  const raw = trace.value?.provider ?? undefined;
  // The store names Claude's engine `claude`; the app calls it `claudeAgent`.
  const kind = asProviderKind(raw === "claude" ? "claudeAgent" : raw);
  return kind ? PROVIDER_LABEL[kind] : (raw ?? null);
});
const effort = computed(() => (props.block.effort ? effortMeta(props.block.effort) : null));

// ── when, and what happened ─────────────────────────────────────────────────
const sentDate = computed(() =>
  new Date(props.block.at).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }),
);
const sentTime = computed(() =>
  new Date(props.block.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
);

/** How long the request sat in the queue before its turn started. Under a
 *  second is the send itself, not a wait. */
const waited = computed(() => {
  if (!props.reply || props.block.steered) return null;
  const ms = props.reply.at - props.block.at;
  return ms >= 1000 ? duration(ms) : null;
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
  if (props.reply.state === "running") return "The turn is still running. Its tokens land when it settles.";
  return "The provider didn't report usage for this turn.";
});

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── open and close ──────────────────────────────────────────────────────────
const cardEl = ref<HTMLElement | null>(null);
const backEl = ref<HTMLButtonElement | null>(null);
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
  backEl.value?.focus();
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
        :style="originVars"
        role="dialog"
        aria-modal="true"
        aria-label="Request trace"
        @keydown="onKeydown"
      >
        <header class="tr__bar">
          <button ref="backEl" type="button" class="tr__back" aria-label="Back to the thread" @click="onClose">
            <HugeiconsIcon class="tr__back-glyph" :icon="ArrowTurnBackwardIcon" :size="18" :stroke-width="2" />
          </button>
          <span class="tr__crumb">
            <span class="tr__dim">trace</span>
            <span>request</span>
          </span>
        </header>

        <div class="tr__body">
          <!-- Left: the request and what it cost. -->
          <div class="tr__main">
            <p class="tr__quote selectable">{{ block.text || "Attachment" }}</p>
            <p v-if="block.steered" class="tr__aside">
              Sent while the agent was working. It joined that turn, so these are that turn's numbers.
            </p>

            <div v-if="loading" class="tr__skeleton" aria-hidden="true">
              <i /><i /><i />
            </div>

            <p v-else-if="missing" class="tr__empty">{{ missing }}</p>

            <template v-else-if="trace">
              <div class="tr__figures">
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

              <div
                class="tr__bar-chart"
                role="img"
                :aria-label="parts.map((p) => `${p.label} ${formatCount(p.tokens)}`).join(', ')"
              >
                <span
                  v-for="(p, i) in parts"
                  :key="p.key"
                  class="seg"
                  :class="`seg--${p.tone}`"
                  :style="{ flexGrow: p.tokens, '--i': i }"
                />
              </div>

              <ul class="tr__legend">
                <li v-for="p in parts" :key="p.key" class="leg">
                  <i class="leg__dot" :class="`seg--${p.tone}`" />
                  <span class="leg__k">{{ p.label }}</span>
                  <span class="leg__v">{{ formatCount(p.tokens) }}</span>
                  <span class="leg__pct">{{ Math.round((p.tokens / barTotal) * 100) }}%</span>
                </li>
              </ul>

              <p class="tr__own">
                Your words were about <b>{{ formatTokens(ownTokens) }}</b> of the
                {{ formatTokens(input) }} tokens sent. The rest is the thread so far, instructions and tool results.
              </p>
            </template>
          </div>

          <!-- Right: the facts, read top-down. -->
          <aside class="tr__meta">
            <div class="meta">
              <span class="meta__k">Sent</span>
              <span class="meta__v meta__v--ink">{{ sentDate }}</span>
              <span class="meta__v">{{ sentTime }}</span>
            </div>
            <div class="meta">
              <span class="meta__k">Thread</span>
              <span class="meta__v meta__v--ink">{{ threadTitle || "Untitled thread" }}</span>
            </div>
            <div v-if="model" class="meta">
              <span class="meta__k">Model</span>
              <span class="meta__v meta__v--ink meta__model">
                <ProviderLogo :brand="model.brand" :size="13" />
                {{ model.name }}
              </span>
              <span v-if="providerName" class="meta__v">via {{ providerName }}</span>
            </div>
            <div v-if="effort" class="meta">
              <span class="meta__k">Effort</span>
              <span class="meta__v meta__effort">
                <i class="meta__dot" :style="{ background: effort.hue }" />
                {{ effort.label }}
              </span>
            </div>
            <div class="meta">
              <span class="meta__k">Outcome</span>
              <span class="meta__v meta__effort">
                <i class="meta__dot" :class="`meta__dot--${outcome.tone}`" />
                {{ outcome.label }}
              </span>
            </div>
            <div v-if="waited" class="meta">
              <span class="meta__k">Queued</span>
              <span class="meta__v">{{ waited }}</span>
            </div>
            <div v-if="attachments" class="meta">
              <span class="meta__k">Attached</span>
              <span class="meta__v">{{ attachments }} file{{ attachments === 1 ? "" : "s" }}</span>
            </div>
            <div v-if="skills.length" class="meta">
              <span class="meta__k">Skills</span>
              <span class="meta__v">{{ skills.join(", ") }}</span>
            </div>
          </aside>
        </div>
      </div>
    </ModalShell>
  </Teleport>
</template>

<style scoped>
.tr {
  --tr-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --tone-cached: color-mix(in srgb, var(--ink) 22%, transparent);
  --tone-written: color-mix(in oklab, var(--accent) 45%, var(--ground));
  --tone-fresh: color-mix(in srgb, var(--ink) 70%, transparent);
  --tone-output: var(--accent);
  --tone-reasoning: color-mix(in oklab, var(--accent) 60%, #8b5cf6);
  position: relative;
  z-index: 1;
  width: min(720px, calc(100% - 40px));
  max-height: calc(100% - 40px);
  margin: auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 30px 34px 34px;
  border-radius: 22px;
  background-color: var(--panel);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 24px 64px -24px color-mix(in srgb, var(--ink) 28%, transparent);
}
/* Grow out of the request, and shrink back into it. */
.tr.is-in {
  animation: tr-grow 460ms cubic-bezier(0.34, 1.3, 0.64, 1) backwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
.tr.is-out {
  animation: tr-shrink var(--modal-exit) cubic-bezier(0.4, 0, 0.9, 1) forwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
@keyframes tr-grow {
  from { opacity: 0.35; transform: scale(0.16); }
  60% { opacity: 1; }
}
@keyframes tr-shrink {
  to { opacity: 0; transform: scale(0.16); }
}

/* ── top bar ──────────────────────────────────────────────────────────────── */
.tr__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 22px;
}
.tr__back {
  display: inline-flex;
  color: var(--muted);
  opacity: 0.7;
  cursor: pointer;
  transition: opacity 0.18s ease, color 0.25s ease;
}
.tr__back:hover,
.tr__back:focus-visible {
  outline: none;
  opacity: 1;
  color: var(--ink);
}
.tr__back-glyph { transform: rotate(180deg) scaleX(-1); }
.tr__crumb {
  display: inline-flex;
  gap: 7px;
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--ink);
}
.tr__dim { color: var(--muted); }

/* ── body: the request · the facts ────────────────────────────────────────── */
.tr__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 168px;
  gap: 36px;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;
}
.tr__main { min-width: 0; }

.tr__quote {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  padding-left: 14px;
  border-left: 2px solid color-mix(in oklab, var(--accent) 45%, transparent);
  font-size: 15px;
  line-height: 1.55;
  color: var(--ink);
  white-space: pre-wrap;
  text-wrap: pretty;
}
.tr__aside,
.tr__empty {
  margin-top: 14px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--muted);
}
.tr__empty { margin-top: 30px; }

.tr__figures {
  display: flex;
  flex-wrap: wrap;
  gap: 34px;
  margin-top: 30px;
}
.fig { display: flex; flex-direction: column; gap: 6px; }
.fig__v {
  font-size: 26px;
  letter-spacing: -0.6px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.fig__sep {
  margin-inline: 3px;
  color: var(--faint, var(--muted));
}
.fig__k,
.meta__k {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.9px;
  text-transform: uppercase;
  color: var(--muted);
}

/* The turn's tokens as one proportional bar, each kind its own tone. */
.tr__bar-chart {
  display: flex;
  gap: 3px;
  height: 10px;
  margin-top: 26px;
}
.seg {
  min-width: 4px;
  border-radius: 3px;
  transform-origin: left center;
  animation: seg-in 520ms var(--tr-ease) backwards;
  animation-delay: calc(120ms + var(--i, 0) * 60ms);
}
@keyframes seg-in {
  from { transform: scaleX(0); opacity: 0; }
}
.seg--cached { background: var(--tone-cached); }
.seg--written { background: var(--tone-written); }
.seg--fresh { background: var(--tone-fresh); }
.seg--output { background: var(--tone-output); }
.seg--reasoning { background: var(--tone-reasoning); }

.tr__legend {
  display: grid;
  gap: 2px;
  margin-top: 16px;
  padding: 0;
  list-style: none;
}
.leg {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto 40px;
  align-items: center;
  gap: 10px;
  height: 26px;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.leg__dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  animation: none;
}
.leg__v,
.leg__pct {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.leg__pct { color: var(--muted); }

.tr__own {
  margin-top: 18px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--muted);
}
.tr__own b {
  font-weight: 500;
  color: var(--ink);
}

.tr__skeleton {
  display: grid;
  gap: 10px;
  margin-top: 30px;
}
.tr__skeleton i {
  height: 12px;
  border-radius: 4px;
  background: var(--hover);
}
.tr__skeleton i:nth-child(1) { width: 40%; height: 26px; }
.tr__skeleton i:nth-child(3) { width: 70%; }

/* ── facts rail ───────────────────────────────────────────────────────────── */
.tr__meta {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-top: 2px;
}
.meta { display: flex; flex-direction: column; gap: 5px; }
.meta__v {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.meta__v--ink { color: var(--ink-soft); }
.meta__model,
.meta__effort {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.meta__effort { color: var(--ink-soft); }
.meta__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.meta__dot--ok { background: var(--diff-add); }
.meta__dot--bad { background: var(--diff-del); }
.meta__dot--idle { background: var(--muted); }
.meta__dot--live {
  background: var(--accent);
  animation: live 1.4s ease-in-out infinite;
}
@keyframes live {
  50% { opacity: 0.35; }
}

@media (max-width: 640px) {
  .tr { padding: 24px 20px 26px; }
  .tr__body { grid-template-columns: minmax(0, 1fr); gap: 26px; }
}

@media (prefers-reduced-motion: reduce) {
  .tr.is-in,
  .tr.is-out { animation-duration: 0.01s; }
  .seg,
  .meta__dot--live { animation: none; }
}
</style>
