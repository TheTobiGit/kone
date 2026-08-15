<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { onKeyStroke } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  CloudUploadIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import type { Project } from "~/composables/useProject";
import type { useGitSpace } from "~/composables/useGitSpace";
import type { useProjectGit } from "~/composables/useProjectGit";

// The repository, as a place rather than a panel.
//
// This is the shell: a masthead that says where you are and what the repository
// wants from you, a quiet rail of sections, and one scrolling panel. Everything
// factual lives in `space` (the shared funnel) — this component decides what is
// worth showing and, more importantly, what isn't. The masthead promotes exactly
// one action at a time, because a row of equal-weight buttons makes the user do
// the reading that the page should have done for them.

const props = defineProps<{
  project: Project;
  space: ReturnType<typeof useGitSpace>;
  git: ReturnType<typeof useProjectGit>;
  /** The layer is on screen. Sections load on first reveal, not on mount. */
  visible: boolean;
}>();

const emit = defineEmits<{
  openFile: [path: string, rect: DOMRect | null];
  /** How many commits/pull requests deep the space is — 0 on the sections. */
  detailDepth: [depth: number];
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

const SECTIONS: { id: Section; label: string }[] = [
  { id: "about", label: "About" },
  { id: "changes", label: "Changes" },
  { id: "history", label: "History" },
  { id: "branches", label: "Branches" },
  { id: "prs", label: "Pull requests" },
  { id: "stashes", label: "Stashes" },
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

const panelEl = ref<HTMLElement | null>(null);
// One scroll container serves every section, so each section's offset is kept
// by hand. Without this, leaving a history you'd read halfway down strands you
// at the same pixel offset in Branches — and coming back starts you at the top
// of a list you'd already worked through.
const scrollTops = new Map<Section, number>();

function go(next: Section) {
  if (section.value === next) return;
  cue("toggle");
  const el = panelEl.value;
  if (el) scrollTops.set(section.value, el.scrollTop);
  section.value = next;
  if (!visited.value.includes(next)) visited.value.push(next);
  // A failure from the last section isn't news in this one.
  props.space.error.value = null;
  load(next);
  void nextTick(() => {
    const p = panelEl.value;
    if (!p) return;
    p.scrollTop = scrollTops.get(next) ?? 0;
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

// ── the detail stack ──────────────────────────────────────────────────────────
// A commit and a pull request each get a whole view rather than a drawer inside
// a list: they carry a body, a diff, a conversation and a person, and none of
// that fits in a row that has to stay a row. It's a stack because a pull request
// lists its own commits, and opening one from there should come back to the pull
// request rather than to wherever you started.
//
// The shell isn't unmounted underneath it, only hidden — every section keeps its
// scroll offset and its loaded pages, so stepping back is genuinely a step back.
type Detail = { kind: "commit"; hash: string } | { kind: "pr"; number: number };
const stack = ref<Detail[]>([]);
const detail = computed<Detail | null>(() => stack.value.at(-1) ?? null);

function openCommit(hash: string) {
  cue("press");
  stack.value = [...stack.value, { kind: "commit", hash }];
}
function openPr(number: number) {
  cue("press");
  stack.value = [...stack.value, { kind: "pr", number }];
}
function back() {
  if (!stack.value.length) return;
  cue("toggle");
  stack.value = stack.value.slice(0, -1);
}

// Escape pops one level. The project's own Escape handler only closes the file
// detail and the switcher, neither of which can be open from in here, so there's
// nothing to fight over.
onKeyStroke("Escape", (e) => {
  if (!props.visible || !stack.value.length) return;
  e.preventDefault();
  back();
});

// A detail view draws its own return glyph beside its own title, which is what
// the file detail does too — and the project's corner arrow steps aside for that
// one. So the depth goes up: the corner arrow can't be a second, identical arrow
// 300px away from the first, and it can't be the thing that leaves for the
// working tree while there's still a layer of this to step out of.
watch(
  () => stack.value.length,
  (depth) => emit("detailDepth", depth),
);

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
const operationLabel = computed(() => {
  const op = props.space.state.value.operation;
  return op === "cherry-picking" ? "CHERRY-PICKING" : op.replace("ing", "ing").toUpperCase();
});
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

// ── who you are, at the foot of the rail ──────────────────────────────────────
// This used to be a block inside About, which put it on a page about the
// repository and repeated it for every project as though it were a fact about
// this one. It's chrome: it belongs where it's always true and never in the way.
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

const activeIndex = computed(() => SECTIONS.findIndex((s) => s.id === section.value));

function onFetch() {
  cue("toggle");
  void props.space.fetch();
}
function onPull() {
  cue("press");
  void props.space.pull();
}
function onPush() {
  cue("press");
  void props.space.push(upstream.value ? undefined : { setUpstream: true });
}
function onContinue() {
  cue("press");
  void props.space.continueOperation();
}
function onAbort() {
  cue("press");
  void props.space.abortOperation();
}
</script>

<template>
  <div class="gs">
    <div v-show="!detail" class="gs__inner">
      <!-- ── masthead ───────────────────────────────────────────────────── -->
      <header class="gs__masthead app-drag">
        <div class="gs__identity app-no-drag">
          <p class="gs__eyebrow">
            <template v-if="originLabel">{{ originLabel }}</template>
            <template v-else>Local only</template>
          </p>
          <h1 class="gs__branch">{{ branchName || "detached HEAD" }}</h1>

          <!-- Mid-operation replaces the note entirely: nothing else matters
               until the merge or rebase is resolved. -->
          <p v-if="midOperation" class="gs__state">
            {{ operationLabel }}
            <template v-if="conflictCount">
              · {{ conflictCount }} conflicted file{{ conflictCount === 1 ? "" : "s" }}
            </template>
          </p>
          <p v-else-if="note" class="gs__note">{{ note }}</p>
        </div>

        <div class="gs__actions app-no-drag">
          <template v-if="midOperation">
            <button type="button" class="gs__btn" :disabled="busy" @click="onAbort">
              Abort
            </button>
            <button
              type="button"
              class="gs__btn gs__btn--primary"
              :disabled="busy"
              @click="onContinue"
            >
              Continue
            </button>
          </template>
          <template v-else-if="origin">
            <button type="button" class="gs__btn" :disabled="busy" @click="onFetch">
              <HugeiconsIcon :icon="RefreshIcon" :size="13" :stroke-width="1.8" aria-hidden="true" />
              Fetch
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
        </div>
      </header>

      <!-- A running operation reads as a thread of light under the masthead —
           the only moving thing on the page, and never a spinner. -->
      <div class="gs__progress" :class="{ 'gs__progress--on': busy }" aria-hidden="true">
        <i class="gs__progress-run" />
      </div>

      <p v-if="space.error.value" class="gs__error" role="alert">
        <HugeiconsIcon :icon="AlertCircleIcon" :size="13" :stroke-width="1.8" aria-hidden="true" />
        {{ space.error.value }}
      </p>

      <!-- ── body ───────────────────────────────────────────────────────── -->
      <div class="gs__body">
        <nav class="gs__nav" aria-label="Repository sections">
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

        <div ref="panelEl" class="gs__panel">
          <GitSpaceAbout
            v-if="visited.includes('about')"
            v-show="section === 'about'"
            :space="space"
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
            @open="openCommit"
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

    <!-- ── the open thing ─────────────────────────────────────────────────── -->
    <!-- The whole stack is rendered and all but the top of it hidden, for the
         same reason the sections above are: stepping into a commit from a pull
         request's Commits tab and stepping back should return you to that tab,
         with its patch still read and its conversation still scrolled. A `v-if`
         here would rebuild the pull request from its first beat every time, and
         "back" would quietly mean "start again".

         Keyed by depth as well as identity, so stepping from one pull request to
         another remounts rather than swapping payloads under a view that already
         finished loading. -->
    <template v-for="(d, i) in stack" :key="d.kind === 'commit' ? `${i}:c:${d.hash}` : `${i}:p:${d.number}`">
      <GitSpaceCommitView
        v-if="d.kind === 'commit'"
        v-show="i === stack.length - 1"
        :space="space"
        :hash="d.hash"
        :nested="i > 0"
        @back="back"
        @open-file="(p, r) => emit('openFile', p, r)"
      />
      <GitSpacePullRequestView
        v-else
        v-show="i === stack.length - 1"
        :space="space"
        :number="d.number"
        :nested="i > 0"
        @back="back"
        @open-commit="openCommit"
      />
    </template>
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
  /* The shell's own three-beat entrance: masthead, then rail, then panel. */
  --gs-enter-mast: 0ms;
  --gs-enter-nav: 60ms;
  --gs-enter-panel: 120ms;
  display: flex;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.gs__inner {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1040px;
  min-height: 0;
  padding: 5rem 2.5rem 2.5rem;
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

/* ── masthead ─────────────────────────────────────────────────────────────── */
.gs__masthead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  flex-shrink: 0;
  animation: gs-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: var(--gs-enter-mast);
}
.gs__identity {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
/* An identifier, not a category label. STAGED and REMOTE are labels and keep
   the uppercase micro-label treatment; a repo slug is a proper noun that GitHub
   renders in its own case, and every other identifier in this space — branch
   refs, upstreams, paths, hashes — is set mono in natural case. The wide
   tracking goes with it: it exists to open up small caps, and lowercase mono
   already has the sidebearings it needs. */
.gs__eyebrow {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.2px;
  line-height: 1;
  color: var(--muted);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gs__branch {
  font-size: 28px;
  letter-spacing: -0.5px;
  line-height: 1.1;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gs__note,
.gs__state {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.gs__state {
  letter-spacing: 1.5px;
  text-transform: uppercase;
  font-size: 11px;
  color: var(--diff-del);
}

.gs__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding-top: 4px;
}
/* The app's one button recipe: bare until hovered, then a soft pill. */
.gs__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding-inline: 11px;
  border-radius: 8px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-soft);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--gs-t-micro) ease,
    opacity var(--gs-t-micro) ease;
}
.gs__btn:hover:not(:disabled) {
  background-color: var(--hover);
}
.gs__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
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

/* ── progress + error ─────────────────────────────────────────────────────── */
.gs__progress {
  position: relative;
  height: 2px;
  margin-top: 18px;
  overflow: hidden;
  border-radius: 1px;
  opacity: 0;
  transition: opacity var(--gs-t-small) ease;
  flex-shrink: 0;
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
  margin-top: 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--diff-del);
  flex-shrink: 0;
  animation: gs-in var(--gs-t-small) var(--gs-ease) backwards;
}
.gs__error :deep(svg) {
  flex-shrink: 0;
}

/* ── body ─────────────────────────────────────────────────────────────────── */
.gs__body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 34px;
}
.gs__nav {
  display: flex;
  flex-direction: column;
  width: 150px;
  flex-shrink: 0;
  animation: gs-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: var(--gs-enter-nav);
}
.gs__navrows {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* One pill that slides, rather than a background that appears on the row you
   picked and disappears from the one you left. The rail is a fixed ladder — 30px
   rows on a 2px gap — so where the pill goes is arithmetic, not measurement, and
   it can't fall out of step with the layout on a resize.

   It replaced an accent dot. Nothing else in this app marks a selection with a
   coloured bullet, and the one thing on a calm page that carries the brand
   colour reads as an alert. */
.gs__navmark {
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 30px;
  border-radius: 8px;
  background-color: color-mix(in srgb, var(--ink) 6.5%, transparent);
  transform: translateY(calc(var(--at, 0) * 32px));
  transition: transform var(--gs-t-small) var(--gs-ease-move);
  pointer-events: none;
}
/* Positioned so the rows paint over the pill: an absolutely-placed sibling
   otherwise sits above every static one, whatever the source order says. */
.gs__navrow {
  position: relative;
  display: flex;
  align-items: center;
  height: 30px;
  padding-inline: 10px;
  border-radius: 8px;
  font-size: 12.5px;
  letter-spacing: -0.1px;
  color: var(--muted);
  cursor: pointer;
  text-align: left;
  transition:
    background-color var(--gs-t-micro) ease,
    color var(--gs-t-micro) ease;
}
.gs__navrow:not(.gs__navrow--on):hover {
  background-color: var(--hover);
}
.gs__navrow:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.gs__navrow--on {
  color: var(--ink);
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
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  opacity: 0.75;
}

/* ── who you are ──────────────────────────────────────────────────────────── */
/* The foot of the rail, on every section. Two lines when your commit address
   isn't the account you're signed in as, one line when it is — the disagreement
   is the whole message, so it doesn't need a sentence explaining itself. */
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
  letter-spacing: -0.1px;
  line-height: 1.3;
  color: var(--ink-soft);
}
.gs__whomail {
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.3;
  color: var(--muted);
}

.gs__panel {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding-left: 40px;
  padding-right: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 14%, transparent) transparent;
  animation: gs-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: var(--gs-enter-panel);
}
/* Switching sections. Shorter than an arrival from nothing, because the frame
   around it never went away — and with no exit animation, so the new section
   doesn't make you wait for the old one to leave. */
.gs__panel--swap {
  animation: gs-in var(--gs-t-small) var(--gs-ease) backwards;
}

@media (prefers-reduced-motion: reduce) {
  .gs__masthead,
  .gs__nav,
  .gs__panel,
  .gs__panel--swap,
  .gs__error {
    animation: none;
  }
  .gs__btn,
  .gs__navrow,
  .gs__progress {
    transition: none;
  }
  .gs__progress--on .gs__progress-run {
    animation: none;
    transform: none;
    width: 100%;
  }
  .gs__navmark {
    transition: none;
  }
}
</style>
