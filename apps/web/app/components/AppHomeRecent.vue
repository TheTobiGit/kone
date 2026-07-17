<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion } from "motion-v";
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
  forget: [path: string];
  start: [key: ActionKey];
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
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              class="shrink-0 text-muted"
              aria-hidden="true"
            >
              <circle
                cx="11"
                cy="11"
                r="7"
                stroke="currentColor"
                stroke-width="2"
              />
              <path
                d="m20 20-3.5-3.5"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
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
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              class="text-muted"
              aria-hidden="true"
            >
              <path
                d="m6 9 6 6 6-6"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </template>
    </HomeHeader>

    <!-- Content block sits toward the top-center of the open space. -->
    <section class="relative z-10 mx-auto mt-24 flex w-full max-w-[820px] flex-col">
      <!-- Project grid — three across, generously spaced. The start actions
           flow as trailing cells right after the last project, so they read as
           part of the same run rather than a separate block below. -->
      <motion.div
        class="grid grid-cols-3 gap-x-14 gap-y-6"
        :initial="{ opacity: 0, y: 8 }"
        :animate="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }"
      >
        <div
          v-for="project in shown"
          :key="project.path"
          class="group/card relative w-fit"
        >
          <button
            type="button"
            :disabled="anyPending"
            class="block cursor-pointer rounded-[22px] text-left transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-1 focus-visible:-translate-y-1 focus-visible:outline-none disabled:cursor-default disabled:hover:translate-y-0"
            @click="emit('open', project)"
          >
            <ProjectFolder
              :name="project.name"
              :repo="summaries[project.path]?.repo ?? true"
              :branch="summaries[project.path]?.branch ?? null"
              :added="summaries[project.path]?.added ?? 0"
              :removed="summaries[project.path]?.removed ?? 0"
              :files="summaries[project.path]?.files ?? []"
            />
          </button>

          <!-- Remove from recents — appears on hover, top-right of the card. -->
          <button
            type="button"
            aria-label="Remove from recents"
            class="absolute right-1.5 top-1.5 flex size-6 cursor-pointer items-center justify-center rounded-full bg-ground text-muted opacity-0 shadow-sm transition-opacity duration-200 hover:text-ink group-hover/card:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
            @click.stop="emit('forget', project.path)"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>

        <!-- Start actions — the same three-way column as the first-run hero,
             kept as one unit but flowed as a trailing cell so it continues the
             grid run rather than starting a fresh block below. Centers against
             the taller folder cells sharing its row. -->
        <div class="-ml-1.5 self-center">
          <StartActions :pending="pending" @start="emit('start', $event)" />
        </div>
      </motion.div>

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
