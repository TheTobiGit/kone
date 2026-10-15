<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon, ArrowUpRight01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import MarkdownMessage from "~/components/markdown/MarkdownMessage.vue";
import type { useGitSpace } from "~/composables/useGitSpace";
import type { GitCommit, GitContributor, GitHubPullRequest } from "~/types/desktop";

// The repository's front page: the reason to open a project here rather than
// on GitHub. It's written the way the Overview is — sentences with the facts
// set inline, quiet labels with counts, mono numbers, drawings instead of
// boxes — and nothing on it sits in a card.
//
// Top to bottom: what the repository is, told as two sentences; its rhythm,
// every commit of the last eight weeks as a dot you can open; what's moving
// right now, the latest commits as a timeline beside the open pull requests and
// the people who build it; and the README, laid out as a page. The GitHub-fed
// parts (facts, stars, avatars, pull requests) sit on top of what git alone
// knows: a missing or logged-out `gh` costs the page nothing it can't do
// without, and the reason appears once.

type Section = "about" | "changes" | "history" | "branches" | "prs" | "stashes";

const props = defineProps<{ space: ReturnType<typeof useGitSpace> }>();
const emit = defineEmits<{
  /** Step to another section of the space. */
  go: [section: Section];
  openCommit: [hash: string];
  openPr: [number: number];
}>();

// The shell reads About on entry, but this section asks as well and each load
// de-dupes against the shell's. The log and the pull requests are the same
// reads History and Pull requests make, so visiting those later costs nothing.
// The pull requests wait for the repo-wide read, which is what says whether
// `gh` can answer at all.
onMounted(() => {
  const s = props.space;
  void s.loadAbout();
  void s.loadCommits();
  void s.loadCommitAuthors();
  void s.load().then(() => s.loadPrs());
});
// There is no cached list to render from here, so nothing paints until the read
// lands: a null README would otherwise flash "No README" for a loading beat.
const ready = computed(() => props.space.ready("about"));

const readme = computed(() => props.space.readme.value);
const repoInfo = computed(() => props.space.repoInfo.value);
const gh = computed(() => props.space.gh.value);
const origin = computed(() => props.space.origin.value);
const contributors = computed(() => props.space.contributors.value);
const commits = computed(() => props.space.commits.value);
const openPrs = computed(() => props.space.prs.value.filter((pr) => pr.state === "open"));
const myEmail = computed(() => props.space.identity.value.email?.toLowerCase() ?? null);

// ── the story ─────────────────────────────────────────────────────────────────
const description = computed(() => repoInfo.value?.description ?? null);
const topics = computed(() => repoInfo.value?.topics ?? []);
const homepage = computed(() => repoInfo.value?.homepageUrl || null);
/** The homepage without its scheme — nobody reads `https://` twice. */
const homepageLabel = computed(
  () => homepage.value?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? "",
);
/** "A Vue project under MIT, started in Jun 2026." — each part only if known. */
const madeOf = computed(() => {
  const r = repoInfo.value;
  if (!r) return null;
  const kind = [r.visibility === "public" ? null : r.visibility, r.isFork ? "fork" : null].filter(Boolean).join(" ");
  return {
    language: r.language,
    kind: kind || "project",
    license: r.license,
    since: r.createdAt ? month(r.createdAt) : null,
    pushed: r.pushedAt ? relativeIso(r.pushedAt) : null,
  };
});

// ── rhythm ────────────────────────────────────────────────────────────────────
// Eight weeks, a column a day, a dot a commit — from the first page of the log
// History already reads. Each dot is the commit itself: hover says which, click
// opens it. Yours are green, everyone else's ink, so "how much of this was me"
// is a glance. The window ends today; a repository that's been quiet for longer
// shows its last active eight weeks instead, and says so.
const DAYS = 56;
const STACK = 7;
const DAY_MS = 86_400_000;
type Day = { key: string; at: number; label: string; commits: GitCommit[]; month: string | null };
const lastCommitAt = computed(() => {
  const t = Date.parse(commits.value[0]?.date ?? "");
  return Number.isNaN(t) ? null : t;
});
const rhythmEnd = computed(() => {
  const today = startOfDay(Date.now());
  const last = lastCommitAt.value;
  if (last === null || today - startOfDay(last) < DAYS * DAY_MS) return today;
  return startOfDay(last);
});
const rhythmIsRecent = computed(() => rhythmEnd.value === startOfDay(Date.now()));
const rhythm = computed<Day[]>(() => {
  const end = rhythmEnd.value;
  const days: Day[] = [];
  let lastMonth = -1;
  for (let i = DAYS - 1; i >= 0; i -= 1) {
    const at = end - i * DAY_MS;
    const m = new Date(at).getMonth();
    const month = m === lastMonth ? null : new Date(at).toLocaleDateString(undefined, { month: "short" });
    lastMonth = m;
    days.push({ key: String(at), at, label: dayLabel(at), commits: [], month });
  }
  for (const c of commits.value) {
    const t = Date.parse(c.date);
    if (Number.isNaN(t)) continue;
    const index = DAYS - 1 - Math.round((end - startOfDay(t)) / DAY_MS);
    if (index >= 0 && index < DAYS) days[index]!.commits.push(c);
  }
  // Oldest at the bottom of each column, so a column grows the way the day did.
  for (const d of days) d.commits.reverse();
  return days;
});
const rhythmTotal = computed(() => rhythm.value.reduce((n, d) => n + d.commits.length, 0));
const rhythmMine = computed(
  () => rhythm.value.reduce((n, d) => n + d.commits.filter(isMine).length, 0),
);
/** As tall as the busiest day needs, so a quiet stretch isn't a tall empty band. */
const rhythmRows = computed(() =>
  Math.min(STACK, Math.max(3, ...rhythm.value.map((d) => d.commits.length))),
);
function isMine(c: GitCommit): boolean {
  return Boolean(myEmail.value) && c.email.toLowerCase() === myEmail.value;
}
/** The column's dots, capped; the last one stands in for the rest. */
function stack(day: Day): GitCommit[] {
  return day.commits.slice(0, STACK);
}
function overflow(day: Day): number {
  return Math.max(0, day.commits.length - STACK);
}
/** One sentence that says whether the repository is alive. */
const pulseLine = computed(() => {
  const last = lastCommitAt.value;
  if (last === null) return null;
  const since = Date.now() - 7 * DAY_MS;
  const week = commits.value.filter((c) => Date.parse(c.date) >= since);
  if (!week.length) return { quiet: true, when: relative(last), count: 0, people: 0 };
  const people = new Set(week.map((c) => c.email || c.author)).size;
  return { quiet: false, when: relative(last), count: week.length, people };
});

// ── lately ────────────────────────────────────────────────────────────────────
const latest = computed<GitCommit[]>(() => commits.value.slice(0, 5));
const latestPrs = computed<GitHubPullRequest[]>(() => openPrs.value.slice(0, 4));
function face(c: GitCommit): string | null {
  return props.space.faceFor(c.email)?.avatarDataUrl ?? null;
}
function prState(pr: GitHubPullRequest) {
  if (pr.isDraft) return { label: "Draft", tone: "muted" };
  if (pr.reviewDecision === "approved") return { label: "Approved", tone: "ok" };
  if (pr.reviewDecision === "changes-requested") return { label: "Changes requested", tone: "bad" };
  if (pr.checks === "failing") return { label: "Checks failing", tone: "bad" };
  return { label: "Needs review", tone: "warn" };
}

// ── people ────────────────────────────────────────────────────────────────────
// A crowd, not a leaderboard: everyone's face, sized by how much they've
// written, overlapping like people standing together. The sentence under it
// names whoever wrote the most, because that's the one fact a list of faces
// can't say on its own.
const PEOPLE_SHOWN = 10;
const people = computed(() => contributors.value?.people.slice(0, PEOPLE_SHOWN) ?? []);
const peoplePeak = computed(() => Math.max(1, ...people.value.map((p) => p.commits)));
const peopleMore = computed(() => (contributors.value?.total ?? 0) - people.value.length);
const peopleTotalCommits = computed(() =>
  (contributors.value?.people ?? []).reduce((n, p) => n + p.commits, 0),
);
const lead = computed(() => {
  const top = people.value[0];
  if (!top || people.value.length < 2 || !peopleTotalCommits.value) return null;
  return { person: top, share: Math.round((top.commits / peopleTotalCommits.value) * 100) };
});
function faceSize(person: GitContributor): number {
  return Math.round(30 + Math.sqrt(person.commits / peoplePeak.value) * 26);
}

// ── readme ────────────────────────────────────────────────────────────────────
// Folded to a preview with a fade until asked for; a long README shouldn't push
// everything above it out of mind.
const readmeOpen = ref(false);

// ── outward actions ───────────────────────────────────────────────────────────
const cloneUrl = computed(() => origin.value?.fetchUrl ?? null);
const copied = ref(false);
async function copyClone() {
  if (!cloneUrl.value) return;
  try {
    await navigator.clipboard.writeText(cloneUrl.value);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1600);
  } catch {
    // The clipboard can refuse (no focus, no permission); the URL is still on
    // screen in the link's title, so there's nothing more to say.
  }
}
function open(url: string | null | undefined) {
  if (url) void props.space.openExternal(url);
}

// Why the GitHub-fed facts are missing — null when there's nothing to explain.
// Same plain wording as the pull-requests section, so a known reason reads the
// same everywhere in the space.
const blocked = computed<string | null>(() => {
  if (!origin.value) return "This project has no remote, so there's nothing to connect to on GitHub.";
  if (!origin.value.slug)
    return `${origin.value.fetchUrl} isn't a GitHub remote — its facts live wherever that host keeps them.`;
  if (!gh.value) return null;
  if (!gh.value.installed)
    return "The GitHub CLI isn't installed. Install `gh` and this section fills itself in.";
  if (!gh.value.authenticated)
    return gh.value.message ?? "Run `gh auth login` in a terminal to connect your GitHub account.";
  return null;
});

function plural(n: number, word: string, withNumber = true, suffix = "s", many?: string): string {
  const w = n === 1 ? word : (many ?? `${word}${suffix}`);
  return withNumber ? `${n.toLocaleString()} ${w}` : w;
}

/** Big numbers stay short: 1,284 → "1.3k". */
function compact(n: number): string {
  return n >= 1000
    ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n)
    : n.toLocaleString();
}

// How to credit one contributor. GitHub's contributors endpoint returns handles
// and no display names, so that list can only ever say `@handle` — and the `@`
// is what stops a bare login reading as a misspelt person. git's list is the
// one that carries real names, and those are printed as written.
function credit(person: GitContributor): string {
  return person.login ? `@${person.login}` : person.name;
}

/** An ISO timestamp as "Mar 2021" — a point, not a distance. */
function month(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  return then.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** A time as a quiet "… ago" phrase. */
function relative(then: number): string {
  const delta = Math.max(0, Date.now() - then);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min${min === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
function relativeIso(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : relative(t);
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dayLabel(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
</script>

<template>
  <GitSpaceSkeleton v-if="!ready" variant="prose" />

  <section v-else class="gsa">
    <!-- ── the story ────────────────────────────────────────────────────── -->
    <div class="gsa__block gsa__story" :style="{ '--i': 0 }">
      <p v-if="description" class="gsa__lede">{{ description }}</p>
      <p v-if="madeOf" class="gsa__facts">
        A <b v-if="madeOf.language">{{ madeOf.language }}</b> {{ madeOf.kind }}<template v-if="madeOf.license">
        under <b>{{ madeOf.license }}</b></template><template v-if="madeOf.since">, started in <b>{{ madeOf.since }}</b></template>.
        <template v-if="repoInfo"><button type="button" class="gsa__inline" @click="open(`${repoInfo.url}/stargazers`)"><b class="gsa__mono">{{ compact(repoInfo.stars) }}</b> {{ plural(repoInfo.stars, "star", false) }}</button> and <button type="button" class="gsa__inline" @click="open(`${repoInfo.url}/forks`)"><b class="gsa__mono">{{ compact(repoInfo.forks) }}</b> {{ plural(repoInfo.forks, "fork", false) }}</button><template v-if="madeOf.pushed">, last pushed <b>{{ madeOf.pushed }}</b></template>.</template>
      </p>
      <p v-if="blocked" class="gsa__blocked">{{ blocked }}</p>

      <div class="gsa__links">
        <button v-if="repoInfo" type="button" class="gsa__link gsa__link--ink" @click="open(repoInfo.url)">
          Open on GitHub
          <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
        </button>
        <button v-if="homepage" type="button" class="gsa__link" @click="open(homepage)">
          {{ homepageLabel }}
          <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
        </button>
        <button v-if="cloneUrl" type="button" class="gsa__link" :title="cloneUrl" @click="copyClone">
          <HugeiconsIcon :icon="copied ? Tick02Icon : Copy01Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          {{ copied ? "Copied" : "Copy clone URL" }}
        </button>
        <span v-if="topics.length" class="gsa__topics">
          <span v-for="topic in topics" :key="topic">#{{ topic }}</span>
        </span>
      </div>
    </div>

    <!-- ── rhythm ───────────────────────────────────────────────────────── -->
    <div v-if="commits.length" class="gsa__block" :style="{ '--i': 1 }">
      <div class="gsa__label">
        <span class="gsa__label-name">Rhythm</span>
        <span class="gsa__label-count">{{ rhythmTotal }}</span>
        <span class="gsa__label-note">{{ rhythmIsRecent ? "last 8 weeks" : `8 weeks to ${dayLabel(rhythmEnd)}` }}</span>
        <button type="button" class="gsa__label-go" @click="emit('go', 'history')">
          History <HugeiconsIcon :icon="ArrowRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>

      <p v-if="pulseLine" class="gsa__pulse">
        <template v-if="pulseLine.quiet">Quiet lately. The last commit landed <b>{{ pulseLine.when }}</b>.</template>
        <template v-else>
          <b class="gsa__mono">{{ pulseLine.count }}</b> {{ plural(pulseLine.count, "commit", false) }} this week from
          <b class="gsa__mono">{{ pulseLine.people }}</b> {{ plural(pulseLine.people, "person", false, "", "people") }}. The last one landed <b>{{ pulseLine.when }}</b>.
        </template>
        <template v-if="rhythmMine"> <span class="gsa__mine-key" aria-hidden="true" /> <b class="gsa__mono">{{ rhythmMine }}</b> of these are yours.</template>
      </p>

      <div class="gsa__rhythm" role="list" :aria-label="`Commits per day, ${DAYS} days`">
        <div
          v-for="day in rhythm"
          :key="day.key"
          class="gsa__day"
          role="listitem"
          :title="day.commits.length ? undefined : `${day.label}: no commits`"
        >
          <span class="gsa__day-stack" :style="{ '--rows': rhythmRows }">
            <button
              v-for="(c, n) in stack(day)"
              :key="c.hash"
              type="button"
              class="gsa__dot"
              :class="{ 'gsa__dot--mine': isMine(c), 'gsa__dot--more': n === STACK - 1 && overflow(day) }"
              :style="{ '--n': n }"
              :title="`${c.subject}\n${c.author} · ${day.label} · ${c.short}`"
              :aria-label="`${c.subject}, ${c.author}, ${day.label}`"
              @click="emit('openCommit', c.hash)"
            >
              <template v-if="n === STACK - 1 && overflow(day)">+</template>
            </button>
            <span v-if="!day.commits.length" class="gsa__dot gsa__dot--none" />
          </span>
          <span class="gsa__day-month">{{ day.month }}</span>
        </div>
      </div>
    </div>

    <!-- ── lately ───────────────────────────────────────────────────────── -->
    <div v-if="latest.length || latestPrs.length || people.length" class="gsa__block gsa__lately" :style="{ '--i': 2 }">
      <div v-if="latest.length" class="gsa__col">
        <div class="gsa__label">
          <span class="gsa__label-name">Latest commits</span>
          <button type="button" class="gsa__label-go" @click="emit('go', 'history')">
            All <HugeiconsIcon :icon="ArrowRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
        <ol class="gsa__timeline">
          <li v-for="c in latest" :key="c.hash">
            <button type="button" class="gsa__event" @click="emit('openCommit', c.hash)">
              <span class="gsa__event-dot" :class="{ 'gsa__event-dot--mine': isMine(c) }" aria-hidden="true" />
              <span class="gsa__event-title">{{ c.subject }}</span>
              <span class="gsa__event-meta">
                <span class="gsa__avatar" aria-hidden="true">
                  <img v-if="face(c)" :src="face(c)!" alt="" />
                  <template v-else>{{ c.author[0]?.toUpperCase() }}</template>
                </span>
                {{ c.author }}
                <span class="gsa__sep">·</span>
                {{ c.relative || relativeIso(c.date) }}
                <span class="gsa__hash">{{ c.short }}</span>
              </span>
            </button>
          </li>
        </ol>
      </div>

      <div class="gsa__col gsa__col--side">
        <div v-if="latestPrs.length">
          <div class="gsa__label">
            <span class="gsa__label-name">Open pull requests</span>
            <span class="gsa__label-count">{{ openPrs.length }}</span>
            <button type="button" class="gsa__label-go" @click="emit('go', 'prs')">
              All <HugeiconsIcon :icon="ArrowRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
            </button>
          </div>
          <button v-for="pr in latestPrs" :key="pr.number" type="button" class="gsa__pr" @click="emit('openPr', pr.number)">
            <span class="gsa__pr-title"><span class="gsa__pr-num">#{{ pr.number }}</span> {{ pr.title }}</span>
            <span class="gsa__pr-meta">
              <span class="gsa__state" :class="`gsa__state--${prState(pr).tone}`">{{ prState(pr).label }}</span>
              <span class="gsa__sep">·</span>
              {{ pr.author }}
              <span class="gsa__sep">·</span>
              <span class="gsa__add">+{{ pr.additions.toLocaleString() }}</span>
              <span class="gsa__del">−{{ pr.deletions.toLocaleString() }}</span>
            </span>
          </button>
        </div>

        <div v-if="people.length">
          <div class="gsa__label">
            <span class="gsa__label-name">People</span>
            <span class="gsa__label-count">{{ contributors?.total ?? people.length }}</span>
          </div>
          <div class="gsa__crowd">
            <span
              v-for="(person, n) in people"
              :key="person.name"
              class="gsa__crowd-face"
              :style="{ '--s': `${faceSize(person)}px`, '--n': n, zIndex: PEOPLE_SHOWN - n }"
              :title="`${credit(person)} · ${plural(person.commits, 'commit')}`"
            >
              <img v-if="person.avatarDataUrl" :src="person.avatarDataUrl" alt="" />
              <template v-else>{{ person.name[0]?.toUpperCase() }}</template>
            </span>
            <span v-if="peopleMore > 0" class="gsa__crowd-more">+{{ peopleMore }}</span>
          </div>
          <p v-if="lead" class="gsa__crowd-line">
            <b>{{ credit(lead.person) }}</b> wrote <b class="gsa__mono">{{ lead.share }}%</b> of it, then
            <b>{{ credit(people[1]!) }}</b> with <b class="gsa__mono">{{ people[1]!.commits.toLocaleString() }}</b> commits.
          </p>
        </div>
      </div>
    </div>

    <!-- ── readme ───────────────────────────────────────────────────────── -->
    <div class="gsa__block gsa__doc" :style="{ '--i': 3 }">
      <div class="gsa__label">
        <span class="gsa__label-name gsa__label-name--file">{{ readme?.path ?? "README" }}</span>
      </div>
      <template v-if="readme">
        <div class="gsa__readme selectable" :class="{ 'gsa__readme--folded': !readmeOpen }">
          <MarkdownMessage :source="readme.markdown" historical />
        </div>
        <button type="button" class="gsa__unfold" @click="readmeOpen = !readmeOpen">
          {{ readmeOpen ? "Show less" : "Keep reading" }}
        </button>
      </template>
      <p v-else class="gsa__blocked">No README in this repository.</p>
    </div>
  </section>
</template>

<style scoped>
.gsa {
  display: flex;
  flex-direction: column;
  gap: 56px;
  padding-bottom: 32px;
}

/* ── entrance ─────────────────────────────────────────────────────────────── */
/* The blocks rise in together, each delayed by its own index — capped so a
   longer page never waits out a slow chain. */
.gsa__block {
  animation: gsa-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3);
}
@keyframes gsa-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

b {
  font-weight: 600;
  color: var(--ink);
}
.gsa__mono {
  font-family: var(--font-mono);
  font-weight: 600;
  letter-spacing: -0.02em;
}

/* ── labels ───────────────────────────────────────────────────────────────── */
/* The Overview's section label: a quiet name, its count in mono, and a way
   onward at the far end. */
.gsa__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 14px;
}
.gsa__label-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.gsa__label-name--file {
  font-family: var(--font-mono);
  font-weight: 400;
  font-size: 12px;
  color: var(--muted);
}
.gsa__label-count,
.gsa__label-note {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
.gsa__label-note::before {
  content: "· ";
}
.gsa__label-go {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  padding: 3px 6px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  transition:
    color var(--gs-t-micro) ease,
    background-color var(--gs-t-micro) ease;
}
.gsa__label-go:hover {
  color: var(--ink);
  background-color: var(--hover);
}

/* ── the story ────────────────────────────────────────────────────────────── */
.gsa__story {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 680px;
}
.gsa__lede {
  margin: 0;
  font-size: 21px;
  font-weight: 500;
  line-height: 1.4;
  letter-spacing: -0.015em;
  color: var(--ink);
  text-wrap: pretty;
}
.gsa__facts {
  margin: 0;
  font-size: 15px;
  line-height: 1.6;
  color: var(--ink-soft);
}
/* A fact that's also a door — stars and forks open their GitHub pages. Reads
   as prose until hovered. */
.gsa__inline {
  display: inline;
  margin: 0 -3px;
  padding: 1px 3px;
  border-radius: 6px;
  font: inherit;
  color: inherit;
  cursor: pointer;
  transition: background-color var(--gs-t-micro) ease;
}
.gsa__inline:hover {
  background-color: var(--hover);
}
.gsa__blocked {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
}
.gsa__links {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 18px;
  margin-top: 6px;
}
.gsa__link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 0;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  transition: color var(--gs-t-micro) ease;
}
.gsa__link:hover,
.gsa__link--ink {
  color: var(--ink);
}
.gsa__link--ink {
  font-weight: 500;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--ink) 25%, transparent);
  text-underline-offset: 4px;
}
.gsa__topics {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
}

/* ── rhythm ───────────────────────────────────────────────────────────────── */
.gsa__pulse {
  margin: 0 0 22px;
  font-size: 15px;
  line-height: 1.6;
  color: var(--ink-soft);
}
.gsa__mine-key {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin: 0 2px 0 6px;
  border-radius: 50%;
  background-color: var(--diff-add);
  vertical-align: 1px;
}
.gsa__rhythm {
  display: flex;
  gap: 0;
}
.gsa__day {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1 1 0;
  min-width: 0;
}
/* Every seventh day starts a new week, marked by a hairline the dots stand on. */
.gsa__day-stack {
  display: flex;
  flex-direction: column-reverse;
  align-items: center;
  gap: 3px;
  height: calc(var(--rows, 7) * 13px);
  padding-bottom: 6px;
  box-sizing: content-box;
  width: 100%;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
}
.gsa__dot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 10px;
  height: 10px;
  flex-shrink: 0;
  border-radius: 50%;
  background-color: color-mix(in srgb, var(--ink) 72%, transparent);
  font-family: var(--font-mono);
  font-size: 8px;
  line-height: 1;
  color: var(--ground);
  cursor: pointer;
  transform-origin: center bottom;
  transition:
    transform var(--gs-t-micro) var(--gs-ease),
    background-color var(--gs-t-micro) ease;
  animation: gsa-pop 380ms cubic-bezier(0.34, 1.56, 0.64, 1) backwards;
  animation-delay: calc(120ms + var(--n, 0) * 45ms);
}
.gsa__dot:hover {
  transform: scale(1.45);
  background-color: var(--ink);
}
.gsa__dot--mine {
  background-color: var(--diff-add);
}
.gsa__dot--mine:hover {
  background-color: var(--diff-add);
}
.gsa__dot--more {
  width: 12px;
  height: 12px;
}
.gsa__dot--none {
  width: 4px;
  height: 4px;
  background-color: color-mix(in srgb, var(--ink) 14%, transparent);
  cursor: default;
  animation: none;
}
.gsa__dot--none:hover {
  transform: none;
}
.gsa__dot:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 40%, transparent);
  outline-offset: 2px;
}
@keyframes gsa-pop {
  from {
    opacity: 0;
    transform: scale(0.2);
  }
}
.gsa__day-month {
  align-self: flex-start;
  height: 14px;
  margin-top: 7px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 14px;
  white-space: nowrap;
  color: var(--muted);
}

/* ── lately ───────────────────────────────────────────────────────────────── */
.gsa__lately {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: 64px;
}
.gsa__col--side {
  display: flex;
  flex-direction: column;
  gap: 44px;
}

/* The latest commits as a timeline: one hairline, a dot per commit on it. */
.gsa__timeline {
  position: relative;
  margin: 0;
  padding: 0;
  list-style: none;
}
.gsa__timeline::before {
  content: "";
  position: absolute;
  left: 4px;
  top: 10px;
  bottom: 14px;
  width: 1.5px;
  border-radius: 1px;
  background-color: color-mix(in srgb, var(--ink) 10%, transparent);
}
.gsa__event {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  margin-left: -8px;
  padding: 9px 8px 11px 30px;
  border-radius: 10px;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--gs-t-micro) ease;
}
.gsa__event:hover {
  background-color: var(--hover);
}
.gsa__event-dot {
  position: absolute;
  left: 7px;
  top: 14px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background-color: var(--ground);
  box-shadow: inset 0 0 0 2.5px color-mix(in srgb, var(--ink) 45%, transparent);
}
.gsa__event-dot--mine {
  box-shadow: inset 0 0 0 2.5px var(--diff-add);
}
.gsa__event-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 1.4;
  color: var(--ink);
}
.gsa__event-meta,
.gsa__pr-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  font-size: 12px;
  color: var(--muted);
}
.gsa__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--hover);
  font-size: 9px;
  color: var(--muted);
}
.gsa__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gsa__sep {
  opacity: 0.6;
}
.gsa__hash {
  margin-left: auto;
  padding-left: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
}

/* Open pull requests: two lines each, the state leading the second. */
.gsa__pr {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: calc(100% + 16px);
  margin-left: -8px;
  padding: 9px 8px 11px;
  border-radius: 10px;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--gs-t-micro) ease;
}
.gsa__pr:hover {
  background-color: var(--hover);
}
.gsa__pr-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 1.4;
  color: var(--ink);
}
.gsa__pr-num {
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--muted);
}
.gsa__state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.gsa__state::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: currentColor;
}
.gsa__state--ok {
  color: var(--diff-add);
}
.gsa__state--bad {
  color: var(--diff-del);
}
.gsa__state--warn {
  color: color-mix(in srgb, #c98a16 85%, var(--ink));
}
.gsa__state--muted {
  color: var(--muted);
}
.gsa__add,
.gsa__del {
  font-family: var(--font-mono);
  font-size: 11px;
}
.gsa__add {
  color: var(--diff-add);
}
.gsa__del {
  color: var(--diff-del);
}

/* People as a crowd: overlapping faces, bigger for more commits, each lifting
   a little when pointed at. */
.gsa__crowd {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  padding-left: 8px;
}
.gsa__crowd-face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  width: var(--s);
  height: var(--s);
  margin-left: -8px;
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--hover);
  box-shadow: 0 0 0 3px var(--ground);
  font-size: 13px;
  color: var(--muted);
  transition: transform var(--gs-t-small) var(--gs-ease);
  animation: gsa-pop 420ms cubic-bezier(0.34, 1.56, 0.64, 1) backwards;
  animation-delay: calc(200ms + var(--n, 0) * 50ms);
}
.gsa__crowd-face:hover {
  transform: translateY(-4px);
}
.gsa__crowd-face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gsa__crowd-more {
  margin-left: 10px;
  margin-bottom: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
}
.gsa__crowd-line {
  margin: 14px 0 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ink-soft);
}

/* ── readme ───────────────────────────────────────────────────────────────── */
/* The README as a page of the app, not a file in a box: the document's own
   type at a reading measure, straight on the ground. */
.gsa__readme {
  max-width: 72ch;
}
.gsa__readme--folded {
  max-height: 420px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, #000 55%, transparent);
  mask-image: linear-gradient(to bottom, #000 55%, transparent);
}
.gsa__unfold {
  margin-top: 8px;
  padding: 7px 14px;
  border-radius: 10px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink);
  background-color: var(--hover);
  cursor: pointer;
  transition: background-color var(--gs-t-micro) ease;
}
.gsa__unfold:hover {
  background-color: color-mix(in srgb, var(--ink) 10%, transparent);
}

@media (max-width: 760px) {
  .gsa__lately {
    grid-template-columns: minmax(0, 1fr);
    gap: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gsa__block,
  .gsa__dot,
  .gsa__crowd-face {
    animation: none;
  }
  .gsa__dot,
  .gsa__crowd-face {
    transition: none;
  }
}
</style>
