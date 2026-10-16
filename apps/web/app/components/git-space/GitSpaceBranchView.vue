<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowTurnBackwardIcon, Copy01Icon, FolderLibraryIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import ModalShell from "~/components/ui/ModalShell.vue";
import HoldToConfirm from "~/components/ui/HoldToConfirm.vue";
import { useModalExit } from "~/composables/useModalExit";
import type { GitBranch, GitBranchCompare } from "~/types/desktop";
import type { useGitSpace } from "~/composables/useGitSpace";
import {
  STANDINGS,
  branchNameProblem,
  daysSince,
  isDirtyRefusal,
  localNameOf,
  spokenAge,
  standing,
} from "~/utils/branchStanding";

// One branch, in a card over the list that opened it. It grows out of the
// clicked row and shrinks back into it, as a pull request and an issue do.
//
// Two columns. The main one is what the branch is: how far it has drifted
// from the default branch, drawn as two bars from the point they split, and
// the commits that are its own. The side column is what you can do with it:
// how it stands with its remote and the push or pull that settles that, then
// renaming it, and the two deletes, each behind a hold.

const props = defineProps<{
  space: ReturnType<typeof useGitSpace>;
  /** The branch as the list had it; the card follows the live copy. */
  branch: GitBranch;
  origin: DOMRect | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { cue } = useSound();

const busy = computed(() => props.space.op.value !== null);
/** The live branch: the list reloads under the card after every action. */
const live = computed(
  () =>
    props.space.branches.value.find((b) => b.name === props.branch.name && b.remote === props.branch.remote) ??
    null,
);
const b = computed(() => live.value ?? props.branch);
const current = computed(() => props.space.branches.value.find((x) => x.current) ?? null);
const remoteNames = computed(() => props.space.remotes.value.map((r) => r.name));
const defaultName = computed(
  () => props.space.branches.value.find((x) => !x.remote && x.default)?.name ?? "main",
);

// Deleted, from here or anywhere else: there is nothing left to show.
watch(live, (now, before) => {
  if (before && !now) onClose();
});

// ── against the default branch ───────────────────────────────────────────────

const compare = ref<GitBranchCompare | null>(null);
const loading = ref(true);

async function readCompare() {
  const { name, remote } = props.branch;
  const next = await props.space.branchCompare(name, remote);
  if (props.branch.name !== name) return;
  compare.value = next;
  loading.value = false;
}
// Either tip moving (a push, a pull, a merge into the default) changes what
// is its own.
const baseTips = computed(() =>
  props.space.branches.value
    .filter((x) => x.default)
    .map((x) => x.sha ?? "")
    .join(" "),
);
watch(() => `${b.value.sha} ${baseTips.value}`, readCompare, { immediate: true });

const drift = computed(() => {
  const c = compare.value;
  if (!c || c.base === null) return null;
  const peak = Math.max(1, c.ahead, c.behind);
  return { ...c, aheadPart: c.ahead / peak, behindPart: c.behind / peak };
});

// ── with its remote ──────────────────────────────────────────────────────────

const stand = computed(() => (b.value.remote ? null : standing(b.value)));
const standInfo = computed(() => STANDINGS.find((s) => s.id === stand.value) ?? null);
const standSentence = computed(() => {
  const x = b.value;
  switch (stand.value) {
    case "unpushed":
      return trackable.value
        ? `Not tracking anything, though ${trackable.value} exists. Tracking it keeps the two in step.`
        : hasRemote.value
          ? `Only on this machine. Publishing puts it on ${remote.value} and keeps the two in step.`
          : "Only on this machine. This repo has no remote to publish it to.";
    case "gone":
      return x.merged
        ? `${x.upstream} was deleted on the remote, and its work is in ${defaultName.value}. It can go.`
        : `${x.upstream} was deleted on the remote, with work on it that ${defaultName.value} doesn't have.`;
    case "even":
      return `In step with ${x.upstream}.`;
    case "ahead":
      return `${plural(x.ahead ?? 0, "commit")} here that ${x.upstream} doesn't have.`;
    case "behind":
      return `${x.upstream} has ${plural(x.behind ?? 0, "commit")} this doesn't.`;
    case "both":
      return `${plural(x.ahead ?? 0, "commit")} to push and ${x.behind} to pull. Pull first, then push.`;
    default:
      return "";
  }
});
/** A local-only repo has nowhere to publish to. */
const hasRemote = computed(() => props.space.origin.value !== null);
/** The remote a publish goes to: origin, or the only one there is. */
const remote = computed(() => props.space.origin.value?.name ?? "origin");
/** <remote>/<same name>: the push and publish below can name it plainly. */
const sameNamedUpstream = computed(
  () => !b.value.upstream || localNameOf(b.value.upstream, remoteNames.value) === b.value.name,
);

async function run(task: () => Promise<boolean>) {
  if (busy.value) return cue("refuse");
  cue("press");
  cue((await task()) ? "success" : "error");
}
function publish() {
  void run(() => props.space.push({ branch: b.value.name, setUpstream: true, remote: remote.value }));
}
function pushIt() {
  void run(() =>
    b.value.current ? props.space.push() : props.space.push({ branch: b.value.name }),
  );
}
function pull() {
  // The branch you're on pulls; any other moves forward without a switch.
  void run(() => (b.value.current ? props.space.pull() : props.space.fastForward(b.value.name)));
}
/** A same-named branch on origin that this one could track instead of
 *  being published over it. */
const trackable = computed(() => {
  if (b.value.remote || b.value.upstream) return null;
  const ref = `${remote.value}/${b.value.name}`;
  return props.space.branches.value.some((x) => x.remote && x.name === ref) ? ref : null;
});
function track() {
  const ref = trackable.value;
  if (ref) void run(() => props.space.setUpstream(b.value.name, ref));
}

/** The switch git refused because uncommitted work is in the way. */
const blocked = ref(false);
async function switchTo() {
  if (busy.value) return cue("refuse");
  cue("press");
  blocked.value = false;
  // A remote branch becomes a local one that tracks it, or switches to the
  // local one of that name; the desktop side picks.
  const ok = await props.space.switchBranch(b.value.name);
  cue(ok ? "success" : "error");
  if (!ok && isDirtyRefusal(props.space.error.value)) blocked.value = true;
}
function carry() {
  blocked.value = false;
  void run(() => props.space.switchCarrying(b.value.name));
}

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyName() {
  try {
    await navigator.clipboard.writeText(b.value.name);
  } catch {
    return cue("error");
  }
  cue("press");
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = false), 1600);
}
function merge() {
  void run(() => props.space.mergeBranch(b.value.name));
}
/** A remote branch already checked out under its own name is a switch. */
const localTwin = computed(() =>
  b.value.remote ? props.space.branches.value.find((x) => !x.remote && x.name === localNameOf(b.value.name, remoteNames.value)) : null,
);

// ── rename ───────────────────────────────────────────────────────────────────

const renaming = ref(false);
const renameTo = ref("");
const renameEl = ref<HTMLInputElement | null>(null);
const renameProblem = computed(() => {
  const to = renameTo.value.trim();
  if (to === b.value.name) return null;
  if (props.space.branches.value.some((x) => !x.remote && x.name === to)) return `${to} already exists.`;
  return branchNameProblem(to);
});
async function startRename() {
  cue("expand");
  renaming.value = true;
  renameTo.value = b.value.name;
  await nextTick();
  renameEl.value?.select();
}
async function submitRename() {
  const to = renameTo.value.trim();
  if (!to || to === b.value.name) return void (renaming.value = false);
  if (busy.value || renameProblem.value) return cue("refuse");
  cue("press");
  const from = b.value.name;
  const ok = await props.space.renameBranch(from, to);
  cue(ok ? "success" : "error");
  // The card was for the old name; it has nothing to follow now.
  if (ok) onClose();
}

// ── delete ───────────────────────────────────────────────────────────────────

const canDelete = computed(() => !b.value.remote && !b.value.current && !b.value.worktree);
/** Its own commits, when the default branch doesn't have them all. */
const unmerged = computed(() => (!b.value.merged && drift.value ? drift.value.ahead : 0));
function removeLocal() {
  cue("discard");
  // Plain -d measures against HEAD and the upstream, not the default branch,
  // so it can refuse a branch that is in main. Forced when it is known to be
  // in main, or when the hold, with the count of what goes, is the consent.
  const force = !!b.value.merged || unmerged.value > 0;
  void props.space.deleteBranch(b.value.name, force ? { force: true } : undefined);
}
/** The branch on the remote, for a local one that tracks it or a remote ref. */
const remoteName = computed(() => {
  if (b.value.remote) return b.value.name;
  if (!b.value.upstream || b.value.gone) return null;
  return b.value.upstream;
});
function removeRemote() {
  cue("discard");
  // The full "remote/branch", so a branch on a remote other than origin is
  // deleted where it lives.
  if (remoteName.value) void props.space.deleteBranch(remoteName.value, { remote: true });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ── the card ──────────────────────────────────────────────────────────────────
const INSET = 20;
const MAX_WIDTH = 1080;

const originStyle = computed(() => {
  const vars: Record<string, string> = { "--bsm-inset": `${INSET}px`, "--bsm-max": `${MAX_WIDTH}px` };
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
function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  // Escape in the rename field backs out of the rename, not the card.
  if (renaming.value) {
    renaming.value = false;
    return;
  }
  onClose();
}

const backEl = ref<HTMLButtonElement | null>(null);
let opener: HTMLElement | null = null;
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
        class="bsm"
        :style="originStyle"
        role="dialog"
        aria-modal="true"
        :aria-label="`Branch ${b.name}`"
      >
        <article class="bsv">
          <!-- ── head ─────────────────────────────────────────────────────── -->
          <header class="bsv__head">
            <button
              ref="backEl"
              type="button"
              class="bsv__back"
              aria-label="Back to branches"
              title="Back to branches"
              @click="onClose"
            >
              <HugeiconsIcon
                class="bsv__back-glyph"
                :icon="ArrowTurnBackwardIcon"
                :size="18"
                :stroke-width="2"
                aria-hidden="true"
              />
            </button>

            <div class="bsv__identity">
              <div class="bsv__eyebrow">
                <span class="bsv__state" :class="{ 'bsv__state--on': b.current }">
                  {{ b.current ? "You're on it" : b.remote ? "On the remote" : "Local" }}
                </span>
                <span v-if="b.default">default branch</span>
                <span v-else-if="b.merged">in {{ defaultName }}</span>
                <span v-if="b.sha">{{ b.sha.slice(0, 7) }}</span>
              </div>

              <form v-if="renaming" class="bsv__rename" @submit.prevent="submitRename">
                <input
                  ref="renameEl"
                  v-model="renameTo"
                  class="bsv__title bsv__title--field"
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                  aria-label="New name"
                  :aria-invalid="!!renameProblem"
                  aria-describedby="bsv-rename-hint"
                  :disabled="busy"
                />
                <span id="bsv-rename-hint" class="bsv__hint" :class="{ 'bsv__hint--bad': renameProblem }" aria-live="polite">
                  {{ renameProblem ?? "Enter to rename, Escape to keep it." }}
                </span>
              </form>
              <div v-else class="bsv__titlerow">
                <h2 class="bsv__title">{{ b.name }}</h2>
                <button
                  type="button"
                  class="bsv__copy"
                  :aria-label="copied ? 'Copied' : 'Copy the branch name'"
                  :title="copied ? 'Copied' : 'Copy the branch name'"
                  @click="copyName"
                >
                  <HugeiconsIcon :icon="copied ? Tick02Icon : Copy01Icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
                </button>
                <span class="sr-only" aria-live="polite">{{ copied ? "Copied" : "" }}</span>
              </div>

              <p v-if="b.subject" class="bsv__note">
                <span class="bsv__subject">{{ b.subject }}</span>
                <span v-if="b.author">{{ b.author }}</span>
                <span v-if="b.date">{{ spokenAge(daysSince(b)) }}</span>
              </p>
            </div>

            <div v-if="!b.current" class="bsv__actions">
              <button
                type="button"
                class="bsv__btn"
                :disabled="busy"
                :title="`Merge ${b.name} into ${current?.name ?? 'HEAD'}`"
                @click="merge"
              >
                Merge into {{ current?.name ?? "HEAD" }}
              </button>
              <button
                type="button"
                class="bsv__main-act"
                :disabled="busy || !!b.worktree"
                :title="b.worktree ? `Checked out in ${b.worktree}` : undefined"
                @click="switchTo"
              >
                {{ b.remote && !localTwin ? "Check out" : "Switch to it" }}
              </button>
            </div>
          </header>

          <p v-if="blocked" class="bsv__blocked" role="status">
            <span>Your uncommitted changes are in the way. Bring them along to {{ b.name }}?</span>
            <span class="bsv__fill" />
            <button type="button" class="bsv__btn" @click="blocked = false">Not now</button>
            <button type="button" class="bsv__main-act" :disabled="busy" @click="carry">Bring them along</button>
          </p>

          <!-- ── page ─────────────────────────────────────────────────────── -->
          <div class="bsv__scroll">
            <div class="bsv__cols">
              <section class="bsv__main">
                <template v-if="drift">
                  <div class="bsv__label">
                    <span class="bsv__label-name">Against {{ drift.base }}</span>
                  </div>
                  <!-- Two bars from the point the branches split: its own work
                       going right, what the default gained since going left. -->
                  <div
                    class="bsv__split"
                    role="img"
                    :aria-label="`${plural(drift.ahead, 'commit')} of its own, ${drift.behind} on ${drift.base} since they split`"
                  >
                    <span class="bsv__split-side bsv__split-side--behind">
                      <span class="bsv__split-num">{{ drift.behind }}</span>
                      <span class="bsv__split-track">
                        <i v-if="drift.behind" class="bsv__split-fill bsv__split-fill--behind" :style="{ width: `${drift.behindPart * 100}%` }" />
                      </span>
                    </span>
                    <i class="bsv__split-root" />
                    <span class="bsv__split-side">
                      <span class="bsv__split-track">
                        <i v-if="drift.ahead" class="bsv__split-fill" :style="{ width: `${drift.aheadPart * 100}%` }" />
                      </span>
                      <span class="bsv__split-num">{{ drift.ahead }}</span>
                    </span>
                  </div>
                  <div class="bsv__split-keys" aria-hidden="true">
                    <span>new on {{ drift.base }}</span>
                    <span>its own</span>
                  </div>
                </template>

                <div class="bsv__label bsv__label--list">
                  <span class="bsv__label-name">{{ compare?.base === null ? "Latest commits" : "Its own commits" }}</span>
                  <span v-if="compare" class="bsv__label-count">{{ compare.commits.length }}{{ compare.ahead > compare.commits.length ? ` of ${compare.ahead}` : "" }}</span>
                </div>

                <div v-if="loading" class="bsv__loading" aria-busy="true">
                  <i v-for="n in 4" :key="n" class="bsv__bone" :style="{ '--n': n }" />
                </div>
                <p v-else-if="!compare" class="bsv__empty">Couldn't read this branch.</p>
                <p v-else-if="!compare.commits.length" class="bsv__empty">
                  Nothing of its own. Everything on it is already in {{ compare.base }}.
                </p>
                <ol v-else class="bsv__commits">
                  <li v-for="(c, i) in compare.commits" :key="c.hash" class="bsv__commit" :style="{ '--n': i }">
                    <i class="bsv__commit-dot" aria-hidden="true" />
                    <span class="bsv__commit-subject">{{ c.subject }}</span>
                    <span class="bsv__commit-meta">{{ c.author }}</span>
                    <span class="bsv__commit-meta">{{ c.relative }}</span>
                    <span class="bsv__commit-sha">{{ c.short }}</span>
                  </li>
                </ol>
              </section>

              <aside class="bsv__side">
                <div v-if="!b.remote" class="bsv__block" style="--i: 1">
                  <div class="bsv__label">
                    <span class="bsv__label-name">With its remote</span>
                  </div>
                  <div class="bsv__big">
                    <i
                      class="bsv__stand-dot"
                      :class="`bsv__stand-dot--${stand}`"
                      :style="{ background: standInfo?.color || undefined }"
                      aria-hidden="true"
                    />
                    {{ standInfo?.label }}
                  </div>
                  <p class="bsv__sub">{{ standSentence }}</p>
                  <div class="bsv__do">
                    <button
                      v-if="hasRemote && ((stand === 'unpushed' && !trackable) || (stand === 'gone' && !b.merged))"
                      type="button"
                      class="bsv__quiet"
                      :disabled="busy"
                      @click="publish"
                    >
                      {{ space.op.value === "push" ? "Publishing…" : "Publish" }}
                    </button>
                    <button
                      v-if="trackable"
                      type="button"
                      class="bsv__quiet"
                      :disabled="busy"
                      @click="track"
                    >
                      Track {{ trackable }}
                    </button>
                    <button
                      v-if="stand === 'behind' || (b.current && stand === 'both')"
                      type="button"
                      class="bsv__quiet"
                      :disabled="busy"
                      @click="pull"
                    >
                      {{ space.op.value === "pull" ? "Pulling…" : `${b.current ? "Pull" : "Catch up"} ${b.behind}` }}
                    </button>
                    <button
                      v-if="stand === 'ahead' && (b.current || sameNamedUpstream)"
                      type="button"
                      class="bsv__quiet"
                      :disabled="busy"
                      @click="pushIt"
                    >
                      {{ space.op.value === "push" ? "Pushing…" : `Push ${b.ahead}` }}
                    </button>
                  </div>
                  <p v-if="!b.current && stand === 'both'" class="bsv__sub bsv__sub--tight">
                    Both sides moved, so it needs a real pull. Switch to it first.
                  </p>
                  <p v-else-if="!b.current && stand === 'behind'" class="bsv__sub bsv__sub--tight">
                    Catching up moves it forward without leaving {{ current?.name ?? "where you are" }}.
                  </p>
                </div>

                <div v-if="b.worktree" class="bsv__block" style="--i: 2">
                  <div class="bsv__label">
                    <span class="bsv__label-name">Out in a worktree</span>
                  </div>
                  <p class="bsv__path">
                    <HugeiconsIcon :icon="FolderLibraryIcon" :size="13" :stroke-width="1.8" aria-hidden="true" />
                    <span>{{ b.worktree }}</span>
                  </p>
                  <p class="bsv__sub bsv__sub--tight">Git keeps it there, so it can't be switched to or deleted here.</p>
                </div>

                <dl class="bsv__facts bsv__block" style="--i: 3">
                  <template v-if="b.upstream">
                    <dt>Tracks</dt>
                    <dd :title="b.upstream">{{ b.upstream }}</dd>
                  </template>
                  <template v-if="b.author">
                    <dt>Last by</dt>
                    <dd>{{ b.author }}</dd>
                  </template>
                  <template v-if="b.date">
                    <dt>Last commit</dt>
                    <dd>{{ spokenAge(daysSince(b)) }}</dd>
                  </template>
                </dl>

                <div v-if="!b.remote || remoteName" class="bsv__block bsv__tools" style="--i: 4">
                  <button
                    v-if="!b.remote && !renaming"
                    type="button"
                    class="bsv__quiet"
                    :disabled="busy"
                    @click="startRename"
                  >
                    Rename
                  </button>
                  <template v-if="canDelete">
                    <p v-if="unmerged" class="bsv__sub bsv__sub--warn">
                      {{ plural(unmerged, "commit") }} on it {{ unmerged === 1 ? "isn't" : "aren't" }} in {{ drift?.base }} yet.
                      Deleting it drops {{ unmerged === 1 ? "that" : "them" }} from this machine.
                    </p>
                    <HoldToConfirm
                      class="bsv__hold"
                      :disabled="busy"
                      :aria-label="`Hold to delete branch ${b.name}`"
                      title="Hold to delete"
                      @confirm="removeLocal"
                    >
                      Delete branch
                    </HoldToConfirm>
                  </template>
                  <HoldToConfirm
                    v-if="remoteName"
                    class="bsv__hold"
                    :disabled="busy"
                    :aria-label="`Hold to delete ${remoteName} on the remote`"
                    title="Hold to delete on the remote"
                    @confirm="removeRemote"
                  >
                    Delete {{ remoteName }}
                  </HoldToConfirm>
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
/* Teleported out of the space, so it carries its own copy of the space's
   motion vocabulary, as the issue and pull request cards do. */
.bsm {
  --gs-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --gs-t-micro: 140ms;
  --gs-t-small: 220ms;
  --gs-t-enter: 320ms;
  --gs-stagger: 22ms;
  --gs-enter-panel: 160ms;
  position: absolute;
  inset: var(--bsm-inset, 20px) 0;
  width: min(var(--bsm-max, 1080px), calc(100% - 2 * var(--bsm-inset, 20px)));
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
.bsm.is-in {
  animation: bsm-grow 460ms cubic-bezier(0.34, 1.3, 0.64, 1) backwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
.bsm.is-out {
  animation: bsm-shrink var(--modal-exit) cubic-bezier(0.4, 0, 0.9, 1) forwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
@keyframes bsm-grow {
  from { opacity: 0.35; transform: scale(0.16); }
  60% { opacity: 1; }
}
@keyframes bsm-shrink {
  to { opacity: 0; transform: scale(0.16); }
}
@keyframes bsv-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes bsv-grow {
  from {
    transform: scaleX(0);
  }
}
@keyframes bsv-pulse {
  50% {
    opacity: 0.45;
  }
}

.bsv {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  padding: 34px 40px 0;
}

/* ── head ─────────────────────────────────────────────────────────────────── */
.bsv__head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex-shrink: 0;
  animation: bsv-in var(--gs-t-enter) var(--gs-ease) backwards;
}
.bsv__back {
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
.bsv__back:hover,
.bsv__back:focus-visible {
  outline: none;
  opacity: 1;
  color: var(--ink);
}
.bsv__back:focus-visible {
  border-radius: 8px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.bsv__back-glyph {
  transform: rotate(180deg) scaleX(-1);
}
.bsv__identity {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  flex: 1 1 auto;
}
.bsv__eyebrow {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  color: var(--ink-soft);
}
.bsv__state {
  padding: 3px 7px;
  border-radius: 6px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  background-color: var(--hover);
  color: var(--ink-soft);
}
.bsv__state--on {
  color: var(--accent);
  background-color: color-mix(in srgb, var(--accent) 10%, transparent);
}
.bsv__title {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 22px;
  font-weight: 500;
  letter-spacing: -0.4px;
  line-height: 1.25;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.bsv__titlerow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.bsv__copy {
  display: inline-flex;
  flex-shrink: 0;
  padding: 5px;
  border-radius: 7px;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.bsv__copy:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.bsv__copy:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.bsv__blocked {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin: 22px 0 0 34px;
  padding: 10px 12px 10px 14px;
  border-radius: 12px;
  font-size: 12.5px;
  color: var(--ink);
  background-color: color-mix(in srgb, var(--warn) 10%, transparent);
  box-shadow: inset 3px 0 0 var(--warn);
}
.bsv__fill {
  flex: 1 1 auto;
}
.bsv__title--field {
  width: 100%;
  padding: 2px 8px;
  margin-left: -8px;
  border-radius: 8px;
  background-color: var(--hover);
  border: none;
  outline: none;
}
.bsv__title--field:focus {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.bsv__rename {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bsv__hint {
  font-size: 11.5px;
  color: var(--ink-soft);
}
.bsv__hint--bad {
  color: var(--danger);
}
.bsv__note {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  margin: 0;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.bsv__subject {
  color: var(--ink);
}
.bsv__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.bsv__btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding-inline: 12px;
  border-radius: 9px;
  font-size: 12.5px;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.bsv__btn:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.bsv__main-act {
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
.bsv__main-act:hover:not(:disabled) {
  opacity: 0.88;
}
.bsv__btn:disabled,
.bsv__main-act:disabled,
.bsv__quiet:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ── page ─────────────────────────────────────────────────────────────────── */
.bsv__scroll {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  margin-top: 34px;
  padding-left: 34px;
  padding-right: 8px;
  margin-right: -4px;
  padding-bottom: 40px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 14%, transparent) transparent;
  animation: bsv-in var(--gs-t-enter) var(--gs-ease) var(--gs-enter-panel) backwards;
}
.bsv__cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 64px;
  align-items: start;
}
.bsv__main {
  min-width: 0;
}
.bsv__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 14px;
}
.bsv__label--list {
  margin-top: 36px;
}
.bsv__main > .bsv__label--list:first-child {
  margin-top: 0;
}
.bsv__label-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.bsv__label-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}

/* The split: one root, two bars growing away from it. */
.bsv__split {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bsv__split-side {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 0;
  min-width: 0;
}
.bsv__split-num {
  min-width: 3ch;
  font-family: var(--font-mono);
  font-size: 20px;
  line-height: 1;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.bsv__split-side--behind .bsv__split-num {
  text-align: right;
}
.bsv__split-track {
  display: flex;
  flex: 1 1 auto;
  height: 10px;
}
.bsv__split-side--behind .bsv__split-track {
  justify-content: flex-end;
}
.bsv__split-fill {
  display: block;
  height: 100%;
  min-width: 2px;
  border-radius: 3px;
  background-color: var(--accent-2);
  transform-origin: left center;
  animation: bsv-grow 600ms var(--gs-ease) 300ms backwards;
}
.bsv__split-fill--behind {
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
  transform-origin: right center;
}
.bsv__split-root {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 2px var(--ink-soft);
}
.bsv__split-keys {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 12px;
  color: var(--ink-soft);
}

.bsv__commits {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.bsv__commit {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 34px;
  padding-left: 20px;
  font-size: 13px;
  animation: bsv-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--n, 0), 10) * var(--gs-stagger));
}
/* One rail through the commits, the way History draws them. */
.bsv__commit::before {
  content: "";
  position: absolute;
  left: 4px;
  top: 0;
  bottom: 0;
  width: 1.5px;
  background-color: color-mix(in srgb, var(--ink) 14%, transparent);
}
.bsv__commit:first-child::before {
  top: 50%;
}
.bsv__commit:last-child::before {
  bottom: 50%;
}
.bsv__commit-dot {
  position: absolute;
  left: 0;
  top: 50%;
  width: 9.5px;
  height: 9.5px;
  margin-top: -4.75px;
  border-radius: 50%;
  background-color: var(--panel);
  box-shadow: inset 0 0 0 1.5px var(--ink-soft);
}
.bsv__commit-subject {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}
.bsv__commit-meta {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ink-soft);
}
.bsv__commit-sha {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
}
.bsv__empty {
  font-size: 13px;
  color: var(--ink-soft);
}
.bsv__loading {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.bsv__bone {
  height: 12px;
  width: calc(90% - var(--n) * 12%);
  border-radius: 4px;
  background-color: var(--hover);
  animation: bsv-pulse 1.4s ease-in-out infinite;
  animation-delay: calc(var(--n) * 120ms);
}

/* ── side ─────────────────────────────────────────────────────────────────── */
.bsv__side {
  display: flex;
  flex-direction: column;
  gap: 30px;
  min-width: 0;
  padding-bottom: 24px;
}
.bsv__block {
  animation: bsv-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(var(--i, 0) * var(--gs-stagger) * 3);
}
.bsv__big {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.4px;
  color: var(--ink);
}
.bsv__stand-dot {
  flex-shrink: 0;
  width: 11px;
  height: 11px;
  border-radius: 50%;
}
.bsv__stand-dot--unpushed {
  background: repeating-linear-gradient(
    135deg,
    color-mix(in srgb, var(--ink) 45%, transparent) 0 1.5px,
    transparent 1.5px 3px
  );
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 45%, transparent);
}
.bsv__stand-dot--gone {
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 45%, transparent);
}
.bsv__sub {
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink-soft);
}
.bsv__sub--tight {
  margin-top: 8px;
}
.bsv__sub--warn {
  margin: 0;
  color: var(--ink);
}
.bsv__do {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 14px;
}
.bsv__do:empty {
  display: none;
}
.bsv__quiet {
  height: 28px;
  padding-inline: 12px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink);
  background-color: var(--hover);
  cursor: pointer;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.bsv__quiet:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--ink) 10%, transparent);
}
.bsv__path {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.bsv__facts {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 8px 10px;
  margin: 0;
  font-size: 12.5px;
}
.bsv__facts:empty {
  display: none;
}
.bsv__facts dt {
  color: var(--ink-soft);
}
.bsv__facts dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}
.bsv__tools {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}

.bsv__btn:focus-visible,
.bsv__quiet:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.bsv__main-act:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--panel), 0 0 0 4px color-mix(in srgb, var(--ink) 55%, transparent);
}

@media (max-width: 1180px) {
  .bsv__cols {
    grid-template-columns: minmax(0, 1fr);
  }
  .bsv__side {
    order: -1;
  }
}
@media (max-width: 720px) {
  .bsv {
    padding: 24px 20px 0;
  }
  .bsv__head {
    flex-wrap: wrap;
  }
  .bsv__scroll {
    padding-left: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bsm.is-in,
  .bsm.is-out {
    animation-duration: 0.01s;
  }
  .bsv__head,
  .bsv__scroll,
  .bsv__block,
  .bsv__commit,
  .bsv__split-fill,
  .bsv__bone {
    animation: none;
  }
  .bsv__back,
  .bsv__btn,
  .bsv__main-act,
  .bsv__quiet {
    transition: none;
  }
}
</style>
