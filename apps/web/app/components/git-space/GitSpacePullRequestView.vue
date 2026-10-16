<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowTurnBackwardIcon, ArrowUpRight01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import MarkdownMessage from "~/components/markdown/MarkdownMessage.vue";
import ModalShell from "~/components/ui/ModalShell.vue";
import { useModalExit } from "~/composables/useModalExit";
import { changeBar, checkDuration, prDate } from "~/utils/prFormat";
import type {
  GitFileDiff,
  GitHubCheck,
  GitHubCheckCounts,
  GitHubMergeability,
  GitHubMergeMethod,
  GitHubPerson,
  GitHubPrAction,
  GitHubPrCommit,
  GitHubPrFile,
  GitHubPullRequestDetail,
  GitHubReview,
  GitHubReviewer,
} from "~/types/desktop";
import type { useGitSpace } from "~/composables/useGitSpace";

// One pull request, in full, in a card over the list that opened it. It grows
// out of the clicked row and shrinks back into it, as a commit and a changed
// file do, so the list keeps its scroll and filters under the scrim. It mounts
// itself on the body and owns its entrance, exit and Escape; the opener mounts
// it and unmounts it on `close`.
//
// Two columns. The main one is the pull request as a story: the description,
// then everything that happened to it on one rail — commits, reviews and
// comments in the order they happened, runs of commits folded together — and
// the files, commits and checks a tab away. The side column answers the one
// question you open a pull request to ask, "can this merge, and if not, what's
// in the way": a verdict, the checks as a ring with whatever isn't green
// listed under it, the reviewers as faces ringed in their verdict (faded when
// they judged an older commit), and the size of the change drawn file by file.
//
// The side column is its own component (GitSpacePullRequestSide); this owns
// the data and the tabs, and the side column asks for a tab or a file.
//
// Merging, marking ready, returning to draft, closing and reopening sit under
// the verdict (GitSpacePullRequestMerge), and a comment field closes the
// conversation (GitSpacePullRequestComment). Each re-reads the pull request
// when GitHub has taken it. Approving and requesting changes are still left to
// GitHub, behind the link at the top.

const props = defineProps<{
  space: ReturnType<typeof useGitSpace>;
  number: number;
  /** The clicked row's viewport rect — the grow's origin. */
  origin: DOMRect | null;
}>();

const emit = defineEmits<{
  /** Its exit has finished; unmount it now. */
  close: [];
}>();

const { cue } = useSound();

// One of its commits opens in a card over the pull request, grown from its row,
// so the tab and its scroll are still there when you close it.
const opened = ref<{ hash: string; origin: DOMRect | null } | null>(null);
function openCommit(e: MouseEvent, hash: string) {
  // SAFETY: bound on the commit's button, so currentTarget is that element.
  openCommitAt(hash, (e.currentTarget as HTMLElement).getBoundingClientRect());
}
function openCommitAt(hash: string, origin: DOMRect | null) {
  cue("open");
  opened.value = { hash, origin };
}

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
  cue("press");
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
  if (p.state === "merged") return { word: "Merged", tone: "merged" as const };
  if (p.state === "closed") return { word: "Closed", tone: "bad" as const };
  if (p.isDraft) return { word: "Draft", tone: "flat" as const };
  return { word: "Open", tone: "ok" as const };
});

// ── checks ───────────────────────────────────────────────────────────────────

const checkCounts = computed<GitHubCheckCounts>(() => {
  const counts = { passing: 0, failing: 0, pending: 0, skipped: 0 };
  for (const c of pr.value?.checkRuns ?? []) if (c.state !== "none") counts[c.state] += 1;
  return counts;
});
/** Checks grouped the way you'd deal with them: what broke, what's still
 *  going, then what's fine. */
const CHECK_GROUPS = [
  { id: "failing", label: "Needs attention" },
  { id: "pending", label: "Running" },
  { id: "passing", label: "Passed" },
  { id: "skipped", label: "Skipped" },
] as const;
const checkGroups = computed(() => {
  const runs = pr.value?.checkRuns ?? [];
  const out: { id: string; label: string; checks: GitHubCheck[] }[] = [];
  for (const g of CHECK_GROUPS) {
    const checks = runs.filter((c) => c.state === g.id || (g.id === "skipped" && c.state === "none"));
    if (checks.length) out.push({ id: g.id, label: g.label, checks });
  }
  return out;
});
// ── reviews ──────────────────────────────────────────────────────────────────

/** The commit the branch points at, as GitHub reports it: a review left on
 *  anything else judged code that has since moved. Commit dates can tie or run
 *  backwards, so they can't stand in for it. */
const headOid = computed(() => pr.value?.headOid ?? null);
function isStale(r: GitHubReview): boolean {
  return Boolean(r.commit && headOid.value && r.commit !== headOid.value && r.state !== "pending");
}

/** One face per person. An open request comes after that person's review in
 *  the list and replaces it: asked to look again, they're who this waits on. */
const reviewers = computed<(GitHubReviewer & { stale: boolean })[]>(() => {
  const byLogin = new Map<string, GitHubReviewer & { stale: boolean }>();
  for (const r of pr.value?.reviews ?? []) {
    if (r.author) byLogin.set(r.author.login, { person: r.author, state: r.state, stale: isStale(r) });
  }
  return [...byLogin.values()];
});
const pendingReviewers = computed(() => reviewers.value.filter((r) => r.state === "pending"));

/** Who said what, as one sentence: "Approved by kwesi on an earlier commit ·
 *  waiting on ama". */
const reviewSentence = computed(() => {
  const parts: string[] = [];
  const approved = reviewers.value.filter((r) => r.state === "approved");
  const changes = reviewers.value.filter((r) => r.state === "changes-requested");
  if (approved.length) {
    const stale = approved.every((r) => r.stale);
    parts.push(`Approved by ${names(approved)}${stale ? " on an earlier commit" : ""}`);
  }
  if (changes.length) parts.push(`${names(changes)} asked for changes`);
  if (pendingReviewers.value.length) parts.push(`waiting on ${names(pendingReviewers.value)}`);
  if (!parts.length) return "Nobody has been asked to review yet.";
  const s = parts.join(" · ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
});
function names(list: GitHubReviewer[]): string {
  return list.map((r) => r.person.login).join(", ");
}

// ── files ────────────────────────────────────────────────────────────────────
// Sorted the way they're worth reading: the code itself, then its tests, then
// what was generated or only configures the build.

type FileKind = "source" | "tests" | "generated";
const FILE_GROUPS: { id: FileKind; label: string }[] = [
  { id: "source", label: "Source" },
  { id: "tests", label: "Tests" },
  { id: "generated", label: "Lockfiles and generated" },
];
function fileKind(path: string): FileKind {
  const name = nameOf(path);
  if (/(^|\/)(dist|build|vendor|__snapshots__)\//.test(path) || /\.(lock|snap)$|lock\.(json|yaml)$|^bun\.lockb?$/.test(name)) {
    return "generated";
  }
  if (/(^|\/)(tests?|__tests__|e2e)\//.test(path) || /\.(test|spec)\.[a-z]+$/.test(name)) return "tests";
  return "source";
}
const fileGroups = computed(() => {
  const all = pr.value?.files ?? [];
  const out: { id: FileKind; label: string; files: GitHubPrFile[] }[] = [];
  for (const g of FILE_GROUPS) {
    const list = all.filter((f) => fileKind(f.path) === g.id);
    if (list.length) out.push({ ...g, files: list });
  }
  return out;
});
const filePeak = computed(() => Math.max(1, ...(pr.value?.files ?? []).map((f) => f.additions + f.deletions)));
function fileBar(f: GitHubPrFile, max: number) {
  return changeBar(f, filePeak.value, max);
}
const counts = computed(() => {
  const p = pr.value;
  return {
    conversation: (p?.comments.length ?? 0) + (p?.reviews.filter((r) => r.submittedAt).length ?? 0),
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
  cue("select");
  tab.value = next;
  openPath.value = null;
}
function showFile(path: string) {
  setTab("files");
  openPath.value = path;
}

function toggleFile(path: string) {
  if (openPath.value === path) {
    openPath.value = null;
    cue("collapse");
    return;
  }
  cue("expand");
  openPath.value = path;
}

const openDiff = computed(() => files.value?.find((f) => f.path === openPath.value) ?? null);

// ── words ────────────────────────────────────────────────────────────────────

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
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function checkout() {
  if (busy.value) return;
  cue("press");
  void props.space.checkoutPr(props.number);
}
// The action in flight from this card, and why the last one failed. The space
// keeps its own error line too, but that sits behind the card.
const pending = ref<GitHubPrAction | null>(null);
const actError = ref<string | null>(null);
const commentError = ref<string | null>(null);

async function act(action: GitHubPrAction, method?: GitHubMergeMethod) {
  if (busy.value) return;
  cue("press");
  pending.value = action;
  actError.value = null;
  const number = props.number;
  const ok = await props.space.prAction(number, action, method);
  pending.value = null;
  if (props.number !== number) return;
  if (!ok) {
    actError.value = props.space.error.value;
    return;
  }
  const d = await props.space.prDetail(number);
  if (d && props.number === number) pr.value = d;
}

async function sendComment(body: string): Promise<boolean> {
  commentError.value = null;
  const number = props.number;
  const ok = await props.space.commentOnPr(number, body);
  if (props.number !== number) return ok;
  if (!ok) {
    commentError.value = props.space.error.value;
    return false;
  }
  const d = await props.space.prDetail(number);
  if (d) pr.value = d;
  return true;
}

// Moving to another pull request clears what the last one said.
watch(
  () => props.number,
  () => {
    actError.value = null;
    commentError.value = null;
  },
);

function openOnGitHub() {
  if (pr.value) void props.space.openExternal(pr.value.url);
}

// ── the card ──────────────────────────────────────────────────────────────────
const INSET = 20;
const MAX_WIDTH = 1240;

// Grow from the clicked row's centre, in the card's own coordinates: it sits
// INSET down from the window's top, centred across it.
const originStyle = computed(() => {
  const vars: Record<string, string> = { "--prm-inset": `${INSET}px`, "--prm-max": `${MAX_WIDTH}px` };
  const r = props.origin;
  if (!r) return vars;
  const left = Math.max(INSET, (window.innerWidth - MAX_WIDTH) / 2);
  vars["--ox"] = `${r.left + r.width / 2 - left}px`;
  vars["--oy"] = `${r.top + r.height / 2 - INSET}px`;
  return vars;
});

const { shown, dismiss } = useModalExit();
function onClose(): void {
  dismiss(() => emit("close"));
}

// Taken in the capture phase and consumed, so one press closes this card and
// nothing behind it. While one of its commits is open on top, that card is the
// one Escape is for: it listens after this one, so this lets the key through.
function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape" || opened.value) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  onClose();
}

const backEl = ref<HTMLButtonElement | null>(null);
// The row that opened the card, so focus goes back to it on close.
let opener: HTMLElement | null = null;

// Tab stays inside the card: the app behind it goes inert while it's open, the
// way a native modal dialog would, and a commit card opened on top does the
// same to this one (the template's :inert). Whatever inert the root already had
// (a file detail open behind) is put back as it was.
let appRoot: HTMLElement | null = null;
let rootWasInert = false;

onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  appRoot = document.getElementById("__nuxt");
  rootWasInert = appRoot?.inert ?? false;
  if (appRoot) appRoot.inert = true;
  window.addEventListener("keydown", onEscape, { capture: true });
  requestAnimationFrame(() => (shown.value = true));
  backEl.value?.focus({ preventScroll: true });
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onEscape, { capture: true });
  if (appRoot) appRoot.inert = rootWasInert;
  opener?.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <ModalShell v-slot="{ card }" :shown="shown" class="z-50" @dismiss="onClose">
      <div
        v-bind="card"
        class="prm"
        :style="originStyle"
        role="dialog"
        aria-modal="true"
        :aria-label="pr?.title ?? `Pull request #${number}`"
        :inert="opened !== null"
      >
        <div class="prm__frame">
  <article class="prv">
    <!-- ── head ─────────────────────────────────────────────────────────────
         The shell's masthead shape, so stepping into a pull request lands on the
         same kind of page: identifier, title, then the facts underneath. -->
    <header class="prv__head">
      <button
        ref="backEl"
        type="button"
        class="prv__back"
        aria-label="Back to pull requests"
        title="Back to pull requests"
        @click="onClose"
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
        <p class="prv__eyebrow">
          <span v-if="status" class="prv__state" :class="`prv__state--${status.tone}`">{{ status.word }}</span>
          <span>#{{ number }}</span>
        </p>
        <h1 class="prv__title">{{ pr?.title ?? "Pull request" }}</h1>

        <p v-if="pr" class="prv__note">
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
          <span>opened {{ pr.relative }}</span>
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
          <HugeiconsIcon class="prv__refresh" :icon="RefreshIcon" :size="12" :stroke-width="2" aria-hidden="true" />
        </button>
        <button v-if="pr?.state === 'open'" type="button" class="prv__btn" :disabled="busy" @click="checkout">
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

      <div v-else class="prv__cols">
        <!-- ══ the main column ══════════════════════════════════════════════ -->
        <div class="prv__main">
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

          <!-- ── conversation ─────────────────────────────────────────────── -->
          <section v-if="tab === 'conversation'" :key="tab" class="prv__pane">
            <GitSpacePullRequestConversation
              :pr="pr"
              :head-oid="headOid"
              @open-commit="openCommitAt"
            />
            <GitSpacePullRequestComment
              :busy="busy"
              :send="sendComment"
              :error="commentError"
            />
          </section>

          <!-- ── files ────────────────────────────────────────────────────── -->
          <section v-else-if="tab === 'files'" :key="tab" class="prv__pane">
            <GitSpaceSkeleton v-if="filesLoading" :rows="6" />

            <template v-else>
              <div v-for="g in fileGroups" :key="g.id" class="prv__group">
                <p class="prv__glabel">
                  {{ g.label }} <span class="prv__count">{{ g.files.length }}</span>
                </p>
                <div v-for="(f, i) in g.files" :key="f.path" class="prv__file" :style="{ '--i': i }">
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
                    <span class="prv__bar">
                      <i class="prv__bar-add" :style="{ width: `${fileBar(f, 64).add}px` }" />
                      <i class="prv__bar-del" :style="{ width: `${fileBar(f, 64).del}px` }" />
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
            </template>
          </section>

          <!-- ── commits ──────────────────────────────────────────────────── -->
          <section v-else-if="tab === 'commits'" :key="tab" class="prv__pane">
            <ol class="prv__rail prv__rail--tight">
              <li v-for="(c, i) in pr.commits" :key="c.oid" class="prv__event" :style="{ '--i': i }">
                <i class="prv__node prv__node--commit" />
                <button
                  type="button"
                  class="prv__commit"
                  :title="c.headline"
                  aria-haspopup="dialog"
                  @click="openCommit($event, c.oid)"
                >
                  <span class="prv__headline">{{ c.headline }}</span>
                  <span class="prv__meta">
                    <span class="prv__hash">{{ c.short }}</span>
                    <span>{{ c.author }}</span>
                    <span>{{ c.relative }}</span>
                    <span v-if="c.oid === headOid" class="prv__headtag">head</span>
                  </span>
                </button>
              </li>
            </ol>
            <!-- Only true of a pull request whose branch was pushed from elsewhere;
                 said plainly rather than silently showing nothing. -->
            <p v-if="!pr.commits.length" class="prv__nodesc">GitHub didn't return any commits for this branch.</p>
          </section>

          <!-- ── checks ───────────────────────────────────────────────────── -->
          <section v-else :key="tab" class="prv__pane">
            <div v-for="g in checkGroups" :key="g.id" class="prv__group">
              <p class="prv__glabel">
                {{ g.label }} <span class="prv__count">{{ g.checks.length }}</span>
              </p>
              <div
                v-for="(c, i) in g.checks"
                :key="`${c.workflow}/${c.name}`"
                class="prv__check"
                :style="{ '--i': i }"
              >
                <i class="prv__checkdot" :class="`prv__checkdot--${c.state}`" />
                <span class="prv__checkname">
                  <span v-if="c.workflow" class="prv__dir">{{ c.workflow }} / </span>{{ c.name }}
                </span>
                <span class="prv__dim">{{ checkDuration(c) }}</span>
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
            <p v-if="!pr.checkRuns.length" class="prv__nodesc">No checks ran on this pull request.</p>
          </section>
        </div>

        <!-- ══ the side column: can it merge ════════════════════════════════ -->
        <GitSpacePullRequestSide
          :pr="pr"
          :check-counts="checkCounts"
          :reviewers="reviewers"
          :review-sentence="reviewSentence"
          @tab="setTab"
          @show-file="showFile"
          @open-url="(url) => space.openExternal(url)"
        >
          <template #act>
            <GitSpacePullRequestMerge :pr="pr" :busy="busy" :pending="pending" :error="actError" @act="act" />
          </template>
        </GitSpacePullRequestSide>
      </div>
    </div>

    <GitSpaceCommitCard
      v-if="opened"
      :space="space"
      :hash="opened.hash"
      :origin="opened.origin"
      @close="opened = null"
    />
  </article>
        </div>
      </div>
    </ModalShell>
  </Teleport>
</template>

<style scoped>
/* The card is teleported out of the space, so the space's motion vocabulary
   doesn't reach it by inheritance; it carries its own copy, as the commit
   card does. */
.prm {
  --gs-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --gs-ease-move: cubic-bezier(0.65, 0, 0.35, 1);
  --gs-t-micro: 140ms;
  --gs-t-small: 220ms;
  --gs-t-enter: 320ms;
  --gs-t-large: 420ms;
  --gs-stagger: 22ms;
  --gs-t-sweep: 1100ms;
  --gs-t-breathe: 1700ms;
  --gs-hold: 140ms;
  --gs-enter-panel: 160ms;
  position: absolute;
  inset: var(--prm-inset, 20px) 0;
  width: min(var(--prm-max, 1240px), calc(100% - 2 * var(--prm-inset, 20px)));
  margin-inline: auto;
  z-index: 1;
  display: flex;
  overflow: hidden;
  border-radius: 22px;
  background-color: var(--panel);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 24px 64px -24px color-mix(in srgb, var(--ink) 28%, transparent);
}

/* Grow out of the clicked row, and shrink back into it. */
.prm.is-in {
  animation: prm-grow 460ms cubic-bezier(0.34, 1.3, 0.64, 1) backwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
.prm.is-out {
  animation: prm-shrink var(--modal-exit) cubic-bezier(0.4, 0, 0.9, 1) forwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
@keyframes prm-grow {
  from { opacity: 0.35; transform: scale(0.16); }
  60% { opacity: 1; }
}
@keyframes prm-shrink {
  to { opacity: 0; transform: scale(0.16); }
}

/* The head stays put; the page under it scrolls on its own. */
.prm__frame {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.prv {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  padding: 34px 40px 0;
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
@keyframes prv-grow {
  from {
    transform: scaleX(0);
  }
}

/* ── head ─────────────────────────────────────────────────────────────────── */
.prv__head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex-shrink: 0;
  animation: prv-in var(--gs-t-enter) var(--gs-ease) backwards;
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
.prv__back:focus-visible {
  border-radius: 8px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.prv__back-glyph {
  transform: rotate(180deg) scaleX(-1);
}
.prv__identity {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  flex: 1 1 auto;
}
.prv__eyebrow {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
}
.prv__state {
  padding: 3px 7px;
  border-radius: 6px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  background-color: var(--hover);
  color: var(--ink-soft);
}
.prv__state--ok {
  color: var(--ok);
  background-color: color-mix(in srgb, var(--ok) 10%, transparent);
}
.prv__state--bad {
  color: var(--danger);
  background-color: color-mix(in srgb, var(--danger) 9%, transparent);
}
.prv__title {
  font-size: 26px;
  font-weight: 500;
  letter-spacing: -0.6px;
  line-height: 1.2;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.prv__note {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 12.5px;
  color: var(--muted);
}
.prv__author {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--ink-soft);
}
.prv__route {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.prv__ref {
  max-width: 34ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-soft);
}
.prv__arrow {
  color: var(--muted);
}
.prv__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.prv__btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding-inline: 10px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.prv__btn:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.prv__btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.prv__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.prv__btn--spin .prv__refresh {
  animation: prv-spin 900ms linear infinite;
}
@keyframes prv-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── page ─────────────────────────────────────────────────────────────────── */
.prv__scroll {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  margin-top: 34px;
  padding-left: 34px;
  /* Room for the side column's rows, which reach 6px past it, and their focus
     ring; the negative margin keeps the column's edge where it was. */
  padding-right: 8px;
  margin-right: -4px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  padding-bottom: 40px;
  scrollbar-color: color-mix(in srgb, var(--ink) 14%, transparent) transparent;
  animation: prv-in var(--gs-t-enter) var(--gs-ease) var(--gs-enter-panel) backwards;
}
.prv__cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 64px;
  align-items: start;
}
.prv__main {
  min-width: 0;
}
.prv__empty,
.prv__nodesc {
  font-size: 13px;
  color: var(--muted);
}
.prv__bar {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  width: 64px;
  height: 6px;
  flex-shrink: 0;
}
.prv__bar-add,
.prv__bar-del {
  height: 100%;
  border-radius: 3px;
  transform-origin: left center;
  animation: prv-grow 600ms var(--gs-ease) backwards;
  animation-delay: calc(240ms + min(var(--n, 0), 7) * 60ms);
}
.prv__bar-add {
  background-color: var(--diff-add);
}
.prv__bar-del {
  background-color: var(--diff-del);
}

/* ── tabs ─────────────────────────────────────────────────────────────────── */
.prv__tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 28px;
}
.prv__tab {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
  line-height: 28px;
}
.prv__tab:first-child {
  margin-left: -10px;
}
.prv__tab:hover {
  color: var(--ink-soft);
}
.prv__tab--on {
  color: var(--ink);
  background-color: var(--hover);
}
.prv__tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.prv__count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}
.prv__pane {
  animation: prv-in var(--gs-t-small) var(--gs-ease);
}

/* The rail: one hairline down the gutter, a node or a face at every event. */
.prv__rail {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 22px;
  margin-top: 44px;
  padding: 0;
  list-style: none;
}
.prv__rail::before {
  content: "";
  position: absolute;
  left: 13px;
  top: 8px;
  bottom: 8px;
  width: 1px;
  background-color: color-mix(in srgb, var(--ink) 11%, transparent);
}
.prv__rail--tight {
  gap: 4px;
  margin-top: 0;
}
.prv__event {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 14px;
  min-width: 0;
  animation: prv-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger));
}
.prv__node {
  position: relative;
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  margin: 4px 9.5px 0;
  border-radius: 50%;
  background-color: var(--muted);
  box-shadow: 0 0 0 4px var(--ground);
}
.prv__node--commit {
  background-color: var(--ground);
  box-shadow:
    inset 0 0 0 1.5px var(--muted),
    0 0 0 4px var(--ground);
}
.prv__rail--tight .prv__node {
  margin-top: 10px;
}
.prv__hash {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
.prv__headline {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.prv__face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--hover);
  font-size: 10px;
  color: var(--muted);
}
.prv__face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* ── lists (files, commits, checks) ───────────────────────────────────────── */
.prv__group + .prv__group {
  margin-top: 26px;
}
.prv__glabel {
  margin-bottom: 8px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink-soft);
}
.prv__file,
.prv__check {
  animation: prv-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger));
}
.prv__row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  margin-inline: -8px;
  border-radius: 8px;
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
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.prv__path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ink);
}
.prv__dir {
  color: var(--muted);
}
.prv__nums {
  display: inline-flex;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
}
.prv__add {
  color: var(--diff-add);
}
.prv__del {
  color: var(--diff-del);
}
.prv__dim {
  font-size: 12px;
  color: var(--muted);
}
.prv__nodiff {
  padding: 8px 0 12px 32px;
  font-size: 12px;
  color: var(--muted);
}
.prv__commit {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 7px 10px;
  margin-left: -10px;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
}
.prv__commit:hover {
  background-color: var(--hover);
}
.prv__commit .prv__headline {
  font-size: 13px;
  color: var(--ink);
}
.prv__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
  color: var(--muted);
}
.prv__headtag {
  padding: 1px 6px;
  border-radius: 5px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  background-color: var(--hover);
  color: var(--ink-soft);
}
.prv__check {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
}
.prv__checkdot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: color-mix(in srgb, var(--ink) 22%, transparent);
}
.prv__checkdot--passing {
  background-color: var(--ok);
}
.prv__checkdot--failing {
  background-color: var(--danger);
}
.prv__checkdot--pending {
  background-color: var(--warn);
  animation: prv-pulse 1.4s ease-in-out infinite;
}
@keyframes prv-pulse {
  50% {
    opacity: 0.35;
  }
}
.prv__checkname {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--ink);
}
.prv__go {
  padding: 3px 7px;
  border-radius: 7px;
  font-size: 11.5px;
  color: var(--muted);
  cursor: pointer;
}
.prv__go:hover {
  color: var(--ink);
  background-color: var(--hover);
}
@media (max-width: 1180px) {
  .prv__cols {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (prefers-reduced-motion: reduce) {
  .prm.is-in,
  .prm.is-out {
    animation-duration: 0.01s;
  }
  .prv__head,
  .prv__scroll,
  .prv__pane,
  .prv__event,
  .prv__file,
  .prv__check,
  .prv__bar-add,
  .prv__bar-del,
  .prv__checkdot--pending,
  .prv__btn--spin .prv__refresh {
    animation: none;
  }
}
</style>
