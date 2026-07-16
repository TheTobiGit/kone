<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { motion } from "motion-v";
import { Magnet } from "~/components/ui/magnet";

// In-app folder browser (elastic modal shell). Same focus-stack brain as the
// full-page `FolderPicker` — via `useFolderPicker` — but housed in a centred
// card over a scrim. The card's height springs open and closed as the listing
// grows and shrinks: navigate into a folder with more children and the modal
// stretches down; climb back out and it draws itself back up. Past a cap the
// list scrolls inside instead of pushing the modal off-screen.

const emit = defineEmits<{
  select: [folder: { path: string; name: string }];
  cancel: [];
}>();

const {
  current,
  currentGit,
  rows,
  childIndent,
  rowIndent,
  scrollEl,
  maskImage,
  measure,
  settle,
  enter,
  itemHidden,
  itemShown,
  metaHidden,
  metaShown,
  metaEnter,
  ghosts,
  ghostsOut,
  navigating,
  TRANSITION_MS,
  descend,
  climbTo,
  init,
  entries,
} = useFolderPicker();

// Drives the modal's open/close fade + scale.
const shown = ref(false);

// ── elastic height ────────────────────────────────────────────────────────────
// The card is sized to its content and re-sized whenever the content reflows, so
// it breathes with the listing. A ResizeObserver on the inner block feeds the
// measured height into an inline `height`, and the card's CSS `transition: height`
// (easeOutBack) gives it the springy overshoot as it settles to the new size.
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}

function open() {
  const folder = current.value;
  if (!folder) return;
  close(() => emit("select", { path: folder.path, name: folder.name }));
}

function cancel() {
  close(() => emit("cancel"));
}

// Fade + scale the modal out, then hand control back to the caller. The delay
// matches the 0.24s exit transition so it finishes leaving before unmount.
function close(done: () => void) {
  shown.value = false;
  window.setTimeout(done, 240);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    cancel();
  } else if (event.key === "Enter") {
    event.preventDefault();
    open();
  }
}

onMounted(async () => {
  await init();
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", measure);
  // Measure once the first listing has painted, then track every reflow.
  await settle();
  syncHeight();
  ro = new ResizeObserver(syncHeight);
  if (contentEl.value) ro.observe(contentEl.value);
  requestAnimationFrame(() => {
    shown.value = true;
  });
  window.setTimeout(() => {
    navigating.value = false;
    measure();
  }, TRANSITION_MS);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", measure);
  ro?.disconnect();
});

// Springy pop for the card's entrance (a little overshoot on the way in).
const cardSpring = {
  type: "spring",
  stiffness: 300,
  damping: 22,
  mass: 0.9,
} as const;
</script>

<template>
  <motion.div
    class="fixed inset-0 z-50 flex items-end justify-end overflow-hidden p-6"
    :initial="{ opacity: 0 }"
    :animate="{ opacity: shown ? 1 : 0 }"
    :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
    role="dialog"
    aria-modal="true"
    aria-label="Open a project folder"
  >
    <!-- Scrim: click to dismiss. -->
    <div class="modal-scrim absolute inset-0" @click="cancel" />

    <!-- Ghost layer: outgoing rows fade out exactly where they sat (viewport
         coords, so it must span the full screen just like the page shell). -->
    <div class="pointer-events-none absolute inset-0 z-10">
      <div
        v-for="g in ghosts"
        :key="g.key"
        class="ghost-row"
        :class="[
          ghostsOut ? 'is-out' : '',
          g.kind === 'crumb'
            ? g.current
              ? 'text-ink-soft'
              : 'text-muted'
            : 'text-ink',
        ]"
        :style="{ top: `${g.top}px`, left: `${g.left}px` }"
      >
        <span
          v-if="g.kind === 'crumb'"
          class="inline-flex w-5 shrink-0 items-center opacity-55"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
          </svg>
        </span>
        <span class="picker-label">{{ g.name }}</span>
      </div>
    </div>

    <!-- The card: sized to its content, height springs as the listing reflows. -->
    <motion.div
      class="modal-card relative z-20 w-full max-w-md overflow-hidden"
      :style="{ height: cardHeight === null ? 'auto' : `${cardHeight}px` }"
      :initial="{ opacity: 0, y: 12, scale: 0.96 }"
      :animate="{
        opacity: shown ? 1 : 0,
        y: shown ? 0 : 12,
        scale: shown ? 1 : 0.96,
      }"
      :transition="cardSpring"
    >
      <!-- Vertical + left padding only: the scroll area runs to the card's right
           edge so its scrollbar sits at the edge (the footer re-pads its right). -->
      <div ref="contentEl" class="flex flex-col py-4 pl-4">
        <!-- Breadcrumbs + focused level as one keyed list. Persisting rows keep
             their :key (no re-animate, stay crisp) and ride the FLIP; incoming
             rows fade in; outgoing rows leave via the ghost layer above. -->
        <div
          ref="scrollEl"
          class="picker-scroll relative flex max-h-[48vh] w-full flex-col items-start overflow-x-hidden py-1"
          :class="navigating ? 'overflow-y-hidden' : 'overflow-y-auto'"
          :style="{ maskImage, WebkitMaskImage: maskImage }"
          @scroll="measure"
        >
          <Magnet
            v-for="row in rows"
            :key="row.path"
            class="w-fit"
            inner-class="w-fit"
            :padding="12"
            :magnet-strength="9"
            :disabled="navigating"
            active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
            inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
            :style="{ marginLeft: `${rowIndent(row)}px` }"
          >
            <motion.button
              :data-path="row.path"
              type="button"
              class="picker-row group"
              :class="
                row.kind === 'crumb'
                  ? row.current
                    ? 'text-ink-soft'
                    : 'text-muted'
                  : 'text-ink'
              "
              :initial="itemHidden"
              :animate="itemShown"
              :transition="enter"
              @click="row.kind === 'crumb' ? climbTo(row.index) : descend(row)"
            >
              <span class="picker-travel">
                <!-- Leading glyph: a back-arrow for breadcrumbs, a folder for
                     the focused level's child directories (hugeicons folder-01). -->
                <span
                  v-if="row.kind === 'crumb'"
                  class="pointer-events-none inline-flex w-5 shrink-0 items-center opacity-55 transition-opacity group-hover:opacity-100"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M9 14 4 9l5-5" />
                    <path
                      d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"
                    />
                  </svg>
                </span>
                <span
                  v-else
                  class="pointer-events-none inline-flex w-5 shrink-0 items-center opacity-45 transition-opacity group-hover:opacity-80"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path
                      d="M8 7h8.75c2.107 0 3.16 0 3.917.506a3 3 0 0 1 .827.827C22 9.09 22 10.143 22 12.25c0 3.511 0 5.267-.843 6.528a5 5 0 0 1-1.38 1.38C18.518 21 16.762 21 13.25 21H12c-4.714 0-7.071 0-8.536-1.465C2 18.072 2 15.715 2 11V7.944c0-1.816 0-2.724.38-3.406A3 3 0 0 1 3.538 3.38C4.22 3 5.128 3 6.944 3C8.108 3 8.69 3 9.2 3.191c1.163.436 1.643 1.493 2.168 2.542L12 7"
                    />
                  </svg>
                </span>
                <span class="picker-label">{{ row.name }}</span>
                <span v-if="row.repo" class="picker-git">
                  <span
                    class="picker-repo"
                    :class="{ 'is-loading': !row.git }"
                    title="Git repository"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="13"
                      height="13"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <line x1="6" x2="6" y1="3" y2="15" />
                      <circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>
                    <span class="sr-only">Git repository</span>
                  </span>
                  <motion.span
                    v-if="row.git"
                    class="picker-meta"
                    :initial="metaHidden"
                    :animate="metaShown"
                    :transition="metaEnter"
                  >
                    <span class="picker-branch">{{
                      row.git.branch ?? "detached"
                    }}</span>
                    <span
                      v-if="row.git.added || row.git.removed"
                      class="picker-diff"
                    >
                      <span class="picker-add">+{{ row.git.added }}</span>
                      <span class="picker-del">−{{ row.git.removed }}</span>
                    </span>
                  </motion.span>
                </span>
              </span>
            </motion.button>
          </Magnet>

          <p
            v-if="entries.length === 0"
            class="picker-label px-3 py-2.5 text-muted"
            :style="{ marginLeft: `${childIndent + 20}px` }"
          >
            No subfolders
          </p>
        </div>

        <!-- Footer: open the folder currently in focus, or back out. -->
        <div class="mt-5 flex items-center justify-end gap-6 pr-4">
          <button type="button" class="picker-action text-muted" @click="cancel">
            Cancel
          </button>
          <button
            type="button"
            class="picker-action text-ink"
            :disabled="!current"
            @click="open"
          >
            Open <span class="text-ink-soft">“{{ current?.name }}”</span>
            <span v-if="current?.repo" class="picker-git picker-git-inline">
              <span
                class="picker-repo"
                :class="{ 'is-loading': !currentGit }"
                title="Git repository"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <line x1="6" x2="6" y1="3" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <span class="sr-only">Git repository</span>
              </span>
              <motion.span
                v-if="currentGit"
                class="picker-meta"
                :initial="metaHidden"
                :animate="metaShown"
                :transition="metaEnter"
              >
                <span class="picker-branch">{{
                  currentGit.branch ?? "detached"
                }}</span>
                <span
                  v-if="currentGit.added || currentGit.removed"
                  class="picker-diff"
                >
                  <span class="picker-add">+{{ currentGit.added }}</span>
                  <span class="picker-del">−{{ currentGit.removed }}</span>
                </span>
              </motion.span>
            </span>
          </button>
        </div>
      </div>
    </motion.div>
  </motion.div>
</template>

<style scoped>
/* Scrim behind the card — a soft dim + blur over whatever's underneath. */
.modal-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

/* The elastic card, anchored to the bottom-right corner. `transition: height`
   gives it the springy overshoot as it grows and shrinks with the listing; a
   hairline ring settles it on the scrim without a heavy drop shadow. */
.modal-card {
  background: var(--surface, var(--ground));
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: height 0.5s cubic-bezier(0.34, 1.4, 0.64, 1);
}

.picker-row {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  width: fit-content;
  max-width: 100%;
  cursor: pointer;
  border-radius: 10px;
  padding: 0.5rem 0.75rem;
  text-align: left;
  transition:
    background-color 0.18s ease,
    color 0.25s ease;
}
.picker-row:hover {
  background-color: var(--hover);
}
.picker-row:focus-visible {
  outline: none;
  background-color: var(--hover);
}
.picker-travel {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
  max-width: 100%;
  will-change: transform;
}
.picker-label {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.1;
}

/* Git metadata: a branch glyph, the branch name, and a line diffstat, sitting
   just after the folder name. The whole group is `flex: none` so it stays put
   while a long folder name truncates ahead of it. */
.picker-git {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  flex: none;
  margin-left: 0.5rem;
  min-width: 0;
}

/* The branch glyph — tinted with the accent; calm at rest, firms on hover. */
.picker-repo {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--accent);
  opacity: 0.7;
  transition: opacity 0.18s ease;
}
.group:hover .picker-repo {
  opacity: 1;
}
/* While the branch + diffstat are still being read, the glyph breathes — a
   quiet "working" beat until its summary resolves and eases in beside it. */
.picker-repo.is-loading {
  animation: repoPulse 1.5s ease-in-out infinite;
}

/* Branch + diffstat travel in together as one motion group (see metaEnter). */
.picker-meta {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  will-change: transform, opacity, filter;
}

/* Branch name — quiet mono, recedes behind the folder name. Truncates rather
   than pushing the diffstat off the edge. */
.picker-branch {
  min-width: 0;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: -0.01em;
}

/* Line diffstat — green insertions, warm-red deletions. */
.picker-diff {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  flex: none;
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.picker-add {
  color: #5f9e6a;
}
.picker-del {
  color: #c2745c;
}
@media (prefers-color-scheme: dark) {
  .picker-add {
    color: #7fb98a;
  }
  .picker-del {
    color: #dc8a6f;
  }
}

@keyframes repoPulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 0.8;
  }
}

/* Footer "Open …" variant — nudge the row onto the text baseline. */
.picker-git-inline {
  vertical-align: -3px;
}
.picker-git-inline .picker-repo {
  opacity: 0.85;
}
.picker-action:hover .picker-git-inline .picker-repo {
  opacity: 1;
}

/* Outgoing rows: sit exactly where they were, fade out in place. */
.ghost-row {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
  opacity: 1;
  will-change: opacity;
  transition: opacity 0.4s cubic-bezier(0.45, 0, 0.55, 1);
}
.ghost-row.is-out {
  opacity: 0;
}

.picker-action {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.picker-action:hover {
  opacity: 0.7;
}
.picker-action:disabled {
  cursor: default;
  opacity: 0.4;
}

/* Subtle, self-effacing scrollbar that firms up on hover. The stable gutter
   reserves its width whether or not it's showing, so the list never shifts
   sideways as content (and the scrollbar) appears and disappears. */
.picker-scroll {
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 16%, transparent) transparent;
}
.picker-scroll::-webkit-scrollbar {
  width: 10px;
}
.picker-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.picker-scroll::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
  border: 3px solid transparent;
  background-clip: content-box;
}
.picker-scroll:hover::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
}
</style>
