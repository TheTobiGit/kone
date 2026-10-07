<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Copy01Icon, FolderOpenIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { Project } from "~/composables/useProject";
import { useSpaceUsage } from "~/composables/useSpaceUsage";
import { useSpaceInstructions, type InstructionKind } from "~/composables/useSpaceInstructions";
import { useSpaceSkills } from "~/composables/useSpaceSkills";
import { useSpaceCamera } from "~/composables/useSpaceCamera";
import { useProjectSummaries } from "~/composables/useProjectSummaries";
import { useSound } from "~/composables/useSound";
import { COLUMNS, COLUMN_GUTTER, INSTRUCTION_KINDS, SECTIONS, type ColumnId } from "~/utils/spaceBoard";
import ProjectFolder from "~/components/project/ProjectFolder.vue";
import SpaceColumn from "./SpaceColumn.vue";
import SpaceActivityCard from "./SpaceActivityCard.vue";
import SpaceSpendCard from "./SpaceSpendCard.vue";
import SpaceModelsCard from "./SpaceModelsCard.vue";
import SpaceSkillsCard from "./SpaceSkillsCard.vue";
import SpaceInstructionsCard from "./SpaceInstructionsCard.vue";

// The project's Space: a fixed pane at the left (a nav that follows the
// camera, and the project's folder at the foot), and beside it a row of
// full-height columns the camera pans across. Each column has its own header
// and scrolls its own feed. A nav item is a section, and a section can be
// several columns: Telemetry is Activity over Spend, Models and Skills stand
// alone, and Instructions is AGENTS.md beside CLAUDE.md (which sections there
// are, and which columns each holds, is ~/utils/spaceBoard). Sending the camera
// to a section lands its first column flush against the pane and washes its
// columns for a moment. The nav's highlight is the section whose column is at
// the pane's edge, so it follows the camera however it moved (the camera itself
// is useSpaceCamera). Where the track's edges cut into a column, that edge fades
// into the ground.

const props = defineProps<{
  project: Project;
  /** This tab is the one on screen. Re-reads wait until it is. */
  visible: boolean;
}>();

const { cue } = useSound();

const usage = useSpaceUsage(
  () => props.project.path,
  () => props.visible,
);

const instructions = useSpaceInstructions(
  () => props.project.path,
  () => props.visible,
);

const skills = useSpaceSkills(
  () => props.project.path,
  () => props.visible,
);

const { trackEl, fadeLeft, fadeRight, activeSection, landed, setColumnRef, onTrackScroll, scrollToSection } =
  useSpaceCamera({
    columns: COLUMNS,
    inset: COLUMN_GUTTER,
    visible: () => props.visible,
  });

/** The columns' leading gutter, as the CSS below reads it. */
const gutter = `${COLUMN_GUTTER}px`;

/** Each column arrives a beat after the one before it. */
const STAGGER_MS = 70;
function enter(id: ColumnId): Record<string, string> {
  return { "--i": `${COLUMNS.findIndex((c) => c.id === id) * STAGGER_MS}ms` };
}

// The folder at the pane's foot is the one the Overview corner shows, drawn
// from the same live git cache, and watched only while this tab is on screen.
const { summaries, subscribe } = useProjectSummaries();
subscribe(() => (props.visible ? [props.project.path] : []));
const summary = computed(() => summaries[props.project.path]);
const folderHovered = ref(false);
/** The pane's inside width (200px less its 16px gutters) over the folder's 200px. */
const FOLDER_SCALE = 0.84;

const fileTitle = (kind: InstructionKind): string => `${kind.toUpperCase()}.md`;

const copied = ref<InstructionKind | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyText(text: string | null, kind: InstructionKind): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    cue("copy");
    copied.value = kind;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.value = null;
    }, 2000);
  } catch {
    // Clipboard permission refused
  }
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<template>
  <div class="sp">
    <!-- Fixed pane: the way around, and the project's folder at the foot -->
    <aside class="sp__pane">
      <nav class="sp__nav" aria-label="Space sections">
        <button
          v-for="s in SECTIONS"
          :key="s.id"
          type="button"
          class="sp__nav-btn"
          :class="{ 'is-active': activeSection === s.id }"
          :aria-current="activeSection === s.id ? 'page' : undefined"
          :aria-label="s.label"
          :title="s.label"
          @click="scrollToSection(s.id)"
        >
          <HugeiconsIcon :icon="s.icon" :size="16" :stroke-width="1.8" aria-hidden="true" />
          <span class="sp__nav-label">{{ s.label }}</span>
        </button>
      </nav>

      <div
        class="sp__folder"
        @mouseenter="folderHovered = true"
        @mouseleave="folderHovered = false"
      >
        <ProjectFolder
          :name="project.name"
          :repo="summary?.repo ?? true"
          :branch="summary?.branch ?? null"
          :added="summary?.added ?? 0"
          :removed="summary?.removed ?? 0"
          :files="summary?.files ?? []"
          :scale="FOLDER_SCALE"
          :hovered="folderHovered"
        />
      </div>
    </aside>

    <!-- The camera's track: full-height columns side by side -->
    <main ref="trackEl" class="sp__track" @scroll.passive="onTrackScroll">
      <!-- Telemetry: Activity over Spend -->
      <SpaceColumn
        :ref="(el) => setColumnRef('activity', el)"
        class="sp__col sp__col--activity"
        title="Telemetry"
        :landed="landed === 'telemetry'"
      >
        <SpaceActivityCard :usage="usage" />
        <SpaceSpendCard :usage="usage" />
      </SpaceColumn>

      <!-- Models -->
      <SpaceColumn
        :ref="(el) => setColumnRef('models', el)"
        class="sp__col sp__col--models"
        title="Models"
        :landed="landed === 'models'"
        :style="enter('models')"
      >
        <SpaceModelsCard :usage="usage" />
      </SpaceColumn>

      <!-- Skills: what each provider can reach from here -->
      <SpaceColumn
        :ref="(el) => setColumnRef('skills', el)"
        class="sp__col sp__col--skills"
        title="Skills"
        :landed="landed === 'skills'"
        :style="enter('skills')"
      >
        <template #aside>
          <span v-if="skills.count.value" class="sp__head-lines">{{ skills.count.value }} skills</span>
        </template>
        <SpaceSkillsCard :groups="skills.groups.value" :settled="skills.settled.value" />
      </SpaceColumn>

      <!-- Instructions: AGENTS.md beside CLAUDE.md -->
      <div class="sp__last">
        <SpaceColumn
          v-for="kind in INSTRUCTION_KINDS"
          :key="kind"
          :ref="(el) => setColumnRef(kind, el)"
          class="sp__col sp__col--file"
          :class="`sp__col--${kind}`"
          :title="fileTitle(kind)"
          :landed="landed === 'instructions'"
          :style="enter(kind)"
        >
          <template #aside>
            <div v-if="instructions[kind].value.detected" class="sp__head-actions">
              <span class="sp__head-lines">{{ instructions[kind].value.lines }} lines</span>
              <button
                type="button"
                class="sp__head-btn"
                title="Reveal file in Finder"
                @click="instructions.reveal(instructions[kind].value.path)"
              >
                <HugeiconsIcon :icon="FolderOpenIcon" :size="13" :stroke-width="1.8" aria-hidden="true" />
                <span class="sr-only">Reveal file</span>
              </button>
              <button
                type="button"
                class="sp__head-btn"
                :title="copied === kind ? 'Copied' : 'Copy contents'"
                @click="copyText(instructions[kind].value.text, kind)"
              >
                <HugeiconsIcon
                  :icon="copied === kind ? Tick02Icon : Copy01Icon"
                  :size="13"
                  :stroke-width="1.8"
                  aria-hidden="true"
                />
                <span class="sr-only">{{ copied === kind ? 'Copied' : 'Copy' }}</span>
              </button>
            </div>
          </template>
          <SpaceInstructionsCard :info="instructions[kind].value" @create="instructions.create(kind)" />
        </SpaceColumn>
      </div>
    </main>

    <!-- The track's edges, faded where they cut into a column -->
    <div ref="fadeLeft" class="sp__edge sp__edge--left" aria-hidden="true" />
    <div ref="fadeRight" class="sp__edge sp__edge--right" aria-hidden="true" />
  </div>
</template>

<style scoped>
.sp {
  --pane: 200px;
  /* The fixed chrome row (back arrow, project nav, window controls) above. */
  --chrome: 3.75rem;
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding-top: var(--chrome);
  box-sizing: border-box;
  background-color: var(--ground);
}

/* ── the pane ────────────────────────────────────────────────────────────── */
.sp__pane {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 28px;
  width: var(--pane);
  padding: 1.5rem 16px;
  box-sizing: border-box;
  animation: sp-pane-in 0.42s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}

/* The project's folder rests at the foot of the pane. */
.sp__folder {
  margin-top: auto;
}

.sp__nav {
  display: flex;
  flex-direction: column;
}
.sp__nav-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 10px 0 14px;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-size: 13px;
  text-align: left;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.25s ease;
  user-select: none;
}
.sp__nav-btn:hover:not(.is-active) {
  color: var(--ink-soft);
}
.sp__nav-btn:focus-visible {
  outline: none;
  color: var(--ink);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent);
}
.sp__nav-btn.is-active {
  color: var(--ink);
  font-weight: 500;
}

/* ── the track ───────────────────────────────────────────────────────────── */
.sp__track {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  /* Panned by the nav, a swipe or Shift+wheel; a scrollbar only adds a bar. */
  scrollbar-width: none;
  /* The columns size against the track: a wide window shows several, a narrow
     one shows a column and the edge of the next. */
  container-type: inline-size;
  overscroll-behavior-x: contain;
}
.sp__track::-webkit-scrollbar {
  display: none;
}

/* The last section is at least as wide as the track, so the camera can carry
   its first column all the way to the pane instead of stopping where the
   content runs out. */
.sp__last {
  display: flex;
  flex: none;
  height: 100%;
  min-width: 100cqw;
}

/* Over the track's edges, fading into the ground where an edge cuts through a
   column. Each is as wide as the longest fade (EDGE_REACH, 40px) and scaled down
   from its edge to the length wanted (see syncCamera), so it starts at nothing. */
.sp__edge {
  position: absolute;
  top: var(--chrome);
  bottom: 0;
  z-index: 1;
  width: 40px;
  transform: scaleX(0);
  pointer-events: none;
}
.sp__edge--left {
  left: var(--pane);
  background: linear-gradient(to right, var(--ground) 20%, transparent);
  transform-origin: left;
}
.sp__edge--right {
  right: 0;
  background: linear-gradient(to left, var(--ground) 20%, transparent);
  transform-origin: right;
}

/* Wide enough for Activity's grid with its day panel at the right, as the
   Space board first had it (~940px inside the card). */
/* Columns keep their leading gutter small: with no rules between them, a column
   landing at the pane sits ~22px off it (the pane's 16px and this gutter). A
   section's last column keeps the full 1.5rem on its trailing side, so the gap
   between sections (30px) is wider than the gap between the columns of one
   (12px, AGENTS.md to CLAUDE.md). The gutter is COLUMN_GUTTER, which the camera
   keeps its edge fades off too. */
.sp__col {
  --col-pad-l: v-bind(gutter);
  animation: sp-col-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) backwards;
  animation-delay: var(--i, 0ms);
}
.sp__col--activity {
  width: min(1024px, calc(100cqw - 2.5rem));
}
.sp__col--models {
  width: min(420px, calc(100cqw - 2.5rem));
}
.sp__col--file,
.sp__col--skills {
  width: min(460px, calc(100cqw - 2.5rem));
}
.sp__col--agents {
  --col-pad-r: v-bind(gutter);
}

.sp__head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sp__head-lines {
  font-size: 11.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.sp__head-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  background-color: transparent;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}
.sp__head-btn:hover {
  color: var(--ink);
  background-color: var(--hover);
}

@keyframes sp-pane-in {
  from {
    opacity: 0;
    transform: translateX(-6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes sp-col-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* Narrow windows fold the pane down to its icons. */
@media (max-width: 1000px) {
  .sp {
    --pane: 56px;
  }
  .sp__pane {
    align-items: center;
    padding: 1.5rem 0;
  }
  .sp__nav-label,
  .sp__folder {
    display: none;
  }
  .sp__nav {
    width: 100%;
  }
  .sp__nav-btn {
    justify-content: center;
    padding: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sp__pane,
  .sp__col {
    animation: none;
  }
}
</style>
