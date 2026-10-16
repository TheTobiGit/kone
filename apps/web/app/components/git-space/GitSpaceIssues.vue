<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Add01Icon, ArrowUpRight01Icon, Comment01Icon, PinIcon } from "@hugeicons/core-free-icons";
import type { GitHubIssue, GitHubPerson } from "~/types/desktop";
import type { useGitSpace } from "~/composables/useGitSpace";

// Issues, read where the code is.
//
// Two columns, like the rest of the space. The main one is the list, sorted by
// what each issue asks of you: anything pinned, then what's assigned to you,
// then what you opened, then everyone else's. Every row leads with a mark for
// where the issue stands (open, done, or closed as not planned), carries its
// labels as dots, and ends with the people on it as faces and how much has been
// said about it.
//
// The side column (GitSpaceIssuesSide) reads the whole list at once: how many
// have someone on them, which labels the open ones carry, who they're with, and
// what has been open longest. Each drawing is also a filter, and the filters
// live here.
//
// Clicking a row opens the issue in a card over the list, where it can be
// commented on, closed and reopened. A new issue is written in place, at the top.

const props = defineProps<{ space: ReturnType<typeof useGitSpace> }>();

const emit = defineEmits<{ open: [number: number, origin: DOMRect | null] }>();

function openRow(e: MouseEvent, number: number) {
  // SAFETY: bound on the row's own button, so currentTarget is that element.
  emit("open", number, (e.currentTarget as HTMLElement).getBoundingClientRect());
}

const { cue } = useSound();

const busy = computed(() => props.space.op.value !== null);
const gh = computed(() => props.space.gh.value);
const origin = computed(() => props.space.origin.value);
const issues = computed(() => props.space.issues.value);
const myLogin = computed(() => props.space.me.value?.login ?? gh.value?.user ?? null);

/** Why the section can't show anything — null when it can. */
const blocked = computed<string | null>(() => {
  if (!origin.value) return "This project has no remote, so there's no tracker to read issues from.";
  if (!origin.value.slug) return `${origin.value.fetchUrl} isn't a GitHub remote — issues live wherever that host keeps them.`;
  if (!gh.value) return null;
  if (!gh.value.installed) return "The GitHub CLI isn't installed. Install `gh` and this section fills itself in.";
  if (!gh.value.authenticated) return gh.value.message ?? "Run `gh auth login` in a terminal to connect your GitHub account.";
  return null;
});

// ── composing ────────────────────────────────────────────────────────────────

const composing = ref(false);
const title = ref("");
const body = ref("");
const created = ref<{ number: number | null; url: string } | null>(null);
const titleEl = ref<HTMLInputElement | null>(null);
const canCompose = computed(() => !blocked.value && gh.value?.authenticated === true);

async function startCompose() {
  cue("expand");
  created.value = null;
  composing.value = true;
  await nextTick();
  titleEl.value?.focus();
}
function cancelCompose() {
  composing.value = false;
  title.value = "";
  body.value = "";
}
async function submit() {
  if (!title.value.trim() || busy.value) return;
  cue("press");
  const result = await props.space.createIssue({ title: title.value.trim(), body: body.value.trim() || undefined });
  if (!result) {
    cue("error");
    return;
  }
  cue("success");
  created.value = result;
  cancelCompose();
}
function onComposerKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    cancelCompose();
  } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void submit();
  }
}
function openCreated(e: MouseEvent) {
  const c = created.value;
  if (!c) return;
  if (c.number) openRow(e, c.number);
  else void props.space.openExternal(c.url);
}

function setState(next: "open" | "all") {
  if (props.space.issueState.value === next) return;
  cue("select");
  void props.space.loadIssues(next);
}

// ── filters ──────────────────────────────────────────────────────────────────

/** The assignee filter: a login, NOBODY for issues no one is on, or ANYONE for those someone is. */
const NOBODY = "\u0000nobody";
const ANYONE = "\u0000anyone";
const query = ref("");
const labelFilter = ref<string | null>(null);
const assigneeFilter = ref<string | null>(null);
const filtering = computed(() => Boolean(query.value.trim() || labelFilter.value || assigneeFilter.value));

function matches(issue: GitHubIssue): boolean {
  if (labelFilter.value && !issue.labels.some((l) => l.name === labelFilter.value)) return false;
  if (assigneeFilter.value === NOBODY && issue.assignees.length) return false;
  if (assigneeFilter.value === ANYONE && !issue.assignees.length) return false;
  if (
    assigneeFilter.value &&
    assigneeFilter.value !== NOBODY &&
    assigneeFilter.value !== ANYONE &&
    !issue.assignees.some((a) => a.login === assigneeFilter.value)
  ) {
    return false;
  }
  const q = query.value.trim().toLowerCase().replace(/^#/, "");
  if (!q) return true;
  return (
    issue.title.toLowerCase().includes(q) ||
    String(issue.number) === q ||
    (issue.author?.login.toLowerCase().includes(q) ?? false) ||
    issue.labels.some((l) => l.name.toLowerCase().includes(q)) ||
    issue.assignees.some((a) => a.login.toLowerCase().includes(q))
  );
}
function clearFilters() {
  query.value = "";
  labelFilter.value = null;
  assigneeFilter.value = null;
}
function pickLabel(name: string) {
  cue("select");
  labelFilter.value = labelFilter.value === name ? null : name;
}
function pickAssignee(login: string) {
  cue("select");
  assigneeFilter.value = assigneeFilter.value === login ? null : login;
}

// ── groups ───────────────────────────────────────────────────────────────────

interface Group {
  id: string;
  label: string;
  rows: GitHubIssue[];
}

const groups = computed<Group[]>(() => {
  const me = myLogin.value;
  const pinned: GitHubIssue[] = [];
  const mine: GitHubIssue[] = [];
  const opened: GitHubIssue[] = [];
  const others: GitHubIssue[] = [];
  const closed: GitHubIssue[] = [];
  for (const issue of issues.value) {
    if (!matches(issue)) continue;
    if (issue.state !== "open") closed.push(issue);
    else if (issue.isPinned) pinned.push(issue);
    else if (me && issue.assignees.some((a) => a.login === me)) mine.push(issue);
    else if (me && issue.author?.login === me) opened.push(issue);
    else others.push(issue);
  }
  const recent = (a: GitHubIssue, b: GitHubIssue) =>
    (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt);
  const out: Group[] = [
    { id: "pinned", label: "Pinned", rows: pinned.sort(recent) },
    { id: "mine", label: "Assigned to you", rows: mine.sort(recent) },
    { id: "opened", label: "Opened by you", rows: opened.sort(recent) },
    { id: "others", label: me ? "Everyone else" : "Open", rows: others.sort(recent) },
    { id: "closed", label: "Closed", rows: closed.sort(recent) },
  ];
  return out.filter((g) => g.rows.length > 0);
});
const shownCount = computed(() => groups.value.reduce((n, g) => n + g.rows.length, 0));

function initial(p: GitHubPerson | null) {
  return (p?.name || p?.login || "")[0]?.toUpperCase() ?? "";
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
function peopleSentence(people: GitHubPerson[]): string {
  if (!people.length) return "Nobody is assigned";
  return `Assigned to ${people.map((p) => (p.login === myLogin.value ? "you" : p.login)).join(", ")}`;
}
</script>

<template>
  <section class="gsi">
    <p v-if="blocked" class="gsi__blocked">{{ blocked }}</p>

    <template v-else>
      <!-- ══ the main column: the list ═══════════════════════════════════ -->
      <div class="gsi__main">
        <header class="gsi__head">
          <div class="gsi__filters" role="tablist" aria-label="Which issues">
            <button
              type="button"
              role="tab"
              class="gsi__filter"
              :class="{ 'gsi__filter--on': space.issueState.value === 'open' }"
              :aria-selected="space.issueState.value === 'open'"
              @click="setState('open')"
            >
              Open
            </button>
            <button
              type="button"
              role="tab"
              class="gsi__filter"
              :class="{ 'gsi__filter--on': space.issueState.value === 'all' }"
              :aria-selected="space.issueState.value === 'all'"
              @click="setState('all')"
            >
              All
            </button>
          </div>
          <button v-if="filtering" type="button" class="gsi__clear" @click="clearFilters">
            {{ shownCount }} of {{ issues.length }} · clear
          </button>
          <span class="gsi__fill" />
          <button
            v-if="canCompose && !composing"
            type="button"
            class="gsi__sweep"
            :disabled="busy"
            @click="startCompose"
          >
            <HugeiconsIcon :icon="Add01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
            New issue
          </button>
        </header>

        <!-- Composer: written in place at the top of the list, not in a dialog. -->
        <form v-if="composing" class="gsi__composer" @submit.prevent="submit" @keydown="onComposerKey">
          <input
            ref="titleEl"
            v-model="title"
            class="gsi__title"
            type="text"
            placeholder="What's the issue?"
            :disabled="busy"
            aria-label="Issue title"
          />
          <textarea
            v-model="body"
            class="gsi__bodyfield"
            rows="4"
            placeholder="Steps, what you expected, what happened instead (optional)"
            :disabled="busy"
            aria-label="Issue description"
          />
          <div class="gsi__composerfoot">
            <span class="gsi__hint">Markdown works.</span>
            <span class="gsi__fill" />
            <button type="button" class="gsi__act" @click="cancelCompose">Cancel</button>
            <button type="submit" class="gsi__create" :disabled="busy || !title.trim()">
              {{ space.op.value === "issue" ? "Opening…" : "Open issue" }}
            </button>
          </div>
        </form>

        <p v-if="created" class="gsi__created" role="status">
          Opened
          <button type="button" class="gsi__link" @click="openCreated">
            <template v-if="created.number">#{{ created.number }}</template>
            <template v-else>the issue</template>
          </button>
        </p>

        <div v-for="(g, gi) in groups" :key="g.id" class="gsi__group" :style="{ '--i': gi }">
          <div class="gsi__label">
            <span class="gsi__label-name">{{ g.label }}</span>
            <span class="gsi__label-count">{{ g.rows.length }}</span>
          </div>

          <div v-for="(issue, i) in g.rows" :key="issue.number" class="gsi__row" :style="{ '--n': i }">
            <button
              type="button"
              class="gsi__main-btn"
              aria-haspopup="dialog"
              @click="openRow($event, issue.number)"
            >
              <GitSpaceIssueGlyph :issue="issue" :size="18" />

              <span class="gsi__body">
                <span class="gsi__line">
                  <span class="gsi__issuetitle">{{ issue.title }}</span>
                  <span class="gsi__num">#{{ issue.number }}</span>
                  <HugeiconsIcon
                    v-if="issue.isPinned && g.id !== 'pinned'"
                    class="gsi__pin"
                    :icon="PinIcon"
                    :size="11"
                    :stroke-width="2"
                    aria-label="Pinned"
                  />
                </span>
                <span class="gsi__meta">
                  <span class="gsi__who">
                    <span class="gsi__face" aria-hidden="true">
                      <img v-if="issue.author?.avatarDataUrl" :src="issue.author.avatarDataUrl" alt="" />
                      <template v-else>{{ initial(issue.author) }}</template>
                    </span>
                    {{ issue.author?.login ?? "someone" }}
                  </span>
                  <span class="gsi__dim">{{ issue.state === "open" ? `opened ${issue.relative}` : `updated ${issue.updated}` }}</span>
                  <span v-for="l in issue.labels.slice(0, 3)" :key="l.name" class="gsi__labeltag">
                    <i class="gsi__labeldot" :style="{ backgroundColor: `#${l.color}` }" />{{ l.name }}
                  </span>
                  <span v-if="issue.labels.length > 3" class="gsi__dim">+{{ issue.labels.length - 3 }}</span>
                </span>
              </span>

              <span class="gsi__right">
                <span
                  class="gsi__people"
                  role="img"
                  :aria-label="peopleSentence(issue.assignees)"
                  :title="peopleSentence(issue.assignees)"
                >
                  <span
                    v-for="(a, ai) in issue.assignees.slice(0, 3)"
                    :key="a.login"
                    class="gsi__face gsi__face--md"
                    :style="{ zIndex: 3 - ai }"
                  >
                    <img v-if="a.avatarDataUrl" :src="a.avatarDataUrl" alt="" />
                    <template v-else>{{ initial(a) }}</template>
                  </span>
                  <i v-if="!issue.assignees.length" class="gsi__nobody" />
                </span>
                <span
                  class="gsi__talk"
                  :class="{ 'gsi__talk--none': !issue.commentCount }"
                  :aria-label="plural(issue.commentCount, 'comment')"
                  :title="plural(issue.commentCount, 'comment')"
                >
                  <HugeiconsIcon :icon="Comment01Icon" :size="12" :stroke-width="1.8" aria-hidden="true" />
                  {{ issue.commentCount }}
                </span>
              </span>
            </button>

            <div class="gsi__actions">
              <button
                type="button"
                class="gsi__act gsi__act--go"
                :title="`Open #${issue.number} on GitHub`"
                :aria-label="`Open #${issue.number} on GitHub`"
                @click="space.openExternal(issue.url)"
              >
                <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <p v-if="filtering && !shownCount" class="gsi__empty">
          Nothing matches.
          <button type="button" class="gsi__link" @click="clearFilters">Clear the filter</button>
        </p>
        <p v-else-if="!issues.length && gh" class="gsi__empty">
          <template v-if="space.issueState.value === 'open'">
            No open issues.
            <span class="gsi__empty-sub">Nothing on the tracker needs anyone right now.</span>
          </template>
          <template v-else>No issues on this repository yet.</template>
        </p>
      </div>

      <GitSpaceIssuesSide
        v-if="issues.length"
        v-model:query="query"
        :issues="issues"
        :my-login="myLogin"
        :nobody="NOBODY"
        :anyone="ANYONE"
        :label-filter="labelFilter"
        :assignee-filter="assigneeFilter"
        @pick-label="pickLabel"
        @pick-assignee="pickAssignee"
        @open="(n, o) => emit('open', n, o)"
      />
    </template>
  </section>
</template>

<style scoped>
.gsi {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 64px;
  align-items: start;
  padding-bottom: 12px;
}
.gsi__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.gsi__fill {
  flex: 1 1 auto;
}

/* ── entrance ─────────────────────────────────────────────────────────────── */
.gsi__group {
  animation: gsi-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3);
}
.gsi__row {
  animation: gsi-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3 + min(var(--n, 0), 7) * var(--gs-stagger));
}
@keyframes gsi-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ── head ─────────────────────────────────────────────────────────────────── */
.gsi__head {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 26px;
  margin-bottom: 26px;
}
.gsi__filters {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background-color: var(--hover);
}
.gsi__filter {
  height: 22px;
  padding-inline: 10px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gsi__filter:hover {
  color: var(--ink);
}
.gsi__filter--on {
  color: var(--ink);
  background-color: var(--raised-high);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
}
.gsi__filter:focus-visible,
.gsi__clear:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.gsi__clear {
  padding: 3px 8px;
  border-radius: 7px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
  background-color: var(--hover);
  cursor: pointer;
}
.gsi__clear:hover {
  color: var(--ink);
}

/* ── labels ───────────────────────────────────────────────────────────────── */
.gsi__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
}
.gsi__label-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.gsi__label-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* ── groups and rows ──────────────────────────────────────────────────────── */
.gsi__group + .gsi__group {
  margin-top: 34px;
}
.gsi__row {
  position: relative;
  display: flex;
  align-items: center;
  margin-inline: -10px;
  border-radius: 10px;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.gsi__row:hover,
.gsi__row:focus-within {
  background-color: var(--hover);
}
.gsi__main-btn {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 11px 10px;
  text-align: left;
  cursor: pointer;
}
.gsi__main-btn:focus-visible {
  outline: none;
  border-radius: 10px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}


.gsi__body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1 1 auto;
  min-width: 0;
}
.gsi__line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.gsi__issuetitle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  letter-spacing: -0.15px;
  color: var(--ink);
}
.gsi__num {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
.gsi__meta {
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
.gsi__who {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.gsi__face {
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
.gsi__face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gsi__dim {
  color: var(--muted);
}
.gsi__labeltag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.gsi__labeldot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.gsi__right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  flex-shrink: 0;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}

/* A pin beside the number, for a pinned issue shown outside the pinned group. */
.gsi__pin {
  flex-shrink: 0;
  align-self: center;
  color: var(--accent);
}

/* The people on an issue, as overlapping faces; a dashed ring when nobody is. */
.gsi__people {
  display: flex;
  align-items: center;
  min-width: 36px;
  justify-content: flex-end;
}
.gsi__face--md {
  width: 20px;
  height: 20px;
  font-size: 10px;
  box-shadow: 0 0 0 2px var(--ground);
}
.gsi__face--md + .gsi__face--md {
  margin-left: -6px;
}
.gsi__row:hover .gsi__face--md,
.gsi__row:focus-within .gsi__face--md {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 4%, var(--ground));
}
.gsi__nobody {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px dashed color-mix(in srgb, var(--ink) 28%, transparent);
}
.gsi__talk {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 3ch;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.gsi__talk--none {
  opacity: 0.45;
}
.gsi__hint {
  font-size: 11.5px;
  color: var(--ink-soft);
}

/* The GitHub action takes the right end's place on hover. */
.gsi__actions {
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
.gsi__row:hover .gsi__actions,
.gsi__row:focus-within .gsi__actions {
  opacity: 1;
  pointer-events: auto;
}
.gsi__row:hover .gsi__right,
.gsi__row:focus-within .gsi__right {
  opacity: 0;
}

.gsi__sweep {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gsi__sweep:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.gsi__sweep:disabled {
  opacity: 0.4;
  cursor: default;
}
.gsi__sweep:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}

/* ── composer ─────────────────────────────────────────────────────────────── */
/* A quiet field at rest, so it reads as somewhere to write; a ring once it has focus. */
.gsi__composer {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 16px;
  padding: 12px 14px 10px;
  border-radius: 12px;
  background-color: var(--hover);
  transition: box-shadow var(--gs-t-micro) var(--gs-ease);
  animation: gsi-in var(--gs-t-enter) var(--gs-ease) backwards;
}
.gsi__composer:focus-within {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.gsi__title,
.gsi__bodyfield {
  width: 100%;
  background: none;
  border: none;
  outline: none;
  font-family: var(--font-sans);
  color: var(--ink);
}
.gsi__title {
  font-size: 14px;
  letter-spacing: -0.2px;
  line-height: 1.4;
}
.gsi__bodyfield {
  resize: none;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--ink-soft);
}
.gsi__title::placeholder,
.gsi__bodyfield::placeholder {
  color: var(--ink-soft);
  opacity: 0.75;
}
.gsi__composerfoot {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
}
.gsi__create {
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
.gsi__create:hover:not(:disabled) {
  opacity: 0.88;
}
.gsi__create:disabled {
  opacity: 0.4;
  cursor: default;
}
.gsi__create:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}

.gsi__created {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 12px;
  padding-inline: 8px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}
.gsi__link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent);
  cursor: pointer;
}
.gsi__link:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
  border-radius: 5px;
}
.gsi__act {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gsi__act:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.gsi__act--go {
  color: var(--ink-soft);
}
.gsi__act:disabled {
  opacity: 0.4;
  cursor: default;
}
.gsi__act:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.gsi__blocked,
.gsi__empty {
  grid-column: 1 / -1;
  max-width: 56ch;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-soft);
}
.gsi__empty-sub {
  color: var(--muted);
}
.gsi__blocked {
  color: var(--muted);
}

@media (max-width: 1180px) {
  .gsi {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .gsi__group,
  .gsi__row,
  .gsi__composer {
    animation: none;
  }
  .gsi__row,
  .gsi__composer,
  .gsi__filter,
  .gsi__sweep,
  .gsi__create,
  .gsi__actions,
  .gsi__right,
  .gsi__act {
    transition: none;
  }
}
</style>
