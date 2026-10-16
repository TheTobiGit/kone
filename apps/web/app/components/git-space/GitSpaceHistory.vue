<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Calendar03Icon, Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import type { useGitSpace } from "~/composables/useGitSpace";
import type { GitCommit } from "~/types/desktop";

// The branch, as a line you can read down — and, beside it, what the line is
// made of.
//
// Two columns, like About. The main one is the log itself: commits gathered
// under their day, a hairline through the gutter with a dot at every commit,
// the dot coloured by what kind of change it was. Above it, every loaded day
// as a bar: the shape of the history at a glance, and a way to jump to any
// part of it. The side column draws the same commits three ways — who wrote
// them, what kind of work they were, which parts of the code they touched —
// and each drawing is also the filter: point at a face, a kind or an area and
// the log narrows to it.
//
// Clicking a commit opens it in a card that grows out of its row over the log,
// so the timeline stays exactly where it was under the scrim and closing the
// card puts you back mid-read.

const props = defineProps<{ space: ReturnType<typeof useGitSpace> }>();

const { cue } = useSound();

const root = ref<HTMLElement | null>(null);
const opened = ref<{ hash: string; origin: DOMRect | null } | null>(null);
const sentinel = ref<HTMLElement | null>(null);
let io: IntersectionObserver | null = null;

const commits = computed(() => props.space.commits.value);
const done = computed(() => props.space.commitsDone.value);

// ── reading a subject ────────────────────────────────────────────────────────
// Conventional commits carry their own taxonomy — "fix(ui): …" says what kind
// of change and where — so the log can sort itself without asking anyone.
// Anything else is simply "other", with its subject left whole.

type Kind = "feat" | "fix" | "refactor" | "upkeep" | "other";

interface KindInfo {
  id: Kind;
  label: string;
  /** The token the kind's dots and bar segments wear. */
  tone: string;
}

const KINDS: KindInfo[] = [
  { id: "feat", label: "Features", tone: "var(--diff-add)" },
  { id: "fix", label: "Fixes", tone: "var(--diff-del)" },
  { id: "refactor", label: "Refactors", tone: "var(--accent)" },
  { id: "upkeep", label: "Upkeep", tone: "var(--ink-soft)" },
  { id: "other", label: "Other", tone: "color-mix(in srgb, var(--ink) 22%, transparent)" },
];
const KIND_OF: Record<string, Kind> = {
  feat: "feat",
  feature: "feat",
  fix: "fix",
  refactor: "refactor",
  perf: "refactor",
  chore: "upkeep",
  style: "upkeep",
  docs: "upkeep",
  test: "upkeep",
  build: "upkeep",
  ci: "upkeep",
};
const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

interface Entry {
  commit: GitCommit;
  /** Position in the whole loaded log, which drives the entrance stagger. */
  index: number;
  /** The conventional prefix as written ("fix(ui)"), or null. */
  tag: string | null;
  title: string;
  kind: Kind;
  scope: string | null;
  breaking: boolean;
  day: number;
}

function read(commit: GitCommit, index: number): Entry {
  const day = startOfDay(Date.parse(commit.date));
  const m = CONVENTIONAL.exec(commit.subject);
  const type = m?.[1]?.toLowerCase();
  const kind = type ? KIND_OF[type] : undefined;
  if (!m || !kind) {
    return { commit, index, tag: null, title: commit.subject, kind: "other", scope: null, breaking: false, day };
  }
  return {
    commit,
    index,
    tag: m[0].slice(0, m[0].indexOf(":")),
    title: m[4]!,
    kind,
    scope: m[2]?.trim().toLowerCase() ?? null,
    breaking: Boolean(m[3]),
    day,
  };
}

const entries = computed<Entry[]>(() => commits.value.map(read));

function tone(kind: Kind): string {
  return KINDS.find((k) => k.id === kind)?.tone ?? "var(--muted)";
}

// ── filters ──────────────────────────────────────────────────────────────────
// Each drawing on the side doubles as a filter. They narrow the commits that are
// loaded; the foot offers to read further back when the match is thin.

const query = ref("");
const who = ref<string | null>(null);
const kindFilter = ref<Kind | null>(null);
const scopeFilter = ref<string | null>(null);

const filtering = computed(
  () => Boolean(query.value.trim() || who.value || kindFilter.value || scopeFilter.value),
);

function matches(e: Entry): boolean {
  if (who.value && authorKey(e.commit) !== who.value) return false;
  if (kindFilter.value && e.kind !== kindFilter.value) return false;
  if (scopeFilter.value && e.scope !== scopeFilter.value) return false;
  const q = query.value.trim().toLowerCase();
  if (!q) return true;
  const c = e.commit;
  return (
    c.subject.toLowerCase().includes(q) ||
    c.author.toLowerCase().includes(q) ||
    c.hash.startsWith(q)
  );
}
const shown = computed<Entry[]>(() => entries.value.filter(matches));

function clearFilters() {
  query.value = "";
  who.value = null;
  kindFilter.value = null;
  scopeFilter.value = null;
}
function pickWho(key: string) {
  who.value = who.value === key ? null : key;
}
function pickKind(kind: Kind) {
  kindFilter.value = kindFilter.value === kind ? null : kind;
}
function pickScope(scope: string) {
  scopeFilter.value = scopeFilter.value === scope ? null : scope;
}

// ── days ─────────────────────────────────────────────────────────────────────

interface DayGroup {
  day: number;
  entries: Entry[];
}

const groups = computed<DayGroup[]>(() => {
  const out: DayGroup[] = [];
  for (const e of shown.value) {
    const last = out[out.length - 1];
    if (last && last.day === e.day) last.entries.push(e);
    else out.push({ day: e.day, entries: [e] });
  }
  return out;
});

// The overview strip: one bar per day from the oldest loaded commit to the
// newest, a week per bar once that grows past a couple of months.
const STRIP_MAX = 64;
const DAY_MS = 86_400_000;

interface Bar {
  start: number;
  end: number;
  count: number;
  shown: number;
}

const strip = computed<Bar[]>(() => {
  const all = entries.value;
  if (!all.length) return [];
  const newest = all[0]!.day;
  const oldest = all[all.length - 1]!.day;
  const span = Math.round((newest - oldest) / DAY_MS) + 1;
  const step = span > STRIP_MAX ? 7 : 1;
  const count = Math.ceil(span / step);
  const bars: Bar[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const end = newest - i * step * DAY_MS;
    bars.push({ start: end - (step - 1) * DAY_MS, end, count: 0, shown: 0 });
  }
  const at = (day: number) => count - 1 - Math.floor(Math.round((newest - day) / DAY_MS) / step);
  for (const e of all) {
    const bar = bars[at(e.day)];
    if (!bar) continue;
    bar.count++;
    if (!filtering.value || matches(e)) bar.shown++;
  }
  return bars;
});
const stripWeekly = computed(() => {
  const first = strip.value[0];
  return Boolean(first && first.start !== first.end);
});
const stripPeak = computed(() => Math.max(1, ...strip.value.map((b) => b.count)));
const sinceLabel = computed(() => {
  const last = entries.value[entries.value.length - 1];
  return last ? dayLabel(last.day) : "";
});

function barTitle(bar: Bar): string {
  const when = stripWeekly.value ? `Week of ${dayLabel(bar.start)}` : dayLabel(bar.end);
  return `${when} · ${plural(bar.count, "commit")}`;
}

/** Jump to the newest shown day inside the bar. */
function jump(bar: Bar) {
  const target = groups.value.find((g) => g.day <= bar.end && g.day >= bar.start);
  if (!target) return;
  const el = root.value?.querySelector<HTMLElement>(`[data-day="${target.day}"]`);
  el?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── who ──────────────────────────────────────────────────────────────────────

interface Author {
  key: string;
  name: string;
  email: string;
  count: number;
}

function authorKey(c: GitCommit): string {
  return (c.email || c.author).toLowerCase();
}

const PEOPLE_SHOWN = 6;
const authors = computed<Author[]>(() => {
  const by = new Map<string, Author>();
  for (const { commit: c } of entries.value) {
    const key = authorKey(c);
    const hit = by.get(key);
    if (hit) hit.count++;
    else by.set(key, { key, name: c.author, email: c.email, count: 1 });
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
});
const crowd = computed(() => authors.value.slice(0, PEOPLE_SHOWN));
const crowdMore = computed(() => authors.value.length - crowd.value.length);
const crowdPeak = computed(() => Math.max(1, ...crowd.value.map((a) => a.count)));
const leadAuthor = computed(() => {
  const picked = who.value ? authors.value.find((a) => a.key === who.value) : authors.value[0];
  if (!picked || !entries.value.length) return null;
  return {
    name: firstName(picked.name),
    share: Math.round((picked.count / entries.value.length) * 100),
      };
});

function faceSize(a: Author): number {
  return Math.round(28 + Math.sqrt(a.count / crowdPeak.value) * 22);
}
function face(email: string): string | null {
  return props.space.faceFor(email)?.avatarDataUrl ?? null;
}
const myEmail = computed(() => props.space.identity.value.email?.toLowerCase() ?? null);
function isMine(c: GitCommit): boolean {
  return Boolean(myEmail.value) && c.email.toLowerCase() === myEmail.value;
}

// ── what kind ────────────────────────────────────────────────────────────────

interface KindCount extends KindInfo {
  count: number;
}

const kinds = computed<KindCount[]>(() => {
  const counts = new Map<Kind, number>();
  for (const e of entries.value) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const out: KindCount[] = [];
  for (const k of KINDS) {
    const count = counts.get(k.id) ?? 0;
    if (count) out.push({ ...k, count });
  }
  return out;
});
const kindTotal = computed(() => Math.max(1, entries.value.length));
const fixShare = computed(() => {
  const fixes = kinds.value.find((k) => k.id === "fix")?.count ?? 0;
  const feats = kinds.value.find((k) => k.id === "feat")?.count ?? 0;
  return { fixes, feats };
});

// ── where ────────────────────────────────────────────────────────────────────

const SCOPES_SHOWN = 5;
const scopes = computed(() => {
  const counts = new Map<string, number>();
  for (const e of entries.value) if (e.scope) counts.set(e.scope, (counts.get(e.scope) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SCOPES_SHOWN);
});
const scopePeak = computed(() => Math.max(1, ...scopes.value.map(([, n]) => n)));

// ── when ─────────────────────────────────────────────────────────────────────

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];
const WEEKDAY_NAMES = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
const weekdays = computed(() => {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const e of entries.value) {
    const d = new Date(e.commit.date).getDay();
    counts[(d + 6) % 7]!++;
  }
  return counts;
});
const weekdayPeak = computed(() => Math.max(1, ...weekdays.value));
const busiestDay = computed(() => WEEKDAY_NAMES[weekdays.value.indexOf(weekdayPeak.value)] ?? "");

// ── rows ─────────────────────────────────────────────────────────────────────

// Only the first page gets the staggered cascade; rows a later page appends must
// not re-run it, so the boundary is the list length right after the first load.
const firstBatchSize = ref<number | null>(commits.value.length > 0 ? commits.value.length : null);
function isPaged(i: number) {
  return firstBatchSize.value !== null && i >= firstBatchSize.value;
}
watch(
  () => commits.value.length,
  (len) => {
    if (len === 0) firstBatchSize.value = null;
    else if (firstBatchSize.value === null) firstBatchSize.value = len;
  },
);

function openCommit(e: MouseEvent, hash: string) {
  cue("open");
  // SAFETY: bound on the row's button, so currentTarget is that element.
  const row = (e.currentTarget as HTMLElement).closest(".gsh__row");
  opened.value = { hash, origin: row ? row.getBoundingClientRect() : null };
}

// Auto-page: the foot of the list coming into view is the request. While a
// filter is on, the foot may already be in view, so it asks with a button.
function observe() {
  io?.disconnect();
  if (!sentinel.value || done.value) return;
  io = new IntersectionObserver(
    (list) => {
      if (!filtering.value && list.some((e) => e.isIntersecting)) void props.space.loadCommits();
    },
    { rootMargin: "240px" },
  );
  io.observe(sentinel.value);
}

watch(sentinel, observe);
watch(done, observe);
onBeforeUnmount(() => io?.disconnect());

// ── words ────────────────────────────────────────────────────────────────────

function startOfDay(t: number): number {
  const d = new Date(Number.isNaN(t) ? 0 : t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dayLabel(t: number): string {
  const today = startOfDay(Date.now());
  if (t === today) return "Today";
  if (t === today - DAY_MS) return "Yesterday";
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}
function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
</script>

<template>
  <section ref="root" class="gsh">
    <template v-if="commits.length">
      <!-- ══ the main column: the log ══════════════════════════════════════ -->
      <div class="gsh__main">
        <div class="gsh__head">
          <div class="gsh__label">
            <span class="gsh__label-name">Commits</span>
            <span class="gsh__label-count">{{ commits.length }}{{ done ? "" : "+" }}</span>
            <span class="gsh__label-note">since {{ sinceLabel }}</span>
            <button
              v-if="filtering"
              type="button"
              class="gsh__clear"
              @click="clearFilters"
            >
              {{ shown.length }} shown
              <HugeiconsIcon :icon="Cancel01Icon" :size="12" :stroke-width="2" />
            </button>
          </div>

          <div
            class="gsh__strip"
            :class="{ 'gsh__strip--weekly': stripWeekly }"
            role="list"
            aria-label="Commits over time"
          >
            <button
              v-for="(bar, b) in strip"
              :key="bar.start"
              type="button"
              role="listitem"
              class="gsh__bar"
              :class="{ 'gsh__bar--empty': !bar.count, 'gsh__bar--dim': filtering && !bar.shown }"
              :style="{ '--h': bar.count / stripPeak, '--hs': bar.shown / stripPeak, '--n': b }"
              :title="barTitle(bar)"
              :disabled="!bar.shown"
              @click="jump(bar)"
            >
              <i class="gsh__bar-all" />
              <i v-if="filtering" class="gsh__bar-shown" />
            </button>
          </div>
        </div>

        <div
          v-for="g in groups"
          :key="g.day"
          class="gsh__day"
          :data-day="g.day"
        >
          <div class="gsh__daylabel">
            <span class="gsh__daylabel-icon" aria-hidden="true">
              <HugeiconsIcon :icon="Calendar03Icon" :size="13" :stroke-width="1.8" />
            </span>
            <span class="gsh__daylabel-name">{{ dayLabel(g.day) }}</span>
            <span class="gsh__label-count">{{ g.entries.length }}</span>
          </div>

          <div
            v-for="e in g.entries"
            :key="e.commit.hash"
            class="gsh__item"
            :class="{ 'gsh__item--paged': isPaged(e.index) }"
            :style="{ '--i': e.index }"
          >
            <div class="gsh__row" :class="{ 'gsh__row--on': opened?.hash === e.commit.hash }">
              <button
                type="button"
                class="gsh__rowmain"
                aria-haspopup="dialog"
                @click="openCommit($event, e.commit.hash)"
              >
                <span class="gsh__rail" aria-hidden="true">
                  <i class="gsh__dot" :style="{ '--tone': tone(e.kind) }" />
                </span>
                <span class="gsh__subject">
                  <span v-if="e.tag" class="gsh__tag">{{ e.tag }}</span>
                  <span class="gsh__title">{{ e.title }}</span>
                  <span v-if="e.breaking" class="gsh__breaking">breaking</span>
                </span>
                <span
                  class="gsh__face"
                  :class="{ 'gsh__face--mine': isMine(e.commit) }"
                  :title="e.commit.author"
                >
                  <img v-if="face(e.commit.email)" :src="face(e.commit.email)!" alt="" />
                  <template v-else>{{ e.commit.author.charAt(0).toUpperCase() }}</template>
                </span>
                <span class="gsh__when" :title="e.commit.relative">{{ clock(e.commit.date) }}</span>
                <span class="gsh__short">{{ e.commit.short }}</span>
              </button>
            </div>
          </div>
        </div>

        <p v-if="filtering && !shown.length" class="gsh__none">
          Nothing in the {{ commits.length }} loaded commits matches.
          <button type="button" class="gsh__link" @click="clearFilters">Clear the filter</button>
        </p>

        <div ref="sentinel" class="gsh__foot">
          <button
            v-if="!done && filtering"
            type="button"
            class="gsh__link"
            @click="space.loadCommits()"
          >
            Look further back
          </button>
          <span v-else-if="!done" class="gsh__more">Loading more…</span>
          <span v-else class="gsh__more">{{ commits.length }} commits · start of history</span>
        </div>
      </div>

      <!-- ══ the side column: what the log is made of ═════════════════════ -->
      <aside class="gsh__side">
        <label class="gsh__search gsh__block" style="--i: 0">
          <HugeiconsIcon :icon="Search01Icon" :size="14" :stroke-width="1.8" />
          <input
            v-model="query"
            type="search"
            placeholder="Find a commit"
            spellcheck="false"
            autocomplete="off"
          />
        </label>

        <div class="gsh__block" style="--i: 1">
          <div class="gsh__label">
            <span class="gsh__label-name">Who</span>
            <span class="gsh__label-count">{{ authors.length }}</span>
          </div>
          <div class="gsh__crowd" :class="{ 'gsh__crowd--picking': who }">
            <button
              v-for="(a, n) in crowd"
              :key="a.key"
              type="button"
              class="gsh__person"
              :class="{ 'gsh__person--on': who === a.key }"
              :style="{ '--s': `${faceSize(a)}px`, '--n': n }"
              :title="`${a.name} · ${plural(a.count, 'commit')}`"
              :aria-pressed="who === a.key"
              @click="pickWho(a.key)"
            >
              <span class="gsh__person-face">
                <img v-if="face(a.email)" :src="face(a.email)!" alt="" />
                <template v-else>{{ a.name.charAt(0).toUpperCase() }}</template>
              </span>
            </button>
            <span v-if="crowdMore > 0" class="gsh__crowd-more">+{{ crowdMore }}</span>
          </div>
          <p v-if="leadAuthor" class="gsh__sub">
            <b>{{ leadAuthor.name }}</b>{{ " " }}wrote {{ leadAuthor.share }}% of these
            {{ commits.length }}.
          </p>
        </div>

        <div class="gsh__block" style="--i: 2">
          <div class="gsh__label">
            <span class="gsh__label-name">What</span>
          </div>
          <div class="gsh__stack" role="presentation">
            <i
              v-for="k in kinds"
              :key="k.id"
              class="gsh__stack-seg"
              :class="{ 'gsh__stack-seg--dim': kindFilter && kindFilter !== k.id }"
              :style="{ flexGrow: k.count, background: k.tone }"
            />
          </div>
          <div class="gsh__legend">
            <button
              v-for="k in kinds"
              :key="k.id"
              type="button"
              class="gsh__key"
              :class="{ 'gsh__key--on': kindFilter === k.id, 'gsh__key--dim': kindFilter && kindFilter !== k.id }"
              :aria-pressed="kindFilter === k.id"
              @click="pickKind(k.id)"
            >
              <i class="gsh__key-dot" :style="{ background: k.tone }" />
              <span class="gsh__key-name">{{ k.label }}</span>
              <span class="gsh__key-count">{{ Math.round((k.count / kindTotal) * 100) }}%</span>
            </button>
          </div>
          <p v-if="fixShare.feats || fixShare.fixes" class="gsh__sub">
            <b>{{ fixShare.feats }}</b>{{ " " }}{{ fixShare.feats === 1 ? "feature" : "features" }}
            and{{ " " }}<b>{{ fixShare.fixes }}</b>{{ " " }}{{ fixShare.fixes === 1 ? "fix" : "fixes" }} so far.
          </p>
        </div>

        <div v-if="scopes.length" class="gsh__block" style="--i: 3">
          <div class="gsh__label">
            <span class="gsh__label-name">Where</span>
          </div>
          <div class="gsh__areas">
            <button
              v-for="([name, n], s) in scopes"
              :key="name"
              type="button"
              class="gsh__area"
              :class="{ 'gsh__area--on': scopeFilter === name, 'gsh__area--dim': scopeFilter && scopeFilter !== name }"
              :aria-pressed="scopeFilter === name"
              @click="pickScope(name)"
            >
              <span class="gsh__area-name" :title="name">{{ name }}</span>
              <span class="gsh__area-track">
                <i class="gsh__area-fill" :style="{ width: `${(n / scopePeak) * 100}%`, '--n': s }" />
              </span>
              <span class="gsh__area-count">{{ n }}</span>
            </button>
          </div>
        </div>

        <div class="gsh__block" style="--i: 4">
          <div class="gsh__label">
            <span class="gsh__label-name">When</span>
          </div>
          <div class="gsh__week">
            <div
              v-for="(n, d) in weekdays"
              :key="d"
              class="gsh__weekday"
              :title="`${WEEKDAY_NAMES[d]} · ${plural(n, 'commit')}`"
            >
              <span class="gsh__weekday-track">
                <i
                  class="gsh__weekday-fill"
                  :class="{ 'gsh__weekday-fill--peak': n === weekdayPeak }"
                  :style="{ '--h': n / weekdayPeak, '--n': d }"
                />
              </span>
              <span class="gsh__weekday-name">{{ WEEKDAYS[d] }}</span>
            </div>
          </div>
          <p v-if="busiestDay" class="gsh__sub">Most of it lands on{{ " " }}<b>{{ busiestDay }}</b>.</p>
        </div>
      </aside>
    </template>

    <!-- Only ever shown once a read has finished and genuinely found nothing. -->
    <p v-else-if="done" class="gsh__empty">
      No commits yet.
      <span class="gsh__empty-sub">The first one will show up here.</span>
    </p>

    <GitSpaceCommitCard
      v-if="opened"
      :space="space"
      :hash="opened.hash"
      :origin="opened.origin"
      @close="opened = null"
    />
  </section>
</template>

<style scoped>
.gsh {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 64px;
  align-items: start;
  padding-bottom: 8px;
}
.gsh__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
/* The side column holds still while the log scrolls past it. */
.gsh__side {
  position: sticky;
  top: 6rem;
  display: flex;
  flex-direction: column;
  gap: 32px;
  min-width: 0;
}

/* ── entrance ─────────────────────────────────────────────────────────────── */
.gsh__block,
.gsh__head {
  animation: gsh-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3);
}
.gsh__item {
  animation: gsh-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger));
}
@keyframes gsh-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* Rows a later page appends fade in flat — no cascade, no translate, no stagger. */
.gsh__item--paged {
  animation: gsh-fade var(--gs-t-small) var(--gs-ease) backwards;
  animation-delay: 0;
}
@keyframes gsh-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes gsh-pop {
  from {
    opacity: 0;
    transform: scale(0.2);
  }
}
@keyframes gsh-rise {
  from {
    transform: scaleY(0);
  }
}
@keyframes gsh-grow {
  from {
    transform: scaleX(0);
  }
}

/* ── labels ───────────────────────────────────────────────────────────────── */
.gsh__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 16px;
}
.gsh__label-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.gsh__label-count,
.gsh__label-note {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.gsh__label-note::before {
  content: "· ";
}
.gsh__clear {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 3px 7px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--ink-soft);
  background-color: var(--hover);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: color var(--gs-t-micro) ease;
}
.gsh__clear:hover {
  color: var(--ink);
}
.gsh__sub {
  margin: 14px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--muted);
}
.gsh__sub b {
  font-weight: 500;
  color: var(--ink-soft);
}

/* ── the strip ────────────────────────────────────────────────────────────── */
/* Every loaded day as a bar, newest on the right, so the history has a shape
   before you read a word of it. A bar is also a way there. */
.gsh__head {
  margin-bottom: 36px;
}
.gsh__strip {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 56px;
}
.gsh__bar {
  position: relative;
  flex: 1 1 0;
  min-width: 2px;
  height: 100%;
  cursor: pointer;
}
.gsh__bar:disabled {
  cursor: default;
}
.gsh__bar-all,
.gsh__bar-shown {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  min-height: 2px;
  border-radius: 2px 2px 1px 1px;
  transform-origin: bottom;
  animation: gsh-rise 560ms var(--gs-ease) backwards;
  animation-delay: calc(120ms + min(var(--n, 0), 64) * 6ms);
}
.gsh__bar-all {
  height: calc(var(--h) * 100%);
  background-color: color-mix(in srgb, var(--ink) 22%, transparent);
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.gsh__bar-shown {
  height: calc(var(--hs) * 100%);
  background-color: var(--ink-soft);
}
.gsh__strip--weekly .gsh__bar-all {
  background-color: color-mix(in srgb, var(--ink) 26%, transparent);
}
.gsh__bar--empty .gsh__bar-all {
  height: 2px;
  background-color: color-mix(in srgb, var(--ink) 8%, transparent);
}
.gsh__bar--dim .gsh__bar-all,
.gsh__bar:has(.gsh__bar-shown) .gsh__bar-all {
  background-color: color-mix(in srgb, var(--ink) 9%, transparent);
}
.gsh__bar:not(:disabled):hover .gsh__bar-all {
  background-color: var(--ink);
}
.gsh__bar:focus-visible {
  outline: none;
  border-radius: 3px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}

/* ── days ─────────────────────────────────────────────────────────────────── */
.gsh__day {
  /* Clear the scroll container's top fade when a bar jumps here. */
  scroll-margin-top: 6rem;
}
.gsh__day + .gsh__day {
  margin-top: 22px;
}
.gsh__daylabel {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
}
/* Sits in the spine's gutter, so each day's line hangs from its calendar. */
.gsh__daylabel-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 18px;
  margin-right: 4px;
  color: var(--muted);
}
.gsh__daylabel-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-soft);
}

/* ── rows ─────────────────────────────────────────────────────────────────── */
/* The row is the tinted surface; the two things inside it are the targets. The
   tint belongs to the row so a hover anywhere on it reads as one object. */
.gsh__row {
  display: flex;
  align-items: center;
  width: 100%;
  height: 34px;
  padding-right: 8px;
  border-radius: 8px;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.gsh__row:hover,
.gsh__row:focus-within,
.gsh__row--on {
  background-color: var(--hover);
}
.gsh__rowmain {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  text-align: left;
  cursor: pointer;
}
.gsh__rowmain:focus-visible,
.gsh__link:focus-visible {
  outline: none;
  border-radius: 6px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
/* The spine: a hairline the full height of the row so consecutive rows join up,
   with the commit's dot on it in the colour of its kind. */
.gsh__rail {
  position: relative;
  flex-shrink: 0;
  width: 18px;
  height: 34px;
}
.gsh__rail::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  transform: translateX(-0.5px);
  background-color: color-mix(in srgb, var(--ink) 11%, transparent);
}
.gsh__daylabel + .gsh__item .gsh__rail::before {
  top: 50%;
}
.gsh__dot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: var(--tone, var(--muted));
  /* A ring of page colour so the hairline appears to pass behind the dot. */
  box-shadow: 0 0 0 3px var(--ground);
  transition: transform var(--gs-t-small) var(--gs-ease-move);
}
.gsh__row:hover .gsh__dot,
.gsh__row--on .gsh__dot {
  transform: translate(-50%, -50%) scale(1.3);
}

.gsh__subject {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}
.gsh__tag {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
.gsh__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--ink);
}
.gsh__breaking {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--diff-del);
}
.gsh__face {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--hover);
  font-size: 10px;
  color: var(--muted);
}
.gsh__face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gsh__when,
.gsh__short {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  color: var(--muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.gsh__when {
  min-width: 8ch;
  text-align: right;
}
.gsh__short {
  min-width: 7ch;
  text-align: right;
  opacity: 0.7;
}

.gsh__foot {
  padding: 18px 0 4px 30px;
}
.gsh__more {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  color: var(--muted);
  opacity: 0.7;
}
.gsh__none {
  margin: 8px 0 0 30px;
  font-size: 13px;
  color: var(--muted);
}
.gsh__link {
  font-size: 13px;
  color: var(--ink-soft);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--ink) 25%, transparent);
  text-decoration-thickness: from-font;
  text-underline-offset: 3px;
  cursor: pointer;
}
.gsh__link:hover {
  color: var(--ink);
}

/* ── search ───────────────────────────────────────────────────────────────── */
.gsh__search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 10px;
  border-radius: 9px;
  color: var(--muted);
  background-color: var(--hover);
  cursor: text;
}
.gsh__search input {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--ink);
  background: none;
  border: 0;
  outline: none;
}
.gsh__search input::placeholder {
  color: var(--muted);
}
.gsh__search:focus-within {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 18%, transparent);
}

/* ── who ──────────────────────────────────────────────────────────────────── */
.gsh__crowd {
  display: flex;
  align-items: flex-end;
  padding-left: 10px;
}
.gsh__person {
  position: relative;
  display: flex;
  margin-left: -10px;
  border-radius: 50%;
  cursor: pointer;
  animation: gsh-pop 460ms cubic-bezier(0.34, 1.56, 0.64, 1) backwards;
  animation-delay: calc(200ms + var(--n, 0) * 55ms);
}
.gsh__person-face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--s);
  height: var(--s);
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--hover);
  box-shadow: 0 0 0 4px var(--ground);
  font-size: 14px;
  color: var(--muted);
  transition:
    transform var(--gs-t-small) var(--gs-ease),
    opacity var(--gs-t-small) var(--gs-ease),
    box-shadow var(--gs-t-small) var(--gs-ease);
}
.gsh__person-face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gsh__person:hover .gsh__person-face {
  transform: translateY(-5px);
}
.gsh__crowd--picking .gsh__person:not(.gsh__person--on) .gsh__person-face {
  opacity: 0.35;
}
.gsh__person--on {
  z-index: 1;
}
.gsh__person--on .gsh__person-face {
  transform: translateY(-5px);
  box-shadow:
    0 0 0 3px var(--ground),
    0 0 0 5px var(--ink-soft);
}
.gsh__person:focus-visible {
  outline: none;
}
.gsh__person:focus-visible .gsh__person-face {
  box-shadow:
    0 0 0 3px var(--ground),
    0 0 0 5px color-mix(in srgb, var(--ink) 40%, transparent);
}
.gsh__crowd-more {
  align-self: center;
  margin-left: 14px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
}

/* ── what ─────────────────────────────────────────────────────────────────── */
.gsh__stack {
  display: flex;
  gap: 2px;
  height: 10px;
  transform-origin: left center;
  animation: gsh-grow 640ms var(--gs-ease) backwards;
  animation-delay: 260ms;
}
.gsh__stack-seg {
  flex-basis: 0;
  min-width: 3px;
  border-radius: 3px;
  transition: opacity var(--gs-t-small) var(--gs-ease);
}
.gsh__stack-seg--dim {
  opacity: 0.25;
}
.gsh__legend {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 12px;
  margin-top: 12px;
}
.gsh__key {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 26px;
  padding: 0 6px;
  margin-left: -6px;
  border-radius: 7px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) ease,
    opacity var(--gs-t-small) ease;
}
.gsh__key:hover,
.gsh__key--on {
  background-color: var(--hover);
}
.gsh__key--dim {
  opacity: 0.45;
}
.gsh__key-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.gsh__key-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.gsh__key-count,
.gsh__area-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* ── where ────────────────────────────────────────────────────────────────── */
.gsh__areas {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gsh__area {
  display: grid;
  grid-template-columns: 72px 1fr 3ch;
  align-items: center;
  gap: 10px;
  height: 26px;
  padding: 0 6px;
  margin: 0 -6px;
  border-radius: 7px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) ease,
    opacity var(--gs-t-small) ease;
}
.gsh__area:hover,
.gsh__area--on {
  background-color: var(--hover);
}
.gsh__area--dim {
  opacity: 0.45;
}
.gsh__area-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
}
.gsh__area-track {
  height: 6px;
}
.gsh__area-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
  transform-origin: left center;
  animation: gsh-grow 600ms var(--gs-ease) backwards;
  animation-delay: calc(300ms + var(--n, 0) * 60ms);
}
.gsh__area-count {
  text-align: right;
}

/* ── when ─────────────────────────────────────────────────────────────────── */
.gsh__week {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 8px;
}
.gsh__weekday {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.gsh__weekday-track {
  position: relative;
  width: 100%;
  height: 44px;
}
.gsh__weekday-fill {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  min-height: 2px;
  height: calc(var(--h) * 100%);
  border-radius: 3px 3px 2px 2px;
  background-color: color-mix(in srgb, var(--ink) 22%, transparent);
  transform-origin: bottom;
  animation: gsh-rise 560ms var(--gs-ease) backwards;
  animation-delay: calc(340ms + var(--n, 0) * 50ms);
}
.gsh__weekday-fill--peak {
  background-color: var(--ink-soft);
}
.gsh__weekday-name {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}

.gsh__empty {
  grid-column: 1 / -1;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-soft);
}
.gsh__empty-sub {
  color: var(--muted);
}

/* Narrow panes stack the drawings under nothing — the log comes first. */
@media (max-width: 1180px) {
  .gsh {
    grid-template-columns: minmax(0, 1fr);
  }
  .gsh__side {
    position: static;
    order: -1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gsh__block,
  .gsh__head,
  .gsh__item,
  .gsh__item--paged,
  .gsh__person,
  .gsh__bar-all,
  .gsh__bar-shown,
  .gsh__stack,
  .gsh__area-fill,
  .gsh__weekday-fill {
    animation: none;
  }
  .gsh__row,
  .gsh__dot,
  .gsh__person-face {
    transition: none;
  }
}
</style>
