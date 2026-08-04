<script setup lang="ts">
import { computed, onMounted } from "vue";
import MarkdownMessage from "~/components/MarkdownMessage.vue";
import type { useGitSpace } from "~/composables/useGitSpace";
import type { GitContributor } from "~/types/desktop";

// The repository, as something to read rather than act on. The face of the
// space: opening a project should answer "what is this" before "what am I doing
// to it", and the working tree is one click away on the rail.
//
// Three quiet blocks — what the repo is, who wrote it, and what its README says.
// The GitHub-fed parts (the facts line, the topics, the contributor avatars) sit
// on top of what git alone knows: a missing or logged-out `gh` costs the section
// nothing it can't do without, and the reason appears once, plain, instead of
// blanking the page. Who *you* are used to be a block here; it's chrome, not a
// fact about this repository, so it lives at the foot of the rail now.

const props = defineProps<{ space: ReturnType<typeof useGitSpace> }>();

// The shell reads About on entry (the rail footer needs it too), but this
// section is also the one that can be reached without the shell having asked —
// so it asks as well, and `loadAbout` de-dupes the two into one round trip.
onMounted(() => {
  void props.space.loadAbout();
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

/** "18 contributors" / "1 contributor" — the count line above the row. */
const contributorCount = computed(() => {
  const n = contributors.value?.total ?? 0;
  return `${n.toLocaleString()} contributor${n === 1 ? "" : "s"}`;
});

/** The repo's name — GitHub's `owner/repo` when reachable, the folder otherwise. */
const repoName = computed(() => repoInfo.value?.nameWithOwner ?? props.space.name.value);
const description = computed(() => repoInfo.value?.description);

// One quiet mono line of facts. Nulls are dropped, never printed as "unknown".
// Ordered so the two that describe the code come first, then the two that count
// people, then the four that place the repository in time and space.
const facts = computed<string[]>(() => {
  const r = repoInfo.value;
  if (!r) return [];
  const out: string[] = [];
  if (r.language) out.push(r.language);
  if (r.license) out.push(r.license);
  out.push(plural(r.stars, "star"));
  out.push(plural(r.forks, "fork"));
  if (r.visibility) out.push(r.visibility.toLowerCase());
  if (r.isFork) out.push("fork");
  if (r.defaultBranch) out.push(`default ${r.defaultBranch}`);
  // Born-on is a fixed point, so it reads as a date; last-touched is the one
  // that means something relative to now.
  if (r.createdAt) out.push(`created ${month(r.createdAt)}`);
  if (r.pushedAt) out.push(`updated ${relative(r.pushedAt)}`);
  return out;
});

const topics = computed(() => repoInfo.value?.topics ?? []);
const homepage = computed(() => repoInfo.value?.homepageUrl || null);
/** The homepage without its scheme — nobody reads `https://` twice. */
const homepageLabel = computed(
  () => homepage.value?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? "",
);

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

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
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

/** An ISO timestamp as a quiet "updated … ago" phrase. */
function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
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
  return `${Math.floor(months / 12)} years ago`;
}
</script>

<template>
  <GitSpaceSkeleton v-if="!ready" variant="prose" />

  <section v-else class="gsa">
    <!-- ── identity ─────────────────────────────────────────────────────── -->
    <div class="gsa__block" :style="{ '--i': 0 }">
      <div class="gsa__identity">
        <img v-if="logo" :src="logo.dataUrl" alt="" class="gsa__logo" />
        <div class="gsa__identity-body">
          <h2 class="gsa__name">{{ repoName }}</h2>
          <p v-if="description" class="gsa__description">{{ description }}</p>
          <button
            v-if="homepage"
            type="button"
            class="gsa__home"
            @click="open(homepage)"
          >
            {{ homepageLabel }}
          </button>
        </div>
      </div>

      <p v-if="facts.length" class="gsa__facts">
        <span v-for="fact in facts" :key="fact">{{ fact }}</span>
      </p>
      <p v-if="topics.length" class="gsa__topics">
        <span v-for="topic in topics" :key="topic">{{ topic }}</span>
      </p>
      <!-- Why the GitHub-fed half of this page is missing. It sits under the
           facts it explains, not in a banner: it's a setup detail, not a fault,
           and the rest of the section is still true without it. -->
      <p v-if="blocked" class="gsa__blocked">{{ blocked }}</p>
    </div>

    <!-- ── contributors ─────────────────────────────────────────────────── -->
    <div v-if="contributors?.total" class="gsa__block" :style="{ '--i': 1 }">
      <p class="gsa__eyebrow">{{ contributorCount }}</p>
      <div class="gsa__contributors">
        <div v-for="person in contributors.people" :key="person.name" class="gsa__contributor">
          <span class="gsa__avatar gsa__contributor-avatar" aria-hidden="true">
            <img v-if="person.avatarDataUrl" :src="person.avatarDataUrl" alt="" />
            <span v-else class="gsa__avatar-fallback">{{ person.name[0]?.toUpperCase() }}</span>
          </span>
          <span class="gsa__contributor-name">{{ credit(person) }}</span>
          <span class="gsa__contributor-count">{{ person.commits.toLocaleString() }}</span>
        </div>
      </div>
      <p
        v-if="contributors.total > contributors.people.length"
        class="gsa__contributors-more"
      >
        +{{ (contributors.total - contributors.people.length).toLocaleString() }} more
      </p>
    </div>

    <!-- ── readme ───────────────────────────────────────────────────────── -->
    <div class="gsa__block" :style="{ '--i': 2 }">
      <template v-if="readme">
        <p class="gsa__eyebrow">{{ readme.path }}</p>
        <div class="gsa__readme selectable">
          <MarkdownMessage :source="readme.markdown" historical />
        </div>
      </template>
      <p v-else class="gsa__noreadme">No README in this repository.</p>
    </div>
  </section>
</template>

<style scoped>
.gsa {
  display: flex;
  flex-direction: column;
  gap: 44px;
  padding-bottom: 12px;
}

/* ── entrance ─────────────────────────────────────────────────────────────── */
/* The blocks rise in together, each delayed by its own index — capped so a
   longer section never waits out a slow chain. The README body is one block and
   animates once as a whole; nothing inside it staggers. */
.gsa__block {
  animation: gsa-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger));
}
@keyframes gsa-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ── identity ─────────────────────────────────────────────────────────────── */
.gsa__identity {
  display: flex;
  align-items: flex-start;
  gap: 18px;
}
.gsa__logo {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: 8px;
  object-fit: cover;
}
.gsa__identity-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.gsa__name {
  font-size: 26px;
  letter-spacing: -0.4px;
  line-height: 1.15;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.gsa__description {
  margin: 0;
  max-width: 62ch;
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink-soft);
}

/* One quiet mono line of facts, the parts joined by a drawn dot so none of
   them can be selected or wrap onto a line of its own. */
.gsa__facts {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.gsa__facts > span + span::before {
  content: "·";
  margin-right: 10px;
  opacity: 0.5;
}
/* Topics are bare words — no chips, no pills, no borders. */
.gsa__topics {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 9px;
  margin-top: 9px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--muted);
}

/* The one link on the page, so it's a word with an underline rather than a
   button: pulled from the font's own metrics, and skipping descenders. */
.gsa__home {
  align-self: flex-start;
  margin-top: 2px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-soft);
  cursor: pointer;
  text-decoration: underline;
  text-underline-position: from-font;
  text-decoration-thickness: from-font;
  text-decoration-color: color-mix(in srgb, var(--ink) 25%, transparent);
  text-underline-offset: 2px;
  transition: color var(--gs-t-micro) ease;
}
.gsa__home:hover {
  color: var(--ink);
}
.gsa__home:focus-visible {
  outline: none;
  border-radius: 3px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.gsa__blocked {
  margin-top: 14px;
  max-width: 58ch;
  font-size: 12.5px;
  line-height: 1.6;
  text-wrap: pretty;
  color: var(--muted);
}

/* ── people ───────────────────────────────────────────────────────────────── */
.gsa__avatar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
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
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
}
/* The people row wraps like the facts line — 18px between people, 8px inside
   one person — so a whole person travels as a unit and a wrap never strands an
   avatar from its name. The avatar is the same circle the "you" block draws,
   just sized down; the fallback letter rides inside it identically. */
.gsa__contributors {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 18px;
}
.gsa__contributor {
  display: flex;
  align-items: center;
  gap: 8px;
}
.gsa__contributor-avatar {
  width: 20px;
  height: 20px;
}
.gsa__contributor-avatar .gsa__avatar-fallback {
  font-size: 10px;
}
.gsa__contributor-name {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-soft);
}
.gsa__contributor-count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
/* Its own line, not the tail of the row: set in the same muted mono as the
   commit counts, it sat one gap after the last person's tally and read as a
   seventh contributor. It summarises the row, so it sits under it. Not a
   control — it goes nowhere on click. */
.gsa__contributors-more {
  margin-top: 12px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--muted);
}

/* ── readme ───────────────────────────────────────────────────────────────── */
/* The filename, not a section label — `README.md` uppercased is `README.MD`,
   which is a different file. Every identifier in this space (branch refs, the
   masthead slug, paths, hashes) is set mono in its own case, and lowercase mono
   already carries the sidebearings that wide tracking exists to add. */
.gsa__eyebrow {
  margin-bottom: 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.2px;
  line-height: 1;
  color: var(--muted);
}
.gsa__readme {
  max-width: 68ch;
}
.gsa__noreadme {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .gsa__block {
    animation: none;
    transition: none;
  }
}
</style>
