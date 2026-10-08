<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { onClickOutside } from "@vueuse/core";
import { useThreadEscape } from "~/composables/useThreadEscape";
import { AnimatePresence, motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { CheckListIcon, FileEditIcon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import GitSpaceChangedFilesList from "~/components/git-space/GitSpaceChangedFilesList.vue";
import PlanTaskList from "~/components/plan/PlanTaskList.vue";
import AgentSubagentDock from "~/components/agent/AgentSubagentDock.vue";
import DockShell from "~/components/thread/DockShell.vue";
import type { DockSectionId } from "~/composables/useDockSections";
import type { ActivePlanState } from "~/utils/planTasks";
import type { ChangedFilesState } from "~/utils/changedFiles";
import type { DelegatesState } from "~/utils/subagentRuns";

const props = withDefaults(
  defineProps<{
    composerOpen?: boolean;
    changes?: ChangedFilesState | null;
    plan?: ActivePlanState | null;
    delegates?: DelegatesState | null;
    projectPath?: string;
    threadKey?: string | null;
    positionMode?: "absolute-pane" | "fixed";
    /** Where the open composer's top edge sits, in px off the surface's
     *  bottom — the rail rests just above it. */
    composerTop?: number;
  }>(),
  {
    composerOpen: false,
    changes: null,
    plan: null,
    delegates: null,
    projectPath: undefined,
    threadKey: "dock",
    positionMode: "absolute-pane",
    composerTop: 0,
  },
);

const emit = defineEmits<{
  openFile: [path: string, rect: DOMRect | null];
  "stop-subagent": [toolUseId: string];
}>();

const subagents = computed(() => (props.delegates?.rows.length ? props.delegates : null));

const hasChanges = computed(() => (props.changes?.files?.length ?? 0) > 0);

const hasContent = computed(() => Boolean(hasChanges.value || props.plan || subagents.value));

// Two stances. With the composer closed the shell rests in the bottom-right
// corner, every section in it. With it open the space above the composer is
// the user's, so the shell folds into a rail of tiles on the pane's right
// edge, resting just above the composer — one per section, its count on it —
// and a tile opens the shell beside the rail at that section.
const railed = computed(() => props.composerOpen);

/** The tile the shell was opened from, or none while only the rail shows. */
const popped = ref<DockSectionId | null>(null);
const railEl = ref<HTMLElement | null>(null);

const { cue } = useSound();

function pick(id: DockSectionId): void {
  const opening = popped.value !== id;
  popped.value = opening ? id : null;
  cue(opening ? "expand" : "collapse");
}

function closePopped(): void {
  if (!popped.value) return;
  popped.value = null;
  cue("collapse");
}

onClickOutside(railEl, closePopped);
useThreadEscape()("rail", () => Boolean(popped.value), closePopped);

// The popped shell belongs to the rail: leaving the rail (the composer
// closing) or the thread drops it, and a section that empties takes its tile.
watch([railed, () => props.threadKey], () => (popped.value = null));

type Tile = { id: DockSectionId; label: string; count: string; live: boolean; icon: typeof FileEditIcon };

const tiles = computed<Tile[]>(() => {
  const out: Tile[] = [];
  if (hasChanges.value && props.changes) {
    const n = props.changes.files.length;
    out.push({ id: "changes", label: `Changes · ${n} ${n === 1 ? "file" : "files"}`, count: String(n), live: props.changes.streaming, icon: FileEditIcon });
  }
  if (props.plan) {
    const tasks = props.plan.tasks;
    const done = tasks.filter((t) => t.status === "completed").length;
    out.push({ id: "tasks", label: `Tasks · ${done} of ${tasks.length} done`, count: `${done}/${tasks.length}`, live: props.plan.streaming, icon: CheckListIcon });
  }
  if (subagents.value) {
    const rows = subagents.value.rows;
    const running = rows.filter((r) => r.live).length;
    out.push({
      id: "subagents",
      label: `Subagents · ${running ? `${running} running` : `${rows.length} done`}`,
      count: String(running || rows.length),
      live: subagents.value.streaming,
      icon: UserMultipleIcon,
    });
  }
  return out;
});

watch(tiles, (list) => {
  if (popped.value && !list.some((t) => t.id === popped.value)) popped.value = null;
});

/** Anything the shell holds still in flight — the header says so. */
const live = computed(() =>
  Boolean(
    (hasChanges.value && props.changes?.streaming) ||
      props.plan?.streaming ||
      subagents.value?.streaming,
  ),
);

/** The footer's line: what each section holds, in one breath. */
const meta = computed(() => {
  const parts: string[] = [];
  const files = props.changes?.files?.length ?? 0;
  if (files) parts.push(`${files} ${files === 1 ? "file" : "files"}`);
  const tasks = props.plan?.tasks ?? [];
  if (tasks.length) {
    const done = tasks.filter((t) => t.status === "completed").length;
    parts.push(`${done}/${tasks.length} tasks`);
  }
  const rows = subagents.value?.rows ?? [];
  if (rows.length) {
    const running = rows.filter((r) => r.live).length;
    parts.push(
      running
        ? `${running} ${running === 1 ? "agent" : "agents"} running`
        : `${rows.length} ${rows.length === 1 ? "agent" : "agents"}`,
    );
  }
  return parts.join(" · ");
});
</script>

<template>
  <div
    v-show="hasContent"
    class="thread-dock-stack"
    :class="railed ? `docks-rail docks-rail--${positionMode}` : `docks-corner docks-corner--${positionMode}`"
    :style="railed ? { '--rail-lift': `${composerTop + 10}px` } : undefined"
  >
    <!-- The rail: a tile per section, the shell popping out beside it. -->
    <div v-if="railed" ref="railEl" data-agent-dock class="dock-rail">
      <div class="dock-rail__tiles" role="toolbar" aria-label="Thread docks">
        <button
          v-for="tile in tiles"
          :key="tile.id"
          type="button"
          class="dock-tile"
          :class="{ 'dock-tile--on': popped === tile.id, 'dock-tile--live': tile.live }"
          :aria-label="tile.label"
          :aria-pressed="popped === tile.id"
          :title="tile.label"
          @click="pick(tile.id)"
        >
          <HugeiconsIcon :icon="tile.icon" :size="15" :stroke-width="1.8" aria-hidden="true" />
          <span class="dock-tile__count">{{ tile.count }}</span>
        </button>
      </div>

      <AnimatePresence>
        <motion.div
          v-if="popped"
          key="popped"
          class="dock-rail__pop"
          :initial="{ opacity: 0, x: 10 }"
          :animate="{ opacity: 1, x: 0 }"
          :exit="{ opacity: 0, x: 8 }"
          :transition="{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }"
        >
          <DockShell
            :key="`agent-dock-pop-${threadKey}`"
            bands
            :title="live ? 'Working' : 'This thread'"
            :live="live"
            :meta="meta"
            :focus="popped"
          >
            <AnimatePresence :initial="false">
              <GitSpaceChangedFilesList
                v-if="hasChanges && changes"
                key="changes"
                :files="changes.files"
                :total-added="changes.totalAdded"
                :total-removed="changes.totalRemoved"
                :streaming="changes.streaming"
                :repo-path="projectPath"
                @open-file="(path, rect) => emit('openFile', path, rect)"
              />
            </AnimatePresence>
            <AnimatePresence :initial="false">
              <PlanTaskList v-if="plan" key="plan" :tasks="plan.tasks" :streaming="plan.streaming" />
            </AnimatePresence>
            <AnimatePresence :initial="false">
              <AgentSubagentDock
                v-if="subagents"
                key="subagents"
                :rows="subagents.rows"
                :streaming="subagents.streaming"
                @stop-subagent="emit('stop-subagent', $event)"
              />
            </AnimatePresence>
          </DockShell>
        </motion.div>
      </AnimatePresence>
    </div>

    <!-- The corner: the whole shell, resting. -->
    <AnimatePresence v-else :initial="false" mode="wait">
      <DockShell
        :key="`agent-dock-${threadKey}`"
        bands
        :title="live ? 'Working' : 'This thread'"
        :live="live"
        :meta="meta"
      >
        <AnimatePresence :initial="false">
          <GitSpaceChangedFilesList
            v-if="hasChanges && changes"
            key="changes"
            :files="changes.files"
            :total-added="changes.totalAdded"
            :total-removed="changes.totalRemoved"
            :streaming="changes.streaming"
            :repo-path="projectPath"
            @open-file="(path, rect) => emit('openFile', path, rect)"
          />
        </AnimatePresence>
        <AnimatePresence :initial="false">
          <PlanTaskList v-if="plan" key="plan" :tasks="plan.tasks" :streaming="plan.streaming" />
        </AnimatePresence>
        <AnimatePresence :initial="false">
          <AgentSubagentDock
            v-if="subagents"
            key="subagents"
            :rows="subagents.rows"
            :streaming="subagents.streaming"
            @stop-subagent="emit('stop-subagent', $event)"
          />
        </AnimatePresence>
      </DockShell>
    </AnimatePresence>
  </div>
</template>

<style scoped>
.thread-dock-stack {
  z-index: 40;
  pointer-events: none;
  --dock-width: min(18rem, calc(100vw - 2.5rem));
}
.thread-dock-stack > * {
  pointer-events: auto;
}

/* ── corner ── the shell sits bottom-right, every section in it. */
.docks-corner {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  --dock-tray-max: min(36rem, calc(100vh - 10rem));
}
.docks-corner--absolute-pane {
  position: absolute;
  right: 12px;
  bottom: 12px;
}
.docks-corner--fixed {
  position: fixed;
  right: 2rem;
  bottom: 2rem;
}

/* ── rail ── tiles on the right edge, resting just above the open composer. */
.docks-rail {
  bottom: var(--rail-lift, 12px);
  --dock-tray-max: min(30rem, calc(100vh - var(--rail-lift, 12px) - 8rem));
}
.docks-rail--absolute-pane {
  position: absolute;
  right: 10px;
}
.docks-rail--fixed {
  position: fixed;
  right: 1.25rem;
}

.dock-rail {
  position: relative;
}
.dock-rail__tiles {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 3px;
  border-radius: 14px;
  background: var(--band);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 8px 22px -12px rgb(0 0 0 / 0.18);
}
.dock-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 38px;
  min-height: 40px;
  padding: 5px 2px 4px;
  border: 0;
  border-radius: 11px;
  background: var(--panel);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 6%, transparent);
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
}
.dock-tile:hover,
.dock-tile:focus-visible {
  outline: none;
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 4%, var(--panel));
}
.dock-tile--on {
  color: var(--ink);
  background: color-mix(in oklab, var(--accent) 12%, var(--panel));
}
.dock-tile__count {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 9.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.dock-tile--on .dock-tile__count {
  color: var(--ink-soft);
}
/* A section with work in flight wears a pulsing dot on its tile's corner. */
.dock-tile--live::after {
  content: "";
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--accent);
  animation: dock-tile-pulse 1.4s ease-in-out infinite;
}
@keyframes dock-tile-pulse {
  50% {
    opacity: 0.35;
  }
}

/* The shell, popped out to the rail's left, bottom-aligned with it so it
   grows upward and never drops over the composer. */
.dock-rail__pop {
  position: absolute;
  bottom: 0;
  right: calc(100% + 10px);
}

@media (prefers-reduced-motion: reduce) {
  .dock-tile--live::after {
    animation: none;
  }
}
</style>
