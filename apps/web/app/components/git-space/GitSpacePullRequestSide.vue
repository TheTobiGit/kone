<script setup lang="ts">
import { computed } from "vue";
import type {
  GitHubCheckCounts,
  GitHubPullRequestDetail,
  GitHubReviewer,
} from "~/types/desktop";
import { changeBar, checkDuration, prDate } from "~/utils/prFormat";
import { PR_STAND, prStandOf, type PrStand } from "~/utils/prStand";

// The open pull request's side column, answering the one question you open a
// pull request to ask: can this merge, and if not, what's in the way. A
// verdict, the checks as a ring with whatever isn't green listed under it, the
// reviewers as faces ringed in their verdict, and the size of the change drawn
// file by file.
//
// The verdict is the same rule the list's rows use (utils/prStand), so a row
// and its card always agree. The card owns the data and the tabs; this asks
// for a tab, a file or a link and lets the card do it, and puts its merge and
// close controls under the verdict through the `act` slot.

const props = defineProps<{
  pr: GitHubPullRequestDetail;
  checkCounts: GitHubCheckCounts;
  /** One face per person, as the card reads them. */
  reviewers: (GitHubReviewer & { stale: boolean })[];
  reviewSentence: string;
}>();

const emit = defineEmits<{
  tab: [tab: "checks" | "files"];
  showFile: [path: string];
  openUrl: [url: string];
}>();

// ── the verdict ──────────────────────────────────────────────────────────────

interface Verdict {
  word: string;
  why: string | null;
  tone: "ok" | "bad" | "warn" | "flat";
}

const TONE = {
  ready: "ok",
  review: "warn",
  running: "warn",
  checking: "warn",
  behind: "warn",
  blocked: "warn",
  changes: "bad",
  failing: "bad",
  conflict: "bad",
  draft: "flat",
  merged: "flat",
  closed: "flat",
} satisfies Record<PrStand, Verdict["tone"]>;

function whyOf(stand: PrStand): string | null {
  const p = props.pr;
  const c = props.checkCounts;
  switch (stand) {
    case "merged": {
      const when = p.mergedAt ? ` on ${prDate(p.mergedAt)}` : "";
      return p.mergedBy ? `${p.mergedBy.login} merged it${when}.` : null;
    }
    case "closed":
      return "Closed without merging.";
    case "draft":
      return "Not asking for review yet.";
    case "conflict":
      return `It conflicts with ${p.base}.`;
    case "failing":
      return `${plural(c.failing, "check")} failed.`;
    case "running":
      return `${plural(c.pending, "check")} still running.`;
    case "changes":
    case "review":
      return props.reviewSentence;
    case "blocked":
      return "A required check or review is missing.";
    case "behind":
      return `${p.base} has moved on since this branched.`;
    case "checking":
      return "GitHub hasn't worked out yet whether this can merge.";
    case "ready":
      return p.mergeability === "unstable"
        ? "It merges, but a check that isn't required is failing."
        : "Green, and nothing is in the way.";
  }
}

const verdict = computed<Verdict>(() => {
  const stand = prStandOf({
    ...props.pr,
    reviewers: props.reviewers,
    failingChecks: props.checkCounts.failing,
    pendingChecks: props.checkCounts.pending,
  });
  return { word: PR_STAND.get(stand)?.label ?? "", why: whyOf(stand), tone: TONE[stand] };
});

// ── checks ───────────────────────────────────────────────────────────────────

const checkBrief = computed(() => {
  const c = props.checkCounts;
  const parts: string[] = [];
  if (c.failing) parts.push(`${c.failing} failing`);
  if (c.pending) parts.push(`${c.pending} running`);
  if (c.passing) parts.push(`${c.passing} passing`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  return parts.join(" · ");
});
/** Anything not green, a few at most. */
const attention = computed(() => {
  const runs = props.pr.checkRuns;
  const failing = runs.filter((c) => c.state === "failing");
  const pending = runs.filter((c) => c.state === "pending");
  return [...failing, ...pending].slice(0, 4);
});

// ── files ────────────────────────────────────────────────────────────────────

const filePeak = computed(() => Math.max(1, ...props.pr.files.map((f) => f.additions + f.deletions)));
/** The biggest few files. */
const biggest = computed(() =>
  [...props.pr.files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions)).slice(0, 5),
);
function fileBar(f: { additions: number; deletions: number }, max: number) {
  return changeBar(f, filePeak.value, max);
}

function nameOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
</script>

<template>
  <aside class="prv__side">
    <div class="prv__block prv__verdictblock" style="--i: 0">
      <p class="prv__big" :class="`prv__big--${verdict.tone}`">
        <i class="prv__big-dot" />
        {{ verdict.word }}
      </p>
      <p v-if="verdict.why" class="prv__sub">{{ verdict.why }}</p>
      <!-- What can be done about it: the card fills this in. -->
      <slot name="act" />
    </div>

    <div v-if="pr.checkRuns.length" class="prv__block" style="--i: 1">
      <div class="prv__label">
        <span class="prv__label-name">Checks</span>
        <button type="button" class="prv__label-go" @click="emit('tab', 'checks')">All</button>
      </div>
      <div class="prv__ringrow">
        <GitSpaceChecksRing :counts="checkCounts" :size="52" :stroke="5" />
        <p class="prv__ringbrief">{{ checkBrief }}</p>
      </div>
      <div v-if="attention.length" class="prv__attn">
        <button
          v-for="c in attention"
          :key="`${c.workflow}/${c.name}`"
          type="button"
          class="prv__attn-row"
          :disabled="!c.url"
          :title="c.url ? 'Open this check on GitHub' : c.name"
          @click="c.url && emit('openUrl', c.url)"
        >
          <i class="prv__checkdot" :class="`prv__checkdot--${c.state}`" />
          <span class="prv__attn-name">{{ c.name }}</span>
          <span class="prv__dim">{{ checkDuration(c) }}</span>
        </button>
      </div>
    </div>

    <div class="prv__block" style="--i: 2">
      <div class="prv__label">
        <span class="prv__label-name">Reviews</span>
      </div>
      <GitSpaceReviewers v-if="reviewers.length" :reviewers="reviewers" :size="30" />
      <p class="prv__sub">{{ reviewSentence }}</p>
    </div>

    <div class="prv__block" style="--i: 3">
      <div class="prv__label">
        <span class="prv__label-name">Changes</span>
        <button type="button" class="prv__label-go" @click="emit('tab', 'files')">Files</button>
      </div>
      <p class="prv__changes">
        <span class="prv__add">+{{ pr.additions }}</span>
        <span class="prv__del">−{{ pr.deletions }}</span>
        <span class="prv__dim">{{ plural(pr.changedFiles, "file") }} · {{ plural(pr.commits.length, "commit") }}</span>
      </p>
      <div class="prv__sizes">
        <button
          v-for="(f, n) in biggest"
          :key="f.path"
          type="button"
          class="prv__size"
          :title="f.path"
          @click="emit('showFile', f.path)"
        >
          <span class="prv__size-name">{{ nameOf(f.path) }}</span>
          <span class="prv__size-track">
            <i class="prv__bar-add" :style="{ width: `${fileBar(f, 96).add}px`, '--n': n }" />
            <i class="prv__bar-del" :style="{ width: `${fileBar(f, 96).del}px`, '--n': n }" />
          </span>
        </button>
      </div>
    </div>

    <div v-if="pr.labels.length || pr.milestone || pr.assignees.length" class="prv__block" style="--i: 4">
      <div v-if="pr.labels.length" class="prv__tags">
        <span v-for="l in pr.labels" :key="l.name" class="prv__tag" :title="l.description ?? l.name">
          <i class="prv__dot" :style="{ backgroundColor: `#${l.color}` }" />{{ l.name }}
        </span>
      </div>
      <dl class="prv__facts">
        <template v-if="pr.assignees.length">
          <dt>Assigned</dt>
          <dd>{{ pr.assignees.map((a) => a.login).join(", ") }}</dd>
        </template>
        <template v-if="pr.milestone">
          <dt>Milestone</dt>
          <dd>{{ pr.milestone }}</dd>
        </template>
        <template v-if="pr.updatedAt">
          <dt>Updated</dt>
          <dd>{{ prDate(pr.updatedAt) }}</dd>
        </template>
      </dl>
    </div>
  </aside>
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
@keyframes prv-grow {
  from {
    transform: scaleX(0);
  }
}
@keyframes prv-pulse {
  50% {
    opacity: 0.35;
  }
}
.prv__side {
  display: flex;
  flex-direction: column;
  gap: 34px;
  min-width: 0;
  padding-bottom: 24px;
}
.prv__block {
  animation: prv-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(var(--i, 0) * var(--gs-stagger) * 3);
}
/* ── side ─────────────────────────────────────────────────────────────────── */
.prv__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 14px;
}
.prv__label-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.prv__label-go {
  margin-left: auto;
  padding: 2px 6px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
}
.prv__label-go:hover {
  color: var(--ink);
  background-color: var(--hover);
}
.prv__sub {
  margin-top: 12px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--muted);
}
.prv__big {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.4px;
  color: var(--ink);
}
.prv__big-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background-color: var(--muted);
}
.prv__big--ok .prv__big-dot {
  background-color: var(--ok);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 18%, transparent);
}
.prv__big--bad .prv__big-dot {
  background-color: var(--danger);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger) 16%, transparent);
}
.prv__big--warn .prv__big-dot {
  background-color: var(--warn);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--warn) 18%, transparent);
}
.prv__verdictblock .prv__sub {
  margin-top: 8px;
}
.prv__ringrow {
  display: flex;
  align-items: center;
  gap: 16px;
}
.prv__ringbrief {
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-soft);
}
.prv__attn {
  display: flex;
  flex-direction: column;
  margin-top: 12px;
}
.prv__attn-row {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 28px;
  padding: 0 6px;
  margin-inline: -6px;
  border-radius: 7px;
  text-align: left;
  cursor: pointer;
}
.prv__attn-row:hover:not(:disabled) {
  background-color: var(--hover);
}
.prv__attn-row:disabled {
  cursor: default;
}
.prv__attn-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.prv__changes {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
  font-family: var(--font-mono);
  font-size: 13px;
}
.prv__changes .prv__dim {
  font-family: var(--font-sans);
  font-size: 12.5px;
}
.prv__sizes {
  display: flex;
  flex-direction: column;
}
.prv__size {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 100px;
  align-items: center;
  gap: 10px;
  height: 26px;
  padding: 0 6px;
  margin-inline: -6px;
  border-radius: 7px;
  text-align: left;
  cursor: pointer;
}
.prv__size:hover {
  background-color: var(--hover);
}
.prv__size-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-soft);
}
.prv__size-track {
  display: flex;
  gap: 2px;
  height: 6px;
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
.prv__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-bottom: 14px;
}
.prv__tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.prv__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.prv__facts {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: 8px 10px;
  font-size: 12.5px;
}
.prv__facts dt {
  color: var(--muted);
}
.prv__facts dd {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--ink-soft);
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
/* Narrow panes put the verdict column above the story. */
@media (max-width: 1180px) {
  .prv__side {
    order: -1;
  }
}

.prv__label-go:focus-visible,
.prv__attn-row:focus-visible,
.prv__size:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .prv__block,
  .prv__bar-add,
  .prv__bar-del,
  .prv__checkdot--pending {
    animation: none;
  }
}
</style>
