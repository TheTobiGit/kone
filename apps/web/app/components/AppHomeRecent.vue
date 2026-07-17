<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  PinIcon,
  AppleFinderIcon,
  Cancel01Icon,
  Search01Icon,
  ArrowDown01Icon,
} from "@hugeicons/core-free-icons";
import type { ActionKey } from "./StartActions.vue";
import type { RecentProject } from "~/composables/useRecentProjects";

// The populated App Home — shown once you've opened at least one project.
// search + sort, a grid of project folders, then the quiet start-action column.
// Each folder is enriched with live git (branch · diffstat · peeking papers)
// the same way the opened-project view is.

const props = defineProps<{
  recents: RecentProject[];
  pending?: ActionKey | null;
}>();
const emit = defineEmits<{
  open: [project: RecentProject];
  start: [key: ActionKey];
  pin: [path: string];
  reveal: [path: string];
  forget: [path: string];
}>();

const { summaries, enrich } = useProjectSummaries();

// Resolve git for every project in view, and for any that get added later.
watch(
  () => props.recents.map((p) => p.path),
  (paths) => {
    for (const path of paths) void enrich(path);
  },
  { immediate: true },
);

// ── search + sort ───────────────────────────────────────────────────────────
const query = ref("");
type Sort = "recent" | "name";
const sort = ref<Sort>("recent");
const sortLabel = computed(() => (sort.value === "recent" ? "Recent" : "Name"));
function cycleSort() {
  sort.value = sort.value === "recent" ? "name" : "recent";
}

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  const list = q
    ? props.recents.filter((p) => p.name.toLowerCase().includes(q))
    : props.recents;
  if (sort.value === "name") {
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }
  return list; // already newest-first from the store
});

// ⌘K / Ctrl-K focuses the search field.
const searchEl = ref<HTMLInputElement | null>(null);
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    searchEl.value?.focus();
  }
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

const anyPending = computed(() => !!props.pending);

// Which card the pointer/focus is on — drives the folder's papers springing out.
const hoveredPath = ref<string | null>(null);
</script>

<template>
  <main
    class="relative flex h-full min-h-screen flex-col overflow-hidden bg-ground px-16 pt-[52px] pb-16"
  >
    <!-- Header: date on the left; search + sort trailing. -->
    <HomeHeader>
      <template #trailing>
        <div class="flex items-center gap-3">
          <label
            class="flex h-9 items-center gap-2.5 rounded-[11px] bg-hover px-3 transition-colors focus-within:bg-hover"
          >
            <HugeiconsIcon
              :icon="Search01Icon"
              :size="15"
              :stroke-width="2"
              class="shrink-0 text-muted"
              aria-hidden="true"
            />
            <input
              ref="searchEl"
              v-model="query"
              type="text"
              placeholder="Search projects"
              class="w-44 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
            />
            <kbd
              class="rounded-[5px] border border-muted/25 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted"
              >⌘K</kbd
            >
          </label>

          <button
            type="button"
            class="flex h-9 cursor-pointer items-center gap-1.5 rounded-[11px] px-3 text-sm font-medium text-ink-soft transition-colors hover:bg-hover"
            @click="cycleSort"
          >
            <span>{{ sortLabel }}</span>
            <HugeiconsIcon
              :icon="ArrowDown01Icon"
              :size="12"
              :stroke-width="2"
              class="text-muted"
              aria-hidden="true"
            />
          </button>
        </div>
      </template>
    </HomeHeader>

    <!-- Content block sits toward the top-center of the open space. -->
    <section class="relative z-10 mx-auto mt-24 flex w-full max-w-[820px] flex-col">
      <!-- Project grid — three across, generously spaced. The start actions
           flow as trailing cells right after the last project, so they read as
           part of the same run rather than a separate block below. Each cell
           rises and settles in reading order (a small per-index delay) so the
           grid assembles itself instead of appearing all at once. -->
      <div class="grid grid-cols-3 gap-x-14 gap-y-6">
        <motion.div
          v-for="(project, i) in shown"
          :key="project.path"
          class="relative w-fit pr-9"
          :initial="{ opacity: 0, y: 12, scale: 0.97 }"
          :animate="{ opacity: 1, y: 0, scale: 1 }"
          :transition="{
            type: 'spring',
            stiffness: 340,
            damping: 13,
            mass: 0.85,
            delay: i * 0.06,
          }"
          @mouseenter="hoveredPath = project.path"
          @mouseleave="hoveredPath = null"
        >
          <!-- Springy lift on hover/focus (driven by the card-level hover so it
               stays lifted while the pointer is on the action rail). Motion
               physics gives a soft overshoot-and-settle; held flat while any
               action is pending. -->
          <motion.button
            type="button"
            :disabled="anyPending"
            class="block cursor-pointer rounded-[22px] text-left focus-visible:outline-none disabled:cursor-default"
            :animate="{ y: !anyPending && hoveredPath === project.path ? -6 : 0 }"
            :while-tap="anyPending ? {} : { y: -3, scale: 0.985 }"
            :transition="{ type: 'spring', stiffness: 420, damping: 17, mass: 0.85 }"
            @focus="hoveredPath = project.path"
            @blur="hoveredPath = null"
            @click="emit('open', project)"
          >
            <ProjectFolder
              :name="project.name"
              :repo="summaries[project.path]?.repo ?? true"
              :branch="summaries[project.path]?.branch ?? null"
              :added="summaries[project.path]?.added ?? 0"
              :removed="summaries[project.path]?.removed ?? 0"
              :files="summaries[project.path]?.files ?? []"
              :hovered="!anyPending && hoveredPath === project.path"
            />
          </motion.button>

          <!-- Hover action rail — a quiet vertical stack floating just outside
               the folder's right edge (in the card's padding gutter), revealed
               on hover: Pin · Reveal · Remove. The gutter keeps it within the
               column track so it never clips at the last column, and inside the
               card's hover box so hovering it holds the card's hover state. -->
          <motion.div
            class="absolute right-0 top-0 bottom-0 flex flex-col justify-center gap-1.5"
            :initial="{ opacity: 0, x: 4 }"
            :animate="{
              opacity: !anyPending && hoveredPath === project.path ? 1 : 0,
              x: !anyPending && hoveredPath === project.path ? 0 : 4,
              y: !anyPending && hoveredPath === project.path ? -6 : 0,
            }"
            :transition="{ type: 'spring', stiffness: 500, damping: 30 }"
            :style="{
              pointerEvents:
                !anyPending && hoveredPath === project.path ? 'auto' : 'none',
            }"
          >
            <!-- Pin to top — filled star when pinned. -->
            <button
              type="button"
              :aria-label="project.pinned ? 'Unpin project' : 'Pin to top'"
              :title="project.pinned ? 'Unpin' : 'Pin to top'"
              class="flex size-6 cursor-pointer items-center justify-center rounded-full bg-ground shadow-sm transition-colors hover:text-ink"
              :class="project.pinned ? 'text-ink' : 'text-muted'"
              @click.stop="emit('pin', project.path)"
            >
              <HugeiconsIcon
                :icon="PinIcon"
                :size="14"
                :stroke-width="project.pinned ? 2.4 : 1.8"
                aria-hidden="true"
              />
            </button>

            <!-- Reveal in Finder. -->
            <button
              type="button"
              aria-label="Reveal in Finder"
              title="Reveal in Finder"
              class="flex size-6 cursor-pointer items-center justify-center rounded-full bg-ground text-muted shadow-sm transition-colors hover:text-ink"
              @click.stop="emit('reveal', project.path)"
            >
              <HugeiconsIcon
                :icon="AppleFinderIcon"
                :size="15"
                :stroke-width="1.7"
                aria-hidden="true"
              />
            </button>

            <!-- Remove from recents. -->
            <button
              type="button"
              aria-label="Remove from recents"
              title="Remove"
              class="flex size-6 cursor-pointer items-center justify-center rounded-full bg-ground text-muted shadow-sm transition-colors hover:text-ink"
              @click.stop="emit('forget', project.path)"
            >
              <HugeiconsIcon
                :icon="Cancel01Icon"
                :size="14"
                :stroke-width="2"
                aria-hidden="true"
              />
            </button>
          </motion.div>
        </motion.div>

        <!-- Start actions — the same three-way column as the first-run hero,
             kept as one unit but flowed as a trailing cell so it continues the
             grid run rather than starting a fresh block below. Rises in right
             after the last project, closing the stagger. Centers against the
             taller folder cells sharing its row. -->
        <motion.div
          class="-ml-1.5 self-center"
          :initial="{ opacity: 0, y: 12, scale: 0.97 }"
          :animate="{ opacity: 1, y: 0, scale: 1 }"
          :transition="{
            type: 'spring',
            stiffness: 340,
            damping: 13,
            mass: 0.85,
            delay: shown.length * 0.06,
          }"
        >
          <StartActions :pending="pending" @start="emit('start', $event)" />
        </motion.div>
      </div>

      <!-- No match for the current search. -->
      <p
        v-if="shown.length === 0"
        class="py-6 font-mono text-xs tracking-wide text-muted"
      >
        No projects match "{{ query }}"
      </p>
    </section>
  </main>
</template>
