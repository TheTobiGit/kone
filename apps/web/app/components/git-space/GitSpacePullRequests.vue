<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Add01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { GitHubPullRequest } from "~/types/desktop";
import { PR_STAND, PR_STAND_RANK, prStandOf, type PrStand } from "~/utils/prStand";
import type { useGitSpace } from "~/composables/useGitSpace";

// Pull requests, without the round trip to a browser.
//
// Two columns, like the rest of the space. The main one is the list, sorted by
// what each pull request needs from you: yours first, then the ones waiting on
// your review, then everyone else's. Every row leads with its checks as a ring,
// so a red sliver shows before you read a word, and ends with the people
// reviewing it as faces ringed in their verdict, and its size drawn as a bar.
//
// The side column (GitSpacePullRequestsSide) reads the whole list at once:
// where everything stands, who the reviews are waiting on, and what has been
// open longest. Each drawing is also a filter, and the filters live here.
//
// Clicking a row opens the pull request in a card over the list; the link out
// to GitHub stays, because merging still happens there.

const props = defineProps<{ space: ReturnType<typeof useGitSpace> }>();

const emit = defineEmits<{ open: [number: number, origin: DOMRect | null] }>();

function openRow(e: MouseEvent, number: number) {
  // SAFETY: bound on the row's own button, so currentTarget is that element.
  emit("open", number, (e.currentTarget as HTMLElement).getBoundingClientRect());
}

const { cue } = useSound();

const composing = ref(false);
const title = ref("");
const body = ref("");
const base = ref("");
const draft = ref(false);
const created = ref<{ number: number | null; url: string } | null>(null);
const titleEl = ref<HTMLInputElement | null>(null);

const busy = computed(() => props.space.op.value !== null);
const gh = computed(() => props.space.gh.value);
const origin = computed(() => props.space.origin.value);
const current = computed(() => props.space.branches.value.find((b) => b.current) ?? null);
const prs = computed(() => props.space.prs.value);
const myLogin = computed(() => props.space.me.value?.login ?? gh.value?.user ?? null);

/** Why the section can't show anything — null when it can. */
const blocked = computed<string | null>(() => {
  if (!origin.value) return "This project has no remote, so there's nothing to open a pull request against.";
  if (!origin.value.slug) return `${origin.value.fetchUrl} isn't a GitHub remote — pull requests live wherever that host keeps them.`;
  if (!gh.value) return null;
  if (!gh.value.installed) return "The GitHub CLI isn't installed. Install `gh` and this section fills itself in.";
  if (!gh.value.authenticated) return gh.value.message ?? "Run `gh auth login` in a terminal to connect your GitHub account.";
  return null;
});

// ── composing ────────────────────────────────────────────────────────────────

// A sensible target for a new PR: the repo's trunk if it exists, otherwise any
// branch that isn't the one you're on.
const defaultBase = computed(() => {
  const locals = props.space.branches.value.filter((b) => !b.remote);
  const trunk = locals.find((b) => b.name === "main") ?? locals.find((b) => b.name === "master");
  return trunk?.name ?? locals.find((b) => !b.current)?.name ?? "main";
});

const canCompose = computed(
  () => !blocked.value && gh.value?.authenticated === true && current.value !== null,
);

async function startCompose() {
  cue("expand");
  created.value = null;
  composing.value = true;
  base.value = defaultBase.value;
  // The branch name is usually most of the title already.
  if (!title.value) title.value = titleFromBranch(current.value?.name ?? "");
  await nextTick();
  titleEl.value?.select();
}
function cancelCompose() {
  composing.value = false;
  title.value = "";
  body.value = "";
  draft.value = false;
}
async function submit() {
  if (!title.value.trim() || busy.value) return;
  cue("press");
  const result = await props.space.createPr({
    title: title.value.trim(),
    body: body.value.trim() || undefined,
    base: base.value.trim() || undefined,
    draft: draft.value || undefined,
  });
  if (!result) {
    cue("error");
    return;
  }
  cue("success");
  created.value = result;
  composing.value = false;
  title.value = "";
  body.value = "";
  draft.value = false;
}

/** "feat/git-space-shell" → "Git space shell" */
function titleFromBranch(name: string) {
  const tail = name.split("/").pop() ?? name;
  const words = tail.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function setState(next: "open" | "all") {
  if (props.space.prState.value === next) return;
  cue("select");
  void props.space.loadPrs(next);
}

function checkout(pr: GitHubPullRequest) {
  cue("press");
  void props.space.checkoutPr(pr.number);
}
function open(url: string) {
  void props.space.openExternal(url);
}

// ── where each one stands ────────────────────────────────────────────────────
// One rule for the list and the open pull request alike (utils/prStand).

function standOf(pr: GitHubPullRequest): PrStand {
  return prStandOf({ ...pr, failingChecks: pr.checkCounts.failing, pendingChecks: pr.checkCounts.pending });
}

// ── filters ──────────────────────────────────────────────────────────────────

const query = ref("");
const standFilter = ref<PrStand | null>(null);
const waitingFilter = ref<string | null>(null);
const filtering = computed(() => Boolean(query.value.trim() || standFilter.value || waitingFilter.value));

function matches(pr: GitHubPullRequest): boolean {
  if (standFilter.value && standOf(pr) !== standFilter.value) return false;
  if (waitingFilter.value && !pr.reviewers.some((r) => r.state === "pending" && r.person.login === waitingFilter.value)) {
    return false;
  }
  const q = query.value.trim().toLowerCase().replace(/^#/, "");
  if (!q) return true;
  return (
    pr.title.toLowerCase().includes(q) ||
    pr.author.toLowerCase().includes(q) ||
    pr.branch.toLowerCase().includes(q) ||
    String(pr.number) === q ||
    pr.labels.some((l) => l.name.toLowerCase().includes(q))
  );
}
function clearFilters() {
  query.value = "";
  standFilter.value = null;
  waitingFilter.value = null;
}
function pickStand(id: PrStand) {
  cue("select");
  standFilter.value = standFilter.value === id ? null : id;
}
function pickWaiting(login: string) {
  cue("select");
  waitingFilter.value = waitingFilter.value === login ? null : login;
}

// ── groups ───────────────────────────────────────────────────────────────────

interface Group {
  id: string;
  label: string;
  rows: GitHubPullRequest[];
}

function waitsOnMe(pr: GitHubPullRequest): boolean {
  return pr.reviewers.some((r) => r.state === "pending" && r.person.login === myLogin.value);
}

const groups = computed<Group[]>(() => {
  const yours: GitHubPullRequest[] = [];
  const waiting: GitHubPullRequest[] = [];
  const others: GitHubPullRequest[] = [];
  const done: GitHubPullRequest[] = [];
  for (const pr of prs.value) {
    if (!matches(pr)) continue;
    if (pr.state !== "open") done.push(pr);
    else if (myLogin.value && pr.author === myLogin.value) yours.push(pr);
    else if (waitsOnMe(pr)) waiting.push(pr);
    else others.push(pr);
  }
  const byStand = (a: GitHubPullRequest, b: GitHubPullRequest) =>
    (PR_STAND_RANK.get(standOf(a)) ?? 0) - (PR_STAND_RANK.get(standOf(b)) ?? 0) ||
    (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt);
  const out: Group[] = [
    { id: "yours", label: "Yours", rows: yours.sort(byStand) },
    { id: "waiting", label: "Waiting on your review", rows: waiting.sort(byStand) },
    { id: "others", label: myLogin.value ? "Everyone else" : "Open", rows: others.sort(byStand) },
    { id: "done", label: "Merged and closed", rows: done.sort(byStand) },
  ];
  return out.filter((g) => g.rows.length > 0);
});
const shownCount = computed(() => groups.value.reduce((n, g) => n + g.rows.length, 0));

// ── drawing a row ────────────────────────────────────────────────────────────

/** The size bar's width: square-root scaled against the biggest on the page,
 *  so a 2,000-line change doesn't flatten every small one to a dot. */
const sizePeak = computed(() => Math.max(1, ...prs.value.map((pr) => pr.additions + pr.deletions)));
const SIZE_MAX = 56;
function sizeWidth(lines: number): number {
  if (!lines) return 0;
  return Math.max(2, Math.sqrt(lines / sizePeak.value) * SIZE_MAX);
}
function sizeSplit(pr: GitHubPullRequest) {
  const total = pr.additions + pr.deletions;
  const w = sizeWidth(total);
  if (!total) return { add: 0, del: 0 };
  return { add: (pr.additions / total) * w, del: (pr.deletions / total) * w };
}

function initial(name: string) {
  return name[0]?.toUpperCase() ?? "";
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
</script>

<template>
  <section class="gsp">
    <p v-if="blocked" class="gsp__blocked">{{ blocked }}</p>

    <template v-else>
      <!-- ══ the main column: the list ═══════════════════════════════════ -->
      <div class="gsp__main">
        <header class="gsp__head">
          <div class="gsp__filters" role="tablist" aria-label="Which pull requests">
            <button
              type="button"
              role="tab"
              class="gsp__filter"
              :class="{ 'gsp__filter--on': space.prState.value === 'open' }"
              :aria-selected="space.prState.value === 'open'"
              @click="setState('open')"
            >
              Open
            </button>
            <button
              type="button"
              role="tab"
              class="gsp__filter"
              :class="{ 'gsp__filter--on': space.prState.value === 'all' }"
              :aria-selected="space.prState.value === 'all'"
              @click="setState('all')"
            >
              All
            </button>
          </div>
          <button v-if="filtering" type="button" class="gsp__clear" @click="clearFilters">
            {{ shownCount }} of {{ prs.length }} · clear
          </button>
          <span class="gsp__fill" />
          <button
            v-if="canCompose && !composing"
            type="button"
            class="gsp__sweep"
            :disabled="busy"
            @click="startCompose"
          >
            <HugeiconsIcon :icon="Add01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
            New pull request
          </button>
        </header>

        <!-- Composer: an editorial block on the page, not a dialog over it. -->
        <div v-if="composing" class="gsp__composer">
          <input
            ref="titleEl"
            v-model="title"
            class="gsp__title"
            type="text"
            spellcheck="false"
            placeholder="Pull request title"
            :disabled="busy"
            aria-label="Pull request title"
            @keydown.esc.prevent="cancelCompose"
          />
          <textarea
            v-model="body"
            class="gsp__bodyfield"
            rows="3"
            spellcheck="false"
            placeholder="Description — optional"
            :disabled="busy"
            aria-label="Pull request description"
            @keydown.esc.prevent="cancelCompose"
          />
          <div class="gsp__composerfoot">
            <span class="gsp__route">
              <span class="gsp__head-branch">{{ current?.name }}</span>
              <span class="gsp__arrow">→</span>
              <input
                v-model="base"
                class="gsp__base"
                type="text"
                spellcheck="false"
                :disabled="busy"
                aria-label="Base branch"
              />
            </span>
            <span class="gsp__fill" />
            <button
              type="button"
              class="gsp__act"
              :class="{ 'gsp__act--on': draft }"
              :aria-pressed="draft"
              @click="cue('toggle', { off: draft }); draft = !draft"
            >
              Draft
            </button>
            <button type="button" class="gsp__act" @click="cancelCompose">Cancel</button>
            <button
              type="button"
              class="gsp__create"
              :disabled="busy || !title.trim()"
              @click="submit"
            >
              Create
            </button>
          </div>
        </div>

        <p v-if="created" class="gsp__created">
          Opened
          <button type="button" class="gsp__link" @click="open(created.url)">
            <template v-if="created.number">#{{ created.number }}</template>
            <template v-else>the pull request</template>
            <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="11" :stroke-width="2" aria-hidden="true" />
          </button>
        </p>

        <div v-for="(g, gi) in groups" :key="g.id" class="gsp__group" :style="{ '--i': gi }">
          <div class="gsp__label">
            <span class="gsp__label-name">{{ g.label }}</span>
            <span class="gsp__label-count">{{ g.rows.length }}</span>
          </div>

          <div
            v-for="(pr, i) in g.rows"
            :key="pr.number"
            class="gsp__row"
            :style="{ '--n': i }"
          >
            <!-- The summary is the way in: everything except the two actions is
                 one target, so there's no small thing to aim at. -->
            <button
              type="button"
              class="gsp__main-btn"
              :title="`Open #${pr.number}`"
              @click="openRow($event, pr.number)"
            >
              <span class="gsp__ring">
                <GitSpaceChecksRing :counts="pr.checkCounts" :size="24" :stroke="3" />
                <i
                  v-if="pr.mergeability === 'conflicting' && pr.state === 'open'"
                  class="gsp__conflict"
                  title="Conflicts with its base branch"
                />
              </span>

              <span class="gsp__body">
                <span class="gsp__line">
                  <span class="gsp__prtitle">{{ pr.title }}</span>
                  <span class="gsp__num">#{{ pr.number }}</span>
                </span>
                <span class="gsp__meta">
                  <span class="gsp__stand">
                    <i class="gsp__stand-dot" :style="{ background: PR_STAND.get(standOf(pr))?.tone }" />
                    {{ PR_STAND.get(standOf(pr))?.label }}
                  </span>
                  <span class="gsp__who">
                    <span class="gsp__face" aria-hidden="true">
                      <img v-if="pr.authorPerson?.avatarDataUrl" :src="pr.authorPerson.avatarDataUrl" alt="" />
                      <template v-else>{{ initial(pr.author) }}</template>
                    </span>
                    {{ pr.author }}
                  </span>
                  <span class="gsp__dim">{{ pr.updated || pr.relative }}</span>
                  <span v-for="l in pr.labels.slice(0, 2)" :key="l.name" class="gsp__labeltag">
                    <i class="gsp__labeldot" :style="{ backgroundColor: `#${l.color}` }" />{{ l.name }}
                  </span>
                  <span v-if="pr.labels.length > 2" class="gsp__dim">+{{ pr.labels.length - 2 }}</span>
                </span>
              </span>

              <span class="gsp__right">
                <GitSpaceReviewers v-if="pr.reviewers.length" :reviewers="pr.reviewers" :size="20" />
                <span
                  class="gsp__size"
                  :title="`+${pr.additions} −${pr.deletions} in ${plural(pr.changedFiles, 'file')}`"
                >
                  <i class="gsp__size-add" :style="{ width: `${sizeSplit(pr).add}px` }" />
                  <i class="gsp__size-del" :style="{ width: `${sizeSplit(pr).del}px` }" />
                </span>
              </span>
            </button>

            <div class="gsp__actions">
              <button
                type="button"
                class="gsp__act"
                :disabled="busy || pr.state !== 'open'"
                @click="checkout(pr)"
              >
                Check out
              </button>
              <button
                type="button"
                class="gsp__act gsp__act--go"
                :title="`Open #${pr.number} on GitHub`"
                :aria-label="`Open #${pr.number} on GitHub`"
                @click="open(pr.url)"
              >
                <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <p v-if="filtering && !shownCount" class="gsp__empty">
          Nothing matches.
          <button type="button" class="gsp__link" @click="clearFilters">Clear the filter</button>
        </p>
        <p v-else-if="!prs.length && gh" class="gsp__empty">
          <template v-if="space.prState.value === 'open'">
            No open pull requests.
            <span class="gsp__empty-sub">Push a branch and open one from here.</span>
          </template>
          <template v-else>No pull requests on this repository yet.</template>
        </p>
      </div>

      <GitSpacePullRequestsSide
        v-if="prs.length"
        v-model:query="query"
        :prs="prs"
        :my-login="myLogin"
        :stand-filter="standFilter"
        :waiting-filter="waitingFilter"
        @pick-stand="pickStand"
        @pick-waiting="pickWaiting"
        @open="(n, o) => emit('open', n, o)"
      />
    </template>
  </section>
</template>

<style scoped>
.gsp {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 64px;
  align-items: start;
  padding-bottom: 12px;
}
.gsp__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.gsp__fill {
  flex: 1 1 auto;
}

/* ── entrance ─────────────────────────────────────────────────────────────── */
.gsp__group {
  animation: gsp-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3);
}
.gsp__row {
  animation: gsp-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3 + min(var(--n, 0), 7) * var(--gs-stagger));
}
@keyframes gsp-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes gsp-grow {
  from {
    transform: scaleX(0);
  }
}

/* ── head ─────────────────────────────────────────────────────────────────── */
.gsp__head {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 26px;
  margin-bottom: 26px;
}
.gsp__filters {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background-color: var(--hover);
}
.gsp__filter {
  height: 22px;
  padding-inline: 10px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gsp__filter:hover {
  color: var(--ink-soft);
}
.gsp__filter--on {
  color: var(--ink);
  background-color: var(--raised-high);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
}
.gsp__filter:focus-visible,
.gsp__clear:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.gsp__clear {
  padding: 3px 8px;
  border-radius: 7px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
  background-color: var(--hover);
  cursor: pointer;
}
.gsp__clear:hover {
  color: var(--ink);
}

/* ── labels ───────────────────────────────────────────────────────────────── */
.gsp__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
}
.gsp__label-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.gsp__label-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* ── groups and rows ──────────────────────────────────────────────────────── */
.gsp__group + .gsp__group {
  margin-top: 34px;
}
.gsp__row {
  position: relative;
  display: flex;
  align-items: center;
  margin-inline: -10px;
  border-radius: 10px;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.gsp__row:hover,
.gsp__row:focus-within {
  background-color: var(--hover);
}
.gsp__main-btn {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 11px 10px;
  text-align: left;
  cursor: pointer;
}
.gsp__main-btn:focus-visible {
  outline: none;
  border-radius: 10px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}

/* The checks ring leads, with a red notch on it when the branch conflicts. */
.gsp__ring {
  position: relative;
  display: flex;
  flex-shrink: 0;
}
.gsp__conflict {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background-color: var(--danger);
  box-shadow: 0 0 0 2px var(--ground);
}
.gsp__row:hover .gsp__conflict {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 4%, var(--ground));
}

.gsp__body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1 1 auto;
  min-width: 0;
}
.gsp__line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.gsp__prtitle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  letter-spacing: -0.15px;
  color: var(--ink);
}
.gsp__num {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
.gsp__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  line-height: 1;
  color: var(--muted);
  white-space: nowrap;
}
.gsp__stand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-soft);
}
.gsp__stand-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.gsp__who {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.gsp__face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--hover);
  font-size: 9px;
  color: var(--muted);
}
.gsp__face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gsp__dim {
  color: var(--muted);
}
.gsp__labeltag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.gsp__labeldot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.gsp__right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  flex-shrink: 0;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
/* The size of the change as a bar: green for lines in, red for lines out. */
.gsp__size {
  display: flex;
  gap: 2px;
  width: 56px;
  height: 6px;
}
.gsp__size-add,
.gsp__size-del {
  height: 100%;
  border-radius: 3px;
  transform-origin: left center;
  animation: gsp-grow 600ms var(--gs-ease) backwards;
  animation-delay: calc(220ms + min(var(--n, 0), 7) * 60ms);
}
.gsp__size-add {
  background-color: var(--diff-add);
}
.gsp__size-del {
  background-color: var(--diff-del);
}

/* The two actions take the right end's place on hover. */
.gsp__actions {
  position: absolute;
  right: 6px;
  top: 50%;
  display: flex;
  align-items: center;
  gap: 2px;
  transform: translateY(-50%);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.gsp__row:hover .gsp__actions,
.gsp__row:focus-within .gsp__actions {
  opacity: 1;
  pointer-events: auto;
}
.gsp__row:hover .gsp__right,
.gsp__row:focus-within .gsp__right {
  opacity: 0;
}

.gsp__sweep {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gsp__sweep:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink-soft);
}
.gsp__sweep:disabled {
  opacity: 0.4;
  cursor: default;
}
.gsp__sweep:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}

/* ── composer ─────────────────────────────────────────────────────────────── */
/* Bare, for the same reason the commit box is — see GitSpaceCommitBox. */
.gsp__composer {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 16px;
  padding: 8px;
  border-radius: 9px;
  background-color: transparent;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
  animation: gsp-in var(--gs-t-enter) var(--gs-ease) backwards;
}
.gsp__composer:focus-within {
  background-color: var(--hover);
}
.gsp__title,
.gsp__bodyfield {
  width: 100%;
  background: none;
  border: none;
  outline: none;
  font-family: var(--font-sans);
  color: var(--ink);
}
.gsp__title {
  font-size: 14px;
  letter-spacing: -0.2px;
  line-height: 1.4;
}
.gsp__bodyfield {
  resize: none;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--ink-soft);
}
.gsp__title::placeholder,
.gsp__bodyfield::placeholder {
  color: var(--muted);
}
.gsp__composerfoot {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
}
.gsp__route {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1;
}
.gsp__head-branch {
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 22ch;
}
.gsp__arrow {
  color: var(--muted);
}
.gsp__base {
  width: 14ch;
  height: 21px;
  padding-inline: 6px;
  border-radius: 6px;
  background-color: var(--hover);
  border: none;
  outline: none;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink);
}
.gsp__create {
  height: 25px;
  padding-inline: 10px;
  border-radius: 8px;
  background-color: var(--ink);
  color: var(--ground);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.gsp__create:hover:not(:disabled) {
  opacity: 0.88;
}
.gsp__create:disabled {
  opacity: 0.4;
  cursor: default;
}
.gsp__create:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}

.gsp__created {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 12px;
  padding-inline: 8px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}
.gsp__link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent);
  cursor: pointer;
}
.gsp__link:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
  border-radius: 5px;
}
.gsp__act {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gsp__act:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.gsp__act--on {
  color: var(--accent);
}
.gsp__act--go {
  color: var(--ink-soft);
}
.gsp__act:disabled {
  opacity: 0.4;
  cursor: default;
}
.gsp__act:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.gsp__blocked,
.gsp__empty {
  grid-column: 1 / -1;
  max-width: 56ch;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-soft);
}
.gsp__empty-sub {
  color: var(--muted);
}
.gsp__blocked {
  color: var(--muted);
}

@media (max-width: 1180px) {
  .gsp {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .gsp__group,
  .gsp__row,
  .gsp__composer,
  .gsp__size-add,
  .gsp__size-del {
    animation: none;
  }
  .gsp__row,
  .gsp__composer,
  .gsp__filter,
  .gsp__sweep,
  .gsp__create,
  .gsp__actions,
  .gsp__right,
  .gsp__act {
    transition: none;
  }
}
</style>
