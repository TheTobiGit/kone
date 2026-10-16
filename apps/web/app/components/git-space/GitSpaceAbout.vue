<script setup lang="ts">
import { computed, onMounted, provide, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon, ArrowUpRight01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import MarkdownMessage from "~/components/markdown/MarkdownMessage.vue";
import { useGit } from "~/composables/useGit";
import type { useGitSpace } from "~/composables/useGitSpace";
import { IMAGE_RESOLVER_KEY, repoImagePath } from "~/utils/markdownImageSource";
import type { GitCommit, GitContributor, GitHubPullRequest } from "~/types/desktop";

// The repository's front page: the reason to open a project here rather than
// on GitHub. It's drawn more than written: quiet labels with counts, big mono
// numbers, dots and bars and faces instead of sentences — and nothing on it
// sits in a card.
//
// Two columns. The main one reads: the description and its links, then the
// README laid out as a page. The side one shows what's happening: the numbers,
// the latest commits as a timeline, four weeks of commits as dots you can
// open, the open pull requests with their size drawn, and the people who build
// it as a crowd. The GitHub-fed parts (facts, stars, avatars, pull requests)
// sit on top of what git alone
// knows: a missing or logged-out `gh` costs the page nothing it can't do
// without, and the reason appears once.

type Section = "about" | "changes" | "history" | "branches" | "prs" | "stashes";

const props = defineProps<{ space: ReturnType<typeof useGitSpace>; dir: string }>();
const emit = defineEmits<{
  /** Step to another section of the space. */
  go: [section: Section];
  openPr: [number: number, origin: DOMRect | null];
}>();

const { cue } = useSound();

// The README's own images ride the git module, not the thread's local-image
// grant: the section knows the checkout and the README's folder, so it can hand
// a repo-relative path to the bridge and get the bytes back as a data URL. This
// is provided to every Markdown image under here — the README above all.
const bridge = useGit();
provide(IMAGE_RESOLVER_KEY, (src: string) => {
  const rel = repoImagePath(readmeDir.value, src);
  return rel ? bridge.image(props.dir, rel) : Promise.resolve(null);
});

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
const homepage = computed(() => repoInfo.value?.homepageUrl || null);
/** The homepage without its scheme — nobody reads `https://` twice. */
const homepageLabel = computed(
  () => homepage.value?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? "",
);
// The numbers, big and bare, each a door. Nulls and GitHub-only facts drop out
// when GitHub can't answer.
type Stat = { key: string; label: string; value: number; go?: Section; url?: string };
const stats = computed<Stat[]>(() => {
  const r = repoInfo.value;
  const out: Stat[] = [];
  if (r) out.push({ key: "stars", label: plural(r.stars, "star", false), value: r.stars, url: `${r.url}/stargazers` });
  if (r) out.push({ key: "forks", label: plural(r.forks, "fork", false), value: r.forks, url: `${r.url}/forks` });
  const branches = props.space.branches.value.filter((b) => !b.remote).length;
  if (branches) out.push({ key: "branches", label: plural(branches, "branch", false, "es"), value: branches, go: "branches" });
  if (gh.value?.authenticated)
    out.push({ key: "prs", label: "open PRs", value: openPrs.value.length, go: "prs" });
  return out;
});

// ── rhythm ────────────────────────────────────────────────────────────────────
// Four weeks, a column a day, a dot a commit — from the first page of the log
// History already reads. Each dot is the commit itself: hover says which, click
// opens it. Yours are green, everyone else's ink, so "how much of this was me"
// is a glance. The window ends today; a repository that's been quiet for longer
// shows its last active four weeks instead, and says so.
const DAYS = 28;
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
const rhythmIsRecent = computed(() => rhythmEnd.value === startOfDay(Date.now()));
/** Commits in the window's last seven days, and from how many people. */
const lastWeek = computed(() => {
  const days = rhythm.value.slice(-7).flatMap((d) => d.commits);
  return { count: days.length, people: new Set(days.map((c) => c.email || c.author)).size };
});
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
// ── lately ────────────────────────────────────────────────────────────────────
const latest = computed<GitCommit[]>(() => commits.value.slice(0, 3));
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

// One scale for every pull request's size bar, so a big one looks big. Square
// root, so a 2,000-line change doesn't flatten every other bar to a sliver.
const prPeak = computed(() =>
  Math.max(1, ...latestPrs.value.map((pr) => Math.sqrt(pr.additions + pr.deletions))),
);
/** This part's share of the pull request's bar, the bar itself scaled to the peak. */
function prWidth(pr: GitHubPullRequest, lines: number): string {
  const all = pr.additions + pr.deletions;
  if (!all || !lines) return "0%";
  const bar = (Math.sqrt(all) / prPeak.value) * 100;
  return `${Math.max(1.5, (bar * lines) / all)}%`;
}
// ── people ────────────────────────────────────────────────────────────────────
// A crowd, not a leaderboard: everyone's face, sized by how much they've
// written, overlapping like people standing together. The sentence under it
// names whoever wrote the most, because that's the one fact a list of faces
// can't say on its own.
const PEOPLE_SHOWN = 7;
const people = computed(() => contributors.value?.people.slice(0, PEOPLE_SHOWN) ?? []);
const peoplePeak = computed(() => Math.max(1, ...people.value.map((p) => p.commits)));
const peopleMore = computed(() => (contributors.value?.total ?? 0) - people.value.length);
const peopleTotalCommits = computed(() =>
  (contributors.value?.people ?? []).reduce((n, p) => n + p.commits, 0),
);
/** Whoever wrote the most, and how much of it — the one fact faces can't say. */
const lead = computed(() => {
  const top = people.value[0];
  if (!top || people.value.length < 2 || !peopleTotalCommits.value) return null;
  return { person: top, share: Math.round((top.commits / peopleTotalCommits.value) * 100) };
});
function faceSize(person: GitContributor): number {
  return Math.round(30 + Math.sqrt(person.commits / peoplePeak.value) * 26);
}

// ── readme ────────────────────────────────────────────────────────────────────
// The README reads as the repository's front page, whole — no fold. Its images
// resolve against its own folder, so a README in `docs/` naming `./img/x.png`
// reads the right file.
const readmeDir = computed(() => {
  const p = readme.value?.path ?? "";
  const cut = p.lastIndexOf("/");
  return cut === -1 ? "" : p.slice(0, cut);
});

// ── outward actions ───────────────────────────────────────────────────────────
const cloneUrl = computed(() => origin.value?.fetchUrl ?? null);
const copied = ref(false);

// A commit opens in a card over About, grown from whatever was clicked, so the
// page is still there when you close it.
const opened = ref<{ hash: string; origin: DOMRect | null } | null>(null);
function openCommit(e: MouseEvent, hash: string) {
  cue("open");
  // SAFETY: bound on a button, so currentTarget is that element.
  opened.value = { hash, origin: (e.currentTarget as HTMLElement).getBoundingClientRect() };
}
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
    <!-- ══ the main column: what it is, and how to read it ═══════════════ -->
    <div class="gsa__main">
      <!-- ── the story ──────────────────────────────────────────────────── -->
      <div class="gsa__block gsa__story" :style="{ '--i': 0 }">
        <p v-if="description" class="gsa__lede selectable">{{ description }}</p>
        <p v-if="blocked" class="gsa__blocked">{{ blocked }}</p>
        <div class="gsa__links">
          <button v-if="repoInfo" type="button" class="gsa__link gsa__link--ink" @click="open(repoInfo.url)">
            GitHub
            <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
          </button>
          <button v-if="homepage" type="button" class="gsa__link" @click="open(homepage)">
            {{ homepageLabel }}
            <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
          </button>
          <button v-if="cloneUrl" type="button" class="gsa__link" :title="cloneUrl" @click="copyClone">
            <HugeiconsIcon :icon="copied ? Tick02Icon : Copy01Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
            {{ copied ? "Copied" : "Clone" }}
          </button>
        </div>
      </div>

      <!-- ── readme ─────────────────────────────────────────────────────── -->
      <div class="gsa__block gsa__doc" :style="{ '--i': 2 }">
        <div class="gsa__label">
          <span class="gsa__label-name gsa__label-name--file">{{ readme?.path ?? "README" }}</span>
        </div>
        <template v-if="readme">
          <div class="gsa__readme selectable">
            <MarkdownMessage :source="readme.markdown" historical />
          </div>
        </template>
        <p v-else class="gsa__blocked">No README in this repository.</p>
      </div>
    </div>

    <!-- ══ the side column: the repository, drawn ═══════════════════════ -->
    <aside class="gsa__side">
      <!-- The numbers, big and bare. Each is a door: the ones with a section
           here open it, the rest open GitHub. -->
      <div v-if="stats.length" class="gsa__block gsa__stats" :style="{ '--i': 1 }">
        <button
          v-for="(stat, n) in stats"
          :key="stat.key"
          type="button"
          class="gsa__stat"
          :style="{ '--n': n }"
          @click="stat.go ? emit('go', stat.go) : open(stat.url)"
        >
          <span class="gsa__stat-value">{{ compact(stat.value) }}</span>
          <span class="gsa__stat-label">{{ stat.label }}</span>
        </button>
      </div>

      <!-- ── latest ─────────────────────────────────────────────────────── -->
      <div v-if="latest.length" class="gsa__block" :style="{ '--i': 2 }">
        <div class="gsa__label">
          <span class="gsa__label-name">Latest commits</span>
          <button type="button" class="gsa__label-go" @click="emit('go', 'history')">
            All <HugeiconsIcon :icon="ArrowRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
        <ol class="gsa__timeline">
          <li v-for="c in latest" :key="c.hash">
            <button type="button" class="gsa__event" :title="`${c.subject}\n${c.short}`" aria-haspopup="dialog" @click="openCommit($event, c.hash)">
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
              </span>
            </button>
          </li>
        </ol>
      </div>

      <!-- ── rhythm ─────────────────────────────────────────────────────── -->
      <div v-if="commits.length" class="gsa__block" :style="{ '--i': 2 }">
        <div class="gsa__label">
          <span class="gsa__label-name">Rhythm</span>
          <span class="gsa__label-count">{{ rhythmTotal }}</span>
          <span class="gsa__label-note">{{ rhythmIsRecent ? "last 4 weeks" : `4 weeks to ${month(new Date(rhythmEnd).toISOString())}` }}</span>
        </div>
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
                aria-haspopup="dialog"
                @click="openCommit($event, c.hash)"
              >
                <template v-if="n === STACK - 1 && overflow(day)">+</template>
              </button>
              <span v-if="!day.commits.length" class="gsa__dot gsa__dot--none" />
            </span>
          </div>
        </div>
        <p class="gsa__sub">
          <b>{{ lastWeek.count }}</b> in the last week from <b>{{ lastWeek.people }}</b> {{ lastWeek.people === 1 ? "person" : "people" }}<template v-if="rhythmMine"> · <i class="gsa__mine-key" aria-hidden="true" /> <b>{{ rhythmMine }}</b> yours</template>
        </p>
      </div>

      <!-- ── pull requests ──────────────────────────────────────────────── -->
      <div v-if="latestPrs.length" class="gsa__block" :style="{ '--i': 3 }">
        <div class="gsa__label">
          <span class="gsa__label-name">Pull requests</span>
          <span class="gsa__label-count">{{ openPrs.length }}</span>
          <button type="button" class="gsa__label-go" @click="emit('go', 'prs')">
            All <HugeiconsIcon :icon="ArrowRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
        <!-- Each with its size drawn: green for what it adds, red for what it
             removes, on one scale so a big one looks big. -->
        <button
          v-for="(pr, n) in latestPrs"
          :key="pr.number"
          type="button"
          class="gsa__pr"
          :title="pr.title"
          @click="emit('openPr', pr.number, ($event.currentTarget as HTMLElement).getBoundingClientRect())"
        >
          <span class="gsa__pr-title">{{ pr.title }}</span>
          <span class="gsa__pr-size" :style="{ '--n': n }">
            <i class="gsa__pr-add" :style="{ width: prWidth(pr, pr.additions) }" />
            <i class="gsa__pr-del" :style="{ width: prWidth(pr, pr.deletions) }" />
          </span>
          <span class="gsa__pr-meta">
            <span class="gsa__state" :class="`gsa__state--${prState(pr).tone}`">{{ prState(pr).label }}</span>
            <span class="gsa__sep">·</span>
            {{ pr.author }}
          </span>
        </button>
      </div>

      <!-- ── people ─────────────────────────────────────────────────────── -->
      <div v-if="people.length" class="gsa__block" :style="{ '--i': 4 }">
        <div class="gsa__label">
          <span class="gsa__label-name">People</span>
          <span class="gsa__label-count">{{ contributors?.total ?? people.length }}</span>
        </div>
        <div class="gsa__crowd">
          <span
            v-for="(person, n) in people"
            :key="person.name"
            class="gsa__crowd-person"
            :style="{ '--s': `${faceSize(person)}px`, '--n': n, zIndex: PEOPLE_SHOWN - n }"
            :title="`${credit(person)} · ${plural(person.commits, 'commit')}`"
          >
            <span class="gsa__crowd-face">
              <img v-if="person.avatarDataUrl" :src="person.avatarDataUrl" alt="" />
              <template v-else>{{ person.name[0]?.toUpperCase() }}</template>
            </span>
          </span>
          <span v-if="peopleMore > 0" class="gsa__crowd-more">+{{ peopleMore }}</span>
        </div>
        <p v-if="lead" class="gsa__sub">
          <b>{{ credit(lead.person) }}</b> wrote <b>{{ lead.share }}%</b> of it, then <b>{{ credit(people[1]!) }}</b> with <b>{{ people[1]!.commits.toLocaleString() }}</b> commits.
        </p>
      </div>
    </aside>

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
/* Two columns: the main one reads (what it is, the README), the side one
   shows what's happening (numbers, latest commits, rhythm, pull requests,
   people). */
.gsa {
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(280px, 26cqi, 360px);
  align-items: start;
  gap: clamp(48px, 6cqi, 88px);
  padding-bottom: 40px;
}
.gsa__main,
.gsa__side {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.gsa__main {
  gap: 52px;
}
.gsa__side {
  gap: 48px;
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
@keyframes gsa-pop {
  from {
    opacity: 0;
    transform: scale(0.2);
  }
}

/* ── labels ───────────────────────────────────────────────────────────────── */
/* The Overview's section label: a quiet name, its count in mono, and a way
   onward at the far end. */
.gsa__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 20px;
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
.gsa__mine-key {
  display: inline-block;
  vertical-align: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: var(--diff-add);
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
  gap: 14px;
  max-width: 560px;
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
}

/* The numbers: big mono figures over a one-word label, nothing around them. */
.gsa__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 2px;
  margin: -6px -8px 0;
}
.gsa__stat {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 6px 8px;
  border-radius: 10px;
  cursor: pointer;
  transition: background-color var(--gs-t-micro) ease;
  animation: gsa-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(80ms + var(--n, 0) * 50ms);
}
.gsa__stat:hover {
  background-color: var(--hover);
}
.gsa__stat-value {
  font-family: var(--font-mono);
  font-size: 19px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: -0.04em;
  color: var(--ink);
}
.gsa__stat-label {
  font-size: 12px;
  white-space: nowrap;
  color: var(--muted);
}

/* ── rhythm ───────────────────────────────────────────────────────────────── */
.gsa__rhythm {
  display: flex;
}
.gsa__day {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1 1 0;
  min-width: 0;
}
.gsa__day-stack {
  display: flex;
  flex-direction: column-reverse;
  align-items: center;
  gap: 3px;
  height: calc(var(--rows, 7) * 11px);
  padding-bottom: 8px;
  box-sizing: content-box;
  width: 100%;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
}
.gsa__dot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background-color: color-mix(in srgb, var(--ink) 72%, transparent);
  font-family: var(--font-mono);
  font-size: 8px;
  line-height: 1;
  color: var(--ground);
  cursor: pointer;
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
.gsa__dot--mine,
.gsa__dot--mine:hover {
  background-color: var(--diff-add);
}
.gsa__dot--more {
  width: 10px;
  height: 10px;
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
  background-color: color-mix(in srgb, var(--ink) 14%, transparent);
}
.gsa__dot:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 40%, transparent);
  outline-offset: 2px;
}
/* A sublabel under a drawing: one quiet line, its numbers in ink. */
.gsa__sub {
  margin: 14px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--muted);
}
.gsa__sub b {
  font-weight: 500;
  color: var(--ink-soft);
}

/* ── lately ───────────────────────────────────────────────────────────────── */

/* The latest commits as a timeline: one hairline, a dot per commit, its
   subject, and who and when underneath. */
.gsa__timeline {
  position: relative;
  margin: 0;
  padding: 0;
  list-style: none;
}
.gsa__timeline::before {
  content: "";
  position: absolute;
  left: 4.5px;
  top: 18px;
  bottom: 18px;
  width: 1.5px;
  border-radius: 1px;
  background-color: color-mix(in srgb, var(--ink) 10%, transparent);
}
.gsa__event {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: calc(100% + 8px);
  margin-left: -8px;
  padding: 10px 8px 11px 30px;
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
  top: 15px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background-color: var(--ground);
  box-shadow: inset 0 0 0 2.5px color-mix(in srgb, var(--ink) 40%, transparent);
}
.gsa__event-dot--mine {
  box-shadow: inset 0 0 0 2.5px var(--diff-add);
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
  font-size: 10px;
  color: var(--muted);
}
.gsa__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
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
.gsa__sep {
  opacity: 0.6;
}
.gsa__hash {
  margin-left: auto;
  padding-left: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
}

/* Pull requests: the title, the change drawn under it, then its state. */
.gsa__pr {
  display: flex;
  flex-direction: column;
  gap: 7px;
  width: calc(100% + 16px);
  margin-left: -8px;
  padding: 10px 8px 12px;
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
.gsa__pr-size {
  display: flex;
  gap: 2px;
  height: 6px;
}
.gsa__pr-add,
.gsa__pr-del {
  height: 100%;
  border-radius: 3px;
  transform-origin: left center;
  animation: gsa-grow 600ms var(--gs-ease) backwards;
  animation-delay: calc(240ms + var(--n, 0) * 70ms);
}
.gsa__pr-add {
  background-color: var(--diff-add);
}
.gsa__pr-del {
  background-color: var(--diff-del);
}
@keyframes gsa-grow {
  from {
    transform: scaleX(0);
  }
}

/* ── people ───────────────────────────────────────────────────────────────── */
/* A crowd, not a leaderboard: overlapping faces sized by commits, the top
   everyone lifting a little when pointed at. */
.gsa__crowd {
  display: flex;
  align-items: flex-start;
  padding-left: 10px;
}
.gsa__crowd-person {
  position: relative;
  display: flex;
  margin-left: -10px;
  animation: gsa-pop 460ms cubic-bezier(0.34, 1.56, 0.64, 1) backwards;
  animation-delay: calc(200ms + var(--n, 0) * 55ms);
}
.gsa__crowd-face {
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
  transition: transform var(--gs-t-small) var(--gs-ease);
}
.gsa__crowd-person:hover .gsa__crowd-face {
  transform: translateY(-5px);
}
.gsa__crowd-face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gsa__crowd-more {
  align-self: center;
  margin-left: 14px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
}

/* ── readme ───────────────────────────────────────────────────────────────── */
/* The README as a page of the app, not a file in a box: the whole document at
   the column's width, straight on the ground. Headings open up past their
   in-reply size — a README is read as a page, so its title should read like
   one — and media takes the full column. Running text keeps the reading
   measure, though: at the column's full width a paragraph runs past 120
   characters a line. */
.gsa__readme {
  max-width: 100%;
}
.gsa__readme :deep(:is(p, ul, ol, blockquote, h3, h4)) {
  max-width: var(--measure);
}
.gsa__readme :deep(h1) {
  margin: 30px 0 12px;
  font-size: 27px;
  line-height: 1.15;
  letter-spacing: -0.02em;
}
.gsa__readme :deep(h2) {
  margin: 28px 0 10px;
  font-size: 20px;
  line-height: 1.2;
  letter-spacing: -0.015em;
}
.gsa__readme :deep(h3) {
  margin: 22px 0 8px;
  font-size: 16px;
}
.gsa__readme :deep(h4) {
  font-size: 14.5px;
}
.gsa__readme :deep(h1:first-child),
.gsa__readme :deep(h2:first-child),
.gsa__readme :deep(h3:first-child) {
  margin-top: 0;
}
/* A hairline under the top-level sections, the way a README page breaks up. */
.gsa__readme :deep(h1:not(:first-child)),
.gsa__readme :deep(h2) {
  padding-bottom: 7px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 9%, transparent);
}

/* Narrow: no room for the side column beside the README, and stacked whole
   under it the activity would sit a README's length away. So the two columns
   dissolve into one grid: what it is, the numbers, the activity two by two,
   then the README. */
@container (max-width: 820px) {
  .gsa {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 48px 40px;
  }
  .gsa__main,
  .gsa__side {
    display: contents;
  }
  .gsa__block {
    order: 2;
  }
  .gsa__story,
  .gsa__stats,
  .gsa__doc {
    grid-column: 1 / -1;
  }
  .gsa__story {
    order: 0;
  }
  .gsa__stats {
    order: 1;
  }
  .gsa__doc {
    order: 3;
  }
}
@container (max-width: 520px) {
  .gsa {
    grid-template-columns: minmax(0, 1fr);
    gap: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gsa__block,
  .gsa__stat,
  .gsa__dot,
  .gsa__pr-add,
  .gsa__pr-del,
  .gsa__crowd-person {
    animation: none;
  }
  .gsa__dot,
  .gsa__crowd-face {
    transition: none;
  }
}
</style>
