<script setup lang="ts">
// The bench as one surface: every project's jobs, grouped by what the job is
// doing, inside a single pane sitting on the portal's ground.
//
// A mock, standing in for the real thing while the shape is settled. It reads
// the real read model, so the grouping, the ordering and the fields are the
// ones a wired list would have; what is provisional is the arrangement.
//
// Why a list and not cards: a job's title is the whole of it. Everything else —
// which checkout, which branch, how long — is something you check, not
// something you read, so it lives at the right edge where the eye can skip it
// and find it again in the same place on every row.
//
// Why one pane rather than a card per status: six cards make six equal places,
// and a status is not a place — it is a shelf in one place. The pane is the
// bench; the bands inside it are where a job is sitting on it.

import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Folder01Icon,
  GitBranchIcon,
  Note01Icon,
  PlayIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import AgentFace from "~/components/agent/AgentFace.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import TurnOrb from "~/components/turn/TurnOrb.vue";
import { useBench } from "~/composables/useBench";
import { PROVIDER_BRAND } from "~/utils/modelPicker";
import { sessionBrand } from "~/utils/modelCatalog";
import { formatElapsed } from "~/utils/subagentRuns";
import { timeAgo } from "~/utils/timeAgo";
import type { HugeIcon } from "~/utils/toolPresentation";
import type { JobRow, JobStatus } from "~/types/desktop";

const emit = defineEmits<{
  /** Write a new job. The pane does not host the composer itself — the portal
   *  does, because the composer covers the list it is launched from. */
  "new-job": [];
}>();

const { groups, jobs, refresh } = useBench();
void refresh();

/** What a status looks like at the head of its band. The tone is a role token
 *  rather than a colour, so a theme the user builds carries the meaning with
 *  it instead of being overruled by a hex. */
const LOOKS = {
  running: { icon: PlayIcon, tone: "accent", empty: "Nothing running" },
  queued: { icon: Clock01Icon, tone: "muted", empty: "Nothing queued" },
  draft: { icon: Note01Icon, tone: "faint", empty: "No drafts" },
  done: { icon: CheckmarkCircle02Icon, tone: "ok", empty: "Nothing finished" },
  failed: { icon: AlertCircleIcon, tone: "danger", empty: "Nothing failed" },
  cancelled: {
    icon: CancelCircleIcon,
    tone: "faint",
    empty: "Nothing cancelled",
  },
} as const satisfies Record<
  JobStatus,
  { icon: HugeIcon; tone: string; empty: string }
>;

/** Finished with. Its title is still worth reading, so the row is dimmed
 *  rather than struck through — a job is a thing that ran, not a box ticked. */
function isSettled(status: JobStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

// ── Views ────────────────────────────────────────────────────────────────────

/** The three questions worth asking of a bench, as tabs. Not one tab per
 *  status: the bands already separate the statuses, and a tab per band would
 *  just be the same list with five sixths hidden. */
const VIEWS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "history", label: "History" },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

const view = ref<ViewId>("all");

const shown = computed(() =>
  groups.value.filter((group) => {
    if (view.value === "active") return !isSettled(group.status);
    if (view.value === "history") return isSettled(group.status);
    return true;
  }),
);

// ── Fields ───────────────────────────────────────────────────────────────────

/** The project by its last path segment. The full path is the identity; the
 *  leaf is what the person calls it. */
function projectLeaf(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}

/** Which engine runs the job, as its own logomark. The brand resolves through
 *  the model when the job pinned one, so a harness re-selling another vendor's
 *  model shows the model's mark rather than its own. */
function targetBrand(job: JobRow) {
  return sessionBrand(
    job.target.provider,
    PROVIDER_BRAND[job.target.provider],
    job.target.model,
  );
}

/** The branch a worktree job will be cut onto. Nothing for a job that runs in
 *  the project's own checkout — there is no second place to name. */
/** Where the job's work sits, in one word.
 *
 *  What it ran on wins over what it asked for: once a run has opened a thread
 *  the branch is a fact, and a job that asked for a worktree is told apart from
 *  one in the project's own checkout by the row's own `worktree` wording only
 *  while it has not started. Before that there is nothing observed to show, so
 *  the request is all there is — and a job aimed at the project's own checkout
 *  requests nothing, which is why most rows are blank until they run. */
function branchLabel(job: JobRow): string | null {
  if (job.branch) return job.branch;
  const workspace = job.target.workspace;
  if (!workspace || workspace.mode !== "worktree") return null;
  return workspace.branch ?? "worktree";
}

/** A clock that ticks only while something is running, so an elapsed time on
 *  screen is the elapsed time. Started on mount and dropped on unmount — the
 *  portal is long-lived, and a timer nobody stops is a timer that runs for the
 *  life of the app. */
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  tick = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  if (tick !== undefined) clearInterval(tick);
});

/** How long a running job has been going, counting up. Lives at the head of
 *  the row beside the orb rather than in the fields on the right: it is the
 *  only value on the row that changes by itself, and a number that grows a
 *  digit inside a right-packed cluster drags every field beside it. */
function runningFor(job: JobRow): string | null {
  if (job.status !== "running") return null;
  return formatElapsed(
    Math.max(0, now.value - (job.startedAt ?? job.createdAt)),
  );
}

/** How long ago a finished job stopped — the only thing still worth knowing
 *  about it. A queued or draft job gets nothing: nothing has happened to it
 *  yet, and the age of the note you wrote is not a fact about the work; in a
 *  column of dates it would read as a due date or a delay when it is neither. */
function settledAgo(job: JobRow): string | null {
  if (!isSettled(job.status)) return null;
  return timeAgo(job.endedAt ?? job.updatedAt);
}

// ── Bands ────────────────────────────────────────────────────────────────────

const collapsed = ref(new Set<JobStatus>());

function toggle(status: JobStatus): void {
  const next = new Set(collapsed.value);
  if (!next.delete(status)) next.add(status);
  collapsed.value = next;
}

// ── Foot ─────────────────────────────────────────────────────────────────────

const running = computed(() =>
  jobs.value.filter((job) => job.status === "running"),
);

const waiting = computed(
  () => jobs.value.filter((job) => job.status === "queued").length,
);

/** One line for the whole bench. Running is counted by project as well as by
 *  job because one job runs per project at a time — four running means four
 *  checkouts busy, and that is the fact the number is actually reporting. */
const tally = computed<string>(() => {
  const live = running.value.length;
  if (live === 0) {
    return waiting.value > 0
      ? `Nothing running · ${waiting.value} waiting`
      : "Nothing running";
  }
  const projects = new Set(running.value.map((job) => job.projectPath)).size;
  const part = `${live} running across ${projects} ${projects === 1 ? "project" : "projects"}`;
  return waiting.value > 0 ? `${part} · ${waiting.value} waiting` : part;
});

</script>

<template>
  <div class="bl">
    <!-- The pane's own row: where you are in the bench on the left, the one
         thing you can add to it on the right. -->
    <header class="bl__top">
      <nav class="bl__views" aria-label="Bench views">
        <button
          v-for="v in VIEWS"
          :key="v.id"
          type="button"
          class="bl__view"
          :class="{ 'bl__view--on': view === v.id }"
          :aria-current="view === v.id ? 'page' : undefined"
          @click="view = v.id"
        >
          {{ v.label }}
        </button>
      </nav>

      <span class="bl__grow" />

      <button type="button" class="bl__new" @click="emit('new-job')">
        <HugeiconsIcon
          :icon="PlusSignIcon"
          :size="14"
          :stroke-width="2.2"
          aria-hidden="true"
        />
        New job
      </button>
    </header>

    <div class="bl__scroll">
      <section v-for="group in shown" :key="group.status" class="bl__group">
        <button
          type="button"
          class="bl__band"
          :class="`bl__band--${LOOKS[group.status].tone}`"
          @click="toggle(group.status)"
        >
          <HugeiconsIcon
            class="bl__chev"
            :class="{ 'bl__chev--shut': collapsed.has(group.status) }"
            :icon="ArrowDown01Icon"
            :size="14"
            :stroke-width="2"
          />
          <HugeiconsIcon
            class="bl__mark"
            :icon="LOOKS[group.status].icon"
            :size="13"
            :stroke-width="2"
          />
          <span class="bl__label">{{ group.label }}</span>
          <span class="bl__count">{{ group.jobs.length }}</span>
        </button>

        <p
          v-if="!collapsed.has(group.status) && group.jobs.length === 0"
          class="bl__none"
        >
          {{ LOOKS[group.status].empty }}
        </p>

        <ul v-else-if="!collapsed.has(group.status)" class="bl__rows">
          <li
            v-for="job in group.jobs"
            :key="job.jobId"
            class="bl__row"
            :class="{
              'bl__row--settled': isSettled(job.status),
              'bl__row--live': job.status === 'running',
            }"
          >
            <!-- Working, as the orb. Only a running row carries one: an orb
                 on every row would say everything is working. It turns in the
                 neutral state for now — which call is in flight arrives on the
                 event stream, and nothing here is listening for it yet. -->
            <TurnOrb
              v-if="job.status === 'running'"
              class="bl__orb"
              state="working"
              :size="16"
              aria-label="Running"
            />

            <span v-if="runningFor(job)" class="bl__elapsed">{{
              runningFor(job)
            }}</span>

            <span class="bl__title">{{ job.title }}</span>

            <!-- The fields, packed against the right edge rather than set in
                 columns: a job with no worktree closes the gap instead of
                 leaving a hole, so every row ends in the same clean edge. -->
            <span class="bl__meta">
              <span class="bl__cell">
                <HugeiconsIcon
                  :icon="Folder01Icon"
                  :size="14"
                  :stroke-width="1.7"
                />
                <span class="bl__ellipsis">{{
                  projectLeaf(job.projectPath)
                }}</span>
              </span>

              <span v-if="branchLabel(job)" class="bl__cell bl__cell--branch">
                <HugeiconsIcon
                  :icon="GitBranchIcon"
                  :size="14"
                  :stroke-width="1.7"
                />
                <span class="bl__ellipsis">{{ branchLabel(job) }}</span>
              </span>

              <span v-if="settledAgo(job)" class="bl__cell">
                <HugeiconsIcon
                  :icon="Clock01Icon"
                  :size="14"
                  :stroke-width="1.7"
                />
                {{ settledAgo(job) }}
              </span>
            </span>

            <!-- Who the job belongs to, last and always there, so the row has a
                 fixed right edge for the packed fields to stop against. -->
            <span class="bl__lead">
              <AgentFace :seed="job.jobId" :size="24" />
              <!-- The engine's mark rides the face rather than taking width of
                   its own: it is an attribute of who is answering, and the face
                   is already where the eye goes to ask that. -->
              <span class="bl__brand">
                <ProviderLogo :brand="targetBrand(job)" :size="10" />
              </span>
            </span>
          </li>
        </ul>
      </section>
    </div>

    <!-- The foot: what the whole bench amounts to, under the orb that is doing
         it. The other portals anchor their lower edge the same way, and without
         it the pane runs out rather than ending. -->
    <footer class="bl__foot">
      <TurnOrb
        state="working"
        :size="16"
        :active="running.length > 0"
        aria-label="Bench activity"
      />
      <span class="bl__tally">{{ tally }}</span>
    </footer>
  </div>
</template>

<style scoped>
/* The pane fills whatever the portal gives it and divides into three: a row
   that stays, a list that scrolls, a foot that stays. */
.bl {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ── Top row ─────────────────────────────────────────────────────────────── */

/* The two bands, header and foot, in the modal shell's construction: a
   recessed surface with its inner corners scooped concave, so the panel
   between them reads as the sheet the bands are pressed into rather than as
   three stacked strips. The arcs are those corners; they are not decoration. */
.bl__top,
.bl__foot {
  --band-bg: var(--band);
  --band-arc: 14px;
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  background-color: var(--band-bg);
  z-index: 1;
}

.bl__top::before,
.bl__top::after,
.bl__foot::before,
.bl__foot::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}

.bl__top::before,
.bl__top::after {
  top: 100%;
}

.bl__top::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.bl__top::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.bl__foot::before,
.bl__foot::after {
  bottom: 100%;
}

.bl__foot::before {
  left: 0;
  background: radial-gradient(
    circle at top right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.bl__foot::after {
  right: 0;
  background: radial-gradient(
    circle at top left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.bl__top {
  gap: 10px;
  padding: 0.625rem 1rem;
}

.bl__views {
  display: flex;
  align-items: center;
  gap: 2px;
}

.bl__view {
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--faint);
  font-size: 12.5px;
  font-weight: 550;
  letter-spacing: -0.005em;
  cursor: pointer;
  transition:
    color 0.16s ease,
    background-color 0.16s ease;
}

.bl__view:hover {
  color: var(--ink-soft);
  background: var(--hover);
}

.bl__view--on {
  color: var(--accent);
  background: var(--accent-wash);
}

.bl__grow {
  flex: 1;
}

.bl__new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 30px;
  padding: 0 12px 0 10px;
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.005em;
  cursor: pointer;
  transition: filter 140ms ease;
}

.bl__new:hover {
  filter: brightness(1.06);
}

/* ── Scroller ────────────────────────────────────────────────────────────── */

.bl__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-bottom: 0.35rem;
}

/* ── Bands ───────────────────────────────────────────────────────────────── */

/* The heading sits a shade back from its rows, so a status reads as a shelf
   the jobs are on rather than as the first line of the list. Full-bleed, so
   the step in tone runs the width of the sheet and the rows are plainly the
   thing in front of it.
   
   One shade for every heading. Tinting each by its status put six different
   colours down the page, which made the headings compete with each other
   instead of separating the list — and the marks already say which status is
   which.

   Not the band's shade, though: the header and the foot are the shell's own
   chrome, and a heading that matches them reads as another strip of chrome
   rather than as part of the list. It sits between the two — stepped back from
   the rows, still clearly in front of the bands. */
.bl__band {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  padding: 0.45rem 1rem;
  border: 0;
  border-top: 1px solid var(--line-soft);
  border-bottom: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--band) 45%, var(--panel));
  text-align: left;
  cursor: pointer;
  transition: background-color 0.16s ease;
}

.bl__group:first-child .bl__band {
  border-top: 0;
}

.bl__band:hover {
  filter: brightness(0.985);
}

.bl__band:hover .bl__chev {
  color: var(--ink-soft);
}

.bl__chev {
  display: inline-flex;
  flex: none;
  color: var(--faint);
  transition:
    transform 0.26s cubic-bezier(0.22, 1, 0.36, 1),
    color 0.18s ease;
}

.bl__chev--shut {
  transform: rotate(-90deg);
}

.bl__band--accent .bl__mark {
  color: var(--accent);
}
.bl__band--ok .bl__mark {
  color: var(--ok);
}
.bl__band--danger .bl__mark {
  color: var(--danger);
}
.bl__band--muted .bl__mark {
  color: var(--ink-soft);
}
.bl__band--faint .bl__mark {
  color: var(--faint);
}

/* The status name as an eyebrow: the band says where you are, the titles under
   it are what you read. */
.bl__label {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--muted);
}

.bl__count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--faint);
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

.bl__rows {
  margin: 0;
  padding: 0 0.5rem 0.35rem;
  list-style: none;
}

.bl__row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 42px;
  padding: 0 0.65rem;
  border-radius: 12px;
  transition: background-color 0.18s ease;
}

.bl__row:hover {
  background: color-mix(in srgb, var(--ink) 4%, transparent);
}

.bl__orb {
  flex: none;
}

/* Tabular figures and a floor on the width, so a second ticking over does not
   nudge the title. */
.bl__elapsed {
  flex: none;
  min-width: 52px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-soft);
  white-space: nowrap;
}

.bl__title {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bl__row--settled .bl__title {
  color: var(--muted);
}

.bl__row--live .bl__title {
  font-weight: 600;
}

.bl__meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 18px;
  flex: none;
}

.bl__cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 450;
  color: var(--ink-soft);
  white-space: nowrap;
}

.bl__cell :deep(svg) {
  flex: none;
  color: var(--muted);
}

/* A guard, not a column: a branch name can be arbitrarily long and must not be
   allowed to crowd the title out of the row. */
.bl__ellipsis {
  min-width: 0;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bl__cell--branch {
  font-family: var(--font-mono);
  font-size: 11px;
}

.bl__lead {
  position: relative;
  flex: none;
  line-height: 0;
}

/* Set into the face's corner on its own disc, so the mark stays legible over
   whatever the portrait happens to be behind it. */
.bl__brand {
  position: absolute;
  right: -2px;
  bottom: -2px;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--panel);
  box-shadow: 0 0 0 1.5px var(--panel);
}

/* ── Foot ────────────────────────────────────────────────────────────────── */

.bl__foot {
  gap: 9px;
  padding: 0.625rem 1rem;
}

.bl__tally {
  font-size: 12px;
  font-weight: 450;
  color: var(--muted);
}

/* An empty status still shows its heading, so this says what is missing rather
   than leaving a heading with nothing under it. */
.bl__none {
  margin: 0;
  padding: 0.55rem 1rem 0.7rem;
  font-size: 12px;
  color: var(--faint);
}

@media (prefers-reduced-motion: reduce) {
  .bl__chev {
    transition: none;
  }
}
</style>
