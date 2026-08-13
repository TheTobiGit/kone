<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowUpRight01Icon, Cancel01Icon, AiBrain01Icon, Clock01Icon, StopIcon } from "@hugeicons/core-free-icons";
import TurnOrb from "~/components/TurnOrb.vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import AgentActivity from "~/components/AgentActivity.vue";
import MarkdownMessage from "~/components/MarkdownMessage.vue";
import ApprovalPrompt from "~/components/ApprovalPrompt.vue";
import { SESSION_BRAND } from "~/types/session";
import {
  brainStack,
  formatElapsed,
  subagentEffort,
  subagentModel,
  subagentTitle,
  type SubagentRunView,
} from "~/utils/subagentRuns";
import { describeModelId } from "~/utils/modelCatalog";
import { segText, type Segment } from "~/utils/conversationSegments";
import type { PendingApproval } from "~/composables/useAgent";
import type { ApprovalDecision, SpawnedThread } from "~/types/desktop";

// The expanded shell — the natural zoom-in of the corner Subagents dock.
// Clicking a dock row opens this instead of a small panel: a taller, wider,
// focused surface with the delegate's identity and live status in a recessed
// header band (the dock's own picker-band signature), the body filling the
// rest with what that delegate is ACTUALLY doing, and — for a nested run — any
// approval it parked on rendered inline so the ask can be answered without
// leaving the shell.
//
// Two kinds, one shell:
//   · run — a provider-native nested run: the body is the child's own live
//     transcript, the same AgentActivity voice as the parent thread, and the
//     approvals attributed to this run (see useAgent's originToolUseId) render
//     as an inline ask pinned above the transcript.
//   · thread — a spawned kone child thread: the parent only ever sees the
//     rolled-up projection (status, elapsed, gate, capped narrative), so the
//     body shows exactly that — the gate it's parked on, the reply it reported
//     — and the footer opens the child's real conversation, where its full
//     live activity lives. No approval API crosses back to the parent, so a
//     parked child's ask renders as a gate card with the open-thread action,
//     never fake buttons.
//
// The shell is presentational: the parent hands in the run/thread derived
// fresh from the live block tree + spawn list, so a working delegate keeps
// streaming into the open shell.

const props = defineProps<{
  kind: "run" | "thread";
  /** The live-derived run (kind === "run"). */
  run?: SubagentRunView | null;
  /** The live-derived spawned thread (kind === "thread"). */
  thread?: SpawnedThread | null;
  /** Approvals attributed to this delegate, rendered inline. */
  approvals?: PendingApproval[];
}>();

const emit = defineEmits<{
  close: [];
  /** Reveal the spawned child's own conversation (thread kind). */
  "open-thread": [];
  /** Stop a live nested run — the parent turn keeps running. The parent hands
   *  it to the session's stopSubagent (keyed by the run's toolUseId). */
  "stop-subagent": [toolUseId: string];
  /** Answer an inline approval — handed straight back to the session. */
  "decide-approval": [requestId: string, decision: ApprovalDecision];
}>();

// ── identity / status ─────────────────────────────────────────────────────────
const run = computed(() => (props.kind === "run" ? (props.run ?? null) : null));

const title = computed(() =>
  run.value ? subagentTitle(run.value) : (props.thread?.title ?? "Subagent"),
);

const model = computed(() =>
  props.kind === "run"
    ? describeModelId(run.value?.model)
    : describeModelId(props.thread?.model),
);

// A spawned thread that crossed the bridge without a model id still names its
// engine — the provider's own mark wears in, so the header never reads generic.
const brand = computed(() => {
  const m = model.value;
  if (m.brand !== "generic") return m.brand;
  if (props.kind === "thread" && props.thread) return SESSION_BRAND[props.thread.provider];
  return "generic";
});

const effort = computed(() => (run.value ? subagentEffort(run.value) : null));

// The live signal: a run is live while starting/running; a thread while it's
// working (a parked thread is also alive — it's the one thing waiting on the
// user — but its ask is the story, rendered below).
const runLive = computed(() => !!run.value?.live);
const thinking = computed(() => {
  if (!run.value?.live) return false;
  const tail = run.value.items[run.value.items.length - 1];
  return tail?.kind === "reasoning_text";
});
const running = computed(() =>
  props.kind === "run"
    ? runLive.value
    : props.thread?.status === "working" || props.thread?.status === "waiting-for-approval" || props.thread?.status === "waiting-for-user-input",
);

// The status word's tone — a parked thread borrows the accent (it's the one
// row needing the human), live states sit in ink, settled fade to muted.
const statusTone = computed(() => {
  const t = props.kind === "thread" ? props.thread?.status : undefined;
  if (t === "waiting-for-approval" || t === "waiting-for-user-input") return "accent";
  if (props.kind === "run") {
    const s = props.run?.status;
    if (s === "completed") return "done";
    if (s === "failed" || s === "stopped") return "error";
    return "live";
  }
  if (t === "completed") return "done";
  if (t === "failed" || t === "interrupted") return "error";
  return "live";
});

// ── thread elapsed — a live ticker so a working child's clock creeps up ───────
// The projection's elapsedMs only moves on spawn-updated events; for a working
// child, now − updatedAt is exactly what the next recompute would add, so a
// per-second ticker rides on top without touching the backend.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;
watch(
  () => props.kind === "thread" && props.thread?.status === "working",
  (on) => {
    if (on && ticker === null) {
      now.value = Date.now();
      ticker = setInterval(() => (now.value = Date.now()), 1000);
    } else if (!on && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  },
  { immediate: true },
);
const elapsed = computed(() => {
  const t = props.thread;
  if (!t || typeof t.elapsedMs !== "number") return "";
  if (t.status === "working") return formatElapsed(t.elapsedMs + Math.max(0, now.value - t.updatedAt));
  return formatElapsed(t.elapsedMs);
});
onBeforeUnmount(() => {
  if (ticker !== null) clearInterval(ticker);
});

// ── the gate a parked child is blocked on ─────────────────────────────────────
// The parent only ever sees the rolled-up ask (SpawnedThread.detail carries the
// approval title / question), and no respond API crosses back to the child — so
// this renders as a quiet gate card with the open-thread action, not buttons
// that could not work.
const gate = computed<{ label: string; text: string } | null>(() => {
  const t = props.thread;
  if (!t) return null;
  if (t.status === "waiting-for-approval")
    return {
      label: "Waiting for your approval",
      text: t.detail ?? "The child is waiting for your go-ahead before it continues.",
    };
  if (t.status === "waiting-for-user-input")
    return {
      label: "Waiting for your answer",
      text: t.detail ?? "The child asked you a question before it continues.",
    };
  return null;
});

// ── run transcript, in arrival order ──────────────────────────────────────────
// Coalesce adjacent same-kind items into segments, then fold thinking+tool runs
// into step groups with text breaking the rail — the same shape renderGroups
// hands the parent thread, so the two read alike.
type SubGroup =
  | { kind: "steps"; key: string; segments: Segment[] }
  | { kind: "text"; seg: Segment };

const groups = computed<SubGroup[]>(() => {
  const items = run.value?.items ?? [];
  const segs: Segment[] = [];
  for (const it of items) {
    const kind = it.kind === "reasoning_text" ? "thinking" : it.kind === "tool_call" ? "tools" : "text";
    const cur = segs[segs.length - 1];
    if (cur && cur.kind === kind) cur.items.push(it);
    else segs.push({ kind, key: it.itemId, items: [it] });
  }
  const out: SubGroup[] = [];
  for (const seg of segs) {
    if (seg.kind === "text") {
      out.push({ kind: "text", seg });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.kind === "steps") last.segments.push(seg);
    else out.push({ kind: "steps", key: seg.key, segments: [seg] });
  }
  return out;
});

const hasTranscript = computed(() => (run.value?.items.length ?? 0) > 0);

// The live tail batch — the last steps group keeps its working orb while the
// child runs; once text takes over (or it settles) it folds like any other.
const tailIsLive = computed(() => {
  if (!runLive.value) return false;
  const tail = groups.value[groups.value.length - 1];
  return tail?.kind === "steps";
});

const threadEmptyText = computed(() => {
  const t = props.thread;
  if (!t) return "";
  if (t.status === "working") return "Working…";
  if (t.status === "idle") return "Queued — the child hasn't started its first turn yet.";
  if (t.status === "failed") return "The child failed without a reply.";
  if (t.status === "interrupted") return "The child was interrupted.";
  return "No reply was captured.";
});

// ── focus / dismissal ─────────────────────────────────────────────────────────
const panelEl = ref<HTMLElement | null>(null);
onMounted(() => panelEl.value?.focus());

function close(): void {
  emit("close");
}
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
});

// Lock the page behind while the overlay is up, so only the shell's body scrolls.
onMounted(() => {
  document.documentElement.style.overflow = "hidden";
});
onBeforeUnmount(() => {
  document.documentElement.style.removeProperty("overflow");
});
</script>

<template>
  <div class="sh" role="dialog" aria-modal="true" :aria-label="`${title}'s shell`">
    <!-- Scrim — the whole board behind, click to dismiss. -->
    <div class="sh__scrim" aria-hidden="true" @click="close" />

    <section
      ref="panelEl"
      class="sh__panel"
      tabindex="-1"
      @mousedown.stop
      @click.self="close"
    >
      <!-- Header band — the dock's picker-band signature, so the shell reads as
           a zoom-in of the dock it came from: state orb, identity (title,
           model, effort), the status word, dismiss. -->
      <header class="sh__head">
        <span class="sh__state" aria-hidden="true">
          <span class="sh__state-stack">
            <span v-if="running" class="sh__state-orb">
              <TurnOrb
                :state="thinking ? 'thinking' : 'working'"
                :size="17"
                :aria-label="thinking ? 'Thinking' : 'Working'"
              />
            </span>
            <span v-else-if="statusTone === 'done'" class="sh__state-glyph sh__state-glyph--done">
              ✓
            </span>
            <span v-else class="sh__state-glyph sh__state-glyph--failed">×</span>
          </span>
        </span>

        <span class="sh__identity">
          <span class="sh__title-row">
            <span class="sh__title" :title="title">{{ title }}</span>
          </span>

          <span class="sh__meta">
            <ProviderLogo v-if="brand !== 'generic'" :brand="brand" :size="14" />
            <span class="sh__model" :title="model.name">{{ model.name }}</span>
            <span
              v-if="effort"
              class="sh__effort"
              :title="`Reasoning effort: ${effort.label}`"
            >
              <span class="sh__brains" :class="{ 'sh__brains--glow': effort.glow }">
                <HugeiconsIcon
                  v-for="i in brainStack(effort.brains)"
                  :key="i"
                  :icon="AiBrain01Icon"
                  :size="12"
                  :stroke-width="2"
                  :style="{ color: effort.hue }"
                />
              </span>
            </span>
            <span class="sh__kind" aria-hidden="true">·</span>
            <span class="sh__kind">{{ kind === "run" ? "Nested run" : "Spawned thread" }}</span>
            <span v-if="kind === 'thread' && elapsed" class="sh__elapsed" :title="`Elapsed: ${elapsed}`">
              <HugeiconsIcon :icon="Clock01Icon" :size="12" :stroke-width="1.8" aria-hidden="true" />
              {{ elapsed }}
            </span>
          </span>

          <span
            v-if="kind === 'run' && run?.prompt"
            class="sh__brief"
            :title="run.prompt"
          >{{ run.prompt }}</span>        </span>

        <button
          v-if="kind === 'run' && runLive && run"
          type="button"
          class="sh__stop"
          :aria-label="`Stop ${title}`"
          :title="`Stop ${title}`"
          @click="emit('stop-subagent', run.toolUseId)"
        >
          <HugeiconsIcon :icon="StopIcon" :size="14" :stroke-width="2" />
        </button>
        <button
          type="button"
          class="sh__close"
          aria-label="Close"
          title="Close (Esc)"
          @click="close"
        >
          <HugeiconsIcon :icon="Cancel01Icon" :size="16" :stroke-width="2" />
        </button>
      </header>

      <div class="sh__body">
        <!-- Inline approvals — a parked child's ask pinned above the scroll, so
             the one thing needing the human is answered before reading on. -->
        <div v-if="approvals && approvals.length" class="sh__asks">
          <ApprovalPrompt
            v-for="a in approvals"
            :key="a.requestId"
            :approval="a.approval"
            scroll-max="none"
            @decide="(d) => emit('decide-approval', a.requestId, d)"
          />
        </div>

        <div class="sh__scroll">
          <!-- ── run: the child's own transcript, same voice as the parent ── -->
          <template v-if="kind === 'run'">
            <p v-if="!hasTranscript" class="sh__empty">
              <span class="sh__empty-orb" aria-hidden="true">
                <TurnOrb :state="thinking ? 'thinking' : 'working'" :size="14" />
              </span>
              {{ runLive ? "Working…" : "Nothing was captured." }}
            </p>

            <div v-else class="sh__thread">
              <template
                v-for="(grp, i) in groups"
                :key="grp.kind === 'text' ? grp.seg.key : grp.key"
              >
                <AgentActivity
                  v-if="grp.kind === 'steps'"
                  :segments="grp.segments"
                  :running="running"
                  :is-tail="tailIsLive && i === groups.length - 1"
                />

                <div v-else class="sh__answer-wrap" :data-markdown-source="segText(grp.seg)">
                  <MarkdownMessage class="sh__answer" :source="segText(grp.seg)" />
                </div>
              </template>

              <!-- The child's final report, once it settles with one. -->
              <div v-if="run?.summary" class="sh__report">
                <span class="sh__report-label">Report</span>
                <p class="sh__report-text">{{ run.summary }}</p>
              </div>
            </div>
          </template>

          <!-- ── thread: the projection — gate, then the reply it reported ── -->
          <template v-else>
            <!-- A parked child's ask: the parent can't answer it (no respond
                 API crosses back), so the gate card hands the user the door. -->
            <div v-if="gate" class="sh__gate">
              <span class="sh__gate-icon" aria-hidden="true">
                <TurnOrb state="working" :size="15" />
              </span>
              <span class="sh__gate-body">
                <span class="sh__gate-label">{{ gate.label }}</span>
                <span class="sh__gate-text">{{ gate.text }}</span>
              </span>
              <button type="button" class="sh__gate-open" @click="emit('open-thread')">
                Open thread
                <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="13" :stroke-width="2" aria-hidden="true" />
              </button>
            </div>

            <!-- The child's reply, capped at the projection's narrative cap. -->
            <div v-if="thread?.summary" class="sh__report">
              <span class="sh__report-label">Latest reply</span>
              <MarkdownMessage class="sh__report-text" :source="thread.summary" />
            </div>

            <p v-if="!gate && !thread?.summary" class="sh__empty">
              <span v-if="running || thread?.status === 'idle'" class="sh__empty-orb" aria-hidden="true">
                <TurnOrb state="working" :size="14" />
              </span>
              {{ threadEmptyText }}
            </p>
          </template>
        </div>
      </div>

      <!-- Footer band (thread kind) — the one real action a spawned child has
           from here: its own conversation, where the full live activity is. -->
      <footer v-if="kind === 'thread'" class="sh__foot">
        <span class="sh__foot-note">
          The child's full activity lives in its own thread.
        </span>
        <button type="button" class="sh__open" @click="emit('open-thread')">
          Open full thread
          <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="15" :stroke-width="2" aria-hidden="true" />
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.sh {
  position: fixed;
  inset: 0;
  z-index: 38;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(0.75rem, 4vh, 2rem) clamp(0.75rem, 4vw, 2rem);
}

.sh__scrim {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background: color-mix(in srgb, #000 34%, transparent);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
}

/* The shell card — a zoom-in of the dock: the same surface fill, hairline ring
   and soft shadow, just given the room to be a focused view. */
.sh__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(58rem, 100%);
  height: min(88vh, 800px);
  border-radius: 24px;
  background: var(--ground);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 9%, transparent),
    0 28px 70px -20px color-mix(in srgb, #000 48%, transparent);
  overflow: hidden;
  outline: none;
}

/* ── header — the recessed band, the dock's own signature ─────────────────── */
.sh__head {
  --band-bg: var(--band);
  --band-arc: 16px;
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
  padding: 1.15rem 1.35rem 1rem;
  background-color: var(--band-bg);
}
.sh__head::before,
.sh__head::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}
.sh__head::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.sh__head::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}

.sh__state {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  margin-top: 2px;
}
.sh__state-stack {
  position: relative;
  width: 20px;
  height: 20px;
}
.sh__state-orb {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.sh__state-glyph {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 19px;
  height: 19px;
  font-size: 11px;
  line-height: 1;
  /* Check and cross both sit on a filled state chip — accent-ink is the theme's
     ink for text on a coloured fill, where white only works in some themes. */
  color: var(--accent-ink);
  border-radius: 6px;
}
.sh__state-glyph--done {
  background: color-mix(in oklab, var(--ok) 88%, transparent);
}
.sh__state-glyph--failed {
  background: color-mix(in oklab, var(--danger) 82%, transparent);
}

.sh__identity {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
  flex: 1;
}
.sh__title-row {
  display: flex;
  align-items: baseline;
  flex-wrap: nowrap;
  min-width: 0;
}
.sh__title {
  flex: 1 1 0%;
  display: block;
  min-width: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1.3;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sh__meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  font-size: 12px;
}
.sh__meta :deep(.plogo) {
  flex: none;
  opacity: 0.9;
}
.sh__model {
  min-width: 0;
  font-weight: 500;
  letter-spacing: -0.005em;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sh__effort {
  display: inline-flex;
  align-items: center;
  flex: none;
}
.sh__brains {
  display: inline-flex;
  align-items: center;
}
.sh__brains > :deep(svg) {
  margin-left: -5px;
}
.sh__brains > :deep(svg:first-child) {
  margin-left: 0;
}
.sh__brains--glow > :deep(svg) {
  filter: drop-shadow(0 0 3px currentColor);
}
.sh__kind {
  flex: none;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--muted);
  opacity: 0.85;
}
.sh__elapsed {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  flex: none;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

.sh__brief {
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--ink-soft);
  text-wrap: pretty;
}

.sh__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  margin: -2px -6px 0 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.sh__close:hover,
.sh__close:focus-visible {
  background: var(--hover);
  color: var(--ink);
  outline: none;
}

/* Stop — sits beside dismiss while a nested run is live: the same quiet
   square language as the close affordance, so stopping reads as part of the
   shell's chrome, not a row action. */
.sh__stop {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  margin: -2px 2px 0 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.sh__stop:hover,
.sh__stop:focus-visible {
  background: var(--hover);
  color: var(--ink);
  outline: none;
}

/* ── body — the delegate's live activity fills the space ──────────────────── */
.sh__body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* Inline approvals — pinned above the scroll so the ask never scrolls away. */
.sh__asks {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 1rem 1.5rem 0.25rem;
}
.sh__asks > :deep(.approve-body) {
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
}

.sh__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 1.25rem 1.5rem 2rem;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 16%, transparent) transparent;
}
.sh__scroll::-webkit-scrollbar {
  width: 10px;
}
.sh__scroll::-webkit-scrollbar-track {
  background: transparent;
}
.sh__scroll::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
  border: 3px solid transparent;
  background-clip: content-box;
}
.sh__scroll:hover::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
}

.sh__thread {
  display: flex;
  flex-direction: column;
  gap: 26px;
  width: 100%;
  max-width: 46rem;
  margin: 0 auto;
}

.sh__empty {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin: 0.5rem 0;
  font-size: 14px;
  color: var(--muted);
}
.sh__empty-orb {
  display: inline-flex;
}

.sh__answer-wrap {
  width: 100%;
  max-width: 46rem;
  margin: 0 auto;
}
.sh__answer {
  width: 100%;
}

/* The gate card — a parked child's ask, quiet and door-shaped. */
.sh__gate {
  display: flex;
  align-items: flex-start;
  gap: 0.7rem;
  width: 100%;
  max-width: 46rem;
  margin: 0.25rem auto 1.5rem;
  padding: 0.85rem 1rem;
  border-radius: 14px;
  background: color-mix(in oklab, var(--accent) 9%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 22%, transparent);
}
.sh__gate-icon {
  display: inline-flex;
  flex: none;
  margin-top: 1px;
}
.sh__gate-body {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
  flex: 1;
}
.sh__gate-label {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}
.sh__gate-text {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.sh__gate-open {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  flex: none;
  margin-top: 0.1rem;
  border: 0;
  border-radius: 999px;
  padding: 0.3rem 0.75rem;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ground);
  background: var(--ink);
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.sh__gate-open:hover {
  opacity: 0.85;
}

/* The child's report — a quiet, labelled block that closes the read. */
.sh__report {
  width: 100%;
  max-width: 46rem;
  margin: 0 auto;
  padding: 0.9rem 1rem;
  border-radius: 14px;
  background: var(--hover);
}
.sh__report-label {
  display: block;
  margin-bottom: 0.4rem;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.sh__report-text {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ink-soft);
}

/* ── footer band (thread kind) — the open-the-child action ────────────────── */
.sh__foot {
  --band-bg: var(--band);
  --band-arc: 16px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.7rem 1.35rem;
  background-color: var(--band-bg);
}
.sh__foot::before,
.sh__foot::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  bottom: 100%;
  pointer-events: none;
}
.sh__foot::before {
  left: 0;
  background: radial-gradient(circle at top right, transparent var(--band-arc), var(--band-bg) 0);
}
.sh__foot::after {
  right: 0;
  background: radial-gradient(circle at top left, transparent var(--band-arc), var(--band-bg) 0);
}
.sh__foot-note {
  font-size: 12px;
  color: var(--muted);
}
.sh__open {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border: 0;
  border-radius: 999px;
  padding: 0.4rem 0.9rem;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ground);
  background: var(--ink);
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.sh__open:hover {
  opacity: 0.85;
}

@media (prefers-reduced-motion: reduce) {
  .sh__scrim {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}
</style>
