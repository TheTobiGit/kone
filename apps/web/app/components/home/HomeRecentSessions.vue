<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  Archive02Icon,
  BubbleChatTemporaryIcon,
  Clock01Icon,
  Delete02Icon,
  Folder01Icon,
  GitBranchIcon,
  PinIcon,
  PinOffIcon,
} from "@hugeicons/core-free-icons";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import HoldToConfirm from "~/components/ui/HoldToConfirm.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import AgentFace from "~/components/agent/AgentFace.vue";
import { agentIdentity } from "~/utils/agentIdentity";
import { Magnet } from "~/components/ui/magnet";
import { sessionBrand } from "~/utils/modelCatalog";
import { sessionCost } from "~/utils/sessionCost";
import { timeAgo } from "~/utils/timeAgo";
import { formatUsd } from "~/utils/usageFormat";
import { prefetchThread } from "~/composables/useAgent";
import type { SessionSummary } from "~/types/session";

// The "recent conversations" block on Project Home — the PINNED / RECENT session
// thread: vendor logomark + working title, a mono meta line (branch · diff ·
// when), and a right-aligned token tally. Pure presentation — the split into
// pinned vs. recent and the data itself come from useRecentSessions.

const props = defineProps<{
  pinned: SessionSummary[];
  recent: SessionSummary[];
  /** Hold the block back until the first history read resolves — nothing flashes
   *  in before the list is known. */
  loading?: boolean;
}>();

const emit = defineEmits<{
  /** Bring this thread on-screen and continue it. */
  open: [threadId: string];
  /** Toggle this thread's pin. */
  pin: [threadId: string];
  /** Hide this thread from the list (recoverable). */
  archive: [threadId: string];
  /** Permanently delete this thread (already confirmed via hold). */
  delete: [threadId: string];
}>();

// Shared magnet settings — same soft pull the lane / file-detail actions use.
const magnet = {
  padding: 12,
  magnetStrength: 9,
  activeTransition: "transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)",
  inactiveTransition: "transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)",
} as const;

// One flat pass over both groups so the row markup lives in a single place; the
// PINNED group leads and wears a gold pin on its header. `start` is the cascade
// index of the group's first row so the stagger keeps counting across sections.
const sections = computed(() => {
  const out: {
    kind: "pinned" | "recent";
    label: string;
    rows: SessionSummary[];
    start: number;
  }[] = [];
  let start = 0;
  if (props.pinned.length) {
    out.push({ kind: "pinned", label: "PINNED", rows: props.pinned, start });
    start += props.pinned.length;
  }
  if (props.recent.length) {
    out.push({ kind: "recent", label: "RECENT", rows: props.recent, start });
  }
  return out;
});

const hasContent = computed(() => props.pinned.length > 0 || props.recent.length > 0);

// ── page-open entrance ──────────────────────────────────────────────────────
// Same beat as --proj-enter-sessions on the project-home mount root. The block
// holds until the first history read resolves — a placeholder on this beat
// flashes shimmer then immediately dissolves, because the IPC round-trip lands
// in the same window. Real rows then inherit whatever of that beat is still
// left, so a fast read still waits its turn and a late read doesn't restart
// the 230ms wait from scratch.
const SESSIONS_ENTER_MS = 230;
const openedAt = performance.now();
const waitedForRead = Boolean(props.loading);
const enterSessionsMs = ref(waitedForRead ? SESSIONS_ENTER_MS : 0);
watch(hasContent, (yes) => {
  if (!yes || !waitedForRead) return;
  enterSessionsMs.value = Math.round(
    Math.max(0, SESSIONS_ENTER_MS - (performance.now() - openedAt)),
  );
}, { flush: "pre" });

// ── lazy reveal ─────────────────────────────────────────────────────────────
// The component renders every row it is handed; the RECENT group starts capped
// (8) and grows a batch at a time as the sentinel below the list scrolls into
// view — no "view all" button, the list just keeps unrolling. Pinned rows are
// deliberate and never capped. The cap is display-only — nothing here touches
// the composable's own limit.
const RECENT_INITIAL = 8;
const RECENT_STEP = 8;
// Two counters drive the reveal. `recentLimit` is how many rows are mounted —
// the batch of real rows lands immediately, so its content is already there.
// `recentReady` is how many of those have had their skeleton overlay lifted.
// A row between the two is real underneath, masked by a shimmering skeleton on
// top; the mask fades out (skeleton leaves last) so content replaces it in
// place with no empty gap.
const recentLimit = ref(RECENT_INITIAL);
const recentReady = ref(RECENT_INITIAL);
const recentOvershoot = computed(() => Math.max(0, props.recent.length - recentLimit.value));
// Where the entrance cascade stops. Rows mounted while the block is still
// writing itself in join the stagger; anything revealed later lands settled,
// because there the mask's fade is the reveal.
const lazyFrom = ref(Number.POSITIVE_INFINITY);

function visibleRows(section: { kind: "pinned" | "recent"; rows: SessionSummary[] }): SessionSummary[] {
  if (section.kind === "recent") {
    return section.rows.slice(0, recentLimit.value);
  }
  return section.rows;
}
// A recent row is still masked while it sits past the ready mark. Pinned rows
// are always real.
function isLoading(section: { kind: "pinned" | "recent" }, ri: number): boolean {
  return section.kind === "recent" && ri >= recentReady.value;
}

// The observer watches a probe below the list: as it nears the viewport we mount
// the next batch (real content, behind skeleton masks), let the masks shimmer
// for a beat, then lift them. The rows are all in memory, so the delay is purely
// to let the skeleton register before the content settles in.
const REVEAL_DELAY = 460;
let observer: IntersectionObserver | null = null;
let revealTimer: number | undefined;
const revealing = ref(false);

// The skeleton is a scroll affordance — it answers "more is coming" for a batch
// the reader asked for. On open the probe already sits in view (eight rows
// rarely fill the region), so the first batch would fire on mount and shimmer
// through the entrance beat. Until the block has settled — or the reader scrolls,
// which is the ask the skeleton answers — reveals mount their rows outright and
// let them ride the cascade instead.
const SETTLE_MS = 750;
const revealArmed = ref(false);
let settleTimer: number | undefined;

function arm(): void {
  if (revealArmed.value) return;
  revealArmed.value = true;
  // Everything already on screen has had its entrance; only what comes next is
  // a lazy reveal.
  lazyFrom.value = recentLimit.value;
  window.clearTimeout(settleTimer);
  document.removeEventListener("scroll", arm, true);
}
// Scroll doesn't bubble, so listen in the capture phase to catch the block's own
// scroll region without reaching for it.
if (import.meta.client) document.addEventListener("scroll", arm, { capture: true, passive: true });
watch(hasContent, (yes) => {
  if (!yes || revealArmed.value || settleTimer !== undefined) return;
  settleTimer = window.setTimeout(arm, enterSessionsMs.value + SETTLE_MS);
}, { immediate: true });

function revealMore(): void {
  if (revealing.value || recentOvershoot.value === 0) return;
  recentLimit.value = Math.min(recentLimit.value + RECENT_STEP, props.recent.length);
  if (!revealArmed.value) {
    // Opening: fill the region with real rows, no mask, no wait. The probe never
    // left view, so the observer won't call again — keep going by hand until the
    // region is full.
    recentReady.value = recentLimit.value;
    void nextTick(() => {
      if (!revealArmed.value && probeInView()) revealMore();
    });
    return;
  }
  // Mount the next batch now (real rows appear, masked); lift the masks after a
  // beat so the skeleton is what fades, never a hole in the list.
  revealing.value = true;
  revealTimer = window.setTimeout(() => {
    recentReady.value = recentLimit.value;
    revealing.value = false;
  }, REVEAL_DELAY);
}
const REVEAL_MARGIN = 240;
let sentinelEl: Element | null = null;
// Same reach the observer's rootMargin has, asked directly — used while opening,
// where the observer stays quiet because the probe never leaves view.
function probeInView(): boolean {
  if (!sentinelEl) return false;
  return sentinelEl.getBoundingClientRect().top <= window.innerHeight + REVEAL_MARGIN;
}

// Template (function) ref: the probe mounts and unmounts with the overshoot, so
// (re)wire the observer whenever the element itself changes.
function setSentinel(el: Element | null | any): void {
  observer?.disconnect();
  observer = null;
  // SAFETY: this is a Vue template (function) ref — Vue passes the mounted
  // element itself here, typed as Element; the `any` slot just absorbs the
  // unmount call where Vue passes null.
  sentinelEl = (el as Element | null) ?? null;
  if (!el || !("IntersectionObserver" in globalThis)) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) revealMore();
    },
    { rootMargin: `0px 0px ${REVEAL_MARGIN}px 0px` },
  );
  // SAFETY: the guard above returned unless el is truthy, and the observer
  // only accepts real Element targets.
  observer.observe(el as Element);
}
watch(
  () => props.recent.length,
  (len) => {
    if (recentLimit.value > len) recentLimit.value = Math.max(RECENT_INITIAL, len);
    if (recentReady.value > recentLimit.value) recentReady.value = recentLimit.value;
  },
);
onBeforeUnmount(() => {
  observer?.disconnect();
  window.clearTimeout(revealTimer);
  window.clearTimeout(settleTimer);
  document.removeEventListener("scroll", arm, true);
});

// 3_200_000 → "3.2M", 480_000 → "480K". Trims trailing zeros so 1.9M / 1.24M
// both read cleanly.
function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1e3) {
    const v = n / 1e3;
    return `${v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(n);
}

// A row shows the diff lane only when a source attributed one; otherwise the
// model name stands in so the meta line never reads empty on the desktop path.
function hasDiff(s: SessionSummary): boolean {
  return (
    (s.added !== undefined && s.added !== null && Number.isFinite(s.added)) ||
    (s.removed !== undefined && s.removed !== null && Number.isFinite(s.removed))
  );
}

const METRIC_KEY = "kone:recent-sessions-metric";
const metric = ref<"tokens" | "cost">("tokens");

if (import.meta.client) {
  const saved = localStorage.getItem(METRIC_KEY);
  if (saved === "tokens" || saved === "cost") {
    metric.value = saved;
  }
}

watch(metric, (val) => {
  if (import.meta.client) {
    try {
      localStorage.setItem(METRIC_KEY, val);
    } catch {
      /* localStorage best-effort */
    }
  }
});

function hasMetricValue(s: SessionSummary): boolean {
  if (metric.value === "cost") return sessionCost(s) > 0;
  return s.tokens !== undefined && s.tokens !== null && Number.isFinite(s.tokens) && s.tokens > 0;
}
</script>

<template>
  <!-- Hold until the first read resolves, and stay out of the layout entirely
       when there's nothing to show — no empty header, no reserved gap, no
       placeholder flash on the way in. The rows arrive with the data and take
       whatever is left of the project-home sessions beat. -->
  <Transition name="rs-out">
    <section
      v-if="hasContent"
      class="rs"
      :style="{ '--proj-enter-sessions': `${enterSessionsMs}ms` }"
    >
        <div v-for="(section, sIdx) in sections" :key="section.kind" class="rs__group">
      <div class="rs__head" :style="{ '--i': section.start }">
        <div class="rs__head-tag">
          <HugeiconsIcon
            class="rs__hicon"
            :class="section.kind === 'pinned' ? 'rs__pin' : 'rs__clock'"
            :icon="section.kind === 'pinned' ? PinIcon : Clock01Icon"
            :size="11"
            :stroke-width="1.8"
            aria-hidden="true"
          />
          <span class="rs__label">{{ section.label }}</span>
        </div>

        <div v-if="sIdx === 0" class="rs__switch" role="group" aria-label="Metric measure">
          <button
            type="button"
            class="rs__switch-btn"
            :class="{ 'rs__switch-btn--on': metric === 'tokens' }"
            @click="metric = 'tokens'"
          >
            Tokens
          </button>
          <button
            type="button"
            class="rs__switch-btn"
            :class="{ 'rs__switch-btn--on': metric === 'cost' }"
            @click="metric = 'cost'"
          >
            Cost
          </button>
        </div>
      </div>

      <ul class="rs__list">
        <li
          v-for="(s, ri) in visibleRows(section)"
          :key="s.threadId"
          class="rs__row"
          :class="{
            'rs__row--loading': isLoading(section, ri),
            'rs__row--lazy': section.kind === 'recent' && ri >= lazyFrom,
          }"
          :style="{ '--i': section.start + ri }"
          :role="isLoading(section, ri) ? undefined : 'button'"
          :tabindex="isLoading(section, ri) ? -1 : 0"
          :aria-hidden="isLoading(section, ri) ? 'true' : undefined"
          @click="!isLoading(section, ri) && emit('open', s.threadId)"
          @keydown.enter.prevent="!isLoading(section, ri) && emit('open', s.threadId)"
          @keydown.space.prevent="!isLoading(section, ri) && emit('open', s.threadId)"
          @pointerenter="!isLoading(section, ri) && prefetchThread(s.threadId)"
          @focus="!isLoading(section, ri) && prefetchThread(s.threadId)"
        >
          <!-- Skeleton mask: the real row is already mounted underneath; this
               shimmering cover sits on top until the row is marked ready, then
               fades out — so the placeholder is what leaves, revealing content
               already in place rather than snapping a fresh row in. -->
          <Transition name="rs-mask">
            <div v-if="isLoading(section, ri)" class="rs__mask" aria-hidden="true">
              <div class="rs__skel-lead">
                <span class="rs__skel-avatar rs__shimmer" />
              </div>
              <div class="rs__skel-main">
                <div class="rs__skel-title">
                  <span
                    class="rs__skel-name rs__shimmer"
                    :style="{ width: 42 + ((ri * 13) % 34) + '%' }"
                  />
                </div>
                <div class="rs__skel-meta">
                  <span class="rs__skel-chip rs__shimmer" style="width: 48px" />
                  <span class="rs__skel-chip rs__shimmer" style="width: 68px" />
                  <span class="rs__skel-chip rs__shimmer" style="width: 40px" />
                  <span class="rs__skel-chip rs__shimmer" style="width: 52px" />
                </div>
              </div>
              <span class="rs__skel-tokens rs__shimmer" />
            </div>
          </Transition>

          <div class="rs__lead">
            <div class="rs__avatar-wrap">
              <AgentFace :seed="s.threadId" :size="36" class="rs__face" />
              <span
                class="rs__badge"
                :title="sessionBrand(s.provider, s.brand, s.model)"
              >
                <ProviderLogo :brand="sessionBrand(s.provider, s.brand, s.model)" :size="20" />
              </span>
            </div>
          </div>

          <div class="rs__main">
            <div class="rs__title">
              <span v-if="s.sideChat" class="rs__sidechat" title="Side chat — forked from a conversation">
                <HugeiconsIcon :icon="BubbleChatTemporaryIcon" :size="12" :stroke-width="2" aria-hidden="true" />
              </span>
              <span class="rs__name">{{ s.title }}</span>
            </div>

            <div class="rs__meta">
              <span class="rs__agent">
                {{ agentIdentity(s.threadId).name }}
              </span>

              <span v-if="s.projectName" class="rs__project" :title="s.projectPath">
                <HugeiconsIcon :icon="Folder01Icon" :size="12" :stroke-width="1.7" aria-hidden="true" />
                {{ s.projectName }}
              </span>

              <span v-if="s.branch" class="rs__branch">
                <HugeiconsIcon :icon="GitBranchIcon" :size="12" :stroke-width="2" aria-hidden="true" />
                {{ s.branch }}
              </span>

              <template v-if="hasDiff(s)">
                <span v-if="s.added" class="rs__add">+{{ s.added }}</span>
                <span v-if="s.removed" class="rs__del">−{{ s.removed }}</span>
              </template>
              <span v-else-if="s.model" class="rs__model">{{ s.model }}</span>

              <span class="rs__when">{{ timeAgo(s.updatedAt) }}</span>
            </div>
          </div>

          <div class="rs__trail">
            <!-- A token / cost tally reads as "this thread cost X" — absent or zero it
                 would claim "cost nothing", which a Cursor thread (no usage
                 reported) must never imply. Only render a real, positive spend. -->
            <div v-if="hasMetricValue(s)" class="rs__tokens">
              <Transition name="rs-swap" mode="out-in">
                <div :key="metric" class="rs__metric-val">
                  <span class="rs__count">
                    {{ metric === "cost" ? formatUsd(sessionCost(s)) : formatTokens(s.tokens ?? 0) }}
                  </span>
                  <span class="rs__unit">{{ metric === "cost" ? "USD" : "TOKENS" }}</span>
                </div>
              </Transition>
            </div>

            <!-- Overlay the token tally on hover / focus. Each magnet-pulls
                 like the lane actions; delete is hold-to-confirm. Stops
                 propagation so they never also open the thread. -->
            <div class="rs__actions" @click.stop>
              <Magnet
                class="w-fit"
                inner-class="w-fit"
                v-bind="magnet"
              >
                <button
                  type="button"
                  class="rs__act"
                  :class="{ 'rs__act--on': s.pinned }"
                  :aria-label="s.pinned ? 'Unpin conversation' : 'Pin conversation'"
                  @click="emit('pin', s.threadId)"
                >
                  <HugeiconsIcon
                    :icon="s.pinned ? PinOffIcon : PinIcon"
                    :size="12"
                    :stroke-width="1.7"
                    aria-hidden="true"
                  />
                  {{ s.pinned ? "Unpin" : "Pin" }}
                </button>
              </Magnet>

              <Magnet
                class="w-fit"
                inner-class="w-fit"
                v-bind="magnet"
              >
                <button
                  type="button"
                  class="rs__act"
                  aria-label="Archive conversation"
                  @click="emit('archive', s.threadId)"
                >
                  <HugeiconsIcon :icon="Archive02Icon" :size="12" :stroke-width="1.7" aria-hidden="true" />
                  Archive
                </button>
              </Magnet>

              <Magnet
                class="w-fit"
                inner-class="w-fit"
                v-bind="magnet"
              >
                <HoldToConfirm
                  variant="lane-discard"
                  title="Hold to delete conversation"
                  aria-label="Hold to delete conversation"
                  @confirm="emit('delete', s.threadId)"
                >
                  <HugeiconsIcon :icon="Delete02Icon" :size="12" :stroke-width="1.7" aria-hidden="true" />
                  Delete
                </HoldToConfirm>
              </Magnet>
            </div>
          </div>
        </li>
      </ul>

      <!-- Reveal-on-scroll probe: while more recents remain uncapped, this thin
           element sits below the list; when it nears view the next batch mounts
           (already-loaded rows behind skeleton masks) and the masks then lift. -->
      <div
        v-if="section.kind === 'recent' && recentOvershoot > 0"
        :ref="setSentinel"
        class="rs__probe"
        aria-hidden="true"
      />
    </div>
    </section>
  </Transition>
</template>

<style scoped>
.rs {
  position: relative;
  display: flex;
  flex-direction: column;
  /* Extra air between the PINNED and RECENT groups so the two sections read as
     distinct, not one continuous run of rows. */
  gap: 40px;
  width: 100%;
}
.rs__group {
  display: flex;
  flex-direction: column;
  /* Head owns the gap to its list now (via padding-bottom) so the sticky band
     can cover rows sliding under it — see .rs__head. */
  gap: 0;
}

/* ── entrance ─────────────────────────────────────────────────────────────
   Same cadence as the change lanes: the section label lifts in, then each
   thread row cascades down the list — soft rise + slight settle, staggered
   across PINNED → RECENT so the page keeps writing itself after the tree. */
@keyframes rs-head-in {
  from { opacity: 0; transform: translateY(9px); }
  to { opacity: 1; transform: none; }
}
@keyframes rs-row-in {
  from { opacity: 0; transform: translateY(14px) scale(0.985); }
  to { opacity: 1; transform: none; }
}

/* ── section header ─────────────────────────────────────────────────────── */
.rs__head {
  /* The section label sticks to the top of the scroll region while its own
     group's rows scroll beneath it, then hands off to the next group's label.
     The band carries the page ground and dissolves over its last few pixels so
     rows melt under it rather than clipping at a hard line — kone's house edge. */
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
  padding-bottom: 14px;
  background: linear-gradient(
    to bottom,
    var(--ground) 0,
    var(--ground) calc(100% - 12px),
    transparent 100%
  );
  animation: rs-head-in 320ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  /* Lead the group's first row by the same 50ms the lane head leads its tiles. */
  animation-delay: calc(var(--proj-enter-sessions, 0ms) + min(var(--i, 0) * 30ms, 360ms));
}
.rs__head-tag {
  display: flex;
  align-items: center;
  gap: 7px;
}
.rs__switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
}
.rs__switch-btn {
  padding: 2px 7px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.04em;
  line-height: 14px;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.16s ease, background-color 0.16s ease, box-shadow 0.16s ease;
}
.rs__switch-btn:hover {
  color: var(--ink);
}
.rs__switch-btn--on {
  background: var(--ground);
  color: var(--ink);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 8%, transparent);
}
.rs__hicon {
  flex-shrink: 0;
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
/* Pin warms to gold — the deliberate group. */
.rs__pin {
  stroke: var(--warn);
}
/* The recent clock stays quiet, tinted to match its label. */
.rs__clock {
  stroke: var(--faint);
}
.rs__label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  line-height: 1;
  color: var(--faint);
}
/* The pinned header carries the gold pin, so its label warms to match. */
.rs__head:has(.rs__pin) .rs__label {
  color: var(--warn);
}

/* ── rows ───────────────────────────────────────────────────────────────── */
.rs__list {
  display: flex;
  flex-direction: column;
  gap: 22px;
  margin: 0;
  padding: 0;
  list-style: none;
}
/* Reveal-on-scroll probe — a thin element below the RECENT list the observer
   watches; when it nears view the next batch mounts. Takes almost no space. */
.rs__probe {
  height: 8px;
  margin-top: 14px;
  pointer-events: none;
}

/* An empty read closes the whole block with a quiet fade instead of the page
   snapping shut. */
.rs-out-leave-active {
  transition: opacity 0.28s ease;
}
.rs-out-leave-to {
  opacity: 0;
}

/* Skeleton mask — mirrors the real row's geometry (dot + name over a mono meta
   line, token block on the right) and sits over the already-mounted row until
   it's marked ready. Ground-filled so the real content behind never shows
   through early; it fades out (leave transition below), so the placeholder is
   what leaves and the content is already there. */
.rs__mask {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  background: var(--ground);
  pointer-events: auto;
}
.rs-mask-leave-active {
  transition: opacity 440ms cubic-bezier(0.22, 1, 0.36, 1);
}
.rs-mask-leave-to {
  opacity: 0;
}
.rs__skel-lead {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.rs__skel-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  flex: none;
}
.rs__skel-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.rs__skel-title {
  display: flex;
  align-items: center;
  gap: 9px;
}
.rs__skel-name {
  height: 14px;
  border-radius: 5px;
  max-width: 320px;
}
.rs__skel-meta {
  display: flex;
  align-items: center;
  gap: 10px;
}
.rs__skel-chip {
  height: 9px;
  border-radius: 4px;
}
.rs__skel-tokens {
  width: 54px;
  height: 24px;
  border-radius: 6px;
  flex: none;
}
/* The shimmer itself — a soft sweep across a low-contrast fill, house-calm (no
   hard highlight). Honors reduced-motion by holding a static fill. */
.rs__shimmer {
  display: inline-block;
  background:
    linear-gradient(
      100deg,
      transparent 20%,
      color-mix(in srgb, var(--ink) 6%, transparent) 40%,
      color-mix(in srgb, var(--ink) 10%, transparent) 50%,
      color-mix(in srgb, var(--ink) 6%, transparent) 60%,
      transparent 80%
    ),
    color-mix(in srgb, var(--ink) 5%, transparent);
  background-size: 220% 100%, 100% 100%;
  background-repeat: no-repeat;
  animation: rs-shimmer 1.4s ease-in-out infinite;
}
@keyframes rs-shimmer {
  from { background-position: 180% 0, 0 0; }
  to { background-position: -80% 0, 0 0; }
}
@media (prefers-reduced-motion: reduce) {
  .rs__shimmer { animation: none; }
  .rs-mask-leave-active { transition: opacity 160ms ease; }
  .rs-out-leave-active { transition: opacity 160ms ease; }
}
.rs__row {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  cursor: pointer;
  border-radius: 10px;
  outline: none;
  /* Grows from its left edge on hover so the list stays anchored — paired with
     the entrance rise below. Transform is shared, so the hover scale settles in
     once the row-in keyframes finish. Promoted to its own compositor layer so
     the scale composites instead of re-rasterizing the row's text each frame —
     that repaint is what read as rigid. */
  /* The hover grows the row rightward from its left edge; reserve that growth
     on the right so the scaled row never overflows the scroll region (whose
     overflow-x-hidden would otherwise clip the trailing actions — the Delete
     button's last letter was getting cut). 14px clears the max 0.9% growth at
     the widest panel plus the delete button's magnet pull. */
  margin-right: 14px;
  transform-origin: left center;
  will-change: transform;
  backface-visibility: hidden;
  animation: rs-row-in 300ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: calc(var(--proj-enter-sessions, 0ms) + 50ms + min(var(--i, 0) * 30ms, 360ms));
  transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}
.rs__row:hover,
.rs__row:focus-visible,
.rs__row:focus-within {
  transform: scale(1.009);
}
/* Lazily-revealed rows land already settled — no entrance rise, since they wake
   up behind the skeleton mask and the mask's fade is the reveal. */
.rs__row--lazy {
  animation: none;
}
/* A masked row is inert: the mask blocks pointer input, and the hover lift is
   suppressed so nothing stirs behind the placeholder. */
.rs__row--loading {
  cursor: default;
}
.rs__row--loading:hover,
.rs__row--loading:focus-within {
  transform: none;
}
/* Borderless row — the whole row opens the thread; on hover the title lights
   up (ink-soft → ink, same as lane / file-detail actions) and the trailing
   actions fade in. */
.rs__row:hover .rs__name,
.rs__row:focus-visible .rs__name,
.rs__row:focus-within .rs__name {
  color: var(--ink);
}
.rs__row:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}
.rs__lead {
  position: relative;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  transition: width 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}
.rs__row:not(.rs__row--loading):hover .rs__lead,
.rs__row:not(.rs__row--loading):focus-visible .rs__lead,
.rs__row:not(.rs__row--loading):focus-within .rs__lead {
  width: 78px;
}
.rs__avatar-wrap {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 36px;
}
.rs__face {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  flex-shrink: 0;
}
.rs__badge {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--ground);
  box-shadow: 0 0 0 3px var(--ground);
  color: var(--ink);
  transform-origin: center center;
  transform: translate(11px, 11px) scale(0.52);
  will-change: transform;
  transition:
    transform 0.34s cubic-bezier(0.22, 1, 0.36, 1),
    background-color 0.34s cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}
.rs__badge :deep(svg) {
  transform-origin: center center;
  transform: scale(1.22);
  will-change: transform;
  transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}
.rs__row:not(.rs__row--loading):hover .rs__badge,
.rs__row:not(.rs__row--loading):focus-visible .rs__badge,
.rs__row:not(.rs__row--loading):focus-within .rs__badge {
  transform: translate(42px, 0) scale(1);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  box-shadow: 0 0 0 0px transparent;
}
.rs__row:not(.rs__row--loading):hover .rs__badge :deep(svg),
.rs__row:not(.rs__row--loading):focus-visible .rs__badge :deep(svg),
.rs__row:not(.rs__row--loading):focus-within .rs__badge :deep(svg) {
  transform: scale(1);
}
.rs__main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.rs__title {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.rs__name {
  font-family: var(--font-sans);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 20px;
  color: var(--ink-soft);
  transition: color 0.16s ease;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The side-chat marker — just the icon, tinted the same accent as the thread
   column's, so a forked conversation never reads as a main one. */
.rs__sidechat {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: color-mix(in srgb, var(--accent) 75%, var(--ink-soft));
}

/* mono meta line — branch · diff · when */
.rs__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 14px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.rs__branch {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.rs__branch svg {
  flex-shrink: 0;
  stroke: var(--muted);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Project chip — only on the App Home aggregate, where a row can come from any
   project. Reads a shade firmer than the branch/diff metadata beside it so the
   "which project" answer leads the line. */
.rs__agent {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  color: var(--ink-soft);
}
.rs__project {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--ink-soft);
  font-weight: 500;
}
.rs__project svg {
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.rs__model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rs__add { color: var(--diff-add); }
.rs__del { color: var(--diff-del); }

/* ── token tally ────────────────────────────────────────────────────────── */
.rs__tokens {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  flex-shrink: 0;
  will-change: opacity;
  /* Matches the actions' reveal curve/duration so the token→actions crossfade
     reads as one exchange rather than two overlapping fades. */
  transition: opacity 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}
.rs__metric-val {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.rs-swap-enter-active,
.rs-swap-leave-active {
  transition:
    opacity 0.18s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.rs-swap-enter-from {
  opacity: 0;
  transform: translateY(3px);
}
.rs-swap-leave-to {
  opacity: 0;
  transform: translateY(-3px);
}
.rs__count {
  font-family: var(--font-mono);
  font-size: 22px;
  letter-spacing: -0.02em;
  line-height: 28px;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.rs__unit {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  line-height: 12px;
  color: var(--faint);
}

/* ── trailing row actions ───────────────────────────────────────────────── */
.rs__trail {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-shrink: 0;
  min-width: 86px;
  min-height: 40px;
}
/* Overlay the token tally on hover — actions sit in front, tokens fade out
   underneath so the trail width never shifts. */
.rs__actions {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  opacity: 0;
  transform: translateX(6px);
  pointer-events: none;
  will-change: opacity, transform;
  /* Same reveal as ChangeLane's lane actions — opacity fade plus a soft slide.
     Shares the row's easing and rides its full duration so the reveal and the
     row's scale move on one clock rather than finishing at different times. */
  transition:
    opacity 0.34s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}
.rs__row:hover .rs__actions,
.rs__row:focus-within .rs__actions {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
.rs__row:hover .rs__tokens,
.rs__row:focus-within .rs__tokens {
  opacity: 0;
}
@media (hover: none) {
  .rs__actions {
    opacity: 1;
    transform: none;
    pointer-events: auto;
  }
  .rs__tokens { opacity: 0; }
}
.rs__act {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.16s ease;
}
.rs__act svg {
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.rs__act:hover,
.rs__act:focus-visible {
  color: var(--ink);
}
.rs__act:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 30%, transparent);
}
/* Pinned: the pin sits lit in gold even at rest. */
.rs__act--on {
  color: var(--warn);
}
.rs__act--on svg {
  fill: color-mix(in srgb, currentColor 22%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .rs__head,
  .rs__row { animation: none; }
  .rs__row,
  .rs__row:hover,
  .rs__row:focus-visible,
  .rs__row:focus-within {
    transform: none;
    transition: none;
  }
  .rs__lead,
  .rs__badge,
  .rs__badge :deep(svg) {
    transition: none;
  }
  .rs-swap-enter-active,
  .rs-swap-leave-active {
    transition: opacity 0.1s ease;
    transform: none;
  }
  .rs__actions {
    transition: opacity 0.18s ease;
    transform: none;
  }
}

html.dark .rs__name {
  color: var(--muted);
}
</style>
