<script setup lang="ts">
import { computed } from "vue";
import { formatCount, formatTokens } from "~/utils/usageFormat";
import TraceCard from "~/components/conversation/TraceCard.vue";
import TraceBreakdown, { type TracePart } from "~/components/conversation/TraceBreakdown.vue";
import { useTurnTrace } from "~/composables/useTurnTrace";
import type { AssistantBlock, UserBlock } from "~/composables/agentTypes";
import { TRACE_TONES } from "~/utils/traceTones";

// A request's trace: what the message sent, opened over the thread from the
// request itself, in the card every trace opens in.
//
// The card quotes the request, leads with how many tokens it sent, then
// shows where they came from as one proportional bar, itemized beneath it.
// The date and thread sit quietly in the foot band.
// It is the request's trace, so the answer's side (output, reasoning, cost,
// and who answered) is the response's trace.
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

/** The words typed, as tokens: about four characters each. An estimate, and
 *  labelled one — no provider reports a single message's share. */
const ownTokens = computed(() => (props.block.text ? Math.max(1, Math.round(props.block.text.length / 4)) : 0));

// ── where the sent tokens came from: one bar ────────────────────────────────
const { scheme } = useTheme();
const parts = computed<TracePart[]>(() => {
  const t = TRACE_TONES[scheme.value === "dark" ? "dark" : "light"];
  return [
    { key: "cached", label: "From cache", value: cacheRead.value, color: t.cached },
    { key: "written", label: "Saved to cache", value: cacheWrite.value, color: t.written },
    { key: "fresh", label: "New input", value: freshInput.value, color: t.fresh },
  ];
});

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
</script>

<template>
  <TraceCard label="Request trace" :origin="origin" @close="emit('close')">
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
        <div class="tr-fig">
          <span class="tr-fig__v">{{ formatTokens(input) }}</span>
          <span class="tr-fig__k">tokens sent</span>
        </div>
        <div v-if="cacheRead" class="tr-fig">
          <span class="tr-fig__v">{{ cachedShare }}%</span>
          <span class="tr-fig__k">from cache</span>
        </div>
      </div>

      <!-- Where the sent tokens came from: one bar, each kind its share of it. -->
      <section class="tr-sec" aria-label="Where the sent tokens came from">
        <TraceBreakdown label="Where the sent tokens came from" :parts="parts" />
        <p v-if="ownTokens" class="tr-note">
          Your words were about <b>{{ formatCount(ownTokens) }}</b> of the {{ formatTokens(input) }} tokens sent.
          The rest is the thread so far, instructions and tool results.
        </p>
      </section>
    </template>

    <template #foot>
      <span class="tr-fact">{{ sentDate }}</span>
      <span class="tr-fact tr-fact--thread">{{ threadTitle || "Untitled thread" }}</span>
      <span v-if="attachments" class="tr-fact">{{ attachments }} file{{ attachments === 1 ? "" : "s" }}</span>
      <span v-if="skills.length" class="tr-fact">{{ skills.join(", ") }}</span>
    </template>
  </TraceCard>
</template>
