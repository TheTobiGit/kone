<script setup lang="ts">
import { computed } from "vue";
import AgentFace from "~/components/agent/AgentFace.vue";
import RosterFace from "~/components/agent/RosterFace.vue";
import { courierAgent, type Agent } from "~/utils/agents";
import { inboxKindLabel, inboxStampAt, inboxStateLabel } from "~/utils/inboxEntry";
import { isSpeakingSender, messageSpeaker } from "~/utils/messageSpeaker";
import { timeAgo } from "~/utils/timeAgo";
import type { InboxEntry, InboxSender } from "~/types/desktop";

// One agent's inbox, as the thread-info drop-down shows it: what other agents
// and kone sent this thread that it has not taken in yet, then what it has.
// Each message reads as who sent it, what kind it is, where it stands and
// when; an answer quotes the message it replies to. Read-only — the inbox is
// the agent's to work through, not the user's.

const props = defineProps<{
  waiting: InboxEntry[];
  seen: InboxEntry[];
  loaded: boolean;
  error: string | null;
}>();

interface From {
  name: string;
  /** Who they are to this thread, from its side. */
  relation: string;
  agent: Agent | undefined;
  seed: string;
}

function fromOf(sender: InboxSender | null): From {
  if (isSpeakingSender(sender)) {
    const s = messageSpeaker(sender);
    return { name: s.name, relation: s.relation, agent: s.agent, seed: s.seed };
  }
  // kone's own notices, and a message nobody could name the sender of, both
  // read as kone: nothing but kone writes to an inbox without an agent sender.
  const kone = courierAgent();
  return { name: kone.name, relation: "kone", agent: kone, seed: kone.id };
}

interface Line {
  entry: InboxEntry;
  from: From;
  /** Who wrote the message an answer replies to. */
  answersName: string | null;
  state: string;
  at: number;
  ago: string;
  iso: string;
  full: string;
}

function lineOf(entry: InboxEntry): Line {
  const at = inboxStampAt(entry);
  const date = new Date(at);
  return {
    entry,
    from: fromOf(entry.sender),
    answersName: entry.answers ? fromOf(entry.answers.sender).name : null,
    state: inboxStateLabel(entry),
    at,
    ago: timeAgo(at),
    iso: date.toISOString(),
    full: date.toLocaleString(),
  };
}

const sections = computed(() => [
  { key: "waiting", label: "Waiting", empty: "Nothing waiting.", lines: props.waiting.map(lineOf) },
  { key: "seen", label: "Seen", empty: "Nothing seen yet.", lines: props.seen.map(lineOf) },
]);
</script>

<template>
  <div class="aip">
    <p v-if="error" class="aip__error" role="status">{{ error }}</p>
    <template v-for="sec in sections" :key="sec.key">
      <p class="tip__section">{{ sec.label }}</p>
      <ol v-if="sec.lines.length" class="aip__list" :aria-label="`${sec.label} messages`">
        <li v-for="l in sec.lines" :key="l.entry.inboxId" class="aip__msg" :data-state="l.entry.state">
          <div class="aip__head">
            <RosterFace v-if="l.from.agent" :agent="l.from.agent" :size="16" class="aip__face" />
            <AgentFace v-else :seed="l.from.seed" :size="16" class="aip__face" />
            <span class="aip__name">{{ l.from.name }}</span>
            <span class="aip__kind" :data-kind="l.entry.kind">{{ inboxKindLabel(l.entry.kind) }}</span>
            <span v-if="l.entry.urgent" class="aip__urgent">Urgent</span>
            <time class="aip__stamp" :datetime="l.iso" :title="l.full">{{ l.ago }}</time>
          </div>
          <p v-if="l.entry.answers" class="aip__quote" :title="l.entry.answers.excerpt">
            <span class="aip__quote-lead">Re {{ l.answersName }}:</span> {{ l.entry.answers.excerpt }}
          </p>
          <p class="aip__body">{{ l.entry.body }}</p>
          <p class="aip__meta">
            <span>{{ l.from.relation }}</span>
            <span class="aip__state">{{ l.state }}</span>
          </p>
        </li>
      </ol>
      <p v-else-if="loaded" class="aip__empty">{{ sec.empty }}</p>
    </template>
  </div>
</template>

<style scoped src="./threadInfoRows.css"></style>

<style scoped>
.aip {
  display: flex;
  flex-direction: column;
}
.aip__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}
.aip__msg {
  padding: 7px 0;
  border-top: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
}
.aip__msg:first-child {
  border-top: 0;
}
/* A message that has been taken in steps back, so what still waits is what
   the eye lands on. */
.aip__msg[data-state="seen"] .aip__body {
  color: var(--ink-soft);
}
.aip__head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.aip__face {
  flex: none;
}
.aip__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 560;
  color: var(--ink);
}
.aip__kind,
.aip__urgent {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 550;
  line-height: 1.5;
  color: var(--muted);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}
/* The kinds that want something back from this agent wear the accent; the
   rest stay quiet. */
.aip__kind[data-kind="question"],
.aip__kind[data-kind="pushback"],
.aip__kind[data-kind="job"] {
  color: color-mix(in srgb, var(--accent) 75%, var(--ink));
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.aip__urgent {
  color: var(--danger, #d9544f);
  background: color-mix(in srgb, var(--danger, #d9544f) 12%, transparent);
}
.aip__stamp {
  flex: none;
  margin-left: auto;
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.aip__quote {
  margin: 4px 0 0 22px;
  padding-left: 7px;
  border-left: 2px solid color-mix(in srgb, var(--ink) 12%, transparent);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aip__quote-lead {
  font-weight: 550;
}
.aip__body {
  margin: 3px 0 0 22px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.aip__meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 3px 0 0 22px;
  font-size: 11px;
  color: var(--muted);
}
.aip__state {
  flex: none;
}
.aip__msg:not([data-state="seen"]) .aip__state {
  color: color-mix(in srgb, var(--accent) 70%, var(--ink));
  font-weight: 550;
}
/* A message kone may never have handed over reads as a failure does, not as
   something on its way. */
.aip__msg[data-state="uncertain"] .aip__state {
  color: var(--danger, #d9544f);
}
.aip__empty {
  margin: 2px 0 4px;
  font-size: 12px;
  color: var(--muted);
}
.aip__error {
  margin: 0 0 6px;
  font-size: 11.5px;
  color: var(--danger, #d9544f);
}
</style>
