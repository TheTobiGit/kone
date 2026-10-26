<script setup lang="ts">
import { computed } from "vue";
import MarkdownMessage from "~/components/markdown/MarkdownMessage.vue";
import GitSpacePullRequestSection from "~/components/git-space/GitSpacePullRequestSection.vue";
import type { PullRequestSectionState } from "~/composables/usePullRequestSections";
import type { GitHubPerson, GitHubPrCommit, GitHubPullRequestDetail, GitHubReview } from "~/types/desktop";
import { prDate } from "~/utils/prFormat";

// The open pull request's Conversation tab: the description, then everything
// that happened to it on one rail. Commits open in a card over the page, which
// the pull request card owns, so this only says which one and where it was.

const props = defineProps<{
  pr: GitHubPullRequestDetail | null;
  summary: PullRequestSectionState;
  activity: PullRequestSectionState;
  /** The commit the branch points at now; a review on any other is stale. */
  headOid: string | null;
}>();

const emit = defineEmits<{
  openCommit: [hash: string, origin: DOMRect | null];
  retry: [section: "summary" | "conversation"];
}>();

function openCommit(e: MouseEvent, hash: string) {
  // SAFETY: bound on the commit's button, so currentTarget is that element.
  emit("openCommit", hash, (e.currentTarget as HTMLElement).getBoundingClientRect());
}

function isStale(r: GitHubReview): boolean {
  return Boolean(r.commit && props.headOid && r.commit !== props.headOid && r.state !== "pending");
}

// ── the rail ─────────────────────────────────────────────────────────────────
// Everything that happened to the pull request, oldest first, on one line.
// Consecutive commits fold into one event — a push of five commits is one
// thing that happened, not five.

type Event =
  | { kind: "opened"; at: string; person: GitHubPerson | null }
  | { kind: "commits"; at: string; commits: GitHubPrCommit[] }
  | { kind: "review"; at: string; review: GitHubReview }
  | { kind: "comment"; at: string; person: GitHubPerson | null; body: string; relative: string }
  | { kind: "merged"; at: string; person: GitHubPerson | null }
  | { kind: "closed"; at: string };

const events = computed<Event[]>(() => {
  const p = props.pr;
  if (!p) return [];
  const raw: Event[] = props.summary.ready ? [{ kind: "opened", at: p.createdAt, person: p.author }] : [];
  for (const c of p.commits) raw.push({ kind: "commits", at: c.date, commits: [c] });
  for (const r of p.reviews) if (r.submittedAt) raw.push({ kind: "review", at: r.submittedAt, review: r });
  for (const c of p.comments) {
    raw.push({ kind: "comment", at: c.createdAt, person: c.author, body: c.body, relative: c.relative });
  }
  if (p.mergedAt) raw.push({ kind: "merged", at: p.mergedAt, person: p.mergedBy });
  else if (p.closedAt) raw.push({ kind: "closed", at: p.closedAt });
  // Opening is where the story starts, even when a commit on the branch is
  // older than the pull request itself.
  raw.sort((a, b) => (a.kind === "opened" ? -1 : b.kind === "opened" ? 1 : a.at.localeCompare(b.at)));
  const out: Event[] = [];
  for (const e of raw) {
    const last = out[out.length - 1];
    if (e.kind === "commits" && last?.kind === "commits") last.commits.push(...e.commits);
    else out.push(e);
  }
  return out;
});

const REVIEW_STATE: Record<string, string> = {
  approved: "approved",
  "changes-requested": "requested changes",
  commented: "reviewed",
  dismissed: "review dismissed",
  pending: "review pending",
};

function initial(p: GitHubPerson | null, fallback = "") {
  return (p?.name || p?.login || fallback)[0]?.toUpperCase() ?? "";
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
</script>

<template>
  <div class="prv__conversation">
  <GitSpacePullRequestSection label="Description" variant="description" v-bind="summary" @retry="emit('retry', 'summary')">
  <div v-if="pr?.body" class="prv__description selectable">
    <MarkdownMessage :source="pr.body" historical />
  </div>
  <p v-else class="prv__nodesc">No description.</p>
  </GitSpacePullRequestSection>

  <GitSpacePullRequestSection class="prv__activity" label="Activity" variant="activity" v-bind="activity" @retry="emit('retry', 'conversation')">
  <ol class="prv__rail">
    <li
      v-for="(e, i) in events"
      :key="`${e.kind}:${e.at}:${i}`"
      class="prv__event"
      :class="`prv__event--${e.kind}`"
      :style="{ '--i': i }"
    >
      <!-- opened -->
      <template v-if="e.kind === 'opened'">
        <i class="prv__node" />
        <p class="prv__line">
          <b>{{ e.person?.login ?? "someone" }}</b>{{ " " }}opened this
          <span class="prv__when">{{ pr?.relative }}</span>
        </p>
      </template>

      <!-- a run of commits -->
      <template v-else-if="e.kind === 'commits'">
        <i class="prv__node prv__node--commit" />
        <div class="prv__pushed">
          <p class="prv__line">
            Pushed {{ plural(e.commits.length, "commit") }}
            <span class="prv__when">{{ e.commits[e.commits.length - 1]?.relative }}</span>
          </p>
          <button
            v-for="c in e.commits"
            :key="c.oid"
            type="button"
            class="prv__pushed-row"
            :title="c.headline"
            aria-haspopup="dialog"
            @click="openCommit($event, c.oid)"
          >
            <span class="prv__hash">{{ c.short }}</span>
            <span class="prv__headline">{{ c.headline }}</span>
          </button>
        </div>
      </template>

      <!-- a review -->
      <template v-else-if="e.kind === 'review'">
        <span
          class="prv__face prv__face--lg prv__face--ringed"
          :class="`prv__face--${e.review.state}`"
          aria-hidden="true"
        >
          <img v-if="e.review.author?.avatarDataUrl" :src="e.review.author.avatarDataUrl" alt="" />
          <span v-else>{{ initial(e.review.author) }}</span>
        </span>
        <div class="prv__said">
          <p class="prv__line">
            <b>{{ e.review.author?.login ?? "someone" }}</b>{{ " " }}
            <span class="prv__verdict" :class="`prv__verdict--${e.review.state}`">
              {{ REVIEW_STATE[e.review.state] }}
            </span>
            <span class="prv__when">{{ e.review.relative }}</span>
            <span v-if="isStale(e.review)" class="prv__stale">on an earlier commit</span>
          </p>
          <div v-if="e.review.body" class="prv__saidbody selectable">
            <MarkdownMessage :source="e.review.body" historical />
          </div>
        </div>
      </template>

      <!-- a comment -->
      <template v-else-if="e.kind === 'comment'">
        <span class="prv__face prv__face--lg" aria-hidden="true">
          <img v-if="e.person?.avatarDataUrl" :src="e.person.avatarDataUrl" alt="" />
          <span v-else>{{ initial(e.person) }}</span>
        </span>
        <div class="prv__said">
          <p class="prv__line">
            <b>{{ e.person?.login ?? "someone" }}</b>
            <span class="prv__when">{{ e.relative }}</span>
          </p>
          <div v-if="e.body" class="prv__saidbody selectable">
            <MarkdownMessage :source="e.body" historical />
          </div>
        </div>
      </template>

      <!-- the end -->
      <template v-else-if="e.kind === 'merged'">
        <i class="prv__node prv__node--merged" />
        <p class="prv__line">
          <b>{{ e.person?.login ?? "someone" }}</b>{{ " " }}merged it
          <span class="prv__when">{{ prDate(e.at) }}</span>
        </p>
      </template>
      <template v-else>
        <i class="prv__node prv__node--closed" />
        <p class="prv__line">
          Closed <span class="prv__when">{{ prDate(e.at) }}</span>
        </p>
      </template>
    </li>
  </ol>
  </GitSpacePullRequestSection>
  </div>
</template>

<style scoped>
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
/* ── conversation ─────────────────────────────────────────────────────────── */
.prv__description {
  max-width: 74ch;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--ink-soft);
}

/* The rail: one hairline down the gutter, a node or a face at every event. */
.prv__rail {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 22px;
  margin-top: 0;
  padding: 0;
  list-style: none;
}
.prv__activity { margin-top: 44px; }
.prv__rail::before {
  content: "";
  position: absolute;
  left: 13px;
  top: 8px;
  bottom: 8px;
  width: 1px;
  background-color: color-mix(in srgb, var(--ink) 11%, transparent);
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
.prv__node--merged {
  background-color: var(--ink-soft);
}
.prv__node--closed {
  background-color: var(--danger);
}
.prv__line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--muted);
}
.prv__line b {
  font-weight: 500;
  color: var(--ink);
}
.prv__when {
  font-size: 12px;
  color: var(--muted);
}
.prv__stale {
  font-size: 12px;
  font-style: italic;
  color: var(--muted);
}
.prv__verdict {
  color: var(--ink-soft);
}
.prv__verdict--approved {
  color: var(--ok);
}
.prv__verdict--changes-requested {
  color: var(--danger);
}
.prv__pushed {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.prv__pushed .prv__line {
  margin-bottom: 4px;
}
.prv__pushed-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  padding: 3px 8px;
  margin-left: -8px;
  border-radius: 7px;
  text-align: left;
  cursor: pointer;
}
.prv__pushed-row:hover {
  background-color: var(--hover);
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
.prv__said {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}
.prv__saidbody {
  max-width: 70ch;
  font-size: 13px;
  line-height: 1.65;
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
.prv__face--lg {
  width: 28px;
  height: 28px;
  font-size: 12px;
  box-shadow: 0 0 0 4px var(--ground);
}
.prv__face--ringed.prv__face--approved {
  box-shadow:
    0 0 0 2px var(--ground),
    0 0 0 4px var(--ok);
}
.prv__face--ringed.prv__face--changes-requested {
  box-shadow:
    0 0 0 2px var(--ground),
    0 0 0 4px var(--danger);
}
.prv__pushed-row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .prv__event {
    animation: none;
  }
}
</style>
