<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  CloudUploadIcon,
  Archive01Icon,
  Clock01Icon,
  FileEditIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  InformationCircleIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import type { Project } from "~/composables/useProject";
import type { useGitSpace } from "~/composables/useGitSpace";
import type { useProjectGit } from "~/composables/useProjectGit";

// The repository, as a place rather than a panel.
//
// This is the shell: a left column that stays put — which repository and
// branch this is, how it stands with origin and the one sync action that
// matters, then the sections, each with its icon — and the section itself
// beside it. The whole page scrolls as one and the left column sticks. Everything factual lives in `space` (the shared
// funnel) — this component decides what is worth showing and, more importantly,
// what isn't. Exactly one action carries weight at a time, because a row of
// equal-weight buttons makes the user do the reading the page should have done.

const props = defineProps<{
  project: Project;
  space: ReturnType<typeof useGitSpace>;
  git: ReturnType<typeof useProjectGit>;
  /** The layer is on screen. Sections load on first reveal, not on mount. */
  visible: boolean;
}>();

const emit = defineEmits<{
  openFile: [path: string, rect: DOMRect | null];
}>();

const { cue } = useSound();

type Section = "about" | "changes" | "history" | "branches" | "prs" | "stashes";
// You land on About. Opening a repository should first answer "what is this",
// and only then "what am I doing to it" — the working tree is one click away
// and, unlike the README, it's already summarised on the screen you came from.
const section = ref<Section>("about");
// Sections mount on first visit and stay — a paged history or a scrolled branch
// list shouldn't be thrown away because you glanced at pull requests.
const visited = ref<Section[]>(["about"]);

const SECTIONS: { id: Section; label: string; icon: typeof GitBranchIcon }[] = [
  { id: "about", label: "About", icon: InformationCircleIcon },
  { id: "changes", label: "Changes", icon: FileEditIcon },
  { id: "history", label: "History", icon: Clock01Icon },
  { id: "branches", label: "Branches", icon: GitBranchIcon },
  { id: "prs", label: "Pull requests", icon: GitPullRequestIcon },
  { id: "stashes", label: "Stashes", icon: Archive01Icon },
];

function countFor(id: Section): number | null {
  if (id === "changes") return props.git.fileCount.value;
  if (id === "branches") return props.space.branches.value.length || null;
  if (id === "prs") return props.space.prs.value.length || null;
  if (id === "stashes") return props.space.stashes.value.length || null;
  // History pages forever, so a count there would only ever mean "loaded so
  // far"; About isn't a list and has nothing to count.
  return null;
}

const scrollEl = ref<HTMLElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
// One scroll container serves every section, so each section's offset is kept
// by hand. Without this, leaving a history you'd read halfway down strands you
// at the same pixel offset in Branches — and coming back starts you at the top
// of a list you'd already worked through.
const scrollTops = new Map<Section, number>();

function go(next: Section) {
  if (section.value === next) return;
  cue("select");
  const el = scrollEl.value;
  if (el) scrollTops.set(section.value, el.scrollTop);
  section.value = next;
  if (!visited.value.includes(next)) visited.value.push(next);
  // A failure from the last section isn't news in this one.
  props.space.error.value = null;
  load(next);
  void nextTick(() => {
    const s = scrollEl.value;
    const p = panelEl.value;
    if (!s || !p) return;
    s.scrollTop = scrollTops.get(next) ?? 0;
    // Retrigger the entrance so the new section arrives instead of blinking
    // into place. Removing the class, forcing a reflow and re-adding it is the
    // only way to restart a CSS animation on an element that never unmounts.
    p.classList.remove("gs__panel--swap");
    void p.offsetWidth;
    p.classList.add("gs__panel--swap");
  });
}

function load(which: Section) {
  const s = props.space;
  if (which === "about") void s.loadAbout();
  else if (which === "history") {
    void s.loadCommits();
    // Faces arrive on their own schedule and the log never waits for them.
    void s.loadCommitAuthors();
  } else if (which === "branches") void s.loadBranches();
  else if (which === "prs") void s.loadPrs();
  else if (which === "stashes") void s.loadStashes();
}

// First reveal fetches the repo-wide facts the masthead reads (remotes, mid-op
// state, the GitHub CLI) plus the branch list — the masthead needs the current
// branch's upstream to know whether "Push" is really "Publish". About is read
// here too rather than only when its section is on screen, because the rail
// footer says who you are on every section, not just that one.
watch(
  () => props.visible,
  (on) => {
    if (!on) return;
    void props.space.load();
    void props.space.loadBranches();
    void props.space.loadAbout();
    load(section.value);
  },
  { immediate: true },
);

// ── the open pull request ─────────────────────────────────────────────────────
// A pull request opens in a card over the section that listed it, grown out of
// the clicked row, the way a commit and a changed file do: the list stays where
// you left it under the scrim, and closing the card shrinks it back into its
// row. The card owns its own Escape, so nothing here listens for one.
const pr = ref<{ number: number; origin: DOMRect | null } | null>(null);

function openPr(number: number, origin: DOMRect | null) {
  cue("open");
  pr.value = { number, origin };
}

// ── what the masthead says ────────────────────────────────────────────────────
const origin = computed(() => props.space.origin.value);
const originLabel = computed(() => {
  const o = origin.value;
  if (!o) return null;
  // github.com is where almost every repo lives — spelling it out on each one
  // is noise, so it's implied and only a different host gets named.
  if (o.host && o.slug) return o.host === "github.com" ? o.slug : `${o.host}/${o.slug}`;
  return o.fetchUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "");
});

const currentBranch = computed(
  () => props.space.branches.value.find((b) => b.current) ?? null,
);
const upstream = computed(() => currentBranch.value?.upstream ?? null);
const branchName = computed(() => props.git.branch.value);

const ahead = computed(() => props.git.ahead.value);
const behind = computed(() => props.git.behind.value);

// The masthead used to recite the upstream, the ahead count, the file count and
// the diffstat. Every one of those is already on screen: the branch title says
// the branch, the Push button carries ↑n, the rail counts the changed files, and
// the diffstat belongs to the Changes list. So this line says the one thing
// nothing else can, and most of the time that's nothing at all — the masthead
// is two lines and the silence means "normal".
const note = computed<string | null>(() => {
  if (!origin.value) return null;
  if (!upstream.value) return "Not published";
  if (ahead.value > 0 && behind.value > 0) return `Diverged ↑${ahead.value} ↓${behind.value}`;
  // An upstream that isn't simply origin/<this branch> is genuinely surprising.
  const tail = upstream.value.split("/").slice(1).join("/");
  if (tail && tail !== branchName.value) return `tracking ${upstream.value}`;
  return null;
});

const midOperation = computed(() => props.space.state.value.operation !== "none");
const conflictCount = computed(() => props.space.state.value.conflicts.length);

// Exactly one action carries weight, and only when there is something to do.
const primary = computed<"push" | "pull" | null>(() => {
  if (midOperation.value) return null;
  if (ahead.value > 0 || !upstream.value) return ahead.value > 0 ? "push" : null;
  if (behind.value > 0) return "pull";
  return null;
});
/** A branch with no upstream isn't pushed, it's published. */
const pushLabel = computed(() => {
  if (!upstream.value) return "Publish";
  return ahead.value > 0 ? `Push ↑${ahead.value}` : "Push";
});
const pullLabel = computed(() =>
  behind.value > 0 ? `Pull ↓${behind.value}` : "Pull",
);

const busy = computed(() => props.space.op.value !== null);

// ── who you are ───────────────────────────────────────────────────────────────
// The headline greets you the way the Overview does: "Hey, @you". It's chrome,
// true on every section, so it lives in the shell rather than in About.
const me = computed(() => props.space.me.value);
const identity = computed(() => props.space.identity.value);

const whoFace = computed(() => me.value?.avatarDataUrl ?? me.value?.avatarUrl ?? null);
/** Your GitHub handle, or the name git signs commits with, or nothing. */
const whoName = computed(
  () => (me.value ? `@${me.value.login}` : identity.value.name || identity.value.email) || null,
);
const whoInitial = computed(() => whoName.value?.replace("@", "")[0]?.toUpperCase() ?? "");

// A commit address that isn't your GitHub account is worth knowing, and it used
// to be spelled out in a sentence. Under the handle it needs no sentence: two
// lines that disagree say it, and when they agree there's only one line.
const whoEmail = computed<string | null>(() => {
  const email = identity.value.email;
  const login = me.value?.login;
  if (!email || !login) return null;
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  // GitHub's own noreply addresses carry the login after the '+'.
  const root = local.split("+").pop() ?? local;
  const handle = login.toLowerCase();
  return local === handle || root === handle ? null : email;
});

// ── the repository, at the head of the column ──────────────────────────────────
const repoName = computed(
  () => props.space.repoInfo.value?.nameWithOwner?.split("/").at(-1) ?? props.space.name.value,
);
const repoLogo = computed(() => props.space.logo.value?.dataUrl ?? null);
const repoUrl = computed(() => props.space.repoInfo.value?.url ?? null);
const operationWord = computed(() => {
  const op = props.space.state.value.operation;
  return op === "cherry-picking" ? "Cherry-picking" : op[0]!.toUpperCase() + op.slice(1);
});

// One pill slides to the section you picked. The rows are a fixed ladder —
// 34px rows on a 2px gap — so where it goes is arithmetic, not measurement.
const activeIndex = computed(() => SECTIONS.findIndex((s) => s.id === section.value));

// These run for seconds against a remote, long enough to look away, so each
// one sounds where it lands as well as where it starts. The buttons are
// disabled while an operation runs, so a `false` here is git refusing, never
// a busy no-op. A fetch only moves remote refs, so it lands silently and
// speaks up only when it fails.
async function landed(op: Promise<boolean>, quietOnSuccess = false): Promise<void> {
  const ok = await op;
  if (!ok) cue("error");
  else if (!quietOnSuccess) cue("success");
}
function onFetch() {
  cue("press");
  void landed(props.space.fetch(), true);
}
function onPull() {
  cue("press");
  void landed(props.space.pull());
}
function onPush() {
  cue("press");
  void landed(props.space.push(upstream.value ? undefined : { setUpstream: true }));
}
function onContinue() {
  cue("press");
  void landed(props.space.continueOperation());
}
function onAbort() {
  cue("press");
  void landed(props.space.abortOperation(), true);
}
</script>


<template>
  <div class="gs">
    <div ref="scrollEl" class="gs__scroll">
      <div class="gs__col">
        <!-- ── the left column ────────────────────────────────────────────── -->
        <nav class="gs__side" aria-label="Repository">
          <!-- Which repository, which branch, and how it stands with origin. -->
          <div class="gs__repo">
            <button
              type="button"
              class="gs__repo-name"
              :disabled="!repoUrl"
              :title="repoUrl ? `Open ${originLabel} on GitHub` : undefined"
              @click="repoUrl && space.openExternal(repoUrl)"
            >
              <img v-if="repoLogo" :src="repoLogo" alt="" class="gs__logo" />
              <span v-else class="gs__logo gs__logo--letter" aria-hidden="true">{{ repoName[0]?.toUpperCase() }}</span>
              <span class="gs__repo-text">{{ repoName }}</span>
            </button>
            <p class="gs__branch" :title="branchName || undefined">
              <HugeiconsIcon :icon="GitBranchIcon" :size="13" :stroke-width="1.8" aria-hidden="true" />
              <span class="gs__branch-text">{{ branchName || "detached HEAD" }}</span>
            </p>
            <p v-if="midOperation" class="gs__state gs__state--bad">
              {{ operationWord }}<template v-if="conflictCount"> · {{ conflictCount }} conflicted</template>
            </p>
            <p v-else-if="!origin" class="gs__state">Local only</p>
            <p v-else-if="note" class="gs__state">{{ note }}</p>
            <p v-else-if="ahead || behind" class="gs__state">
              <span v-if="ahead" class="gs__num--add">↑{{ ahead }} ahead</span>
              <span v-if="behind" class="gs__num--del">↓{{ behind }} behind</span>
            </p>
            <p v-else class="gs__state">In step with origin</p>
          </div>

          <!-- Sync. Exactly one action carries weight, and only when there is
               something to do. -->
          <div class="gs__actions">
            <template v-if="midOperation">
              <button type="button" class="gs__btn" :disabled="busy" @click="onAbort">Abort</button>
              <button type="button" class="gs__btn gs__btn--primary" :disabled="busy" @click="onContinue">
                Continue
              </button>
            </template>
            <template v-else-if="origin">
              <button type="button" class="gs__btn gs__btn--icon" :disabled="busy" title="Fetch" aria-label="Fetch" @click="onFetch">
                <HugeiconsIcon :icon="RefreshIcon" :size="14" :stroke-width="1.8" aria-hidden="true" />
              </button>
              <button
                v-if="upstream"
                type="button"
                class="gs__btn"
                :class="{ 'gs__btn--primary': primary === 'pull' }"
                :disabled="busy"
                @click="onPull"
              >
                <HugeiconsIcon :icon="ArrowDown01Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
                {{ pullLabel }}
              </button>
              <button
                type="button"
                class="gs__btn"
                :class="{ 'gs__btn--primary': primary === 'push' }"
                :disabled="busy"
                @click="onPush"
              >
                <HugeiconsIcon
                  :icon="upstream ? ArrowUp01Icon : CloudUploadIcon"
                  :size="13"
                  :stroke-width="1.8"
                  aria-hidden="true"
                />
                {{ pushLabel }}
              </button>
            </template>
            <!-- A running operation reads as a thread of light under the
                 buttons — the only moving thing on the page. -->
            <div class="gs__progress" :class="{ 'gs__progress--on': busy }" aria-hidden="true">
              <i class="gs__progress-run" />
            </div>
          </div>

          <div class="gs__navrows">
            <i class="gs__navmark" :style="{ '--at': activeIndex }" aria-hidden="true" />
            <button
              v-for="s in SECTIONS"
              :key="s.id"
              type="button"
              class="gs__navrow"
              :class="{ 'gs__navrow--on': section === s.id }"
              :aria-current="section === s.id ? 'page' : undefined"
              @click="go(s.id)"
            >
              <span class="gs__navicon" aria-hidden="true">
                <HugeiconsIcon :icon="s.icon" :size="16" :stroke-width="1.7" />
              </span>
              <span class="gs__navlabel">{{ s.label }}</span>
              <span v-if="countFor(s.id)" class="gs__navcount">{{ countFor(s.id) }}</span>
            </button>
          </div>

          <div v-if="whoName" class="gs__who">
            <span class="gs__whoface" aria-hidden="true">
              <img v-if="whoFace" :src="whoFace" alt="" />
              <span v-else>{{ whoInitial }}</span>
            </span>
            <span class="gs__whobody">
              <span class="gs__whoname">{{ whoName }}</span>
              <span v-if="whoEmail" class="gs__whomail" :title="whoEmail">{{ whoEmail }}</span>
            </span>
          </div>
        </nav>

        <div class="gs__main" :class="{ 'gs__main--wide': section === 'about' }">
          <p v-if="space.error.value" class="gs__error" role="alert">
            <HugeiconsIcon :icon="AlertCircleIcon" :size="13" :stroke-width="1.8" aria-hidden="true" />
            {{ space.error.value }}
          </p>

          <!-- ── the section ────────────────────────────────────────────────── -->
          <div ref="panelEl" class="gs__panel">
            <GitSpaceAbout
              v-if="visited.includes('about')"
              v-show="section === 'about'"
              :space="space"
              :dir="project.path"
              @go="go"
              @open-pr="openPr"
            />
            <GitSpaceChanges
              v-if="visited.includes('changes')"
              v-show="section === 'changes'"
              :space="space"
              :git="git"
              @open-file="(p, r) => emit('openFile', p, r)"
            />
            <GitSpaceHistory
              v-if="visited.includes('history')"
              v-show="section === 'history'"
              :space="space"
            />
            <GitSpaceBranches
              v-if="visited.includes('branches')"
              v-show="section === 'branches'"
              :space="space"
            />
            <GitSpacePullRequests
              v-if="visited.includes('prs')"
              v-show="section === 'prs'"
              :space="space"
              @open="openPr"
            />
            <GitSpaceStashes
              v-if="visited.includes('stashes')"
              v-show="section === 'stashes'"
              :space="space"
              :git="git"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- ── the open pull request ─────────────────────────────────────────── -->
    <GitSpacePullRequestView
      v-if="pr !== null"
      :space="space"
      :number="pr.number"
      :origin="pr.origin"
      @close="pr = null"
    />
  </div>
</template>

<style scoped>
/* One motion vocabulary for the whole space. Every GitSpace* child references
   these and invents no numbers of its own — custom properties inherit straight
   through scoped-style boundaries, which is why they can live here.

   Two easings, by purpose: things that arrive or open decelerate; things that
   move or resize in place ease at both ends. Four durations, by size of the
   thing that changed — plus the two indefinite tempos, which aren't sized by
   anything because nothing changed: they run until an answer arrives. */
.gs {
  --gs-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --gs-ease-move: cubic-bezier(0.65, 0, 0.35, 1);
  --gs-t-micro: 140ms; /* colour, opacity, hover reveals */
  --gs-t-small: 220ms; /* a row expanding, an inline swap */
  --gs-t-enter: 320ms; /* a list or block arriving */
  --gs-t-large: 420ms; /* the whole panel changing */
  --gs-stagger: 22ms; /* per-item entrance delay, capped at 7 by the caller */
  /* Waiting, not changing. Slower than anything above on purpose: a fast loop
     reads as urgency, and none of this is urgent. */
  --gs-t-sweep: 1100ms; /* the progress bar's travelling highlight */
  --gs-t-breathe: 1700ms; /* a skeleton at rest */
  /* How long a read may take before admitting it's slow. Under this, the answer
     lands and no placeholder should ever have been drawn. */
  --gs-hold: 140ms;
  /* The shell's own entrance: the left column, then the section. */
  --gs-enter-mast: 0ms;
  --gs-enter-nav: 80ms;
  --gs-enter-panel: 160ms;
  display: flex;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
/* The whole page scrolls as one; the left column sticks. Content fades out
   before it reaches the project's floating tabs instead of passing under them. */
.gs__scroll {
  container: gs / inline-size;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  -webkit-mask-image: linear-gradient(to bottom, transparent 56px, #000 96px);
  mask-image: linear-gradient(to bottom, transparent 56px, #000 96px);
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 14%, transparent) transparent;
}
.gs__col {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  align-items: start;
  gap: 56px;
  width: 100%;
  max-width: 1680px;
  margin-inline: auto;
  padding: 6rem 2.5rem 3rem;
}
/* Mid-width windows give the section a little more of the row. */
@container gs (max-width: 1100px) {
  .gs__col {
    grid-template-columns: 180px minmax(0, 1fr);
    gap: 36px;
  }
}

/* The one entrance shape in the space: fade plus a 6px rise. Nothing gets its
   own distance. */
@keyframes gs-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ── the left column ──────────────────────────────────────────────────────── */
/* Sticks clear of the project's floating tabs, and stays exactly as tall as
   the window allows so the identity at its foot is always on screen. */
.gs__side {
  position: sticky;
  top: 6rem;
  display: flex;
  flex-direction: column;
  gap: 22px;
  min-height: calc(100vh - 9rem);
  animation: gs-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: var(--gs-enter-nav);
}

.gs__repo {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  padding-inline: 10px;
}
.gs__repo-name {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  margin: 0 -6px;
  padding: 4px 6px;
  border-radius: 9px;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--gs-t-micro) ease;
}
.gs__repo-name:hover:not(:disabled) {
  background-color: var(--hover);
}
.gs__repo-name:disabled {
  cursor: default;
}
.gs__repo-text,
.gs__branch-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gs__logo {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  object-fit: cover;
}
.gs__logo--letter {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-color: var(--ink);
  color: var(--ground);
  font-size: 12px;
}
.gs__branch {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-soft);
}
.gs__branch :deep(svg) {
  flex-shrink: 0;
  color: var(--muted);
}
.gs__state {
  display: flex;
  gap: 8px;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
.gs__state--bad {
  color: var(--diff-del);
}
.gs__num--add {
  color: var(--diff-add);
}
.gs__num--del {
  color: var(--diff-del);
}

.gs__actions {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-inline: 4px;
}
/* The app's one button recipe: bare until hovered, then a soft pill; the
   primary one is the Overview's ink "Commit" pill. */
.gs__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding-inline: 10px;
  border-radius: 8px;
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-soft);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--gs-t-micro) ease,
    opacity var(--gs-t-micro) ease;
}
.gs__btn--icon {
  width: 28px;
  padding: 0;
  justify-content: center;
}
.gs__btn:hover:not(:disabled) {
  background-color: var(--hover);
}
.gs__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.gs__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.gs__btn--primary {
  background-color: var(--ink);
  color: var(--ground);
}
.gs__btn--primary:hover:not(:disabled) {
  background-color: var(--ink);
  opacity: 0.88;
}
.gs__btn--primary:focus-visible {
  box-shadow:
    0 0 0 2px var(--ground),
    0 0 0 4px color-mix(in srgb, var(--ink) 45%, transparent);
}

/* The sections: an icon, a label, a count, and one pill that slides. */
.gs__navrows {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gs__navmark {
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 34px;
  border-radius: 10px;
  background-color: color-mix(in srgb, var(--ink) 6.5%, transparent);
  transform: translateY(calc(var(--at, 0) * 36px));
  transition: transform var(--gs-t-small) var(--gs-ease-move);
  pointer-events: none;
}
.gs__navrow {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding-inline: 10px;
  border-radius: 10px;
  font-size: 13px;
  letter-spacing: -0.1px;
  color: var(--muted);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) ease,
    color var(--gs-t-micro) ease;
}
.gs__navrow:not(.gs__navrow--on):hover {
  background-color: var(--hover);
  color: var(--ink-soft);
}
.gs__navrow:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.gs__navrow--on {
  color: var(--ink);
  font-weight: 500;
}
.gs__navicon {
  display: inline-flex;
  flex-shrink: 0;
  transition: transform var(--gs-t-small) var(--gs-ease);
}
.gs__navrow:hover .gs__navicon {
  transform: scale(1.1);
}
.gs__navlabel {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gs__navcount {
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

/* ── who you are ──────────────────────────────────────────────────────────── */
/* The foot of the column. Two lines when your commit address isn't the
   account you're signed in as, one line when it is. */
.gs__who {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: auto;
  padding: 12px 10px 0;
  min-width: 0;
}
.gs__whoface {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--hover);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  color: var(--muted);
}
.gs__whoface img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gs__whobody {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.gs__whoname,
.gs__whomail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gs__whoname {
  font-size: 11.5px;
  line-height: 1.3;
  color: var(--ink-soft);
}
.gs__whomail {
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.3;
  color: var(--muted);
}

/* ── progress + error ─────────────────────────────────────────────────────── */
.gs__progress {
  position: absolute;
  inset-inline: 4px;
  bottom: -8px;
  height: 2px;
  overflow: hidden;
  opacity: 0;
  transition: opacity var(--gs-t-small) ease;
  pointer-events: none;
}
.gs__progress--on {
  opacity: 1;
}
.gs__progress-run {
  position: absolute;
  inset-block: 0;
  width: 38%;
  border-radius: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--accent) 70%, transparent),
    transparent
  );
  transform: translateX(-100%);
}
.gs__progress--on .gs__progress-run {
  animation: gs-sweep var(--gs-t-sweep) linear infinite;
}
@keyframes gs-sweep {
  to {
    transform: translateX(365%);
  }
}

.gs__error {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 18px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--diff-del);
  animation: gs-in var(--gs-t-small) var(--gs-ease) backwards;
}
.gs__error :deep(svg) {
  flex-shrink: 0;
}

/* ── the section ──────────────────────────────────────────────────────────── */
/* The shell is as wide as About wants; the list sections keep a reading width
   and sit against the column instead of stretching across the whole row. */
.gs__main {
  min-width: 0;
  max-width: 1040px;
}
.gs__main--wide {
  max-width: none;
}
.gs__panel {
  container-type: inline-size;
  min-width: 0;
  animation: gs-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: var(--gs-enter-panel);
}
/* Switching sections. Shorter than an arrival from nothing, because the frame
   around it never went away — and with no exit animation, so the new section
   doesn't make you wait for the old one to leave. */
.gs__panel--swap {
  animation: gs-in var(--gs-t-small) var(--gs-ease) backwards;
}

/* Narrow windows: no room for a column beside the section, so the left column
   becomes a header and its sections a strip that scrolls sideways. */
@container gs (max-width: 820px) {
  .gs__col {
    grid-template-columns: minmax(0, 1fr);
    gap: 32px;
    padding-inline: 1.25rem;
  }
  .gs__side {
    position: static;
    min-height: 0;
    gap: 16px;
  }
  .gs__navrows {
    flex-direction: row;
    margin-inline: -1.25rem;
    padding-inline: 1.25rem;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .gs__navmark {
    display: none;
  }
  .gs__navrow {
    flex-shrink: 0;
  }
  .gs__navrow--on {
    background-color: color-mix(in srgb, var(--ink) 6.5%, transparent);
  }
  .gs__who {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gs__side,
  .gs__panel,
  .gs__panel--swap,
  .gs__error {
    animation: none;
  }
  .gs__btn,
  .gs__navrow,
  .gs__navicon,
  .gs__navmark,
  .gs__progress {
    transition: none;
  }
  .gs__progress--on .gs__progress-run {
    animation: none;
    transform: none;
    width: 100%;
  }
}
</style>
