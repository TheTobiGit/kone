<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion } from "motion-v";
import ArrowDown01 from "~/components/icons/animated/ArrowDown01.vue";
import AppleFinder from "~/components/icons/animated/AppleFinder.vue";
import Cancel01 from "~/components/icons/animated/Cancel01.vue";
import Pin from "~/components/icons/animated/Pin.vue";
import Search01 from "~/components/icons/animated/Search01.vue";
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
  settings: [];
  profile: [];
  openSession: [target: { path: string; name: string; threadId: string }];
}>();

const { summaries, watchVisible } = useProjectSummaries();

// The signed-in user — name and avatar ride the far-right of the top bar.
// Resolved once (shared state); shown only once a name comes back.
const { name, initial, image, avatarStyle, resolve: resolveProfile } = useProfile();
onMounted(resolveProfile);

// The cross-project "recent sessions" list below the grid — every recent
// project's pinned + recent conversations pooled into one recency-ranked stream.
// Pin/archive/delete act through the composable directly (they key on thread id);
// opening one has to switch the active project first, so it routes to the page.
const sessions = useAllRecentSessions();

function onOpenSession(threadId: string): void {
  const row =
    sessions.pinned.value.find((s) => s.threadId === threadId) ??
    sessions.recent.value.find((s) => s.threadId === threadId);
  if (!row?.projectPath) return;
  emit("openSession", {
    path: row.projectPath,
    name: row.projectName ?? row.projectPath,
    threadId,
  });
}

// Live git for the folders on the grid — each tile watches its repo (so branch
// and ± refresh in realtime, in lockstep with the open project) but only while
// it's on screen, so a long list holds a handful of watchers, not one per repo.
const vGitWatch = watchVisible();

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

// A folder is lifted (papers fanned, side-actions shown) when the pointer is
// over it OR the keyboard focus sits anywhere in its group. Tracking focus at
// the group level — not on the folder button alone — keeps the pin/reveal/remove
// actions revealed while you tab through them, instead of hiding the instant
// focus leaves the button and stranding you on an invisible control.
const hoveredPath = ref<string | null>(null);
const focusedPath = ref<string | null>(null);

function isActive(path: string) {
  return (
    !anyPending.value &&
    (hoveredPath.value === path || focusedPath.value === path)
  );
}

// Clear the group's focus only when focus lands outside it (relatedTarget is the
// element gaining focus); moving between the folder button and its side actions
// keeps the group active.
function onFolderFocusOut(e: FocusEvent) {
  // SAFETY: currentTarget is the folder wrapper this focusout handler is bound to.
  const wrap = e.currentTarget as HTMLElement;
  // SAFETY: relatedTarget is the element gaining focus — always a Node, and null already fits the type.
  if (!wrap.contains(e.relatedTarget as Node | null)) focusedPath.value = null;
}

// Side actions are mouse-first; clear lift state when one fires so a clicked
// button doesn't keep focus (and the actions visible) after the pointer leaves,
// and so a pin reorder that moves the folder in the grid can't strand hover.
function onSideAction(
  path: string,
  action: "pin" | "reveal" | "forget",
): void {
  hoveredPath.value = null;
  focusedPath.value = null;
  if (action === "pin") emit("pin", path);
  else if (action === "reveal") emit("reveal", path);
  else if (action === "forget") emit("forget", path);
}
</script>

<template>
  <main
    class="relative flex h-screen flex-col overflow-hidden bg-ground px-16 pt-5 pb-16"
  >
    <h1 class="sr-only">Your projects</h1>

    <HomeHeader>
      <template #leading>
        <RotatingWordmark />
      </template>

      <template #trailing>
        <div class="flex items-center gap-3">
          <SettingsButton @open="emit('settings')" />

          <label
            class="flex h-9 items-center gap-2.5 rounded-[11px] bg-hover px-3 transition-colors focus-within:bg-hover"
          >
            <Search01
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
            class="flex h-9 cursor-pointer items-center gap-1.5 rounded-[11px] px-3 text-sm font-medium text-ink-soft transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
            @click="cycleSort"
          >
            <span>{{ sortLabel }}</span>
            <ArrowDown01
              :size="12"
              :stroke-width="2"
              class="text-muted"
              aria-hidden="true"
            />
          </button>

          <!-- The signed-in user's profile chip, closing the top bar at the
               far right — same ink-dot initial as the in-project corner and the
               Home greeting. Only shown once a machine name resolves. -->
          <button
            v-if="name"
            type="button"
            class="ml-0.5 inline-flex size-[30px] shrink-0 cursor-pointer select-none items-center justify-center rounded-full text-[13px] leading-none transition-transform duration-300 ease-out hover:scale-105 focus-visible:outline-none"
            :style="avatarStyle"
            :title="name"
            :aria-label="`Open profile — ${name}`"
            @click="emit('profile')"
          >
            <template v-if="!image">{{ initial }}</template>
          </button>
        </div>
      </template>
    </HomeHeader>

    
    <section class="relative z-10 mx-auto mt-24 flex w-full max-w-[820px] shrink-0 flex-col">
      
      <div class="grid grid-cols-3 gap-x-14 gap-y-6">
        <motion.div
          v-for="(project, i) in shown"
          :key="project.path"
          v-git-watch="project.path"
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
          @focusin="focusedPath = project.path"
          @focusout="onFolderFocusOut"
        >
          
          <motion.button
            type="button"
            :disabled="anyPending"
            class="folder-btn block cursor-pointer rounded-[22px] text-left focus-visible:outline-none disabled:cursor-default"
            :animate="{ y: isActive(project.path) ? -6 : 0 }"
            :while-tap="anyPending ? {} : { y: -3, scale: 0.985 }"
            :transition="{ type: 'spring', stiffness: 420, damping: 38, mass: 0.85 }"
            @click="emit('open', project)"
          >
            <ProjectFolder
              :name="project.name"
              :repo="summaries[project.path]?.repo ?? true"
              :branch="summaries[project.path]?.branch ?? null"
              :added="summaries[project.path]?.added ?? 0"
              :removed="summaries[project.path]?.removed ?? 0"
              :files="summaries[project.path]?.files ?? []"
              :hovered="isActive(project.path)"
            />
          </motion.button>

          
          <motion.div
            class="absolute right-0 top-0 bottom-0 flex flex-col justify-center gap-1.5"
            :initial="{ opacity: 0, x: 4 }"
            :animate="{
              opacity: isActive(project.path) ? 1 : 0,
              x: isActive(project.path) ? 0 : 4,
              y: isActive(project.path) ? -6 : 0,
            }"
            :transition="{ type: 'spring', stiffness: 500, damping: 30 }"
            :style="{
              pointerEvents: isActive(project.path) ? 'auto' : 'none',
            }"
          >
            
            <button
              type="button"
              :aria-label="project.pinned ? 'Unpin project' : 'Pin to top'"
              :title="project.pinned ? 'Unpin' : 'Pin to top'"
              class="side-act flex size-6 cursor-pointer items-center justify-center transition-colors hover:text-ink"
              :class="project.pinned ? 'text-ink' : 'text-muted'"
              @mousedown.prevent
              @click.stop="onSideAction(project.path, 'pin')"
            >
              <Pin
                :size="14"
                :stroke-width="project.pinned ? 2.4 : 1.8"
                aria-hidden="true"
              />
            </button>

            
            <button
              type="button"
              aria-label="Reveal in Finder"
              title="Reveal in Finder"
              class="side-act flex size-6 cursor-pointer items-center justify-center text-muted transition-colors hover:text-ink"
              @mousedown.prevent
              @click.stop="onSideAction(project.path, 'reveal')"
            >
              <AppleFinder
                :size="15"
                :stroke-width="1.7"
                aria-hidden="true"
              />
            </button>

            
            <button
              type="button"
              aria-label="Remove from recents"
              title="Remove"
              class="side-act flex size-6 cursor-pointer items-center justify-center text-muted transition-colors hover:text-ink"
              @mousedown.prevent
              @click.stop="onSideAction(project.path, 'forget')"
            >
              <Cancel01
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

    <!-- Recent sessions across every project — the same conversations block as
         Project Home, but pooled from all your recents so the launcher shows
         where you left off anywhere. Self-hides until a history read resolves
         with something to show, so an empty launcher stays exactly as it was. -->
    <section
      v-if="sessions.hasAny.value"
      class="home-sessions relative z-10 mx-auto mt-24 flex min-h-0 w-full max-w-[820px] flex-1 flex-col overflow-y-auto overflow-x-hidden pb-6"
    >
      <RecentSessions
        :pinned="sessions.pinned.value"
        :recent="sessions.recent.value"
        :loading="sessions.loading.value"
        @open="onOpenSession"
        @pin="sessions.togglePin"
        @archive="sessions.archive"
        @delete="sessions.remove"
      />
    </section>
  </main>
</template>

<style scoped>
/* The page holds the viewport; the header + project grid stay put and only the
   session ("thread") listing scrolls. Its overflow is hidden from view (no
   scrollbar) and the bottom edge fades into a soft smoke mask so rows dissolve
   into the composer margin rather than clipping at a hard line — the same easing
   as the conversation thread's scroll region. */
.home-sessions {
  scrollbar-width: none;
  -webkit-mask-image: linear-gradient(
    to bottom,
    #000 calc(100% - 44px),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    #000 calc(100% - 44px),
    transparent 100%
  );
}
.home-sessions::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* The hover lift translates the whole tile, and motion-v drives it by writing the
   transform inline each frame — so without promotion the name/branch/diff text
   re-paints at every fractional offset while the vector glyphs stay crisp, which
   reads as the icons settling a beat before the text. Pinning the tile to its own
   compositor layer rasterizes the text once and lets it ride the transform. */
.folder-btn {
  will-change: transform;
  backface-visibility: hidden;
}

/* Keyboard-only focus (nothing on mouse — clicking a folder opens it, so no ring
   is left behind). The folder isn't a card, so rather than box the whole button
   (which would frame the empty space above the peeking papers), the ring hugs the
   folder's pocket — the rounded body that reads as the object. */
.folder-btn:focus-visible :deep(.folder__pocket) {
  outline: 2px solid color-mix(in srgb, var(--ink) 26%, transparent);
  outline-offset: 3px;
}

/* The round pin / reveal / remove actions ring on their own when tabbed to
   (they stay revealed via the group's focus-within tracking). */
.side-act:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 34%, transparent);
  outline-offset: 2px;
}
</style>
