<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { onKeyStroke, useEventListener } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  CloudUploadIcon,
  GitBranchIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import type { Project } from "~/composables/useProject";
import type { useGitSpace } from "~/composables/useGitSpace";
import type { useProjectGit } from "~/composables/useProjectGit";

// The repository, as a place rather than a panel.
//
// This is the shell, built the way the Overview is: a sentence that says where
// you are and how you stand with origin, a little track drawing of the same
// thing, then a sticky row of sections with the remote actions at its end, and
// the section underneath. The whole page scrolls as one, so the headline leaves
// and the section row stays. Everything factual lives in `space` (the shared
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

const scrollEl = ref<HTMLElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const barEl = ref<HTMLElement | null>(null);
// One scroll container serves every section, so each section's offset is kept
// by hand. Without this, leaving a history you'd read halfway down strands you
// at the same pixel offset in Branches — and coming back starts you at the top
// of a list you'd already worked through.
const scrollTops = new Map<Section, number>();

/** Where the section row sticks: scrolled past this, the headline is gone. */
function barTop(): number {
  // Less the band the row sticks below, so it lands exactly where it sticks.
  return Math.max(0, (barEl.value?.offsetTop ?? 0) - 60);
}

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
    // A section you haven't read yet starts at its own top. If the headline had
    // already scrolled away, it stays away: the row you just clicked shouldn't
    // jump down the screen from under the pointer.
    s.scrollTop = scrollTops.get(next) ?? Math.min(s.scrollTop, barTop());
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
  cue("open");
  stack.value = [...stack.value, { kind: "commit", hash }];
}
function openPr(number: number) {
  cue("open");
  stack.value = [...stack.value, { kind: "pr", number }];
}
function back() {
  if (!stack.value.length) return;
  cue("leave");
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

// ── the sentence ──────────────────────────────────────────────────────────────
// "kone is on main, 2 commits ahead of origin." The repository and the branch
// are the nouns; the clause after them is the state, and its numbers carry the
// same green and red the Overview gives added and removed lines.
const repoName = computed(
  () => props.space.repoInfo.value?.nameWithOwner?.split("/").at(-1) ?? props.space.name.value,
);
const repoLogo = computed(() => props.space.logo.value?.dataUrl ?? null);
const repoUrl = computed(() => props.space.repoInfo.value?.url ?? null);
const operationWord = computed(() => {
  const op = props.space.state.value.operation;
  return op === "cherry-picking" ? "cherry-pick" : op.replace(/ing$/, "");
});

function plural(n: number, word: string): string {
  return `${word}${n === 1 ? "" : "s"}`;
}

// ── the track ─────────────────────────────────────────────────────────────────
// The sentence, drawn: origin's line along the bottom, yours peeling off it.
// Your unpushed commits sit on your line in green, the ones you haven't pulled
// sit on origin's in the muted ink, and each line ends in a tag saying whose it
// is. Capped at four dots a side; the number in the tag says the rest.
const TRACK = { base: 86, high: 38, step: 26, fork: 78 } as const;
const track = computed(() => {
  const hasOrigin = Boolean(origin.value);
  const published = Boolean(upstream.value);
  const a = Math.min(4, ahead.value);
  const b = Math.min(4, behind.value);
  const shared = [22, 50, TRACK.fork];
  const splits = hasOrigin && published && a > 0;
  const mine = Array.from({ length: a }, (_, i) => TRACK.fork + 40 + i * TRACK.step);
  const theirs = Array.from({ length: b }, (_, i) => TRACK.fork + TRACK.step + i * TRACK.step);
  const baseEnd = Math.max(TRACK.fork + TRACK.step, theirs.at(-1) ?? 0);
  const highEnd = mine.at(-1) ?? TRACK.fork + 40;
  return { hasOrigin, published, splits, mine, theirs, shared, baseEnd, highEnd };
});
const branchPath = computed(() => {
  const { fork, base, high } = TRACK;
  return `M${fork} ${base} C ${fork + 22} ${base}, ${fork + 14} ${high}, ${fork + 40} ${high} L ${track.value.highEnd} ${high}`;
});

// ── the section row ───────────────────────────────────────────────────────────
// The ink car that rides the line to the section you picked. Its place is
// measured rather than computed, so it can't drift from the stops on a resize.
const tabEls = ref<HTMLElement[]>([]);
const mark = ref({ x: 0, w: 0 });
function measureMark() {
  const i = SECTIONS.findIndex((s) => s.id === section.value);
  const el = tabEls.value[i];
  if (el) mark.value = { x: el.offsetLeft + el.offsetWidth / 2, w: el.offsetWidth };
}
watch([section, () => props.visible], () => void nextTick(measureMark));
// Counts arrive after the row is drawn and widen the tabs they land in.
watch(
  () => SECTIONS.map((s) => countFor(s.id)).join(","),
  () => void nextTick(measureMark),
);
onMounted(() => {
  measureMark();
  // Webfonts settle a beat after mount and change every label's width.
  void document.fonts?.ready.then(measureMark);
});
useEventListener("resize", measureMark);

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
    <div v-show="!detail" ref="scrollEl" class="gs__scroll">
      <div class="gs__col">
        <!-- ── headline ───────────────────────────────────────────────────── -->
        <header class="gs__head">
          <div class="gs__say">
            <p class="gs__hey">
              <span class="gs__soft">Hey,</span>
              <span class="gs__face" :title="whoEmail ?? undefined" aria-hidden="true">
                <img v-if="whoFace" :src="whoFace" alt="" />
                <template v-else>{{ whoInitial || "?" }}</template>
              </span>
              <span class="gs__ink">{{ whoName ?? "there" }}</span>
            </p>

            <p class="gs__line">
              <button
                type="button"
                class="gs__token"
                :disabled="!repoUrl"
                :title="repoUrl ? `Open ${originLabel} on GitHub` : undefined"
                @click="repoUrl && space.openExternal(repoUrl)"
              >
                <img v-if="repoLogo" :src="repoLogo" alt="" class="gs__logo" />
                {{ repoName }}
              </button>
              <span class="gs__soft">{{ " " }}is on{{ " " }}</span>
              <span class="gs__ink gs__branch">
                <HugeiconsIcon :icon="GitBranchIcon" :size="22" :stroke-width="2" class="gs__branch-icon" aria-hidden="true" />{{ branchName || "a detached HEAD" }}</span><template v-if="midOperation"><span class="gs__soft">, in the middle of a {{ operationWord }}</span><template v-if="conflictCount"><span class="gs__soft">{{ " " }}with{{ " " }}</span><span class="gs__num gs__num--del">{{ conflictCount }}</span><span class="gs__soft">{{ " " }}conflicted {{ plural(conflictCount, "file") }}</span></template><span class="gs__soft">.</span></template>
              <template v-else-if="!origin"><span class="gs__soft">. It only lives on this computer.</span></template>
              <template v-else-if="!upstream"><span class="gs__soft">, and it isn't published yet.</span></template>
              <template v-else-if="ahead && behind"><span class="gs__soft">,{{ " " }}</span><span class="gs__num gs__num--add">{{ ahead }}</span><span class="gs__soft">{{ " " }}ahead and{{ " " }}</span><span class="gs__num gs__num--del">{{ behind }}</span><span class="gs__soft">{{ " " }}behind origin.</span></template>
              <template v-else-if="ahead"><span class="gs__soft">,{{ " " }}</span><span class="gs__num gs__num--add">{{ ahead }}</span><span class="gs__soft">{{ " " }}{{ plural(ahead, "commit") }} ahead of origin.</span></template>
              <template v-else-if="behind"><span class="gs__soft">,{{ " " }}</span><span class="gs__num gs__num--del">{{ behind }}</span><span class="gs__soft">{{ " " }}{{ plural(behind, "commit") }} behind origin.</span></template>
              <template v-else><span class="gs__soft">, in step with origin.</span></template>
            </p>
            <p v-if="note && !midOperation && upstream" class="gs__note">{{ note }}</p>
          </div>

          <!-- The sentence, drawn. Decorative: everything in it is in the words. -->
          <div class="gs__track" aria-hidden="true">
            <svg viewBox="0 0 240 120" class="gs__track-svg">
              <template v-if="track.hasOrigin">
                <path
                  :d="`M8 ${TRACK.base} L ${track.baseEnd + 18} ${TRACK.base}`"
                  class="gs__rail"
                  :class="{ 'gs__rail--ghost': !track.published }"
                />
                <path v-if="track.splits || !track.published" :d="branchPath" class="gs__rail gs__rail--mine" />
              </template>
              <path v-else :d="`M8 ${TRACK.base} L 200 ${TRACK.base}`" class="gs__rail gs__rail--mine" />

              <circle
                v-for="(x, i) in track.shared"
                :key="`s${x}`"
                :cx="x"
                :cy="TRACK.base"
                r="5"
                class="gs__dot"
                :style="{ '--d': i }"
              />
              <circle
                v-for="(x, i) in track.theirs"
                :key="`t${x}`"
                :cx="x"
                :cy="TRACK.base"
                r="5"
                class="gs__dot gs__dot--theirs"
                :style="{ '--d': i + 3 }"
              />
              <circle
                v-for="(x, i) in track.mine"
                :key="`m${x}`"
                :cx="x"
                :cy="TRACK.high"
                r="5.5"
                class="gs__dot gs__dot--mine"
                :style="{ '--d': i + 3 }"
              />
            </svg>

            <span
              v-if="track.hasOrigin"
              class="gs__tag"
              :style="{ left: `${(track.baseEnd + 24) / 2.4}%`, top: `${TRACK.base / 1.2}%` }"
            >origin<template v-if="behind"> ↓{{ behind }}</template></span>
            <span
              class="gs__tag gs__tag--me"
              :style="
                track.splits || (track.hasOrigin && !track.published)
                  ? { left: `${(track.highEnd + 14) / 2.4}%`, top: `${TRACK.high / 1.2}%` }
                  : { left: `${track.hasOrigin ? (track.baseEnd + 24) / 2.4 : 86}%`, top: `${(TRACK.base - 30) / 1.2}%` }
              "
            >
              <span class="gs__tag-face">
                <img v-if="whoFace" :src="whoFace" alt="" />
                <template v-else>{{ whoInitial }}</template>
              </span>
              you<template v-if="ahead"> ↑{{ ahead }}</template>
            </span>
          </div>
        </header>

        <!-- ── the section row ────────────────────────────────────────────── -->
        <div ref="barEl" class="gs__bar">
          <!-- The sections as stops on a line — the same line the branch
               track above is drawn with. A small ink car rides it to the stop
               you pick, and each stop carries its count above it. -->
          <nav class="gs__metro" aria-label="Repository sections">
            <i class="gs__metro-rail" aria-hidden="true" />
            <i class="gs__metro-car" :style="{ transform: `translateX(${mark.x}px)` }" aria-hidden="true" />
            <button
              v-for="s in SECTIONS"
              :key="s.id"
              ref="tabEls"
              type="button"
              class="gs__stop"
              :class="{ 'gs__stop--on': section === s.id }"
              :aria-current="section === s.id ? 'page' : undefined"
              @click="go(s.id)"
            >
              <span class="gs__stop-count">{{ countFor(s.id) ?? "" }}</span>
              <span class="gs__stop-dot" aria-hidden="true" />
              <span class="gs__stop-label">{{ s.label }}</span>
            </button>
          </nav>

          <div class="gs__actions">
            <template v-if="midOperation">
              <button type="button" class="gs__btn" :disabled="busy" @click="onAbort">Abort</button>
              <button type="button" class="gs__btn gs__btn--primary" :disabled="busy" @click="onContinue">
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

          <!-- A running operation reads as a thread of light along the row's
               foot — the only moving thing on the page, and never a spinner. -->
          <div class="gs__progress" :class="{ 'gs__progress--on': busy }" aria-hidden="true">
            <i class="gs__progress-run" />
          </div>
        </div>

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
            @go="go"
            @open-commit="openCommit"
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
  /* The shell's own three-beat entrance: headline, then section row, then the
     section itself. */
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
/* The whole page scrolls as one: the headline leaves, the section row sticks. */
.gs__scroll {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 14%, transparent) transparent;
}
/* The Overview's measure, so switching between the two tabs moves nothing. */
.gs__col {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 940px;
  margin-inline: auto;
  padding: 5.5rem 2.5rem 3rem;
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

/* ── headline ─────────────────────────────────────────────────────────────── */
.gs__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 32px;
  animation: gs-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: var(--gs-enter-mast);
}
.gs__say {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  max-width: 600px;
}
.gs__hey,
.gs__line {
  margin: 0;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.gs__hey {
  display: flex;
  align-items: center;
  gap: 10px;
  line-height: 1.15;
}
.gs__line {
  line-height: 1.28;
  text-wrap: pretty;
}
.gs__soft {
  color: var(--ink-soft);
}
.gs__ink {
  color: var(--ink);
}
.gs__face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--ink);
  color: var(--ground);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0;
}
.gs__face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* The repository, as the Overview sets its project name: ink, inline, and a
   soft pill warms in under it on hover because it opens GitHub. */
.gs__token {
  display: inline-block;
  margin: 0 -5px;
  padding: 0 5px;
  border-radius: 9px;
  font: inherit;
  letter-spacing: inherit;
  color: var(--ink);
  white-space: nowrap;
  cursor: pointer;
  transition: background-color var(--gs-t-micro) ease;
}
.gs__token:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}
.gs__token:disabled {
  cursor: default;
}
.gs__token:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 26%, transparent);
  outline-offset: 1px;
}
.gs__logo {
  display: inline-block;
  width: 26px;
  height: 26px;
  margin-right: 6px;
  border-radius: 7px;
  vertical-align: -3px;
  object-fit: cover;
}
.gs__branch {
  overflow-wrap: anywhere;
}
.gs__branch-icon {
  display: inline-block;
  margin-right: 4px;
  vertical-align: -2px;
  color: var(--muted);
}
/* Numbers in the sentence: mono, like the Overview's +575 −203. */
.gs__num {
  font-family: var(--font-mono);
  font-weight: 600;
  letter-spacing: -0.04em;
}
.gs__num--add {
  color: var(--diff-add);
}
.gs__num--del {
  color: var(--diff-del);
}
.gs__note {
  margin: 6px 0 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
}

/* ── the track ────────────────────────────────────────────────────────────── */
.gs__track {
  position: relative;
  flex-shrink: 0;
  width: 240px;
  height: 120px;
  margin-top: 6px;
}
.gs__track-svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.gs__rail {
  fill: none;
  stroke: color-mix(in srgb, var(--ink) 16%, transparent);
  stroke-width: 3;
  stroke-linecap: round;
}
.gs__rail--ghost {
  stroke-dasharray: 2 7;
}
.gs__rail--mine {
  stroke: color-mix(in srgb, var(--diff-add) 55%, transparent);
  stroke-dasharray: 260;
  stroke-dashoffset: 260;
  animation: gs-draw 700ms var(--gs-ease) 220ms forwards;
}
@keyframes gs-draw {
  to {
    stroke-dashoffset: 0;
  }
}
.gs__dot {
  fill: var(--ground);
  stroke: color-mix(in srgb, var(--ink) 30%, transparent);
  stroke-width: 2.5;
  transform-box: fill-box;
  transform-origin: center;
  animation: gs-pop 420ms cubic-bezier(0.34, 1.56, 0.64, 1) backwards;
  animation-delay: calc(260ms + var(--d, 0) * 70ms);
}
.gs__dot--theirs {
  fill: color-mix(in srgb, var(--ink) 30%, transparent);
  stroke: none;
}
.gs__dot--mine {
  fill: var(--diff-add);
  stroke: var(--ground);
  stroke-width: 2.5;
}
@keyframes gs-pop {
  from {
    opacity: 0;
    transform: scale(0.3);
  }
}
.gs__tag {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  transform: translateY(-50%);
  background-color: var(--raised-high);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 7%, transparent),
    0 2px 6px color-mix(in srgb, var(--ink) 8%, transparent);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  color: var(--muted);
  animation: gs-in var(--gs-t-enter) var(--gs-ease) 560ms backwards;
}
.gs__tag--me {
  padding-left: 3px;
  color: var(--ink);
}
.gs__tag-face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--ink);
  color: var(--ground);
  font-size: 9px;
}
.gs__tag-face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* ── the section row ──────────────────────────────────────────────────────── */
/* Sticks under the project tabs once the headline has scrolled away, on the
   page's own ground so the section scrolls under it rather than through it.
   The band above it is ground too, or text would show between the two rows. */
.gs__bar {
  position: sticky;
  /* Clear of the project's own floating tabs, which sit over this page. */
  top: 60px;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 32px;
  margin-top: 48px;
  padding-top: 14px;
  background-color: var(--ground);
  animation: gs-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: var(--gs-enter-nav);
}
.gs__bar::before {
  content: "";
  position: absolute;
  inset-inline: -24px;
  bottom: 100%;
  height: 60px;
  background-color: var(--ground);
  pointer-events: none;
}
/* The line: equal-width stops, a rail from the first dot to the last, and the
   car parked over the current stop. */
.gs__metro {
  position: relative;
  display: flex;
  flex: 0 1 600px;
  min-width: 0;
  padding-bottom: 12px;
}
.gs__metro-rail {
  position: absolute;
  top: 27px;
  inset-inline: calc(100% / 12);
  height: 3px;
  margin-top: -1.5px;
  border-radius: 2px;
  background-color: color-mix(in srgb, var(--ink) 12%, transparent);
  pointer-events: none;
}
.gs__metro-car {
  position: absolute;
  top: 27px;
  left: 0;
  z-index: 1;
  width: 34px;
  height: 14px;
  margin: -7px 0 0 -17px;
  border-radius: 999px;
  background-color: var(--ink);
  box-shadow:
    0 0 0 4px var(--ground),
    0 4px 10px -2px color-mix(in srgb, var(--ink) 40%, transparent);
  transition: transform 520ms cubic-bezier(0.5, 0, 0.2, 1.25);
  pointer-events: none;
}
/* Headlights: a short bright stripe inside the car, so it reads as a thing
   that travels rather than a highlight. */
.gs__metro-car::after {
  content: "";
  position: absolute;
  inset: 5px 9px;
  border-radius: 2px;
  background-color: color-mix(in srgb, var(--ground) 55%, transparent);
}
.gs__stop {
  position: relative;
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0 2px;
  cursor: pointer;
}
.gs__stop:focus-visible {
  outline: none;
}
.gs__stop:focus-visible .gs__stop-label {
  border-radius: 6px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 26%, transparent);
}
.gs__stop-count {
  height: 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 14px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  transition: color var(--gs-t-micro) ease;
}
.gs__stop-dot {
  position: relative;
  z-index: 0;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background-color: var(--ground);
  box-shadow: inset 0 0 0 2.5px color-mix(in srgb, var(--ink) 28%, transparent);
  transition:
    transform var(--gs-t-small) var(--gs-ease),
    box-shadow var(--gs-t-micro) ease;
}
.gs__stop:hover .gs__stop-dot {
  transform: scale(1.3);
  box-shadow: inset 0 0 0 2.5px var(--ink);
}
.gs__stop-label {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.1px;
  color: var(--muted);
  transition: color var(--gs-t-micro) ease;
}
.gs__stop:hover .gs__stop-label,
.gs__stop--on .gs__stop-label,
.gs__stop--on .gs__stop-count {
  color: var(--ink);
}

.gs__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
/* The app's one button recipe: bare until hovered, then a soft pill; the
   primary one is the Overview's ink "Commit" pill. */
.gs__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding-inline: 11px;
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
  position: absolute;
  inset-inline: 0;
  bottom: -1px;
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
  margin: 14px 0 0;
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
.gs__panel {
  min-width: 0;
  padding-top: 36px;
  animation: gs-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: var(--gs-enter-panel);
}
/* Switching sections. Shorter than an arrival from nothing, because the frame
   around it never went away — and with no exit animation, so the new section
   doesn't make you wait for the old one to leave. */
.gs__panel--swap {
  animation: gs-in var(--gs-t-small) var(--gs-ease) backwards;
}

/* Narrow windows: the drawing gives its room to the sentence. */
@media (max-width: 860px) {
  .gs__track {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gs__head,
  .gs__bar,
  .gs__panel,
  .gs__panel--swap,
  .gs__error,
  .gs__dot,
  .gs__tag {
    animation: none;
  }
  .gs__rail--mine {
    animation: none;
    stroke-dashoffset: 0;
  }
  .gs__btn,
  .gs__metro-car,
  .gs__stop-dot,
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
