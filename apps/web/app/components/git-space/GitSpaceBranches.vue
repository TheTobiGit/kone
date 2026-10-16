<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Add01Icon, FolderLibraryIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import type { useGitSpace } from "~/composables/useGitSpace";
import type { GitBranch } from "~/types/desktop";
import {
  STALE_DAYS,
  STANDINGS,
  branchNameProblem,
  daysSince,
  isDirtyRefusal,
  kindOf,
  localNameOf,
  shortAge,
  spokenAge,
  standing,
  type BranchStanding,
} from "~/utils/branchStanding";

// Every branch, read at once.
//
// The list is the branches as work: the one you're on, the rest newest first,
// the ones already in the default branch set apart, and what lives only on the
// remote. Each row says how it stands with its remote as a dot (the same dot
// the side column's bar is made of), what last happened on it, and how long
// ago. A row opens the branch in a card; the one move you most often came for,
// switching to it, sits on the row itself.

const props = defineProps<{ space: ReturnType<typeof useGitSpace> }>();

const emit = defineEmits<{
  open: [branch: GitBranch, origin: DOMRect | null];
}>();

const { cue } = useSound();

const busy = computed(() => props.space.op.value !== null);
const all = computed(() => props.space.branches.value);
const current = computed(() => all.value.find((b) => b.current) ?? null);
const defaultName = computed(() => all.value.find((b) => !b.remote && b.default)?.name ?? "main");
const localCount = computed(() => all.value.filter((b) => !b.remote).length);
const remoteCount = computed(() => all.value.length - localCount.value);

// ── filters ──────────────────────────────────────────────────────────────────

const query = ref("");
const standingFilter = ref<BranchStanding | null>(null);
const kindFilter = ref<string | null>(null);
const filtering = computed(() => !!query.value.trim() || !!standingFilter.value || !!kindFilter.value);

function pickStanding(id: BranchStanding) {
  cue("press");
  standingFilter.value = standingFilter.value === id ? null : id;
}
function pickKind(kind: string) {
  cue("press");
  kindFilter.value = kindFilter.value === kind ? null : kind;
}
function clearFilters() {
  cue("press");
  query.value = "";
  standingFilter.value = null;
  kindFilter.value = null;
}

function shown(b: GitBranch): boolean {
  const q = query.value.trim().toLowerCase();
  if (q && !b.name.toLowerCase().includes(q) && !(b.subject ?? "").toLowerCase().includes(q)) return false;
  if (kindFilter.value && kindOf(b.remote ? localNameOf(b.name) : b.name) !== kindFilter.value) return false;
  // How a branch stands with its remote is a local branch's fact.
  if (standingFilter.value && (b.remote || standing(b) !== standingFilter.value)) return false;
  return true;
}

/** The default branch first, then the rest newest first. */
const byNewest = (a: GitBranch, b: GitBranch) =>
  Number(!!b.default) - Number(!!a.default) ||
  (b.date ?? "").localeCompare(a.date ?? "") ||
  a.name.localeCompare(b.name);

const localNames = computed(() => new Set(all.value.filter((b) => !b.remote).map((b) => b.name)));
/** A remote branch some local branch tracks is that branch's business, so
 *  it is listed once, as the local one. A same-named one on another remote,
 *  or one nothing tracks, keeps its own row. */
function remoteOnly(b: GitBranch): boolean {
  return b.remote && !all.value.some((l) => !l.remote && l.upstream === b.name);
}

interface Group {
  id: string;
  label: string;
  rows: GitBranch[];
}
const groups = computed<Group[]>(() => {
  const visible = all.value.filter(shown);
  const local = visible.filter((b) => !b.remote).sort(byNewest);
  const remote = visible.filter(remoteOnly).sort(byNewest);
  const out: Group[] = [
    { id: "current", label: "You're on", rows: local.filter((b) => b.current) },
    { id: "local", label: "Branches", rows: local.filter((b) => !b.current && !b.merged) },
    { id: "merged", label: `Already in ${defaultName.value}`, rows: local.filter((b) => !b.current && b.merged) },
    { id: "remote", label: "Only on the remote", rows: remote },
  ];
  return out.filter((g) => g.rows.length);
});
const shownCount = computed(() => groups.value.reduce((n, g) => n + g.rows.length, 0));
const listedCount = computed(() => all.value.filter((b) => !b.remote || remoteOnly(b)).length);

// ── a row ────────────────────────────────────────────────────────────────────

function colorOf(id: BranchStanding): string | undefined {
  return STANDINGS.find((s) => s.id === id)?.color || undefined;
}

function drift(b: GitBranch): string {
  const s = standing(b);
  if (s === "unpushed") return "not pushed";
  if (s === "gone") return "remote gone";
  if (s === "even") return "in step";
  return [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : ""].filter(Boolean).join(" ");
}
function driftSentence(b: GitBranch): string {
  const s = standing(b);
  if (s === "unpushed") return "Never pushed";
  if (s === "gone") return `Its remote branch ${b.upstream} was deleted`;
  if (s === "even") return `In step with ${b.upstream}`;
  const parts: string[] = [];
  if (b.ahead) parts.push(`${b.ahead} to push`);
  if (b.behind) parts.push(`${b.behind} to pull`);
  return `${parts.join(", ")} against ${b.upstream}`;
}

function openRow(e: MouseEvent, b: GitBranch) {
  // SAFETY: bound on the row's own button, so currentTarget is that element.
  emit("open", b, (e.currentTarget as HTMLElement).getBoundingClientRect());
}

/** A switch git refused because uncommitted work is in the way. */
const blocked = ref<string | null>(null);

async function switchTo(b: GitBranch) {
  if (busy.value) return cue("refuse");
  cue("press");
  blocked.value = null;
  // A remote branch becomes a local one that tracks it, or switches to the
  // local one of that name; the desktop side picks.
  const ok = await props.space.switchBranch(b.name);
  if (!ok && isDirtyRefusal(props.space.error.value)) blocked.value = b.name;
}
async function carry() {
  const name = blocked.value;
  if (!name || busy.value) return cue("refuse");
  cue("press");
  const ok = await props.space.switchCarrying(name);
  cue(ok ? "success" : "error");
  blocked.value = null;
}

// ── fetch ────────────────────────────────────────────────────────────────────

async function fetchRemote() {
  if (busy.value) return cue("refuse");
  cue("press");
  cue((await props.space.fetch()) ? "success" : "error");
}

// ── a new branch ─────────────────────────────────────────────────────────────

const creating = ref(false);
const newName = ref("");
/** Put it on the remote straight away, the way it will end up anyway. */
const publishNew = ref(true);
const hasRemote = computed(() => props.space.remotes.value.length > 0);
const newNameEl = ref<HTMLInputElement | null>(null);
const problem = computed(() => {
  const name = newName.value.trim();
  if (localNames.value.has(name)) return `${name} already exists.`;
  return branchNameProblem(name);
});

async function startCreate() {
  cue("expand");
  creating.value = true;
  newName.value = "";
  await nextTick();
  newNameEl.value?.focus();
}
function cancelCreate() {
  creating.value = false;
  newName.value = "";
}
async function submitCreate() {
  const name = newName.value.trim();
  if (!name) return cancelCreate();
  // Another operation holds the repo, or git would refuse the name. Enter
  // reaches here either way, so say no rather than swallow it.
  if (busy.value || problem.value) return cue("refuse");
  cue("press");
  let ok = await props.space.createBranch(name, { checkout: true });
  if (ok && hasRemote.value && publishNew.value) {
    ok = await props.space.push({ branch: name, setUpstream: true, remote: props.space.origin.value?.name });
  }
  cue(ok ? "success" : "error");
  if (ok) cancelCreate();
}

async function clearMerged(names: string[]) {
  cue("discard");
  await props.space.deleteBranches(names);
}
</script>

<template>
  <section class="gsb">
    <!-- ══ the main column: the list ═══════════════════════════════════════ -->
    <div class="gsb__main">
      <header class="gsb__head">
        <span class="gsb__headcount">
          <b>{{ localCount }}</b> local<template v-if="remoteCount">
            · <b>{{ remoteCount }}</b> on the remote</template>
        </span>
        <button v-if="filtering" type="button" class="gsb__clear" @click="clearFilters">
          {{ shownCount }} of {{ listedCount }} · clear
        </button>
        <span class="gsb__fill" />
        <button
          type="button"
          class="gsb__sweep"
          :class="{ 'gsb__sweep--spin': space.op.value === 'fetch' }"
          :disabled="busy"
          title="Fetch from the remote, and drop the branches it deleted"
          @click="fetchRemote"
        >
          <HugeiconsIcon class="gsb__spin" :icon="RefreshIcon" :size="12" :stroke-width="2" aria-hidden="true" />
          {{ space.op.value === "fetch" ? "Fetching…" : "Fetch" }}
        </button>
        <button v-if="!creating" type="button" class="gsb__sweep" :disabled="busy" @click="startCreate">
          <HugeiconsIcon :icon="Add01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
          New branch
        </button>
      </header>

      <!-- The new-branch field is written in place at the top, not in a dialog. -->
      <form
        v-if="creating"
        class="gsb__composer"
        @submit.prevent="submitCreate"
        @keydown.esc.prevent="cancelCreate"
      >
        <input
          ref="newNameEl"
          v-model="newName"
          class="gsb__namefield"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="feat/what-it-does"
          aria-label="New branch name"
          :aria-invalid="!!problem"
          aria-describedby="gsb-new-hint"
          :disabled="busy"
        />
        <div class="gsb__composerfoot">
          <span id="gsb-new-hint" class="gsb__hint" :class="{ 'gsb__hint--bad': problem }" aria-live="polite">
            <template v-if="problem">{{ problem }}</template>
            <template v-else>From <b>{{ current?.name ?? "HEAD" }}</b>, and you'll be on it.</template>
          </span>
          <span class="gsb__fill" />
          <label v-if="hasRemote" class="gsb__check">
            <input v-model="publishNew" type="checkbox" :disabled="busy" />
            Publish it
          </label>
          <button type="button" class="gsb__act gsb__act--flat" @click="cancelCreate">Cancel</button>
          <button type="submit" class="gsb__create" :disabled="busy || !newName.trim() || !!problem">
            {{ space.op.value === "branch" ? "Creating…" : "Create" }}
          </button>
        </div>
      </form>

      <p v-if="blocked" class="gsb__blocked" role="status">
        <span>Your uncommitted changes are in the way of <b>{{ blocked }}</b>.</span>
        <span class="gsb__fill" />
        <button type="button" class="gsb__act gsb__act--flat" @click="blocked = null">Not now</button>
        <button type="button" class="gsb__create" :disabled="busy" @click="carry">Bring them along</button>
      </p>

      <GitSpaceSkeleton v-if="!all.length && !space.ready('branches')" :rows="5" />

      <p v-else-if="!all.length" class="gsb__empty">No branches yet. The first commit makes one.</p>

      <p v-else-if="!groups.length" class="gsb__empty">
        Nothing matches.
        <button type="button" class="gsb__link" @click="clearFilters">Show every branch</button>
      </p>

      <div v-for="(g, gi) in groups" :key="g.id" class="gsb__group" :style="{ '--i': gi }">
        <div class="gsb__label">
          <span class="gsb__label-name">{{ g.label }}</span>
          <span class="gsb__label-count">{{ g.rows.length }}</span>
        </div>

        <div
          v-for="(b, i) in g.rows"
          :key="b.name"
          class="gsb__row"
          :class="{ 'gsb__row--current': b.current, 'gsb__row--remote': b.remote }"
          :style="{ '--n': i }"
        >
          <button type="button" class="gsb__main-btn" aria-haspopup="dialog" @click="openRow($event, b)">
            <span
              class="gsb__dot"
              :class="b.remote ? 'gsb__dot--remote' : `gsb__dot--${standing(b)}`"
              :style="{ background: !b.remote ? colorOf(standing(b)) : undefined }"
              aria-hidden="true"
            />

            <span class="gsb__body">
              <span class="gsb__line">
                <span class="gsb__name">{{ b.name }}</span>
                <span v-if="b.default" class="gsb__tag">default</span>
                <span v-if="b.worktree" class="gsb__tag" :title="`Checked out in ${b.worktree}`">
                  <HugeiconsIcon :icon="FolderLibraryIcon" :size="11" :stroke-width="1.8" aria-hidden="true" />
                  worktree
                </span>
              </span>
              <span v-if="b.subject || b.author" class="gsb__meta">
                <span v-if="b.subject" class="gsb__subject">{{ b.subject }}</span>
                <span v-if="b.author" class="gsb__dim">{{ b.author }}</span>
              </span>
            </span>

            <span class="gsb__right">
              <span v-if="!b.remote" class="gsb__drift" :class="`gsb__drift--${standing(b)}`" :title="driftSentence(b)">
                <span class="sr-only">{{ driftSentence(b) }}</span>
                <span aria-hidden="true">{{ drift(b) }}</span>
              </span>
              <span
                v-if="b.date"
                class="gsb__age"
                :class="{ 'gsb__age--stale': (daysSince(b) ?? 0) >= STALE_DAYS && !b.default }"
                :title="`Last commit ${spokenAge(daysSince(b))}`"
              >
                <span class="sr-only">, last commit {{ spokenAge(daysSince(b)) }}</span>
                <span aria-hidden="true">{{ shortAge(daysSince(b)) }}</span>
              </span>
            </span>
          </button>

          <div v-if="!b.current" class="gsb__actions">
            <button
              type="button"
              class="gsb__act"
              :disabled="busy || !!b.worktree"
              :title="b.worktree ? `Checked out in ${b.worktree}` : undefined"
              :aria-label="`${b.remote ? 'Check out' : 'Switch to'} ${b.name}`"
              @click="switchTo(b)"
            >
              {{ b.remote ? "Check out" : "Switch" }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ══ the side column: the branches at a glance ═══════════════════════ -->
    <GitSpaceBranchesSide
      v-if="all.length"
      v-model:query="query"
      :branches="all"
      :standing-filter="standingFilter"
      :kind-filter="kindFilter"
      :busy="busy"
      @pick-standing="pickStanding"
      @pick-kind="pickKind"
      @open="(b, r) => emit('open', b, r)"
      @clear-merged="clearMerged"
    />
  </section>
</template>

<style scoped>
.gsb {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 64px;
  align-items: start;
  padding-bottom: 12px;
}
.gsb__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.gsb__fill {
  flex: 1 1 auto;
}
.gsb__group {
  animation: gsb-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3);
}
.gsb__row {
  animation: gsb-in var(--gs-t-enter) var(--gs-ease) backwards;
  animation-delay: calc(min(var(--i, 0), 7) * var(--gs-stagger) * 3 + min(var(--n, 0), 7) * var(--gs-stagger));
}
@keyframes gsb-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes gsb-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── head ─────────────────────────────────────────────────────────────────── */
.gsb__head {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 26px;
  margin-bottom: 26px;
}
.gsb__headcount {
  font-size: 12.5px;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.gsb__headcount b {
  font-weight: 500;
  color: var(--ink);
}
.gsb__clear {
  padding: 3px 8px;
  border-radius: 7px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
  background-color: var(--hover);
  cursor: pointer;
}
.gsb__clear:hover {
  color: var(--ink);
}
.gsb__sweep {
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
.gsb__sweep:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.gsb__sweep:disabled {
  opacity: 0.4;
  cursor: default;
}
.gsb__sweep--spin .gsb__spin {
  animation: gsb-spin 900ms linear infinite;
}

/* ── composer ─────────────────────────────────────────────────────────────── */
.gsb__composer {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 22px;
  padding: 12px 14px 10px;
  border-radius: 12px;
  background-color: var(--hover);
  transition: box-shadow var(--gs-t-micro) var(--gs-ease);
  animation: gsb-in var(--gs-t-enter) var(--gs-ease) backwards;
}
.gsb__composer:focus-within {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.gsb__namefield {
  width: 100%;
  background: none;
  border: none;
  outline: none;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink);
}
.gsb__namefield::placeholder {
  color: var(--ink-soft);
  opacity: 0.6;
}
.gsb__composerfoot {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
}
.gsb__hint {
  font-size: 11.5px;
  color: var(--ink-soft);
}
.gsb__hint b {
  font-family: var(--font-mono);
  font-weight: 500;
  color: var(--ink);
}
.gsb__hint--bad {
  color: var(--danger);
}
.gsb__check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 6px;
  font-size: 11.5px;
  color: var(--ink-soft);
  cursor: pointer;
}
.gsb__check input {
  accent-color: var(--ink);
}
.gsb__blocked {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 22px;
  padding: 10px 12px 10px 14px;
  border-radius: 12px;
  font-size: 12.5px;
  color: var(--ink);
  background-color: color-mix(in srgb, var(--warn) 10%, transparent);
  box-shadow: inset 3px 0 0 var(--warn);
}
.gsb__blocked b {
  font-family: var(--font-mono);
  font-weight: 500;
}
.gsb__create {
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
.gsb__create:hover:not(:disabled) {
  opacity: 0.88;
}
.gsb__create:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ── labels ───────────────────────────────────────────────────────────────── */
.gsb__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
.gsb__label-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-soft);
}
.gsb__label-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}

/* ── groups and rows ──────────────────────────────────────────────────────── */
.gsb__group + .gsb__group {
  margin-top: 30px;
}
.gsb__row {
  position: relative;
  display: flex;
  align-items: center;
  margin-inline: -10px;
  border-radius: 10px;
  transition: background-color var(--gs-t-micro) var(--gs-ease);
}
.gsb__row:hover,
.gsb__row:focus-within {
  background-color: var(--hover);
}
.gsb__main-btn {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 10px;
  text-align: left;
  cursor: pointer;
}

/* The dot is the side column's legend, drawn on the row: a fill for each
   standing, hatched for never pushed, a ring for a remote that went away, and
   a hollow square for a branch only the remote has. */
.gsb__dot {
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.gsb__dot--unpushed {
  background: repeating-linear-gradient(
    135deg,
    color-mix(in srgb, var(--ink) 45%, transparent) 0 1.5px,
    transparent 1.5px 3px
  );
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 45%, transparent);
}
.gsb__dot--gone,
.gsb__dot--remote {
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 45%, transparent);
}
.gsb__dot--remote {
  border-radius: 2px;
}
/* The one you're on is ringed, so "where am I" answers itself. */
.gsb__row--current .gsb__dot {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: 2px;
}

.gsb__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
}
.gsb__line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.gsb__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.2;
  color: var(--ink);
}
.gsb__row--current .gsb__name {
  color: var(--accent);
}
.gsb__tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: 5px;
  font-size: 10.5px;
  line-height: 1.2;
  color: var(--ink-soft);
  background-color: var(--hover);
}
.gsb__row:hover .gsb__tag,
.gsb__row:focus-within .gsb__tag {
  background-color: var(--sunken);
}
.gsb__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.2;
  color: var(--ink-soft);
  white-space: nowrap;
}
.gsb__subject {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gsb__dim {
  flex-shrink: 0;
  opacity: 0.8;
}

.gsb__right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-soft);
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.gsb__drift--unpushed,
.gsb__drift--gone,
.gsb__drift--even {
  opacity: 0.75;
}
.gsb__age {
  min-width: 3ch;
  text-align: right;
}
.gsb__age--stale {
  color: var(--warn);
}

/* Switching takes the right end's place on hover. */
.gsb__actions {
  position: absolute;
  right: 8px;
  top: 50%;
  display: flex;
  align-items: center;
  gap: 2px;
  transform: translateY(-50%);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--gs-t-micro) var(--gs-ease);
}
.gsb__row:hover .gsb__actions,
.gsb__row:focus-within .gsb__actions {
  opacity: 1;
  pointer-events: auto;
}
.gsb__row:has(.gsb__actions):hover .gsb__right,
.gsb__row:has(.gsb__actions):focus-within .gsb__right {
  opacity: 0;
}
.gsb__act {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  border-radius: 7px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--ink-soft);
  background-color: var(--sunken);
  cursor: pointer;
  transition:
    background-color var(--gs-t-micro) var(--gs-ease),
    color var(--gs-t-micro) var(--gs-ease);
}
.gsb__act--flat {
  background: none;
}
.gsb__act:hover:not(:disabled) {
  color: var(--ink);
}
.gsb__act:disabled {
  opacity: 0.4;
  cursor: default;
}
.gsb__link {
  margin-left: 6px;
  color: var(--accent);
  cursor: pointer;
}
.gsb__empty {
  max-width: 56ch;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-soft);
}

.gsb__main-btn:focus-visible,
.gsb__act:focus-visible,
.gsb__sweep:focus-visible,
.gsb__clear:focus-visible,
.gsb__create:focus-visible,
.gsb__link:focus-visible {
  outline: none;
  border-radius: 8px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 55%, transparent);
}
.gsb__main-btn:focus-visible {
  border-radius: 10px;
}

@media (max-width: 1180px) {
  .gsb {
    grid-template-columns: minmax(0, 1fr);
    gap: 40px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gsb__group,
  .gsb__row,
  .gsb__composer,
  .gsb__sweep--spin .gsb__spin {
    animation: none;
  }
  .gsb__row,
  .gsb__sweep,
  .gsb__actions,
  .gsb__right,
  .gsb__act {
    transition: none;
  }
}
</style>
