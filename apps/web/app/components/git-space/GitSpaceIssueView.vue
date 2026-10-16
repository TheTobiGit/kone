<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowTurnBackwardIcon, ArrowUpRight01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import MarkdownMessage from "~/components/markdown/MarkdownMessage.vue";
import ModalShell from "~/components/ui/ModalShell.vue";
import { useModalExit } from "~/composables/useModalExit";
import { prDate } from "~/utils/prFormat";
import type { GitHubIssueCloseReason, GitHubIssueDetail, GitHubPerson } from "~/types/desktop";
import type { useGitSpace } from "~/composables/useGitSpace";

// One issue, in full, in a card over the list that opened it. It grows out of
// the clicked row and shrinks back into it, as a pull request does, so the list
// keeps its scroll and filters under the scrim. It mounts itself on the body
// and owns its entrance, exit and Escape; the opener unmounts it on `close`.
//
// Two columns. The main one is the issue as it was written and talked about:
// the description, then every comment on one rail, ending where it was closed,
// with a field to add the next one. The side column says where it stands and
// who has it: open or closed (and why), the way to close or reopen it, the
// people on it as faces, everyone who has spoken, and its labels and dates.

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

const issue = ref<GitHubIssueDetail | null>(null);
const loading = ref(true);
const refreshing = ref(false);

watch(
  () => props.number,
  async (number) => {
    loading.value = true;
    issue.value = null;
    const d = await props.space.issueDetail(number);
    // A different issue may have been opened while this was in flight.
    if (props.number !== number) return;
    issue.value = d;
    loading.value = false;
  },
  { immediate: true },
);

async function refresh() {
  // Never alongside an action, whose own re-read this older answer could undo.
  if (refreshing.value || busy.value) return;
  cue("press");
  refreshing.value = true;
  const number = props.number;
  const d = await props.space.issueDetail(number, true);
  if (props.number !== number) return;
  if (d) issue.value = d;
  refreshing.value = false;
}

const busy = computed(() => props.space.op.value !== null);
const myLogin = computed(() => props.space.me.value?.login ?? props.space.gh.value?.user ?? null);

// ── where it stands ──────────────────────────────────────────────────────────

const stand = computed(() => {
  const i = issue.value;
  if (!i) return null;
  if (i.state === "open") return { word: "Open", tone: "ok" as const };
  if (i.stateReason === "duplicate") return { word: "Duplicate", tone: "flat" as const };
  if (i.stateReason === "not-planned") return { word: "Not planned", tone: "flat" as const };
  return { word: "Done", tone: "done" as const };
});

const why = computed(() => {
  const i = issue.value;
  if (!i) return "";
  if (i.state === "open") {
    if (!i.assignees.length) return "Nobody has picked it up yet.";
    return `With ${names(i.assignees)}.`;
  }
  const when = i.closedAt ? ` on ${prDate(i.closedAt)}` : "";
  if (i.stateReason === "duplicate") return `Closed as a duplicate${when}.`;
  if (i.stateReason === "not-planned") return `Closed as not planned${when}.`;
  return `Closed as done${when}.`;
});

/** Closing and reopening are GitHub's to allow: anyone who can triage, and the
 *  person who opened it. */
const canAct = computed(() => {
  const i = issue.value;
  return Boolean(i && (i.canTriage || (myLogin.value && i.author?.login === myLogin.value)));
});

// ── who ──────────────────────────────────────────────────────────────────────

/** Everyone who has spoken, the author first, then in the order they joined. */
const participants = computed<GitHubPerson[]>(() => {
  const i = issue.value;
  if (!i) return [];
  const seen = new Map<string, GitHubPerson>();
  if (i.author) seen.set(i.author.login, i.author);
  for (const c of i.comments) if (c.author && !seen.has(c.author.login)) seen.set(c.author.login, c.author);
  return [...seen.values()];
});

/** How many comments each participant left, for the bars under their faces. */
const said = computed(() => {
  const by = new Map<string, number>();
  for (const c of issue.value?.comments ?? []) {
    if (c.author) by.set(c.author.login, (by.get(c.author.login) ?? 0) + 1);
  }
  return by;
});
const saidPeak = computed(() => Math.max(1, ...said.value.values()));

// ── acting ───────────────────────────────────────────────────────────────────

type Pending = "done" | "not-planned" | "reopen";
const pending = ref<Pending | null>(null);
const actError = ref<string | null>(null);
const commentError = ref<string | null>(null);

async function act(what: Pending) {
  if (busy.value || refreshing.value) return;
  cue("press");
  pending.value = what;
  actError.value = null;
  const number = props.number;
  const reason: GitHubIssueCloseReason | undefined =
    what === "reopen" ? undefined : what === "done" ? "completed" : "not-planned";
  const ok = await props.space.issueAction(number, what === "reopen" ? "reopen" : "close", reason);
  pending.value = null;
  if (props.number !== number) return;
  if (!ok) {
    cue("error");
    actError.value = props.space.error.value;
    return;
  }
  cue("success");
  const d = await props.space.issueDetail(number);
  if (d && props.number === number) issue.value = d;
}

async function sendComment(body: string): Promise<boolean> {
  commentError.value = null;
  const number = props.number;
  const ok = await props.space.commentOnIssue(number, body);
  if (props.number !== number) return ok;
  if (!ok) {
    commentError.value = props.space.error.value;
    return false;
  }
  const d = await props.space.issueDetail(number);
  if (d) issue.value = d;
  return true;
}

// Moving to another issue clears what the last one said.
watch(
  () => props.number,
  () => {
    actError.value = null;
    commentError.value = null;
  },
);

function openOnGitHub() {
  if (issue.value) void props.space.openExternal(issue.value.url);
}

// ── words ────────────────────────────────────────────────────────────────────

function initial(p: GitHubPerson | null) {
  return (p?.name || p?.login || "")[0]?.toUpperCase() ?? "";
}
function nameOf(p: GitHubPerson) {
  return p.login === myLogin.value ? "you" : p.login;
}
function names(people: GitHubPerson[]): string {
  return people.map(nameOf).join(", ");
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ── the card ──────────────────────────────────────────────────────────────────
const INSET = 20;
const MAX_WIDTH = 1240;

// Grow from the clicked row's centre, in the card's own coordinates: it sits
// INSET down from the window's top, centred across it.
const originStyle = computed(() => {
  const vars: Record<string, string> = { "--ism-inset": `${INSET}px`, "--ism-max": `${MAX_WIDTH}px` };
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
// nothing behind it.
function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  onClose();
}

const backEl = ref<HTMLButtonElement | null>(null);
// The row that opened the card, so focus goes back to it on close.
let opener: HTMLElement | null = null;

// Tab stays inside the card: the app behind it goes inert while it's open, the
// way a native modal dialog would, and whatever inert it had is put back.
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
        class="ism"
        :style="originStyle"
        role="dialog"
        aria-modal="true"
        :aria-label="issue?.title ?? `Issue #${number}`"
      >
        <article class="isv">
          <!-- ── head ─────────────────────────────────────────────────────── -->
          <header class="isv__head">
            <button
              ref="backEl"
              type="button"
              class="isv__back"
              aria-label="Back to issues"
              title="Back to issues"
              @click="onClose"
            >
              <HugeiconsIcon
                class="isv__back-glyph"
                :icon="ArrowTurnBackwardIcon"
                :size="18"
                :stroke-width="2"
                aria-hidden="true"
              />
            </button>

            <div class="isv__identity">
              <p class="isv__eyebrow">
                <span v-if="stand" class="isv__state" :class="`isv__state--${stand.tone}`">{{ stand.word }}</span>
                <span>#{{ number }}</span>
              </p>
              <h1 class="isv__title">{{ issue?.title ?? "Issue" }}</h1>
              <p v-if="issue" class="isv__note">
                <span class="isv__author">
                  <span class="isv__face" aria-hidden="true">
                    <img v-if="issue.author?.avatarDataUrl" :src="issue.author.avatarDataUrl" alt="" />
                    <span v-else>{{ initial(issue.author) }}</span>
                  </span>
                  {{ issue.author?.login ?? "someone" }}
                </span>
                <span>opened {{ issue.relative }}</span>
                <span>{{ plural(issue.comments.length, "comment") }}</span>
              </p>
            </div>

            <div class="isv__actions">
              <button
                type="button"
                class="isv__btn"
                :class="{ 'isv__btn--spin': refreshing }"
                title="Re-read this issue"
                aria-label="Re-read this issue"
                :disabled="busy"
                @click="refresh"
              >
                <HugeiconsIcon class="isv__refresh" :icon="RefreshIcon" :size="12" :stroke-width="2" aria-hidden="true" />
              </button>
              <button v-if="issue" type="button" class="isv__btn" @click="openOnGitHub">
                GitHub
                <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
              </button>
            </div>
          </header>

          <!-- ── page ─────────────────────────────────────────────────────── -->
          <div class="isv__scroll">
            <GitSpaceSkeleton v-if="loading" variant="prose" />

            <p v-else-if="!issue" class="isv__empty">
              This issue couldn't be read. The GitHub CLI may not be signed in.
            </p>

            <div v-else class="isv__cols">
              <!-- ══ the main column: what was said ═════════════════════════ -->
              <div class="isv__main">
                <div v-if="issue.body" class="isv__description selectable">
                  <MarkdownMessage :source="issue.body" historical />
                </div>
                <p v-else class="isv__nodesc">No description.</p>

                <ol class="isv__rail">
                  <li class="isv__event" style="--i: 0">
                    <i class="isv__node" />
                    <p class="isv__line">
                      <b>{{ issue.author?.login ?? "someone" }}</b>{{ " " }}opened this
                      <span class="isv__when">{{ issue.relative }}</span>
                    </p>
                  </li>
                  <li
                    v-for="(c, i) in issue.comments"
                    :key="`${c.createdAt}:${i}`"
                    class="isv__event"
                    :style="{ '--i': i + 1 }"
                  >
                    <span class="isv__face isv__face--lg" aria-hidden="true">
                      <img v-if="c.author?.avatarDataUrl" :src="c.author.avatarDataUrl" alt="" />
                      <span v-else>{{ initial(c.author) }}</span>
                    </span>
                    <div class="isv__said">
                      <p class="isv__line">
                        <b>{{ c.author?.login ?? "someone" }}</b>
                        <span class="isv__when">{{ c.relative }}</span>
                      </p>
                      <div v-if="c.body" class="isv__saidbody selectable">
                        <MarkdownMessage :source="c.body" historical />
                      </div>
                    </div>
                  </li>
                  <li
                    v-if="issue.state === 'closed'"
                    class="isv__event"
                    :style="{ '--i': issue.comments.length + 1 }"
                  >
                    <span class="isv__endmark">
                      <GitSpaceIssueGlyph :issue="issue" :size="16" />
                    </span>
                    <p class="isv__line">
                      {{ why }}
                    </p>
                  </li>
                </ol>

                <GitSpacePullRequestComment
                  :busy="busy || refreshing"
                  :send="sendComment"
                  :error="commentError"
                  label="Comment on this issue"
                />
              </div>

              <!-- ══ the side column: where it stands, who has it ═══════════ -->
              <aside class="isv__side">
                <div class="isv__block" style="--i: 0">
                  <p class="isv__big">
                    <GitSpaceIssueGlyph :issue="issue" :size="20" />
                    {{ stand?.word }}
                  </p>
                  <p class="isv__sub isv__sub--tight">{{ why }}</p>

                  <div v-if="canAct" class="isv__do">
                    <template v-if="issue.state === 'open'">
                      <button type="button" class="isv__main-act" :disabled="busy || refreshing" @click="act('done')">
                        {{ pending === "done" ? "Closing…" : "Close as done" }}
                      </button>
                      <button type="button" class="isv__quiet" :disabled="busy || refreshing" @click="act('not-planned')">
                        {{ pending === "not-planned" ? "Closing…" : "Close as not planned" }}
                      </button>
                    </template>
                    <button
                      v-else
                      type="button"
                      class="isv__main-act isv__main-act--soft"
                      :disabled="busy || refreshing"
                      @click="act('reopen')"
                    >
                      {{ pending === "reopen" ? "Reopening…" : "Reopen" }}
                    </button>
                  </div>
                  <p v-if="actError" class="isv__error" role="alert">{{ actError }}</p>
                </div>

                <div class="isv__block" style="--i: 1">
                  <div class="isv__label">
                    <span class="isv__label-name">Assigned</span>
                    <span v-if="issue.assignees.length" class="isv__label-count">{{ issue.assignees.length }}</span>
                  </div>
                  <ul v-if="issue.assignees.length" class="isv__people">
                    <li v-for="a in issue.assignees" :key="a.login" class="isv__person">
                      <span class="isv__face isv__face--md" aria-hidden="true">
                        <img v-if="a.avatarDataUrl" :src="a.avatarDataUrl" alt="" />
                        <span v-else>{{ initial(a) }}</span>
                      </span>
                      <span class="isv__person-name">
                        {{ nameOf(a) }}
                        <span v-if="a.name && a.name !== a.login" class="isv__dim">{{ a.name }}</span>
                      </span>
                    </li>
                  </ul>
                  <p v-else class="isv__person">
                    <i class="isv__nobody" aria-hidden="true" />
                    <span class="isv__person-name isv__dim">Nobody yet</span>
                  </p>
                </div>

                <div class="isv__block" style="--i: 2">
                  <div class="isv__label">
                    <span class="isv__label-name">Who's talking</span>
                    <span class="isv__label-count">{{ participants.length }}</span>
                  </div>
                  <div class="isv__voices">
                    <div v-for="(p, n) in participants" :key="p.login" class="isv__voice">
                      <span class="isv__face isv__face--md" aria-hidden="true">
                        <img v-if="p.avatarDataUrl" :src="p.avatarDataUrl" alt="" />
                        <span v-else>{{ initial(p) }}</span>
                      </span>
                      <span class="isv__voice-name" :title="p.login">{{ nameOf(p) }}</span>
                      <span class="isv__voice-track">
                        <i
                          class="isv__voice-fill"
                          :style="{ width: `${((said.get(p.login) ?? 0) / saidPeak) * 100}%`, '--n': n }"
                        />
                      </span>
                      <span class="isv__count">{{ said.get(p.login) ?? 0 }}</span>
                    </div>
                  </div>
                  <p class="isv__sub">
                    <template v-if="issue.comments.length">
                      {{ plural(issue.comments.length, "comment") }} from
                      {{ said.size === 1 ? "one person" : `${said.size} people` }}.
                    </template>
                    <template v-else>Nobody has commented yet.</template>
                  </p>
                </div>

                <div class="isv__block" style="--i: 3">
                  <div v-if="issue.labels.length" class="isv__tags">
                    <span v-for="l in issue.labels" :key="l.name" class="isv__tag" :title="l.description ?? l.name">
                      <i class="isv__dot" :style="{ backgroundColor: `#${l.color}` }" />{{ l.name }}
                    </span>
                  </div>
                  <dl class="isv__facts">
                    <template v-if="issue.milestone">
                      <dt>Milestone</dt>
                      <dd>{{ issue.milestone }}</dd>
                    </template>
                    <dt>Opened</dt>
                    <dd>{{ prDate(issue.createdAt) }}</dd>
                    <template v-if="issue.updatedAt">
                      <dt>Updated</dt>
                      <dd>{{ prDate(issue.updatedAt) }}</dd>
                    </template>
                    <template v-if="issue.closedAt">
                      <dt>Closed</dt>
                      <dd>{{ prDate(issue.closedAt) }}</dd>
                    </template>
                    <template v-if="issue.isPinned">
                      <dt>Pinned</dt>
                      <dd>To the repository</dd>
                    </template>
                  </dl>
                </div>
              </aside>
            </div>
          </div>
        </article>
      </div>
    </ModalShell>
  </Teleport>
</template>

<style scoped>
/* The card is teleported out of the space, so the space's motion vocabulary
   doesn't reach it by inheritance; it carries its own copy, as the pull
   request card does. */
.ism {
  --gs-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --gs-t-micro: 140ms;
  --gs-t-small: 220ms;
  --gs-t-enter: 320ms;
  --gs-stagger: 22ms;
  --gs-enter-panel: 160ms;
  position: absolute;
  inset: var(--ism-inset, 20px) 0;
  width: min(var(--ism-max, 1240px), calc(100% - 2 * var(--ism-inset, 20px)));
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
.ism.is-in {
  animation: ism-grow 460ms cubic-bezier(0.34, 1.3, 0.64, 1) backwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
.ism.is-out {
  animation: ism-shrink var(--modal-exit) cubic-bezier(0.4, 0, 0.9, 1) forwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
@keyframes ism-grow {
  from { opacity: 0.35; transform: scale(0.16); }
  60% { opacity: 1; }
}
@keyframes ism-shrink {
  to { opacity: 0; transform: scale(0.16); }
}
@keyframes isv-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes isv-grow {
  from {
    transform: scaleX(0);
  }
}

.isv {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  padding: 34px 40px 0;
}

/* ── head ─────────────────────────────────────────────────────────────────── */
.isv__head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex-shrink: 0;
  animation: isv-in var(--gs-t-enter) var(--gs-ease) backwards;
}
.isv__back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--ink-soft);
  opacity: 0.8;
  cursor: pointer;
  transition:
    opacity var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.isv__back:hover,
.isv__back:focus-visible {
  outline: none;
  opacity: 1;
  color: var(--ink);
}
.isv__back:focus-visible {
  border-radius: 8px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.isv__back-glyph {
  transform: rotate(180deg) scaleX(-1);
}
.isv__identity {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  flex: 1 1 auto;
}
.isv__eyebrow {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  color: var(--muted);
}
.isv__state {
  padding: 3px 7px;
  border-radius: 6px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  background-color: var(--hover);
  color: var(--ink-soft);
}
.isv__state--ok {
  color: var(--ok);
  background-color: color-mix(in srgb, var(--ok) 10%, transparent);
}
.isv__state--done {
  color: var(--accent-2);
  background-color: color-mix(in srgb, var(--accent-2) 10%, transparent);
}
.isv__title {
  font-size: 26px;
  font-weight: 500;
  letter-spacing: -0.6px;
  line-height: 1.2;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.isv__note {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 12.5px;
  color: var(--muted);
}
.isv__author {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--ink-soft);
}
.isv__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.isv__btn {
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
.isv__btn:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.isv__btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.isv__btn--spin .isv__refresh {
  animation: isv-spin 900ms linear infinite;
}
@keyframes isv-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── page ─────────────────────────────────────────────────────────────────── */
.isv__scroll {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  margin-top: 34px;
  padding-left: 34px;
  /* Room for the side column's focus rings; the negative margin keeps the
     column's edge where it was. */
  padding-right: 8px;
  margin-right: -4px;
  padding-bottom: 40px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 14%, transparent) transparent;
  animation: isv-in var(--gs-t-enter) var(--gs-ease) var(--gs-enter-panel) backwards;
}
.isv__cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 64px;
  align-items: start;
}
.isv__main {
  min-width: 0;
}
.isv__empty,
.isv__nodesc {
  font-size: 13px;
  color: var(--ink-soft);
}
.isv__description {
  max-width: 74ch;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--ink-soft);
}

/* The rail: one hairline down the gutter, a node or a face at every event. */
.isv__rail {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 22px;
  margin-top: 44px;
  padding: 0;
  list-style: none;
}
.isv__rail::before {
  content: "";
  position: absolute;
  left: 13px;
  top: 8px;
  bottom: 8px;
  width: 1px;
  background-color: color-mix(in srgb, var(--ink) 11%, transparent);
}
.isv__event {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 14px;
  min-width: 0;
  animation: isv-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger));
}
.isv__node {
  position: relative;
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  margin: 4px 9.5px 0;
  border-radius: 50%;
  background-color: var(--ok);
  box-shadow: 0 0 0 4px var(--panel);
}
.isv__endmark {
  display: flex;
  flex-shrink: 0;
  margin: 1px 6px 0;
  border-radius: 50%;
  background-color: var(--panel);
  box-shadow: 0 0 0 4px var(--panel);
}
.isv__line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--ink-soft);
}
.isv__line b {
  font-weight: 500;
  color: var(--ink);
}
.isv__when {
  font-size: 12px;
  color: var(--muted);
}
.isv__said {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}
.isv__saidbody {
  max-width: 70ch;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-soft);
}
.isv__face {
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
  color: var(--ink-soft);
}
.isv__face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.isv__face--md {
  width: 24px;
  height: 24px;
  font-size: 11px;
}
.isv__face--lg {
  width: 28px;
  height: 28px;
  font-size: 12px;
  box-shadow: 0 0 0 4px var(--panel);
}

/* ── side ─────────────────────────────────────────────────────────────────── */
.isv__side {
  display: flex;
  flex-direction: column;
  gap: 34px;
  min-width: 0;
  padding-bottom: 24px;
}
.isv__block {
  animation: isv-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(var(--i, 0) * var(--gs-stagger) * 3);
}
.isv__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 14px;
}
.isv__label-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.isv__label-count,
.isv__count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.isv__sub {
  margin-top: 12px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink-soft);
}
.isv__sub--tight {
  margin-top: 8px;
}
.isv__big {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.4px;
  color: var(--ink);
}
.isv__do {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 16px;
}
.isv__main-act {
  height: 30px;
  padding-inline: 14px;
  border-radius: 9px;
  background-color: var(--ink);
  color: var(--ground);
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.isv__main-act:hover:not(:disabled) {
  opacity: 0.88;
}
.isv__main-act--soft {
  background-color: var(--hover);
  color: var(--ink);
}
.isv__quiet {
  height: 28px;
  padding-inline: 8px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.isv__quiet:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.isv__main-act:disabled,
.isv__quiet:disabled {
  opacity: 0.4;
  cursor: default;
}
.isv__error {
  margin: 10px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--danger);
}
.isv__people {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.isv__person {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.isv__person-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  font-size: 13px;
  color: var(--ink);
}
.isv__nobody {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1.5px dashed color-mix(in srgb, var(--ink) 30%, transparent);
}
.isv__dim {
  font-size: 12px;
  color: var(--ink-soft);
}
.isv__voices {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.isv__voice {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
}
.isv__voice-name {
  width: 84px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.isv__voice-track {
  flex: 1 1 auto;
  height: 6px;
}
.isv__voice-fill {
  display: block;
  height: 100%;
  min-width: 0;
  border-radius: 3px;
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
  transform-origin: left center;
  animation: isv-grow 600ms var(--gs-ease) backwards;
  animation-delay: calc(300ms + var(--n, 0) * 60ms);
}
.isv__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-bottom: 14px;
}
.isv__tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.isv__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.isv__facts {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: 8px 10px;
  margin: 0;
  font-size: 12.5px;
}
.isv__facts dt {
  color: var(--ink-soft);
}
.isv__facts dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--ink);
}

.isv__btn:focus-visible,
.isv__main-act:focus-visible,
.isv__quiet:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.isv__main-act:focus-visible {
  box-shadow: 0 0 0 2px var(--panel), 0 0 0 4px color-mix(in srgb, var(--ink) 55%, transparent);
}

/* Narrow panes put where it stands above what was said. */
@media (max-width: 1180px) {
  .isv__cols {
    grid-template-columns: minmax(0, 1fr);
  }
  .isv__side {
    order: -1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ism.is-in,
  .ism.is-out {
    animation-duration: 0.01s;
  }
  .isv__head,
  .isv__scroll,
  .isv__event,
  .isv__block,
  .isv__voice-fill,
  .isv__btn--spin .isv__refresh {
    animation: none;
  }
  .isv__back,
  .isv__btn,
  .isv__main-act,
  .isv__quiet {
    transition: none;
  }
}
</style>
