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

watch(
  () => props.recents.map((p) => p.path),
  (paths) => {
    for (const path of paths) void enrich(path);
  },
  { immediate: true },
);

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
    // Name sort still keeps pins leading (alpha within each group).
    return [...list].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
  return list;
});

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

const hoveredPath = ref<string | null>(null);
</script>

<template>
  <main
    class="relative flex h-full min-h-screen flex-col overflow-hidden bg-ground px-16 pt-[52px] pb-16"
  >
    <h1 class="sr-only">Your projects</h1>

    <HomeHeader>
      <template #trailing>
        <div class="flex items-center gap-3">
          <SoundToggle />

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
              class="w-44 bg-transparent text-base text-ink outline-none placeholder:text-muted sm:text-sm"
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

    
    <section class="relative z-10 mx-auto mt-24 flex w-full max-w-[820px] flex-col">
      
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

      
      <p
        v-if="shown.length === 0"
        class="py-6 font-mono text-xs tracking-wide text-muted"
      >
        No projects match “{{ query }}”
      </p>
    </section>
  </main>
</template>
