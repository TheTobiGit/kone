<script setup lang="ts">
import { computed } from "vue";
import { formatTokens } from "~/utils/usageFormat";
import TraceInline, { type TracePart } from "~/components/conversation/TraceInline.vue";
import { useTurnTrace } from "~/composables/useTurnTrace";
import type { AssistantBlock, UserBlock } from "~/composables/agentTypes";
import { TRACE_TONES } from "~/utils/traceTones";

// A request's trace, as two quiet lines under the request: what the turn sent
// and how much of it the cache carried, then where those tokens came from as
// one proportional bar. The answer's side (output, reasoning, cost) is the
// response's trace.
//
// Tokens belong to the turn the request started, not to the words typed: the
// provider bills the whole prompt the turn sent (instructions, history, tool
// results) and reports it once per turn.

const props = defineProps<{
  block: UserBlock;
  /** The reply this request started (or was steered into), when there is one. */
  reply: AssistantBlock | undefined;
  /** The thread's durable id; null on a column that has never sent. */
  threadId: string | null;
}>();

const { trace, loading } = useTurnTrace(() => ({
  threadId: props.threadId,
  turnId: props.reply?.turnId,
  state: props.reply?.state,
}));

const input = computed(() => trace.value?.inputTokens ?? 0);
const cacheRead = computed(() => trace.value?.cacheReadTokens ?? 0);
const cacheWrite = computed(() => trace.value?.cacheCreationTokens ?? 0);
const freshInput = computed(() => Math.max(0, input.value - cacheRead.value - cacheWrite.value));
/** The share of what was sent that came back from the cache. */
const cachedShare = computed(() => (input.value ? Math.round((cacheRead.value / input.value) * 100) : 0));

/** The line: what was sent, and how much of it the cache carried. */
const facts = computed(() => {
  if (loading.value) return ["Loading usage…"];
  if (!trace.value) {
    if (!props.reply) return ["No turn yet"];
    if (props.reply.state === "running") return ["Usage after this turn"];
    return ["Usage not reported"];
  }
  if (!input.value) return ["No tokens reported"];
  return [
    `${formatTokens(input.value)} sent`,
    `${cachedShare.value}% cached`,
  ];
});

// ── where the sent tokens came from: one bar ────────────────────────────────
const { scheme } = useTheme();
const parts = computed<TracePart[]>(() => {
  const tones = TRACE_TONES[scheme.value === "dark" ? "dark" : "light"];
  return [
    { key: "cached", label: "Cache", value: cacheRead.value, color: tones.cached, text: formatTokens(cacheRead.value) },
    { key: "written", label: "Saved", value: cacheWrite.value, color: tones.written, text: formatTokens(cacheWrite.value) },
    { key: "fresh", label: "New", value: freshInput.value, color: tones.fresh, text: formatTokens(freshInput.value) },
  ];
});
</script>

<template>
  <TraceInline label="Request" :facts="facts" :parts="trace ? parts : []" />
</template>
