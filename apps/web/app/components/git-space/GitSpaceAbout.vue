<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowRight01Icon,
  Copy01Icon,
  GitBranchIcon,
  GitForkIcon,
  GitPullRequestIcon,
  Link01Icon,
  StarIcon,
  Tick02Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import MarkdownMessage from "~/components/markdown/MarkdownMessage.vue";
import type { useGitSpace } from "~/composables/useGitSpace";
import type { GitCommit, GitContributor, GitHubPullRequest } from "~/types/desktop";

// The repository's front page: the reason to open a project here rather than
// on GitHub. It answers "what is this, is it alive, what's happening, who's on
// it" at a glance, and every part of it is a way in: the stat tiles, the latest
// commits and the open pull requests each open their own section or detail.
//
// Top to bottom: a hero (identity, the one or two outward actions, stat tiles),
// a pulse (commits per day across the last 30 days, from the log already read
// for History), what's happening (the latest commits beside the open pull
// requests), the people (who has written how much, as bars), and the README in
// a card that opens up on demand. The GitHub-fed parts (facts, stars, avatars,
// pull requests) sit on top of what git alone knows: a missing or logged-out
// `gh` costs the page nothing it can't do without, and the reason appears once.

type Section = "about" | "changes" | "history" | "branches" | "prs" | "stashes";

const props = defineProps<{ space: ReturnType<typeof useGitSpace> }>();
const emit = defineEmits<{
  /** Step to another section of the space. */
  go: [section: Section];
  openCommit: [hash: string];
  openPr: [number: number];
}>();

// The shell reads About on entry (the rail footer needs it too), but this
// section is also the one that can be reached without the shell having asked —
// so it asks as well, and each load de-dupes against the shell's. The log and
// the pull requests feed the pulse and "what's happening"; both are the same
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
const logo = computed(() => props.space.logo.value);
const repoInfo = computed(() => props.space.repoInfo.value);
const gh = computed(() => props.space.gh.value);
const origin = computed(() => props.space.origin.value);
const contributors = computed(() => props.space.contributors.value);
const commits = computed(() => props.space.commits.value);
const openPrs = computed(() => props.space.prs.value.filter((pr) => pr.state === "open"));
const localBranches = computed(() => props.space.branches.value.filter((b) => !b.remote));

/** The repo's name — GitHub's `owner/repo` when reachable, the folder otherwise. */
const repoName = computed(() => repoInfo.value?.nameWithOwner ?? props.space.name.value);
const owner = computed(() => (repoName.value.includes("/") ? repoName.value.split("/")[0] : null));
const shortName = computed(() => repoName.value.split("/").at(-1) ?? repoName.value);
const description = computed(() => repoInfo.value?.description);
const topics = computed(() => repoInfo.value?.topics ?? []);
const homepage = computed(() => repoInfo.value?.homepageUrl || null);
/** The homepage without its scheme — nobody reads `https://` twice. */
const homepageLabel = computed(
  () => homepage.value?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? "",
);

// Small facts that describe the code and where it stands, as chips under the
// description. Nulls are dropped, never printed as "unknown".
const chips = computed<string[]>(() => {
  const r = repoInfo.value;
  if (!r) return [];
  const out: string[] = [];
  if (r.language) out.push(r.language);
  if (r.license) out.push(r.license);
  if (r.visibility) out.push(r.visibility.toLowerCase());
  if (r.isFork) out.push("fork");
  if (r.defaultBranch) out.push(`default ${r.defaultBranch}`);
  if (r.createdAt) out.push(`since ${month(r.createdAt)}`);
  return out;
});

// ── stat tiles ────────────────────────────────────────────────────────────────
// Big numbers, each a door: the ones that have a section here open it, the ones
// that only exist on GitHub open GitHub.
type Tile = { key: string; label: string; value: number; icon: typeof StarIcon; go?: Section; url?: string };
const tiles = computed<Tile[]>(() => {
  const r = repoInfo.value;
  const out: Tile[] = [];
  if (r) out.push({ key: "stars", label: plural(r.stars, "star", false), value: r.stars, icon: StarIcon, url: `${r.url}/stargazers` });
  if (contributors.value?.total)
    out.push({ key: "people", label: plural(contributors.value.total, "contributor", false), value: contributors.value.total, icon: UserGroupIcon, url: r ? `${r.url}/graphs/contributors` : undefined });
  if (gh.value?.authenticated)
    out.push({ key: "prs", label: `open pull request${openPrs.value.length === 1 ? "" : "s"}`, value: openPrs.value.length, icon: GitPullRequestIcon, go: "prs" });
  out.push({ key: "branches", label: plural(localBranches.value.length, "branch", false, "es"), value: localBranches.value.length, icon: GitBranchIcon, go: "branches" });
  if (r) out.push({ key: "forks", label: plural(r.forks, "fork", false), value: r.forks, icon: GitForkIcon, url: `${r.url}/forks` });
  return out;
});
function openTile(tile: Tile) {
  if (tile.go) emit("go", tile.go);
  else open(tile.url);
}

// ── pulse ─────────────────────────────────────────────────────────────────────
// Commits per day across 30 days, from the first page of the log. One series,
// so one hue: the bar's height is the count, and an empty day is a short stub
// so the strip still reads as a calendar. The window ends today; a repository
// that's gone quiet for longer than that shows its last active month instead
// of thirty empty days, and says so.
const DAYS = 30;
const DAY_MS = 86_400_000;
type Day = { key: string; label: string; count: number };
const lastCommitAt = computed(() => {
  const t = Date.parse(commits.value[0]?.date ?? "");
  return Number.isNaN(t) ? null : t;
});
const pulseEnd = computed(() => {
  const today = startOfDay(Date.now());
  const last = lastCommitAt.value;
  if (last === null || today - startOfDay(last) < DAYS * DAY_MS) return today;
  return startOfDay(last);
});
const pulseIsRecent = computed(() => pulseEnd.value === startOfDay(Date.now()));
const pulseTitle = computed(() =>
  pulseIsRecent.value ? "Pulse · last 30 days" : `Pulse · the 30 days to ${dayLabel(pulseEnd.value)}`,
);
const pulse = computed<Day[]>(() => {
  const end = pulseEnd.value;
  const days: Day[] = [];
  for (let i = DAYS - 1; i >= 0; i -= 1) {
    const at = end - i * DAY_MS;
    days.push({ key: String(at), label: dayLabel(at), count: 0 });
  }
  for (const c of commits.value) {
    const t = Date.parse(c.date);
    if (Number.isNaN(t)) continue;
    const index = DAYS - 1 - Math.round((end - startOfDay(t)) / DAY_MS);
    if (index >= 0 && index < DAYS) days[index]!.count += 1;
  }
  return days;
});
const pulseTotal = computed(() => pulse.value.reduce((n, d) => n + d.count, 0));
const pulsePeak = computed(() => Math.max(1, ...pulse.value.map((d) => d.count)));
/** One sentence that says whether the repository is alive. */
const pulseLine = computed(() => {
  const last = lastCommitAt.value;
  if (last === null) return "No commits yet.";
  const when = relative(last);
  const since = Date.now() - 7 * DAY_MS;
  const week = commits.value.filter((c) => Date.parse(c.date) >= since);
  if (!week.length) {
    const stretch = pulseTotal.value ? ` ${plural(pulseTotal.value, "commit")} in the month before that.` : "";
    return `Quiet lately. The last commit landed ${when}.${stretch}`;
  }
  const people = new Set(week.map((c) => c.email || c.author)).size;
  return `${plural(week.length, "commit")} this week from ${plural(people, "person", true, "", "people")}. The last one landed ${when}.`;
});
function barHeight(count: number): string {
  if (!count) return "3px";
  return `${Math.max(10, (count / pulsePeak.value) * 100)}%`;
}

// ── what's happening ──────────────────────────────────────────────────────────
const latest = computed<GitCommit[]>(() => commits.value.slice(0, 4));
const latestPrs = computed<GitHubPullRequest[]>(() => openPrs.value.slice(0, 4));
function face(c: GitCommit): string | null {
  return props.space.faceFor(c.email)?.avatarDataUrl ?? null;
}
function prState(pr: GitHubPullRequest) {
  if (pr.isDraft) return { label: "draft", tone: "muted" };
  if (pr.reviewDecision === "approved") return { label: "approved", tone: "ok" };
  if (pr.reviewDecision === "changes-requested") return { label: "changes requested", tone: "bad" };
  if (pr.checks === "failing") return { label: "checks failing", tone: "bad" };
  return { label: "needs review", tone: "warn" };
}

// ── people ────────────────────────────────────────────────────────────────────
const PEOPLE_SHOWN = 6;
const people = computed(() => contributors.value?.people.slice(0, PEOPLE_SHOWN) ?? []);
const peoplePeak = computed(() => Math.max(1, ...people.value.map((p) => p.commits)));
const peopleMore = computed(() => (contributors.value?.total ?? 0) - people.value.length);

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
    // screen in the button's title, so there's nothing more to say.
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
    <!-- ── hero ─────────────────────────────────────────────────────────── -->
    <div class="gsa__block gsa__hero" :style="{ '--i': 0 }">
      <div class="gsa__identity">
        <img v-if="logo" :src="logo.dataUrl" alt="" class="gsa__logo" />
        <span v-else class="gsa__logo gsa__logo--letter" aria-hidden="true">{{ shortName[0]?.toUpperCase() }}</span>
        <div class="gsa__identity-body">
          <h2 class="gsa__name">
            <span v-if="owner" class="gsa__owner">{{ owner }} /</span>
            {{ shortName }}
          </h2>
          <p v-if="description" class="gsa__description">{{ description }}</p>
          <p v-if="chips.length || topics.length" class="gsa__chips">
            <span v-for="chip in chips" :key="chip" class="gsa__chip">{{ chip }}</span>
            <span v-for="topic in topics" :key="`t:${topic}`" class="gsa__chip gsa__chip--topic">#{{ topic }}</span>
          </p>
        </div>
        <div class="gsa__actions">
          <button v-if="repoInfo" type="button" class="gsa__action gsa__action--primary" @click="open(repoInfo.url)">
            Open on GitHub
            <HugeiconsIcon :icon="ArrowRight01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
          </button>
          <button v-if="cloneUrl" type="button" class="gsa__action" :title="cloneUrl" @click="copyClone">
            <HugeiconsIcon :icon="copied ? Tick02Icon : Copy01Icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
            {{ copied ? "Copied" : "Copy clone URL" }}
          </button>
          <button v-if="homepage" type="button" class="gsa__action gsa__action--quiet" @click="open(homepage)">
            <HugeiconsIcon :icon="Link01Icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
            {{ homepageLabel }}
          </button>
        </div>
      </div>

      <div class="gsa__tiles">
        <button
          v-for="tile in tiles"
          :key="tile.key"
          type="button"
          class="gsa__tile"
          :class="{ 'gsa__tile--inside': tile.go }"
          :title="tile.go ? 'Open in kone' : 'Open on GitHub'"
          @click="openTile(tile)"
        >
          <span class="gsa__tile-top">
            <HugeiconsIcon :icon="tile.icon" :size="15" :stroke-width="1.8" aria-hidden="true" />
            <HugeiconsIcon class="gsa__tile-go" :icon="ArrowRight01Icon" :size="13" :stroke-width="2" aria-hidden="true" />
          </span>
          <span class="gsa__tile-value">{{ compact(tile.value) }}</span>
          <span class="gsa__tile-label">{{ tile.label }}</span>
        </button>
      </div>

      <!-- Why the GitHub-fed half of this page is missing. It sits under the
           facts it explains, not in a banner: it's a setup detail, not a fault,
           and the rest of the page is still true without it. -->
      <p v-if="blocked" class="gsa__blocked">{{ blocked }}</p>
    </div>

    <!-- ── pulse ────────────────────────────────────────────────────────── -->
    <div v-if="commits.length" class="gsa__block gsa__card" :style="{ '--i': 1 }">
      <div class="gsa__card-head">
        <p class="gsa__eyebrow">{{ pulseTitle }}</p>
        <button type="button" class="gsa__more" @click="emit('go', 'history')">
          History <HugeiconsIcon :icon="ArrowRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>
      <p class="gsa__pulse-line">{{ pulseLine }}</p>
      <div class="gsa__pulse" role="img" :aria-label="`Commits per day over the last ${DAYS} days`">
        <span
          v-for="day in pulse"
          :key="day.key"
          class="gsa__bar-hit"
          :title="`${day.label}: ${plural(day.count, 'commit')}`"
        >
          <span class="gsa__bar" :class="{ 'gsa__bar--empty': !day.count }" :style="{ height: barHeight(day.count) }" />
        </span>
      </div>
      <div class="gsa__pulse-axis">
        <span>{{ pulse[0]?.label }}</span>
        <span>{{ pulseIsRecent ? "today" : pulse.at(-1)?.label }}</span>
      </div>
    </div>

    <!-- ── what's happening ─────────────────────────────────────────────── -->
    <div v-if="latest.length || latestPrs.length" class="gsa__block gsa__now" :style="{ '--i': 2 }">
      <div v-if="latest.length" class="gsa__card">
        <div class="gsa__card-head">
          <p class="gsa__eyebrow">Latest commits</p>
          <button type="button" class="gsa__more" @click="emit('go', 'history')">
            All <HugeiconsIcon :icon="ArrowRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
        <button v-for="c in latest" :key="c.hash" type="button" class="gsa__row" @click="emit('openCommit', c.hash)">
          <span class="gsa__avatar gsa__row-avatar" aria-hidden="true">
            <img v-if="face(c)" :src="face(c)!" alt="" />
            <span v-else class="gsa__avatar-fallback">{{ c.author[0]?.toUpperCase() }}</span>
          </span>
          <span class="gsa__row-body">
            <span class="gsa__row-title">{{ c.subject }}</span>
            <span class="gsa__row-meta">{{ c.author }} · {{ relativeIso(c.date) || c.relative }}</span>
          </span>
          <span class="gsa__row-tail">{{ c.short }}</span>
        </button>
      </div>
      <div v-if="latestPrs.length" class="gsa__card">
        <div class="gsa__card-head">
          <p class="gsa__eyebrow">Open pull requests</p>
          <button type="button" class="gsa__more" @click="emit('go', 'prs')">
            All <HugeiconsIcon :icon="ArrowRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
        <button v-for="pr in latestPrs" :key="pr.number" type="button" class="gsa__row" @click="emit('openPr', pr.number)">
          <span class="gsa__row-num">#{{ pr.number }}</span>
          <span class="gsa__row-body">
            <span class="gsa__row-title">{{ pr.title }}</span>
            <span class="gsa__row-meta">
              {{ pr.author }} · {{ pr.relative }} ·
              <span class="gsa__add">+{{ pr.additions.toLocaleString() }}</span>
              <span class="gsa__del">−{{ pr.deletions.toLocaleString() }}</span>
            </span>
          </span>
          <span class="gsa__state" :class="`gsa__state--${prState(pr).tone}`">{{ prState(pr).label }}</span>
        </button>
      </div>
    </div>

    <!-- ── people ───────────────────────────────────────────────────────── -->
    <div v-if="people.length" class="gsa__block gsa__card" :style="{ '--i': 3 }">
      <div class="gsa__card-head">
        <p class="gsa__eyebrow">Who builds it</p>
        <span class="gsa__card-note">commits</span>
      </div>
      <div class="gsa__people">
        <div v-for="person in people" :key="person.name" class="gsa__person" :title="`${credit(person)}: ${plural(person.commits, 'commit')}`">
          <span class="gsa__avatar gsa__person-avatar" aria-hidden="true">
            <img v-if="person.avatarDataUrl" :src="person.avatarDataUrl" alt="" />
            <span v-else class="gsa__avatar-fallback">{{ person.name[0]?.toUpperCase() }}</span>
          </span>
          <span class="gsa__person-name">{{ credit(person) }}</span>
          <span class="gsa__person-track">
            <span class="gsa__person-bar" :style="{ width: `${(person.commits / peoplePeak) * 100}%` }" />
          </span>
          <span class="gsa__person-count">{{ person.commits.toLocaleString() }}</span>
        </div>
      </div>
      <p v-if="peopleMore > 0" class="gsa__people-more">and {{ plural(peopleMore, "other", true) }}</p>
    </div>

    <!-- ── readme ───────────────────────────────────────────────────────── -->
    <div class="gsa__block gsa__card gsa__readme-card" :style="{ '--i': 4 }">
      <template v-if="readme">
        <div class="gsa__card-head">
          <p class="gsa__eyebrow gsa__eyebrow--file">{{ readme.path }}</p>
        </div>
        <div class="gsa__readme selectable" :class="{ 'gsa__readme--folded': !readmeOpen }">
          <MarkdownMessage :source="readme.markdown" historical />
        </div>
        <button type="button" class="gsa__unfold" @click="readmeOpen = !readmeOpen">
          {{ readmeOpen ? "Show less" : "Read the whole README" }}
        </button>
      </template>
      <p v-else class="gsa__noreadme">No README in this repository.</p>
    </div>
  </section>
</template>

<style scoped>
.gsa {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-bottom: 24px;
}

/* ── entrance ─────────────────────────────────────────────────────────────── */
/* The blocks rise in together, each delayed by its own index — capped so a
   longer page never waits out a slow chain. */
.gsa__block {
  animation: gsa-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 2);
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

/* ── cards ────────────────────────────────────────────────────────────────── */
/* The same raised white cards the Overview's change cards sit on, so the two
   surfaces read as one app. */
.gsa__card {
  padding: 18px 20px;
  border-radius: 16px;
  background-color: var(--raised-high);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 5%, transparent);
}
.gsa__card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.gsa__eyebrow {
  margin: 0;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--ink-soft);
}
/* A filename keeps its own case and its mono face. */
.gsa__eyebrow--file {
  font-family: var(--font-mono);
  font-weight: 400;
  font-size: 11.5px;
  color: var(--muted);
}
.gsa__card-note {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}
.gsa__more {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 8px;
  margin-right: -8px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  transition: color var(--gs-t-micro) ease, background-color var(--gs-t-micro) ease;
}
.gsa__more:hover {
  color: var(--ink);
  background-color: var(--hover);
}

/* ── hero ─────────────────────────────────────────────────────────────────── */
.gsa__hero {
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 26px 26px 22px;
  border-radius: 20px;
  background:
    radial-gradient(120% 140% at 0% 0%, color-mix(in oklab, var(--accent) 9%, transparent), transparent 60%),
    var(--raised-high);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 5%, transparent);
}
.gsa__identity {
  display: flex;
  align-items: flex-start;
  gap: 18px;
}
.gsa__logo {
  flex-shrink: 0;
  width: 56px;
  height: 56px;
  border-radius: 14px;
  object-fit: cover;
  box-shadow: 0 6px 18px -8px color-mix(in srgb, var(--ink) 45%, transparent);
}
.gsa__logo--letter {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 600;
  color: var(--ground);
  background-color: var(--ink);
}
.gsa__identity-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.gsa__name {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.6px;
  line-height: 1.1;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.gsa__owner {
  font-weight: 400;
  color: var(--muted);
}
.gsa__description {
  margin: 0;
  max-width: 60ch;
  font-size: 14.5px;
  line-height: 1.55;
  color: var(--ink-soft);
  text-wrap: pretty;
}
.gsa__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.gsa__chip {
  padding: 3px 9px;
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--ink-soft);
  background-color: var(--hover);
}
.gsa__chip--topic {
  color: var(--accent);
  background-color: color-mix(in oklab, var(--accent) 10%, transparent);
}

.gsa__actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  flex-shrink: 0;
}
.gsa__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 8px 14px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.2;
  color: var(--ink);
  background-color: var(--hover);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color var(--gs-t-micro) ease, transform var(--gs-t-micro) ease;
}
.gsa__action:hover {
  background-color: color-mix(in srgb, var(--ink) 10%, transparent);
}
.gsa__action:active {
  transform: scale(0.98);
}
.gsa__action--primary {
  color: var(--ground);
  background-color: var(--ink);
}
.gsa__action--primary:hover {
  background-color: color-mix(in srgb, var(--ink) 86%, transparent);
}
.gsa__action--quiet {
  background: none;
  color: var(--muted);
}
.gsa__action:focus-visible,
.gsa__tile:focus-visible,
.gsa__row:focus-visible,
.gsa__more:focus-visible,
.gsa__unfold:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent);
}

/* Stat tiles: big numbers that are also doors. The arrow shows on hover, and a
   tile that opens a section here leans the accent; one that leaves for GitHub
   stays neutral. */
.gsa__tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
  gap: 10px;
}
.gsa__tile {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 12px 14px 12px;
  border-radius: 14px;
  text-align: left;
  color: var(--muted);
  background-color: color-mix(in srgb, var(--ground) 70%, transparent);
  cursor: pointer;
  transition: background-color var(--gs-t-micro) ease, transform var(--gs-t-small) var(--gs-ease);
}
.gsa__tile:hover {
  transform: translateY(-2px);
  background-color: var(--ground);
}
.gsa__tile-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  margin-bottom: 6px;
}
.gsa__tile-go {
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--gs-t-micro) ease, transform var(--gs-t-small) var(--gs-ease);
}
.gsa__tile:hover .gsa__tile-go {
  opacity: 1;
  transform: none;
}
.gsa__tile--inside .gsa__tile-top {
  color: var(--accent);
}
.gsa__tile-value {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.5px;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.gsa__tile-label {
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
}

.gsa__blocked {
  margin: 0;
  max-width: 58ch;
  font-size: 12.5px;
  line-height: 1.6;
  text-wrap: pretty;
  color: var(--muted);
}

/* ── pulse ────────────────────────────────────────────────────────────────── */
.gsa__pulse-line {
  margin: -4px 0 16px;
  font-size: 15px;
  line-height: 1.45;
  color: var(--ink);
  text-wrap: pretty;
}
/* One series, one hue: the accent. Bars are thin with a rounded top anchored
   to the baseline; an empty day keeps a short stub so the strip reads as a
   calendar, and each day's hit area is the full column. */
.gsa__pulse {
  display: grid;
  grid-template-columns: repeat(30, 1fr);
  align-items: end;
  gap: 2px;
  height: 72px;
}
.gsa__bar-hit {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  height: 100%;
}
.gsa__bar {
  width: min(100%, 12px);
  border-radius: 4px 4px 1px 1px;
  background-color: var(--accent);
  transform-origin: bottom;
  animation: gsa-grow 520ms var(--gs-ease) backwards;
  transition: opacity var(--gs-t-micro) ease;
}
.gsa__bar--empty {
  background-color: var(--hover);
}
.gsa__pulse:hover .gsa__bar:not(.gsa__bar--empty) {
  opacity: 0.45;
}
.gsa__pulse .gsa__bar-hit:hover .gsa__bar {
  opacity: 1;
}
@keyframes gsa-grow {
  from {
    transform: scaleY(0);
  }
}
.gsa__pulse-axis {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}

/* ── what's happening ─────────────────────────────────────────────────────── */
.gsa__now {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 18px;
}
.gsa__row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 9px 10px;
  margin: 0 -10px;
  width: calc(100% + 20px);
  border-radius: 10px;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--gs-t-micro) ease;
}
.gsa__row:hover {
  background-color: var(--hover);
}
.gsa__row-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.gsa__row-title {
  overflow: hidden;
  font-size: 13px;
  line-height: 1.35;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink);
}
.gsa__row-meta {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11.5px;
  line-height: 1.35;
  color: var(--muted);
}
.gsa__row-tail,
.gsa__row-num {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}
.gsa__row-num {
  width: 34px;
}
.gsa__add {
  font-family: var(--font-mono);
  color: var(--diff-add);
}
.gsa__del {
  margin-left: 4px;
  font-family: var(--font-mono);
  color: var(--diff-del);
}
/* A state is a word with a dot, never colour alone. */
.gsa__state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ink-soft);
}
.gsa__state::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--muted);
}
.gsa__state--ok::before {
  background-color: var(--diff-add);
}
.gsa__state--bad::before {
  background-color: var(--diff-del);
}
.gsa__state--warn::before {
  background-color: var(--accent);
}

/* ── avatars ──────────────────────────────────────────────────────────────── */
.gsa__avatar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--hover);
}
.gsa__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gsa__avatar-fallback {
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  color: var(--muted);
}
.gsa__row-avatar {
  width: 26px;
  height: 26px;
}

/* ── people ───────────────────────────────────────────────────────────────── */
.gsa__people {
  display: grid;
  grid-template-columns: auto minmax(90px, max-content) 1fr auto;
  align-items: center;
  column-gap: 12px;
  row-gap: 10px;
}
.gsa__person {
  display: contents;
}
.gsa__person-avatar {
  width: 24px;
  height: 24px;
}
.gsa__person-name {
  font-size: 13px;
  color: var(--ink);
}
.gsa__person-track {
  height: 8px;
  border-radius: 4px;
  background-color: var(--hover);
  overflow: hidden;
}
.gsa__person-bar {
  display: block;
  height: 100%;
  border-radius: 4px;
  background-color: var(--accent);
  transform-origin: left;
  animation: gsa-fill 620ms var(--gs-ease) backwards;
}
@keyframes gsa-fill {
  from {
    transform: scaleX(0);
  }
}
.gsa__person-count {
  min-width: 32px;
  font-family: var(--font-mono);
  font-size: 11px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.gsa__people-more {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--muted);
}

/* ── readme ───────────────────────────────────────────────────────────────── */
.gsa__readme {
  max-width: 72ch;
}
/* Folded to a preview that fades out, until it's asked for in full. */
.gsa__readme--folded {
  max-height: 320px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, #000 60%, transparent);
  mask-image: linear-gradient(to bottom, #000 60%, transparent);
}
.gsa__unfold {
  margin-top: 10px;
  padding: 7px 14px;
  border-radius: 10px;
  font-size: 12.5px;
  color: var(--ink);
  background-color: var(--hover);
  cursor: pointer;
  transition: background-color var(--gs-t-micro) ease;
}
.gsa__unfold:hover {
  background-color: color-mix(in srgb, var(--ink) 10%, transparent);
}
.gsa__noreadme {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
}

@media (max-width: 760px) {
  .gsa__identity {
    flex-wrap: wrap;
  }
  .gsa__actions {
    flex-direction: row;
    flex-wrap: wrap;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gsa__block,
  .gsa__bar,
  .gsa__person-bar {
    animation: none;
  }
  .gsa__tile,
  .gsa__tile-go {
    transition: none;
  }
}
</style>
