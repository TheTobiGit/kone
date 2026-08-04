<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Add01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { GitHubPullRequest } from "~/types/desktop";
import type { useGitSpace } from "~/composables/useGitSpace";

// Pull requests, without the round trip to a browser.
//
// This is the list: is it green, has anyone looked at it, is it still a draft —
// one line each, scannable, plus a composer for opening one from the branch
// you're already on. A row is a summary and stays a summary; clicking it steps
// into the pull request's own page, which has the description, the conversation,
// the checks and the patch. The link out to GitHub stays on every row, because
// merging and reviewing still happen there.

const props = defineProps<{ space: ReturnType<typeof useGitSpace> }>();

const emit = defineEmits<{ open: [number: number] }>();

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

/** Why the section can't show anything — null when it can. */
const blocked = computed<string | null>(() => {
  if (!origin.value) return "This project has no remote, so there's nothing to open a pull request against.";
  if (!origin.value.slug) return `${origin.value.fetchUrl} isn't a GitHub remote — pull requests live wherever that host keeps them.`;
  if (!gh.value) return null;
  if (!gh.value.installed) return "The GitHub CLI isn't installed. Install `gh` and this section fills itself in.";
  if (!gh.value.authenticated) return gh.value.message ?? "Run `gh auth login` in a terminal to connect your GitHub account.";
  return null;
});

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
  cue("toggle");
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
  cue("toggle");
  void props.space.loadPrs(next);
}

function checkout(pr: GitHubPullRequest) {
  cue("press");
  void props.space.checkoutPr(pr.number);
}
function open(url: string) {
  void props.space.openExternal(url);
}

const REVIEW: Record<string, string> = {
  approved: "approved",
  "changes-requested": "changes requested",
  "review-required": "review needed",
};
</script>

<template>
  <section class="gsp">
    <header class="gsp__head">
      <div class="gsp__filters">
        <button
          type="button"
          class="gsp__filter"
          :class="{ 'gsp__filter--on': space.prState.value === 'open' }"
          @click="setState('open')"
        >
          Open
        </button>
        <button
          type="button"
          class="gsp__filter"
          :class="{ 'gsp__filter--on': space.prState.value === 'all' }"
          @click="setState('all')"
        >
          All
        </button>
      </div>
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
          @click="cue('toggle'); draft = !draft"
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

    <p v-if="blocked" class="gsp__blocked">{{ blocked }}</p>

    <template v-else-if="space.prs.value.length">
      <div v-for="(pr, i) in space.prs.value" :key="pr.number" class="gsp__row" :style="{ '--i': i }">
        <!-- The summary is the way in: everything except the two actions is one
             target, so there's no small thing to aim at. -->
        <button
          type="button"
          class="gsp__main"
          :title="`Open #${pr.number}`"
          @click="cue('press'); emit('open', pr.number)"
        >
          <span class="gsp__num">#{{ pr.number }}</span>

          <span class="gsp__body">
            <!-- Title and state on one line: what it is, and how it's doing. The
                 facts underneath then get the full width of the row. -->
            <span class="gsp__line">
              <span class="gsp__prtitle">{{ pr.title }}</span>
              <span class="gsp__flags">
                <span v-if="pr.isDraft" class="gsp__flag">draft</span>
                <span v-else-if="pr.state === 'merged'" class="gsp__flag gsp__flag--merged">merged</span>
                <span v-else-if="pr.state === 'closed'" class="gsp__flag">closed</span>
                <span
                  v-if="pr.reviewDecision"
                  class="gsp__flag"
                  :class="{
                    'gsp__flag--ok': pr.reviewDecision === 'approved',
                    'gsp__flag--bad': pr.reviewDecision === 'changes-requested',
                  }"
                >
                  {{ REVIEW[pr.reviewDecision] }}
                </span>
                <!-- Checks are a dot: colour is the whole message, and it costs one
                     character instead of a word per row. -->
                <i
                  v-if="pr.checks !== 'none'"
                  class="gsp__checks"
                  :class="`gsp__checks--${pr.checks}`"
                  :title="`Checks ${pr.checks}`"
                />
              </span>
            </span>
            <span class="gsp__meta">
              <span class="gsp__branchref">{{ pr.branch }} → {{ pr.base }}</span>
              <span class="gsp__dim">{{ pr.author }}</span>
              <span class="gsp__dim">{{ pr.relative }}</span>
              <span v-if="pr.additions" class="gsp__add">+{{ pr.additions }}</span>
              <span v-if="pr.deletions" class="gsp__del">−{{ pr.deletions }}</span>
              <span v-if="pr.comments" class="gsp__dim">{{ pr.comments }} comments</span>
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
          <!-- Named for where it goes, now that opening the pull request itself
               is what the row does. -->
          <button type="button" class="gsp__act gsp__act--go" @click="open(pr.url)">
            GitHub
            <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="11" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
      </div>
    </template>

    <p v-else-if="gh" class="gsp__empty">
      <template v-if="space.prState.value === 'open'">
        No open pull requests.
        <span class="gsp__empty-sub">Push a branch and open one from here.</span>
      </template>
      <template v-else>No pull requests on this repository yet.</template>
    </p>
  </section>
</template>

<style scoped>
.gsp {
  display: flex;
  flex-direction: column;
  padding-bottom: 12px;
}

.gsp__head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  margin-bottom: 10px;
  padding-inline: 8px;
}
.gsp__fill {
  flex: 1 1 auto;
}
.gsp__filters {
  display: flex;
  align-items: center;
  gap: 2px;
}
.gsp__filter {
  padding: 3px 7px;
  border-radius: 7px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gsp__filter:hover {
  background-color: var(--hover);
}
.gsp__filter--on {
  color: var(--ink);
}
.gsp__filter:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
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
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
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
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
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
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
  border-radius: 5px;
}

/* ── rows ─────────────────────────────────────────────────────────────────── */
.gsp__row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 46px;
  padding: 6px 8px;
  border-radius: 9px;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
  animation: gsp-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i), 7) * var(--gs-stagger));
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
.gsp__row:hover,
.gsp__row:focus-within {
  background-color: var(--hover);
}
/* The summary as one target. The row keeps the tint and the entrance; this just
   carries the layout the number and the two lines used to sit in directly. */
.gsp__main {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  cursor: pointer;
}
.gsp__main:focus-visible {
  outline: none;
  border-radius: 7px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.gsp__num {
  flex-shrink: 0;
  min-width: 5ch;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
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
  gap: 14px;
  min-width: 0;
}
.gsp__prtitle {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  letter-spacing: -0.1px;
  color: var(--ink);
}
.gsp__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
/* Drawn separators, so they can't be selected or wrap onto their own line. */
.gsp__meta > span + span::before {
  content: "·";
  margin-right: 10px;
  opacity: 0.5;
}
.gsp__branchref {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-soft);
}
.gsp__dim {
  white-space: nowrap;
  flex-shrink: 0;
}
.gsp__add {
  color: var(--diff-add);
}
.gsp__del {
  color: var(--diff-del);
}

.gsp__flags {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-shrink: 0;
}
.gsp__flag {
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
  color: var(--muted);
}
.gsp__flag--ok {
  color: var(--diff-add);
}
.gsp__flag--bad {
  color: var(--diff-del);
}
.gsp__flag--merged {
  color: var(--accent);
}
.gsp__checks {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--muted);
}
.gsp__checks--passing {
  background-color: var(--diff-add);
}
.gsp__checks--failing {
  background-color: var(--diff-del);
}
.gsp__checks--pending {
  background-color: var(--accent);
}

.gsp__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  flex-shrink: 0;
  min-width: 140px;
  opacity: 0;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.gsp__row:hover .gsp__actions,
.gsp__row:focus-within .gsp__actions {
  opacity: 1;
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
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.gsp__blocked,
.gsp__empty {
  padding: 2px 8px;
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

@media (prefers-reduced-motion: reduce) {
  .gsp__row,
  .gsp__composer {
    animation: none;
  }
  .gsp__row,
  .gsp__composer,
  .gsp__filter,
  .gsp__sweep,
  .gsp__create,
  .gsp__actions,
  .gsp__act {
    transition: none;
  }
}
</style>
