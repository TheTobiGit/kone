<script setup lang="ts">
import { computed } from "vue";
import { formatCount, formatTokens, formatUsd } from "~/utils/usageFormat";
import TraceCard from "~/components/conversation/TraceCard.vue";
import TraceBreakdown, { type TracePart } from "~/components/conversation/TraceBreakdown.vue";
import { useTurnTrace } from "~/composables/useTurnTrace";
import type { AssistantBlock, UserBlock } from "~/composables/agentTypes";
import { formatDuration, summarizeResponse } from "~/utils/responseTrace";
import { describeModelId, effortMeta, isEffortTier } from "~/utils/modelCatalog";
import { PROVIDER_LABEL } from "~/utils/usageProviders";

// A response's trace: what the agent did to answer, opened over the thread
// from the reply itself, in the card every trace opens in.
//
// The card quotes the reply, names who answered (model, provider, effort),
// leads with how long it took, how many tools it called, what it wrote and
// what that cost, then shows the tools by kind, in the hues the thread draws
// them in, and the written tokens split into reply and reasoning. When it finished and the thread sit in the foot.
//
// The transcript answers the time and the tools, so those show at once, even
// while the turn runs; the tokens and cost wait on the turn's usage row.

const props = defineProps<{
  /** Every piece of the turn, in order: a steer splits one reply into several. */
  pieces: AssistantBlock[];
  /** The request the turn answers, for the effort it was sent at. */
  request: UserBlock | undefined;
  /** The thread's durable id; null on a column that has never sent. */
  threadId: string | null;
  threadTitle: string;
  /** The reply's viewport rect — the grow's origin. */
  origin: DOMRect | null;
  /** The live clock, so a running turn's time keeps counting. */
  now: number;
}>();

const emit = defineEmits<{
  /** Its exit has finished; unmount it now. */
  close: [];
}>();

const last = computed(() => props.pieces.at(-1));
const { trace, loading } = useTurnTrace(() => ({
  threadId: props.threadId,
  turnId: last.value?.turnId,
  state: last.value?.state,
}));

const summary = computed(() => summarizeResponse(props.pieces));
const took = computed(() => {
  const s = summary.value;
  return s ? formatDuration((s.endedAt ?? props.now) - s.startedAt) : "";
});

// ── who answered ────────────────────────────────────────────────────────────
const model = computed(() => {
  const id = trace.value?.model ?? props.request?.model;
  return id ? describeModelId(id).name : null;
});
const provider = computed(() => {
  const p = trace.value?.provider;
  return Object.entries(PROVIDER_LABEL).find(([kind]) => kind === p)?.[1] ?? null;
});
const effort = computed(() => {
  const tier = props.request?.effort;
  return isEffortTier(tier) && tier !== "base" ? `${effortMeta(tier).label} effort` : null;
});
const who = computed(() => [model.value, provider.value, effort.value].filter(Boolean).join(" · "));

// ── what it did and wrote ───────────────────────────────────────────────────
const { theme } = useTheme();
const toolParts = computed<TracePart[]>(() => {
  const hues = theme.value.hues.families;
  return (summary.value?.tools ?? []).map((t) => ({
    key: t.family,
    label: t.label,
    value: t.count,
    color: hues[t.family] ?? "var(--muted)",
  }));
});

const output = computed(() => trace.value?.outputTokens ?? 0);
const reasoning = computed(() => Math.min(trace.value?.reasoningTokens ?? 0, output.value));
// Ink, not hue: the tools above already spend the hues, and a written token
// isn't any of them. The reply is the darker step, the reasoning the lighter.
const writtenParts = computed<TracePart[]>(() => [
  { key: "reply", label: "Reply", value: output.value - reasoning.value, color: "color-mix(in srgb, var(--ink) 72%, var(--panel))" },
  { key: "reasoning", label: "Reasoning", value: reasoning.value, color: "color-mix(in srgb, var(--ink) 40%, var(--panel))" },
]);

const stateNote = computed(() => {
  const state = summary.value?.state;
  if (state === "interrupted") return "Stopped";
  if (state === "failed") return "Couldn't finish";
  return null;
});

/** Why there are no token numbers, when there are none. */
const missing = computed(() => {
  if (loading.value || trace.value) return null;
  if (last.value?.state === "running") return "Still answering. The tokens land when the turn settles.";
  return "The provider didn't report usage for this turn.";
});

// ── when ───────────────────────────────────────────────────────────────────
const finished = computed(() => {
  const s = summary.value;
  if (!s) return "";
  const at = new Date(s.endedAt ?? s.startedAt);
  const day = at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}`;
});
</script>

<template>
  <TraceCard label="Response trace" :origin="origin" @close="emit('close')">
    <template v-if="summary">
      <p class="tr-quote selectable">{{ summary.reply || "It worked without writing a reply." }}</p>
      <p v-if="who" class="rt-who">{{ who }}</p>

      <!-- The headline: how long, how many tools, what it wrote and what that cost. -->
      <div class="tr-figs">
        <div class="tr-fig">
          <span class="tr-fig__v">{{ took }}</span>
          <span class="tr-fig__k">{{ summary.state === "running" ? "so far" : "took" }}</span>
        </div>
        <div class="tr-fig">
          <span class="tr-fig__v">{{ formatCount(summary.toolCalls) }}</span>
          <span class="tr-fig__k">tool calls</span>
        </div>
        <div v-if="trace && output" class="tr-fig">
          <span class="tr-fig__v">{{ formatTokens(output) }}</span>
          <span class="tr-fig__k">tokens written</span>
        </div>
        <div v-if="trace && trace.costUsd !== null" class="tr-fig">
          <span class="tr-fig__v">{{ formatUsd(trace.costUsd) }}</span>
          <span class="tr-fig__k">cost</span>
        </div>
      </div>

      <!-- The tools it called, by kind. -->
      <section v-if="summary.toolCalls" class="tr-sec" aria-labelledby="rt-tools">
        <h3 id="rt-tools" class="tr-sec__k">What it did</h3>
        <TraceBreakdown label="Tool calls by kind" :parts="toolParts" />
        <p v-if="summary.subagents || summary.failedCalls" class="tr-note">
          <template v-if="summary.subagents">
            It started <b>{{ formatCount(summary.subagents) }}</b> subagent{{ summary.subagents === 1 ? "" : "s" }},
            which made {{ formatCount(summary.subagentCalls) }} more call{{ summary.subagentCalls === 1 ? "" : "s" }}.
          </template>
          <template v-if="summary.failedCalls">
            <b>{{ formatCount(summary.failedCalls) }}</b> call{{ summary.failedCalls === 1 ? "" : "s" }} failed.
          </template>
        </p>
      </section>

      <!-- What it wrote: the reply, and the reasoning behind it. -->
      <div v-if="loading" class="tr-skeleton" aria-hidden="true">
        <i /><i /><i />
      </div>
      <p v-else-if="missing" class="tr-empty">{{ missing }}</p>
      <section v-else-if="trace && output" class="tr-sec" aria-labelledby="rt-written">
        <h3 id="rt-written" class="tr-sec__k">What it wrote</h3>
        <TraceBreakdown label="Tokens written" :parts="writtenParts" />
      </section>
    </template>

    <template #foot>
      <span class="tr-fact">{{ finished }}</span>
      <span class="tr-fact tr-fact--thread">{{ threadTitle || "Untitled thread" }}</span>
      <span v-if="stateNote" class="tr-fact">{{ stateNote }}</span>
    </template>
  </TraceCard>
</template>

<style scoped>
.rt-who {
  margin-top: 12px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-soft);
}
</style>
