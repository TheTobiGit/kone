<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { motion } from "motion-v";
import { onClickOutside } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowRight01Icon,
  Folder01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import PlusSign from "~/components/icons/animated/PlusSign.vue";
import FolderOpen from "~/components/icons/animated/FolderOpen.vue";
import Github from "~/components/icons/animated/Github.vue";
import { useRecentProjects, type RecentProject } from "~/composables/useRecentProjects";
import { useProjectSummaries } from "~/composables/useProjectSummaries";
import { useSound } from "~/composables/useSound";

// Project selection modal — positioned directly beneath the question button with no backdrop blur:
// 1. Projects list card: Single-line rows with git branch right next to project name
// 2. New project actions card: Quick actions to create, open, or clone

const props = defineProps<{
  /** The path of the currently active project — omitted from the switcher list. */
  currentPath?: string;
  /** Optional explicit project list. Defaults to all recent projects. */
  projects?: RecentProject[];
}>();

const emit = defineEmits<{
  select: [project: RecentProject];
  cancel: [];
}>();

const { recents, remember } = useRecentProjects();
const { cue } = useSound();
const { summaries, subscribe } = useProjectSummaries();
const { reset: resetClone } = useGitClone();
const { reset: resetCreate } = useCreateProject();

const allProjects = computed<RecentProject[]>(() => props.projects ?? recents.value);

// Filter out the active project; prioritize pinned projects first, then recency
const displayProjects = computed<RecentProject[]>(() => {
  const list = allProjects.value.filter((p) => p.path !== props.currentPath);
  return [...list].sort((a, b) => {
    const ap = a.pinned ? 1 : 0;
    const bp = b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0);
  });
});

// Live git summaries for displayed projects
subscribe(() => displayProjects.value.map((p) => p.path));

// ── new project actions ──────────────────────────────────────────────────────
const actions = [
  { key: "create", label: "Create a new project", icon: PlusSign },
  { key: "open", label: "Open from local folder", icon: FolderOpen },
  { key: "clone", label: "Clone from GitHub", icon: Github },
] as const;

type ActionKey = (typeof actions)[number]["key"];
const activeSubModal = ref<ActionKey | null>(null);

function handleAction(key: ActionKey): void {
  cue("press");
  if (key === "clone") resetClone();
  if (key === "create") resetCreate();
  activeSubModal.value = key;
}

function onSubModalSuccess(folder: { path: string; name: string }): void {
  remember(folder);
  activeSubModal.value = null;
  resetClone();
  resetCreate();
  cue("open");
  close(() => emit("select", { ...folder, lastOpenedAt: Date.now() }));
}

function onSubModalCancel(): void {
  activeSubModal.value = null;
  resetClone();
  resetCreate();
}

// ── selection & dismissal ───────────────────────────────────────────────────
const shown = ref(false);
const closing = ref(false);
const contentEl = ref<HTMLElement | null>(null);

onClickOutside(contentEl, () => {
  if (!activeSubModal.value) onCancel();
});

function close(done: () => void): void {
  if (closing.value) return;
  closing.value = true;
  shown.value = false;
  window.setTimeout(done, 200);
}

function onCancel(): void {
  if (activeSubModal.value) return;
  close(() => emit("cancel"));
}

function choose(project: RecentProject): void {
  cue("open");
  close(() => emit("select", project));
}

function onKeydown(e: KeyboardEvent): void {
  if (activeSubModal.value) return;
  if (e.key === "Escape") {
    e.preventDefault();
    onCancel();
  }
}

let opener: HTMLElement | null = null;

onMounted(async () => {
  // SAFETY: activeElement is the element focused before open; null is allowed by type.
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);

  await nextTick();
  requestAnimationFrame(() => {
    shown.value = true;
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  opener?.focus();
});

const cardSpring = {
  type: "spring",
  stiffness: 340,
  damping: 24,
  mass: 0.85,
} as const;
</script>

<template>
  <div class="relative z-30">
    <!-- Single compact outer shell with narrower width positioned at button -->
    <motion.div
      ref="contentEl"
      class="modal-shell flex w-[300px] flex-col overflow-hidden text-left"
      :initial="{ opacity: 0, y: -6, scale: 0.97 }"
      :animate="{
        opacity: shown ? 1 : 0,
        y: shown ? 0 : -6,
        scale: shown ? 1 : 0.97,
      }"
      :transition="cardSpring"
      role="dialog"
      aria-modal="true"
      aria-label="Switch project"
    >
      <div class="picker-inner flex shrink-0 flex-col">
        <!-- Recessed header band with arc scoops -->
        <div class="picker-header flex items-center justify-between gap-3">
          <span class="picker-title">Switch project</span>
          <button
            type="button"
            class="picker-action shrink-0 text-muted"
            @click="onCancel"
          >
            Cancel
          </button>
        </div>

        <!-- Tray containing the two inset cards with ultra-slim padding and distinct gap -->
        <div class="picker-tray flex flex-col gap-[5px] px-[1px] pb-[1px]">
          <!-- Section 1: Projects List Card -->
          <section
            v-if="displayProjects.length > 0"
            class="picker-card picker-card--list flex flex-col overflow-hidden"
            aria-label="Projects list"
          >
            <div class="picker-scroll flex max-h-[35vh] flex-col gap-0.5 overflow-y-auto p-1">
              <button
                v-for="p in displayProjects"
                :key="p.path"
                type="button"
                class="project-row"
                @click="choose(p)"
              >
                <span class="project-row__lead">
                  <HugeiconsIcon
                    :icon="Folder01Icon"
                    :size="15"
                    :stroke-width="1.7"
                    class="project-row__folder"
                    aria-hidden="true"
                  />
                </span>

                <span class="project-row__name" :title="p.name">{{ p.name }}</span>

                <span
                  v-if="summaries[p.path]?.branch"
                  class="project-row__branch"
                  :title="summaries[p.path]?.branch ?? undefined"
                >
                  <HugeiconsIcon :icon="GitBranchIcon" :size="11" :stroke-width="1.8" aria-hidden="true" />
                  <span>{{ summaries[p.path]?.branch }}</span>
                </span>
              </button>
            </div>
          </section>

          <!-- Section 2: New Project Actions Card -->
          <section class="picker-card picker-card--actions flex flex-col p-1" aria-label="New project actions">
            <button
              v-for="action in actions"
              :key="action.key"
              type="button"
              class="action-row"
              @click="handleAction(action.key)"
            >
              <span class="action-row__icon">
                <component
                  :is="action.icon"
                  :size="16"
                  :stroke-width="1.7"
                  trigger="hover"
                />
              </span>
              <span class="action-row__label">{{ action.label }}</span>
              <HugeiconsIcon
                :icon="ArrowRight01Icon"
                :size="13"
                :stroke-width="2"
                class="action-row__arrow text-muted"
                aria-hidden="true"
              />
            </button>
          </section>
        </div>
      </div>
    </motion.div>

    <!-- Sub-modals for creation / opening / cloning teleported to body -->
    <Teleport to="body">
      <UiFolderPickerModal
        v-if="activeSubModal === 'open'"
        @select="onSubModalSuccess"
        @cancel="onSubModalCancel"
      />

      <UiGitHubCloneModal
        v-if="activeSubModal === 'clone'"
        @clone="onSubModalSuccess"
        @cancel="onSubModalCancel"
      />

      <ProjectCreateProjectModal
        v-if="activeSubModal === 'create'"
        @create="onSubModalSuccess"
        @cancel="onSubModalCancel"
      />
    </Teleport>
  </div>
</template>

<style scoped>
/* Outer tray shell */
.modal-shell {
  --band-bg: var(--band);
  --band-arc: 14px;
  background: var(--band-bg);
  border-radius: 20px;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 10%, transparent),
    0 16px 36px -8px rgb(0 0 0 / 0.36);
}

/* Recessed header band with concave arc scoops */
.picker-header {
  position: relative;
  padding: 0.5rem 0.8rem;
  background-color: var(--band-bg);
}

.picker-header::before,
.picker-header::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}

.picker-header::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.picker-header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.picker-title {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

.picker-action {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}

.picker-action:hover {
  opacity: 0.7;
}

/* Tray framing the two cards with ultra-slim concentric padding and distinct gap */
.picker-tray {
  padding: 0 1px 1px;
}

/* The two distinct elevated cards inside the shell */
.picker-card {
  background: var(--panel);
  border-radius: 18px;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 6%, transparent),
    0 1px 2px rgb(0 0 0 / 0.05);
}

/* Project Single-Line Row — branch sits directly adjacent to name */
.project-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  width: 100%;
  padding: 0.42rem 0.55rem;
  border-radius: 9px;
  text-align: left;
  cursor: pointer;
  color: var(--ink);
  transition: background-color 0.16s ease;
}

.project-row:hover {
  background-color: var(--hover);
}

.project-row:focus-visible {
  outline: none;
  background-color: var(--hover);
}

.project-row__lead {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
}

.project-row__folder {
  color: var(--muted);
  transition: color 0.18s ease;
}

.project-row:hover .project-row__folder {
  color: var(--ink-soft);
}

.project-row__name {
  flex: 0 1 auto;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-row__branch {
  display: inline-flex;
  align-items: center;
  gap: 2.5px;
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--muted);
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Action Rows */
.action-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  padding: 0.42rem 0.55rem;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--ink);
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;
}

.action-row:hover {
  background-color: var(--hover);
}

.action-row:focus-visible {
  outline: none;
  background-color: var(--hover);
}

.action-row__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--ink-soft);
  transition: color 0.16s ease;
}

.action-row:hover .action-row__icon {
  color: var(--ink);
}

.action-row__label {
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
}

.action-row__arrow {
  flex: none;
  opacity: 0;
  transform: translateX(-3px);
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.action-row:hover .action-row__arrow {
  opacity: 1;
  transform: translateX(0);
}

/* Scrollbar */
.picker-scroll {
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 16%, transparent) transparent;
}

.picker-scroll::-webkit-scrollbar {
  width: 5px;
}

.picker-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.picker-scroll::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
  border: 1px solid transparent;
  background-clip: content-box;
}

.picker-scroll:hover::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
}
</style>
