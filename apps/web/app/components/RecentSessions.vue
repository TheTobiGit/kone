<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  Archive02Icon,
  BubbleChatTemporaryIcon,
  Delete02Icon,
  Folder01Icon,
  GitBranchIcon,
  PinIcon,
  PinOffIcon,
} from "@hugeicons/core-free-icons";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import HoldToConfirm from "~/components/HoldToConfirm.vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import { Magnet } from "~/components/ui/magnet";
import { sessionBrand } from "~/utils/modelCatalog";
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

function revealMore(): void {
  if (revealing.value || recentOvershoot.value === 0) return;
  revealing.value = true;
  // Mount the next batch now (real rows appear, masked); lift the masks after a
  // beat so the skeleton is what fades, never a hole in the list.
  recentLimit.value = Math.min(recentLimit.value + RECENT_STEP, props.recent.length);
  revealTimer = window.setTimeout(() => {
    recentReady.value = recentLimit.value;
    revealing.value = false;
  }, REVEAL_DELAY);
}
// Template (function) ref: the probe mounts and unmounts with the overshoot, so
// (re)wire the observer whenever the element itself changes.
function setSentinel(el: Element | null | any): void {
  observer?.disconnect();
  observer = null;
  if (!el || typeof IntersectionObserver === "undefined") return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) revealMore();
    },
    { rootMargin: "0px 0px 240px 0px" },
  );
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

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.floor(d / 365)}y ago`;
}

// A row shows the diff lane only when a source attributed one; otherwise the
// model name stands in so the meta line never reads empty on the desktop path.
function hasDiff(s: SessionSummary): boolean {
  return typeof s.added === "number" || typeof s.removed === "number";
}
</script>

<template>
  <!-- Hold until the first read resolves, and stay out of the layout entirely
       when there's nothing to show — no empty header, no reserved gap. -->
  <section v-if="!loading && hasContent" class="rs">
    <div v-for="section in sections" :key="section.kind" class="rs__group">
      <div class="rs__head" :style="{ '--i': section.start }">
        <HugeiconsIcon
          v-if="section.kind === 'pinned'"
          class="rs__pin"
          :icon="PinIcon"
          :size="11"
          :stroke-width="1.8"
          aria-hidden="true"
        />
        <span class="rs__label">{{ section.label }}</span>
      </div>

      <ul class="rs__list">
        <li
          v-for="(s, ri) in visibleRows(section)"
          :key="s.threadId"
          class="rs__row"
          :class="{
            'rs__row--loading': isLoading(section, ri),
            'rs__row--lazy': section.kind === 'recent' && ri >= RECENT_INITIAL,
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
              <div class="rs__skel-main">
                <div class="rs__skel-title">
                  <span class="rs__skel-dot rs__shimmer" />
                  <span
                    class="rs__skel-name rs__shimmer"
                    :style="{ width: 42 + ((ri * 13) % 34) + '%' }"
                  />
                </div>
                <div class="rs__skel-meta">
                  <span class="rs__skel-chip rs__shimmer" style="width: 68px" />
                  <span class="rs__skel-chip rs__shimmer" style="width: 40px" />
                  <span class="rs__skel-chip rs__shimmer" style="width: 52px" />
                </div>
              </div>
              <span class="rs__skel-tokens rs__shimmer" />
            </div>
          </Transition>

          <div class="rs__main">
            <div class="rs__title">
              <ProviderLogo :brand="sessionBrand(s.provider, s.brand, s.model)" :size="16" />
              <span v-if="s.sideChat" class="rs__sidechat" title="Side chat — forked from a conversation">
                <HugeiconsIcon :icon="BubbleChatTemporaryIcon" :size="12" :stroke-width="2" aria-hidden="true" />
              </span>
              <span class="rs__name">{{ s.title }}</span>
            </div>

            <div class="rs__meta">
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
            <!-- A token tally reads as "this thread cost X" — absent or zero it
                 would claim "cost nothing", which a Cursor thread (no usage
                 reported) must never imply. Only render a real, positive spend. -->
            <div v-if="typeof s.tokens === 'number' && s.tokens > 0" class="rs__tokens">
              <span class="rs__count">{{ formatTokens(s.tokens) }}</span>
              <span class="rs__unit">TOKENS</span>
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
</template>

<style scoped>
.rs {
  display: flex;
  flex-direction: column;
  gap: 22px;
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
.rs__pin {
  flex-shrink: 0;
  fill: none;
  stroke: var(--pin-ink, #a57c2b);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.rs__label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  line-height: 1;
  color: var(--rs-label, #b0afaa);
}
/* The pinned header carries the gold pin, so its label warms to match. */
.rs__head:has(.rs__pin) .rs__label {
  color: var(--pin-ink, #a57c2b);
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
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  background: var(--ground);
  pointer-events: auto;
}
.rs-mask-leave-active {
  transition: opacity 440ms cubic-bezier(0.22, 1, 0.36, 1);
}
.rs-mask-leave-to {
  opacity: 0;
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
.rs__skel-dot {
  width: 16px;
  height: 16px;
  border-radius: 5px;
  flex: none;
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
      color-mix(in srgb, var(--ink, #1c1c1f) 6%, transparent) 40%,
      color-mix(in srgb, var(--ink, #1c1c1f) 10%, transparent) 50%,
      color-mix(in srgb, var(--ink, #1c1c1f) 6%, transparent) 60%,
      transparent 80%
    ),
    color-mix(in srgb, var(--ink, #1c1c1f) 5%, transparent);
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
}
@media (prefers-color-scheme: dark) {
  .rs__shimmer {
    background:
      linear-gradient(
        100deg,
        transparent 20%,
        color-mix(in srgb, #fff 8%, transparent) 40%,
        color-mix(in srgb, #fff 13%, transparent) 50%,
        color-mix(in srgb, #fff 8%, transparent) 60%,
        transparent 80%
      ),
      color-mix(in srgb, #fff 6%, transparent);
    background-size: 220% 100%, 100% 100%;
    background-repeat: no-repeat;
  }
}
.rs__row {
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
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
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink, #1c1c1f) 30%, transparent);
}
.rs__main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
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
  color: color-mix(in srgb, var(--accent, #8b5cf6) 75%, var(--ink-soft, #3f3f46));
}

/* mono meta line — branch · diff · when */
.rs__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 14px;
  color: var(--rs-muted, #a1a1aa);
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
  stroke: var(--rs-muted, #a1a1aa);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Project chip — only on the App Home aggregate, where a row can come from any
   project. Reads a shade firmer than the branch/diff metadata beside it so the
   "which project" answer leads the line. */
.rs__project {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--rs-project, #6b6b70);
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
.rs__add { color: #059669; }
.rs__del { color: #e11d48; }

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
.rs__count {
  font-family: var(--font-mono);
  font-size: 22px;
  letter-spacing: -0.02em;
  line-height: 28px;
  color: var(--rs-count, #27272a);
  font-variant-numeric: tabular-nums;
}
.rs__unit {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  line-height: 12px;
  color: var(--rs-label, #b0afaa);
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
  color: var(--rs-muted, #a1a1aa);
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
  color: var(--ink, #1c1c1f);
}
.rs__act:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink, #1c1c1f) 30%, transparent);
}
/* Pinned: the pin sits lit in gold even at rest. */
.rs__act--on {
  color: var(--pin-ink, #a57c2b);
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
  .rs__actions {
    transition: opacity 0.18s ease;
    transform: none;
  }
}

@media (prefers-color-scheme: dark) {
  .rs {
    --rs-muted: #8a8a90;
    --rs-label: #6b6b70;
    --rs-count: #ededf0;
    --rs-project: #b6b6bd;
    --pin-ink: #c99b45;
  }
  .rs__name {
    color: var(--muted);
  }
}
</style>
