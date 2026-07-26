<script setup lang="ts">
import { computed, ref } from "vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
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
  /** Permanently delete this thread (already confirmed here). */
  delete: [threadId: string];
}>();

// Delete is irreversible, so the trash acts in two taps: the first arms the row
// (the icon becomes a check), a second within the window confirms. Any other
// action — or clicking away — disarms it. One row can be armed at a time.
const armedId = ref<string | null>(null);

function onDelete(threadId: string): void {
  if (armedId.value === threadId) {
    armedId.value = null;
    emit("delete", threadId);
  } else {
    armedId.value = threadId;
  }
}
function disarm(): void {
  armedId.value = null;
}

// One flat pass over both groups so the row markup lives in a single place; the
// PINNED group leads and wears a gold pin on its header.
const sections = computed(() => {
  const out: { kind: "pinned" | "recent"; label: string; rows: SessionSummary[] }[] = [];
  if (props.pinned.length) out.push({ kind: "pinned", label: "PINNED", rows: props.pinned });
  if (props.recent.length) out.push({ kind: "recent", label: "RECENT", rows: props.recent });
  return out;
});

const hasContent = computed(() => props.pinned.length > 0 || props.recent.length > 0);

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
      <div class="rs__head">
        <svg
          v-if="section.kind === 'pinned'"
          class="rs__pin"
          viewBox="0 0 24 24"
          width="11"
          height="11"
          aria-hidden="true"
        >
          <path d="M9 4h6M10 4l-.6 6.2-2.9 1.9v1.1h11v-1.1l-2.9-1.9L14 4M12 15.2V20" />
        </svg>
        <span class="rs__label">{{ section.label }}</span>
      </div>

      <ul class="rs__list">
        <li
          v-for="s in section.rows"
          :key="s.threadId"
          class="rs__row"
          :class="{ 'rs__row--armed': armedId === s.threadId }"
          role="button"
          tabindex="0"
          @click="emit('open', s.threadId)"
          @keydown.enter.prevent="emit('open', s.threadId)"
          @keydown.space.prevent="emit('open', s.threadId)"
          @mouseleave="disarm"
        >
          <div class="rs__main">
            <div class="rs__title">
              <ProviderLogo :brand="s.brand" :size="16" />
              <span class="rs__name">{{ s.title }}</span>
            </div>

            <div class="rs__meta">
              <span v-if="s.branch" class="rs__branch">
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" fill="none" />
                  <circle cx="6" cy="18" r="3" fill="none" />
                  <path d="M18 9a9 9 0 0 1-9 9" fill="none" />
                </svg>
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
            <div v-if="typeof s.tokens === 'number'" class="rs__tokens">
              <span class="rs__count">{{ formatTokens(s.tokens) }}</span>
              <span class="rs__unit">TOKENS</span>
            </div>

            <!-- Revealed on row hover / focus. Each stops propagation so it never
                 also opens the thread. -->
            <div class="rs__actions">
              <button
                type="button"
                class="rs__act"
                :class="{ 'rs__act--on': s.pinned }"
                :title="s.pinned ? 'Unpin' : 'Pin'"
                :aria-label="s.pinned ? 'Unpin conversation' : 'Pin conversation'"
                @click.stop="emit('pin', s.threadId)"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <path d="M9 4h6M10 4l-.6 6.2-2.9 1.9v1.1h11v-1.1l-2.9-1.9L14 4M12 15.2V20" />
                </svg>
              </button>

              <button
                type="button"
                class="rs__act"
                title="Archive"
                aria-label="Archive conversation"
                @click.stop="emit('archive', s.threadId)"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <path d="M4 7h16M5 7v11.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7M4 7l1.4-2.5A1 1 0 0 1 6.3 4h11.4a1 1 0 0 1 .9.5L20 7M9.5 12h5" />
                </svg>
              </button>

              <button
                type="button"
                class="rs__act rs__act--danger"
                :title="armedId === s.threadId ? 'Confirm delete' : 'Delete'"
                :aria-label="armedId === s.threadId ? 'Confirm delete' : 'Delete conversation'"
                @click.stop="onDelete(s.threadId)"
              >
                <svg
                  v-if="armedId === s.threadId"
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  aria-hidden="true"
                >
                  <path d="M5 12.5 10 17.5 19 6.5" />
                </svg>
                <svg v-else viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <path d="M4 7h16M9 7V4.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8V7M6.5 7l.8 12.1a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9L18.5 7M10 11v6M14 11v6" />
                </svg>
              </button>
            </div>
          </div>
        </li>
      </ul>
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
  gap: 14px;
}

/* ── section header ─────────────────────────────────────────────────────── */
.rs__head {
  display: flex;
  align-items: center;
  gap: 7px;
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
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.rs__row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  cursor: pointer;
  border-radius: 10px;
  outline: none;
  animation: rs-row-in 500ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
/* Borderless, card-free affordance — the whole row is clickable; on hover the
   title nudges toward the iris and the trailing actions fade in, no box drawn. */
.rs__name {
  transition: color 140ms ease;
}
.rs__row:hover .rs__name,
.rs__row:focus-visible .rs__name {
  color: var(--iris, #6b5bd2);
}
.rs__row:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--iris, #6b5bd2) 55%, transparent);
  outline-offset: 6px;
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
  color: var(--ink, #1c1c1f);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
/* Reserve the actions' width so revealing them never shifts the token tally;
   they simply fade in from the right on hover / focus / when armed. */
.rs__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transform: translateX(4px);
  pointer-events: none;
  transition: opacity 140ms ease, transform 140ms ease;
}
.rs__row:hover .rs__actions,
.rs__row:focus-within .rs__actions,
.rs__row--armed .rs__actions {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
.rs__act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--rs-muted, #a1a1aa);
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease;
}
.rs__act svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.rs__act:hover {
  color: var(--ink, #1c1c1f);
  background: color-mix(in srgb, currentColor 10%, transparent);
}
/* Pinned: the pin sits lit in gold even at rest. */
.rs__act--on {
  color: var(--pin-ink, #a57c2b);
}
.rs__act--on svg {
  fill: color-mix(in srgb, currentColor 22%, transparent);
}
.rs__act--danger:hover {
  color: #e11d48;
  background: color-mix(in srgb, #e11d48 12%, transparent);
}
/* Armed for deletion — the trash has become a check and reads hot. */
.rs__row--armed .rs__act--danger {
  color: #e11d48;
  background: color-mix(in srgb, #e11d48 14%, transparent);
}

@keyframes rs-row-in {
  from { opacity: 0; transform: translateY(8px); }
}
@media (prefers-reduced-motion: reduce) {
  .rs__row { animation: none; }
}

@media (prefers-color-scheme: dark) {
  .rs {
    --rs-muted: #8a8a90;
    --rs-label: #6b6b70;
    --rs-count: #ededf0;
    --pin-ink: #c99b45;
  }
}
</style>
