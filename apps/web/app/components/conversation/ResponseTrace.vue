<script setup lang="ts">
import { computed } from "vue";
import { formatCount, formatTokens, formatUsd } from "~/utils/usageFormat";
import TraceInline, { type TracePart } from "~/components/conversation/TraceInline.vue";
import { useTurnTrace } from "~/composables/useTurnTrace";
import type { AssistantBlock } from "~/composables/agentTypes";
import { formatDuration, summarizeResponse } from "~/utils/responseTrace";

// A response's trace, as two quiet lines under the reply: how long it took,
// how many tools it called, what it wrote and what that cost, then the tools
// by kind as one bar, in the hues the thread draws them in.
//
// The transcript answers the time and the tools, so those show at once, even
// while the turn runs; the tokens and cost wait on the turn's usage row.

const props = defineProps<{
  /** Every piece of the turn, in order: a steer splits one reply into several. */
  pieces: AssistantBlock[];
  /** The thread's durable id; null on a column that has never sent. */
  threadId: string | null;
  /** The live clock, so a running turn's time keeps counting. */
  now: number;
}>();

const last = computed(() => props.pieces.at(-1));
const { trace } = useTurnTrace(() => ({
  threadId: props.threadId,
  turnId: last.value?.turnId,
  state: last.value?.state,
}));

const summary = computed(() => summarizeResponse(props.pieces));
const took = computed(() => {
  const s = summary.value;
  return s ? formatDuration((s.endedAt ?? props.now) - s.startedAt) : "";
});

/** The line: how long, how many calls, what it wrote and what that cost. */
const facts = computed(() => {
  const s = summary.value;
  if (!s) return [];
  const read = trace.value;
  const written = read?.outputTokens ?? 0;
  const cost = read?.costUsd ?? null;
  return [
    s.state === "running" ? `${took.value} so far` : took.value,
    `${formatCount(s.toolCalls)} tool call${s.toolCalls === 1 ? "" : "s"}`,
    ...(written ? [`${formatTokens(written)} written`] : []),
    ...(cost === null ? [] : [formatUsd(cost)]),
    ...(s.failedCalls ? [`${formatCount(s.failedCalls)} failed`] : []),
  ];
});

/** The tools it called, by kind, in the hues the thread draws them in. */
const { theme } = useTheme();
const toolParts = computed<TracePart[]>(() => {
  const hues = theme.value.hues.families;
  return (summary.value?.tools ?? []).map((tool) => ({
    key: tool.family,
    label: tool.label,
    value: tool.count,
    color: hues[tool.family] ?? "var(--muted)",
    text: formatCount(tool.count),
  }));
});
</script>

<template>
  <TraceInline label="Response" :facts="facts" :parts="toolParts" />
</template>
