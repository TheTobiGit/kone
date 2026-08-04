<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowTurnBackwardIcon, ArrowUpRight01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import MarkdownMessage from "~/components/MarkdownMessage.vue";
import type { GitFileDiff, GitHubPerson, GitHubPullRequestDetail } from "~/types/desktop";
import type { useGitSpace } from "~/composables/useGitSpace";

// One pull request, in full.
//
// The list this opens from answers "how is my work doing" — green or not, looked
// at or not — and it stops there, because everything else used to mean a browser.
// This is the everything else: the description as its author wrote it, who said
// what, which checks ran, what changed, and the commits that got it there.
//
// What it deliberately doesn't have is buttons for merging, closing, approving or
// commenting. There is no backing call for any of them, and a button that opens
// GitHub in a new window while pretending to be a merge button is worse than the
// honest link at the top of the page. So this view reads, and reads completely.

const props = defineProps<{
  space: ReturnType<typeof useGitSpace>;
  number: number;
  /** Opened from something other than the list. Nothing here needs it yet — the
   *  back arrow says the same thing either way — but the stack knows, and the
   *  shell passes what it knows rather than making the view guess. */
  nested: boolean;
}>();

const emit = defineEmits<{
  back: [];
  openCommit: [hash: string];
}>();

const { cue } = useSound();

type Tab = "conversation" | "files" | "commits" | "checks";

const pr = ref<GitHubPullRequestDetail | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const tab = ref<Tab>("conversation");
const files = ref<GitFileDiff[] | null>(null);
const filesLoading = ref(false);
const openPath = ref<string | null>(null);

watch(
  () => props.number,
  async (number) => {
    loading.value = true;
    pr.value = null;
    files.value = null;
    openPath.value = null;
    tab.value = "conversation";
    const d = await props.space.prDetail(number);
    // A different pull request may have been opened while this was in flight.
    if (props.number !== number) return;
    pr.value = d;
    loading.value = false;
  },
  { immediate: true },
);

// The patch is one read for the whole pull request and it's cached, so it's
// fetched the first time the Files tab is asked for rather than up front — most
// visits here are to read the conversation.
watch([tab, pr], async () => {
  if (tab.value !== "files" || !pr.value || files.value || filesLoading.value) return;
  const number = props.number;
  filesLoading.value = true;
  const patch = await props.space.prDiff(number);
  if (props.number !== number) return;
  files.value = patch;
  filesLoading.value = false;
});

/** A pull request is the one thing in this space that genuinely moves while
 *  you're looking at it — someone reviews, a check goes green. So it's the one
 *  thing with a re-read. */
async function refresh() {
  if (refreshing.value) return;
  cue("toggle");
  refreshing.value = true;
  const number = props.number;
  const d = await props.space.prDetail(number, true);
  if (props.number !== number) return;
  if (d) pr.value = d;
  refreshing.value = false;
}

const busy = computed(() => props.space.op.value !== null);

/** The state as one word, and whether that word is good news. */
const status = computed(() => {
  const p = pr.value;
  if (!p) return null;
  if (p.state === "merged") return { word: "merged", tone: "merged" as const };
  if (p.state === "closed") return { word: "closed", tone: "bad" as const };
  if (p.isDraft) return { word: "draft", tone: "flat" as const };
  return { word: "open", tone: "ok" as const };
});

const REVIEW: Record<string, string> = {
  approved: "approved",
  "changes-requested": "changes requested",
  "review-required": "review needed",
};

/** Why it can't merge, in the words GitHub means rather than its enum. Only
 *  said for an open pull request: a merged one's mergeability is history. */
const MERGEABILITY: Record<string, string> = {
  conflicting: "conflicts with the base branch",
  blocked: "blocked — a required check or review is missing",
  behind: "behind the base branch",
  unstable: "merges, but a check is failing",
};
const obstacle = computed(() => {
  const p = pr.value;
  if (!p || p.state !== "open" || p.isDraft) return null;
  return MERGEABILITY[p.mergeability] ?? null;
});

const REVIEW_STATE: Record<string, string> = {
  approved: "approved",
  "changes-requested": "requested changes",
  commented: "commented",
  dismissed: "review dismissed",
  pending: "review pending",
};

/** Reviews and comments in one column, oldest first — because that's the
 *  conversation, and splitting it into two lists makes it unreadable. */
const conversation = computed(() => {
  const p = pr.value;
  if (!p) return [];
  const entries = [
    ...p.reviews.map((r) => ({
      kind: "review" as const,
      person: r.author,
      body: r.body,
      at: r.submittedAt,
      relative: r.relative,
      state: r.state,
      url: null as string | null,
    })),
    ...p.comments.map((c) => ({
      kind: "comment" as const,
      person: c.author,
      body: c.body,
      at: c.createdAt,
      relative: c.relative,
      state: null as string | null,
      url: c.url,
    })),
  ];
  // A pending review has no timestamp — it hasn't happened. It belongs at the
  // end, with the things still being waited on.
  return entries.sort((a, b) => {
    if (!a.at) return 1;
    if (!b.at) return -1;
    return a.at.localeCompare(b.at);
  });
});

const counts = computed(() => {
  const p = pr.value;
  return {
    conversation: conversation.value.length,
    files: p?.changedFiles ?? 0,
    commits: p?.commits.length ?? 0,
    checks: p?.checkRuns.length ?? 0,
  };
});

const TABS: { id: Tab; label: string }[] = [
  { id: "conversation", label: "Conversation" },
  { id: "files", label: "Files" },
  { id: "commits", label: "Commits" },
  { id: "checks", label: "Checks" },
];

function setTab(next: Tab) {
  if (tab.value === next) return;
  cue("toggle");
  tab.value = next;
  openPath.value = null;
}

function toggleFile(path: string) {
  if (openPath.value === path) {
    openPath.value = null;
    return;
  }
  cue("toggle");
  openPath.value = path;
}

const openDiff = computed(() => files.value?.find((f) => f.path === openPath.value) ?? null);

function initial(p: GitHubPerson | null, fallback = "") {
  return (p?.name || p?.login || fallback)[0]?.toUpperCase() ?? "";
}
function nameOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}
function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}

/** A label's own colour, used at the weight this space uses colour: a dot and a
 *  tinted word, never a filled chip. GitHub gives six hex digits, no '#'. */
function labelTint(hex: string) {
  return `#${hex}`;
}

function checkout() {
  if (busy.value) return;
  cue("press");
  void props.space.checkoutPr(props.number);
}
function openOnGitHub() {
  if (pr.value) void props.space.openExternal(pr.value.url);
}
function goBack() {
  emit("back");
}
</script>

<template>
  <article class="prv">
    <!-- ── head ─────────────────────────────────────────────────────────────
         The shell's masthead shape, so stepping into a pull request lands on the
         same kind of page: identifier, title, then the facts underneath. -->
    <header class="prv__head">
      <button
        type="button"
        class="prv__back"
        aria-label="Back to pull requests"
        title="Back to pull requests"
        @click="goBack"
      >
        <HugeiconsIcon
          class="prv__back-glyph"
          :icon="ArrowTurnBackwardIcon"
          :size="18"
          :stroke-width="2"
          aria-hidden="true"
        />
      </button>

      <div class="prv__identity">
        <p class="prv__eyebrow">#{{ number }}</p>
        <h1 class="prv__title">{{ pr?.title ?? "Pull request" }}</h1>

        <p v-if="pr" class="prv__note">
          <span v-if="status" class="prv__state" :class="`prv__state--${status.tone}`">
            {{ status.word }}
          </span>
          <span class="prv__author">
            <span class="prv__face" aria-hidden="true">
              <img v-if="pr.author?.avatarDataUrl" :src="pr.author.avatarDataUrl" alt="" />
              <span v-else>{{ initial(pr.author) }}</span>
            </span>
            {{ pr.author?.login ?? "someone" }}
          </span>
          <span class="prv__route">
            <!-- A fork's branch is only unambiguous with its owner in front. -->
            <span class="prv__ref">{{ pr.forkOwner ? `${pr.forkOwner}:${pr.branch}` : pr.branch }}</span>
            <span class="prv__arrow">→</span>
            <span class="prv__ref">{{ pr.base }}</span>
          </span>
          <span>{{ pr.relative }}</span>
        </p>
      </div>

      <div class="prv__actions">
        <button
          type="button"
          class="prv__btn"
          :class="{ 'prv__btn--spin': refreshing }"
          title="Re-read this pull request"
          aria-label="Re-read this pull request"
          @click="refresh"
        >
          <HugeiconsIcon
            class="prv__refresh"
            :icon="RefreshIcon"
            :size="12"
            :stroke-width="2"
            aria-hidden="true"
          />
        </button>
        <button
          v-if="pr?.state === 'open'"
          type="button"
          class="prv__btn"
          :disabled="busy"
          @click="checkout"
        >
          Check out
        </button>
        <button v-if="pr" type="button" class="prv__btn" @click="openOnGitHub">
          GitHub
          <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>
    </header>

    <!-- ── page ─────────────────────────────────────────────────────────────── -->
    <div class="prv__scroll">
      <GitSpaceSkeleton v-if="loading" variant="prose" />

      <p v-else-if="!pr" class="prv__empty">
        This pull request couldn't be read. The GitHub CLI may not be signed in.
      </p>

      <template v-else>
        <!-- The two things worth knowing before you read anything: what's in the
             way, and what it's tagged as. Both are one line or absent. -->
        <p v-if="obstacle" class="prv__obstacle">{{ obstacle }}</p>

        <p v-if="pr.labels.length || pr.milestone || pr.assignees.length" class="prv__tags">
          <span v-for="l in pr.labels" :key="l.name" class="prv__label" :title="l.description ?? l.name">
            <i class="prv__dot" :style="{ backgroundColor: labelTint(l.color) }" />
            {{ l.name }}
          </span>
          <span v-if="pr.milestone" class="prv__dim">{{ pr.milestone }}</span>
          <span v-if="pr.assignees.length" class="prv__dim">
            assigned to {{ pr.assignees.map((a) => a.login).join(", ") }}
          </span>
        </p>

        <nav class="prv__tabs" aria-label="Pull request sections">
          <button
            v-for="t in TABS"
            :key="t.id"
            type="button"
            class="prv__tab"
            :class="{ 'prv__tab--on': tab === t.id }"
            :aria-current="tab === t.id ? 'true' : undefined"
            @click="setTab(t.id)"
          >
            {{ t.label }}
            <span v-if="counts[t.id]" class="prv__count">{{ counts[t.id] }}</span>
          </button>
        </nav>

        <!-- ── conversation ───────────────────────────────────────────────── -->
        <section v-if="tab === 'conversation'" :key="tab" class="prv__pane">
          <div v-if="pr.body" class="prv__description selectable">
            <MarkdownMessage :source="pr.body" historical />
          </div>
          <p v-else class="prv__nodesc">No description.</p>

          <div v-if="conversation.length" class="prv__thread">
            <div
              v-for="(entry, i) in conversation"
              :key="`${entry.kind}:${i}`"
              class="prv__entry"
              :style="{ '--i': i }"
            >
              <span class="prv__face prv__face--lg" aria-hidden="true">
                <img v-if="entry.person?.avatarDataUrl" :src="entry.person.avatarDataUrl" alt="" />
                <span v-else>{{ initial(entry.person) }}</span>
              </span>
              <div class="prv__said">
                <p class="prv__saidhead">
                  <span class="prv__who">{{ entry.person?.login ?? "someone" }}</span>
                  <span
                    v-if="entry.state"
                    class="prv__verdict"
                    :class="{
                      'prv__verdict--ok': entry.state === 'approved',
                      'prv__verdict--bad': entry.state === 'changes-requested',
                    }"
                  >
                    {{ REVIEW_STATE[entry.state] }}
                  </span>
                  <span v-else class="prv__dim">commented</span>
                  <span class="prv__dim">{{ entry.relative }}</span>
                </p>
                <!-- An approval with nothing written is the normal case, and it
                     already said everything in the line above. -->
                <div v-if="entry.body" class="prv__saidbody selectable">
                  <MarkdownMessage :source="entry.body" historical />
                </div>
              </div>
            </div>
          </div>

          <p v-if="pr.mergedAt && pr.mergedBy" class="prv__merged">
            Merged by {{ pr.mergedBy.login }} · {{ new Date(pr.mergedAt).toLocaleDateString() }}
          </p>
        </section>

        <!-- ── files ──────────────────────────────────────────────────────── -->
        <section v-else-if="tab === 'files'" :key="tab" class="prv__pane">
          <p class="prv__stat">
            <span>{{ pr.changedFiles }} file{{ pr.changedFiles === 1 ? "" : "s" }}</span>
            <span v-if="pr.additions" class="prv__add">+{{ pr.additions }}</span>
            <span v-if="pr.deletions" class="prv__del">−{{ pr.deletions }}</span>
          </p>

          <GitSpaceSkeleton v-if="filesLoading" :rows="6" />

          <div v-else class="prv__list">
            <div v-for="(f, i) in pr.files" :key="f.path" class="prv__file" :style="{ '--i': i }">
              <button
                type="button"
                class="prv__row"
                :class="{ 'prv__row--on': openPath === f.path }"
                :title="f.path"
                @click="toggleFile(f.path)"
              >
                <FileIcon :path="f.path" :size="14" />
                <span class="prv__path">
                  <span class="prv__dir">{{ dirOf(f.path) }}</span>{{ nameOf(f.path) }}
                </span>
                <span v-if="f.change !== 'modified'" class="prv__dim">{{ f.change }}</span>
                <span class="prv__nums">
                  <span v-if="f.additions" class="prv__add">+{{ f.additions }}</span>
                  <span v-if="f.deletions" class="prv__del">−{{ f.deletions }}</span>
                </span>
              </button>

              <!-- The whole patch arrived in one read, so unfolding a file is a
                   lookup, not a fetch — there's nothing to wait for. -->
              <template v-if="openPath === f.path">
                <GitSpaceInlineDiff v-if="openDiff" :diff="openDiff" :loading="false" />
                <p v-else class="prv__nodiff">
                  This file isn't in the patch — it's probably binary, or too large for GitHub
                  to have sent.
                </p>
              </template>
            </div>
          </div>
        </section>

        <!-- ── commits ────────────────────────────────────────────────────── -->
        <section v-else-if="tab === 'commits'" :key="tab" class="prv__pane">
          <div class="prv__list">
            <button
              v-for="(c, i) in pr.commits"
              :key="c.oid"
              type="button"
              class="prv__commit"
              :style="{ '--i': i }"
              :title="c.headline"
              @click="emit('openCommit', c.oid)"
            >
              <span class="prv__body">
                <span class="prv__headline">{{ c.headline }}</span>
                <span class="prv__meta">
                  <span class="prv__hash">{{ c.short }}</span>
                  <span class="prv__dim">{{ c.author }}</span>
                  <span class="prv__dim">{{ c.relative }}</span>
                </span>
              </span>
            </button>
          </div>
          <!-- Only true of a pull request whose branch was pushed from elsewhere;
               said plainly rather than silently showing nothing. -->
          <p v-if="!pr.commits.length" class="prv__nodesc">
            GitHub didn't return any commits for this branch.
          </p>
        </section>

        <!-- ── checks ─────────────────────────────────────────────────────── -->
        <section v-else :key="tab" class="prv__pane">
          <div v-if="pr.checkRuns.length" class="prv__list">
            <div v-for="(c, i) in pr.checkRuns" :key="`${c.workflow}/${c.name}`" class="prv__check" :style="{ '--i': i }">
              <i class="prv__checkdot" :class="`prv__checkdot--${c.state}`" :title="c.state" />
              <span class="prv__checkname">
                <span v-if="c.workflow" class="prv__dir">{{ c.workflow }} / </span>{{ c.name }}
              </span>
              <span class="prv__dim">{{ c.state }}</span>
              <button
                v-if="c.url"
                type="button"
                class="prv__go"
                title="Open this check on GitHub"
                @click="space.openExternal(c.url!)"
              >
                Logs
              </button>
            </div>
          </div>
          <p v-else class="prv__nodesc">No checks ran on this pull request.</p>
        </section>
      </template>
    </div>
  </article>
</template>

<style scoped>
.prv {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1040px;
  min-height: 0;
  /* Clears the project's corner back arrow, as the shell's inner does. */
  padding: 5rem 2.5rem 2.5rem;
}

/* ── head ─────────────────────────────────────────────────────────────────── */
.prv__head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex-shrink: 0;
  animation: prv-in var(--gs-t-enter) var(--gs-ease) backwards;
}
@keyframes prv-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.prv__back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--muted);
  opacity: 0.7;
  cursor: pointer;
  transition:
    opacity var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.prv__back:hover,
.prv__back:focus-visible {
  outline: none;
  opacity: 1;
  color: var(--ink);
}
.prv__back-glyph {
  transform: rotate(180deg) scaleX(-1);
}

.prv__identity {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  flex: 1 1 auto;
}
.prv__eyebrow {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.2px;
  line-height: 1;
  color: var(--muted);
}
.prv__title {
  font-size: 22px;
  letter-spacing: -0.4px;
  line-height: 1.25;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.prv__note {
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
/* Four facts in a row need parsing marks, or they read as one long string. The
   route's own inner spans are left alone — that arrow is already the separator. */
.prv__note > span + span::before {
  content: "·";
  margin-right: 10px;
  opacity: 0.5;
}
/* The state is a category, so it takes the space's category treatment. */
.prv__state {
  text-transform: uppercase;
  letter-spacing: 1.5px;
  font-size: 10.5px;
}
.prv__state--ok {
  color: var(--diff-add);
}
.prv__state--bad {
  color: var(--diff-del);
}
.prv__state--merged {
  color: var(--ink-soft);
}
.prv__state--flat {
  color: var(--muted);
}
.prv__author {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.prv__route {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.prv__ref {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 22ch;
}
.prv__arrow {
  opacity: 0.55;
}

/* The circle the rail's face draws, one size down. */
.prv__face {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--hover);
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 1;
  color: var(--muted);
}
.prv__face--lg {
  width: 22px;
  height: 22px;
  font-size: 10px;
}
.prv__face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.prv__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding-top: 4px;
}
.prv__btn {
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
  transition: background-color var(--gs-t-micro) ease;
}
.prv__btn:hover {
  background-color: var(--hover);
}
.prv__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.prv__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
/* One turn of the glyph per re-read: the whole point is that something might
   have changed, so the confirmation is that it moved at all. */
.prv__btn--spin .prv__refresh {
  animation: prv-turn var(--gs-t-large) var(--gs-ease-move);
}
@keyframes prv-turn {
  to {
    transform: rotate(360deg);
  }
}

/* ── page ─────────────────────────────────────────────────────────────────── */
.prv__scroll {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  margin-top: 30px;
  padding-left: 34px;
  padding-right: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 14%, transparent) transparent;
  animation: prv-in var(--gs-t-enter) var(--gs-ease) var(--gs-enter-panel) backwards;
}

.prv__empty,
.prv__nodesc,
.prv__nodiff {
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
}
.prv__nodiff {
  max-width: 66ch;
  padding: 8px 0 12px;
  font-size: 12px;
}

/* Whatever stands between this and being merged, said once, in the one colour
   this space uses for a thing that needs attention. */
.prv__obstacle {
  margin-bottom: 16px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--diff-del);
}

.prv__tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-bottom: 26px;
  font-size: 11.5px;
  line-height: 1;
  color: var(--ink-soft);
}
/* A label's colour as a dot beside its name — the tint is the identity, and a
   filled chip would be the loudest thing on the page. */
.prv__label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.prv__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.prv__dim {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  color: var(--muted);
}

/* ── tabs ─────────────────────────────────────────────────────────────────── */
/* The same idiom as the section list's filters: the current one is simply the
   one in full ink. No underline, no pill, nothing boxed. */
.prv__tabs {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 22px;
  flex-wrap: wrap;
}
.prv__tab {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  transition: color var(--gs-t-micro) var(--gs-ease);
}
.prv__tab:hover {
  color: var(--ink-soft);
}
.prv__tab--on {
  color: var(--ink);
}
.prv__tab:focus-visible {
  outline: none;
  border-radius: 5px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.prv__count {
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

/* Keyed on the tab, so switching is a fresh arrival rather than a swap of
   contents inside a frame that stays put. */
.prv__pane {
  display: flex;
  flex-direction: column;
  padding-bottom: 20px;
  animation: prv-in var(--gs-t-small) var(--gs-ease);
}

/* ── conversation ─────────────────────────────────────────────────────────── */
.prv__description {
  max-width: 74ch;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-soft);
}
/* Further from the description than the entries are from each other: the
   description is the pull request, and everything below it is the response to it.
   There's no rule to draw between them, so the gap has to carry it. */
.prv__thread {
  display: flex;
  flex-direction: column;
  gap: 24px;
  margin-top: 48px;
}
.prv__entry {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  animation: prv-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger));
}
.prv__said {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}
.prv__saidhead {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  line-height: 1;
}
.prv__who {
  font-size: 12px;
  color: var(--ink);
}
.prv__verdict {
  font-family: var(--font-mono);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--muted);
}
.prv__verdict--ok {
  color: var(--diff-add);
}
.prv__verdict--bad {
  color: var(--diff-del);
}
.prv__saidbody {
  max-width: 70ch;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--ink-soft);
}
.prv__merged {
  margin-top: 26px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
}

/* ── lists ────────────────────────────────────────────────────────────────── */
.prv__stat {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.prv__add {
  color: var(--diff-add);
}
.prv__del {
  color: var(--diff-del);
}

.prv__list {
  display: flex;
  flex-direction: column;
}
.prv__file,
.prv__check,
.prv__commit {
  animation: prv-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger));
}

.prv__row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 30px;
  padding-inline: 8px;
  margin-inline: -8px;
  border-radius: 7px;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.prv__row:hover,
.prv__row--on {
  background-color: var(--hover);
}
.prv__row:focus-visible,
.prv__commit:focus-visible,
.prv__go:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.prv__path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  color: var(--ink);
}
.prv__dir {
  color: var(--muted);
}
.prv__nums {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

/* A commit row is taller than a file row: it carries a sentence and a line of
   facts, the same two-line shape the history uses. */
.prv__commit {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 9px 8px;
  margin-inline: -8px;
  border-radius: 7px;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.prv__commit:hover {
  background-color: var(--hover);
}
.prv__body {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  flex: 1 1 auto;
}
.prv__headline {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  line-height: 1.2;
  color: var(--ink);
}
.prv__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  line-height: 1;
}
.prv__hash {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
  color: var(--muted);
}

.prv__check {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 30px;
}
/* Checks are a dot everywhere in this space: colour is the whole message. */
.prv__checkdot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background-color: var(--muted);
}
.prv__checkdot--passing {
  background-color: var(--diff-add);
}
.prv__checkdot--failing {
  background-color: var(--diff-del);
}
.prv__checkdot--pending {
  background-color: color-mix(in srgb, var(--ink) 34%, transparent);
}
.prv__checkdot--skipped,
.prv__checkdot--none {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
}
.prv__checkname {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1;
  color: var(--ink);
}
.prv__go {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  border-radius: 5px;
  transition:
    opacity var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.prv__check:hover .prv__go,
.prv__check:focus-within .prv__go {
  opacity: 1;
}
.prv__go:hover {
  color: var(--ink);
}

@media (prefers-reduced-motion: reduce) {
  .prv__head,
  .prv__scroll,
  .prv__pane,
  .prv__entry,
  .prv__file,
  .prv__check,
  .prv__commit {
    animation: none;
  }
  .prv__back,
  .prv__btn,
  .prv__btn--spin .prv__refresh,
  .prv__tab,
  .prv__row,
  .prv__commit,
  .prv__go {
    animation: none;
    transition: none;
  }
}
</style>
