<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import { motion } from "motion-v";
import type { DirEntry } from "~/types/desktop";

// In-app folder browser — a "focus stack" menu modelled on a reference gesture
// menu. The list is anchored in the upper third (so the focused folder stays put
// regardless of child count). Clicking a folder plays a soft
// cross-dissolve: the clicked folder travels from its row up into the
// breadcrumb, the other rows fade out where they sit, and the children
// fade in. Ancestors stack as soft breadcrumbs you can climb back through.

const emit = defineEmits<{
  select: [folder: { path: string; name: string }];
  cancel: [];
}>();

const { home, listDir } = useFileSystem();

type Crumb = { name: string; path: string };

// The path from home (index 0) down to the folder in focus (last).
const trail = ref<Crumb[]>([]);
// Subdirectories of the focused folder.
const entries = ref<DirEntry[]>([]);
const loading = ref(false);
// Drives the overlay's open/close fade.
const shown = ref(false);

const current = computed<Crumb | null>(
  () => trail.value[trail.value.length - 1] ?? null,
);
const currentPath = computed(() => current.value?.path ?? "");
// Breadcrumbs are every trail node below home, tagged with their trail index.
const crumbs = computed(() =>
  trail.value
    .map((node, index) => ({ node, index }))
    .filter((c) => c.index > 0),
);

const STEP = 26; // px of indent per level of depth
const MAX_STEPS = 4; // clamp so deep trees don't march off the edge
function indent(level: number): number {
  return Math.min(Math.max(level, 0), MAX_STEPS) * STEP;
}
const childIndent = computed(() => indent(trail.value.length - 1));

// Breadcrumbs + the focused level are rendered as ONE keyed list. A folder keeps
// the same :key as it turns from a row into a breadcrumb, so it's the same DOM
// node before and after — it doesn't re-animate (stays crisp) and rides a manual
// FLIP up to the breadcrumb slot.
type Row =
  | {
      kind: "crumb";
      name: string;
      path: string;
      index: number;
      current: boolean;
    }
  | { kind: "entry"; name: string; path: string };

const rows = computed<Row[]>(() => {
  const last = trail.value.length - 1;
  return [
    ...crumbs.value.map((c) => ({
      kind: "crumb" as const,
      name: c.node.name,
      path: c.node.path,
      index: c.index,
      current: c.index === last,
    })),
    ...entries.value.map((e) => ({
      kind: "entry" as const,
      name: e.name,
      path: e.path,
    })),
  ];
});

function rowIndent(row: Row): number {
  return row.kind === "crumb" ? indent(row.index - 1) : childIndent.value;
}

// ── transition ────────────────────────────────────────────────────────────────
// Bouncy spring for the picker's entrance (underdamped → a little overshoot).
const spring = { type: "spring", stiffness: 260, damping: 15, mass: 0.9 } as const;

// Incoming rows rise up + fade in on a bouncy spring — they "push up" into place.
// Persisting rows keep their :key so they never re-run this (they stay put and
// ride the FLIP instead); only incoming rows animate.
const enter = { type: "spring", stiffness: 320, damping: 20, mass: 0.8 } as const;
const itemHidden = { opacity: 0, y: 24 };
const itemShown = { opacity: 1, y: 0 };

// Outgoing rows are captured as absolutely-positioned ghosts that fade out
// exactly where they sat — so the new level lays out (and is measured for the
// FLIP) cleanly underneath, and nothing collapses or piles up.
type Ghost = {
  key: string;
  name: string;
  kind: "crumb" | "entry";
  current: boolean;
  top: number;
  left: number;
};
const ghosts = ref<Ghost[]>([]);
const ghostsOut = ref(false);
// How long the cross-dissolve (ghost fade + FLIP + entrance) takes to settle.
const TRANSITION_MS = 440;
// True while a cross-dissolve is in flight (and during the first paint) — locks
// the scroll overflow closed so the reflowing rows can't flash the scrollbar
// mid-transition or as the initial listing pops in.
const navigating = ref(true);

function findRow(path: string): HTMLElement | null {
  const els = scrollEl.value?.querySelectorAll<HTMLElement>("[data-path]");
  if (!els) return null;
  for (const el of els) if (el.dataset.path === path) return el;
  return null;
}

// FLIP one surviving row from where it was (`from`) to where it landed. The
// transform rides the inner `.picker-travel` span (motion owns the button's own
// transform). Big delta = the selected folder rising to a breadcrumb; small
// delta = a breadcrumb drifting as the centered block re-centers.
function flipRow(path: string, from: DOMRect): void {
  const el = findRow(path);
  if (!el) return;
  const to = el.getBoundingClientRect();
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  const inner = el.querySelector<HTMLElement>(".picker-travel") ?? el;
  inner
    .animate(
      [
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: "translate(0px, 0px)" },
      ],
      // easeOutBack — the traveling folder overshoots its slot and springs back.
      { duration: 460, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
    )
    .finished.catch(() => {});
}

// ── scroll-edge fades ─────────────────────────────────────────────────────────
const scrollEl = ref<HTMLElement | null>(null);
const canScrollUp = ref(false);
const canScrollDown = ref(false);
const FADE = 22; // px

function measure() {
  const el = scrollEl.value;
  if (!el) return;
  canScrollUp.value = el.scrollTop > 1;
  canScrollDown.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}

async function settle() {
  await nextTick();
  measure();
}

const maskImage = computed(() => {
  const top = canScrollUp.value ? `transparent 0, #000 ${FADE}px` : "#000 0";
  const bottom = canScrollDown.value
    ? `#000 calc(100% - ${FADE}px), transparent 100%`
    : "#000 100%";
  return `linear-gradient(to bottom, ${top}, ${bottom})`;
});

async function load(path: string): Promise<DirEntry[]> {
  try {
    const listing = await listDir(path);
    return listing.entries;
  } catch {
    return []; // unreadable (permissions) — show an empty level
  }
}

// One navigation for both directions: snapshot the current rows, load the new
// level, then cross-dissolve — ghosts fade out, survivors FLIP, incomers fade in.
async function navigate(opts: { loadPath: string; nextTrail: Crumb[] }) {
  if (loading.value) return;
  loading.value = true;
  navigating.value = true;

  // FIRST: snapshot every visible row's screen rect + look.
  const oldRects = new Map<string, DOMRect>();
  const prevRows = rows.value;
  const container = scrollEl.value;
  if (container) {
    for (const el of container.querySelectorAll<HTMLElement>("[data-path]")) {
      const p = el.dataset.path;
      if (p) oldRects.set(p, el.getBoundingClientRect());
    }
  }

  const next = await load(opts.loadPath);
  trail.value = opts.nextTrail;
  entries.value = next;
  loading.value = false;

  const newPaths = new Set(rows.value.map((r) => r.path));
  // Outgoing rows → ghosts that fade out where they were.
  ghosts.value = prevRows.flatMap((r) => {
    if (newPaths.has(r.path)) return [];
    const rect = oldRects.get(r.path);
    if (!rect) return [];
    return [
      {
        key: r.path,
        name: r.name,
        kind: r.kind,
        current: r.kind === "crumb" ? r.current : false,
        top: rect.top,
        left: rect.left,
      },
    ];
  });
  ghostsOut.value = false;

  await nextTick();
  // LAST / INVERT / PLAY: FLIP every row that persisted.
  for (const path of newPaths) {
    const from = oldRects.get(path);
    if (from) flipRow(path, from);
  }
  measure();
  // Blur the ghosts away, then drop them.
  requestAnimationFrame(() => {
    ghostsOut.value = true;
  });
  window.setTimeout(() => {
    ghosts.value = [];
    ghostsOut.value = false;
    navigating.value = false;
    measure();
  }, TRANSITION_MS);
}

// Open a folder: it lifts up to become the newest breadcrumb.
function descend(entry: DirEntry) {
  return navigate({
    loadPath: entry.path,
    nextTrail: [...trail.value, { name: entry.name, path: entry.path }],
  });
}

// Go back to the parent of the crumb at trail index `k`: the clicked crumb
// glides back down into the list.
function climbTo(k: number) {
  if (k < 1) return;
  const target = trail.value[k - 1];
  const clicked = trail.value[k];
  if (!target || !clicked) return;
  return navigate({ loadPath: target.path, nextTrail: trail.value.slice(0, k) });
}

// ── manual path entry ─────────────────────────────────────────────────────────
const pathInput = ref("");
const pathError = ref(false);
watch(currentPath, (p) => (pathInput.value = p), { immediate: true });

async function submitPath() {
  const target = pathInput.value.trim();
  if (!target || loading.value) return;
  loading.value = true;
  try {
    const listing = await listDir(target);
    trail.value = [{ name: listing.name, path: listing.path }];
    entries.value = listing.entries;
    pathError.value = false;
  } catch {
    pathError.value = true;
  } finally {
    loading.value = false;
    void settle();
  }
}

function revertPath(event: Event) {
  pathInput.value = currentPath.value;
  pathError.value = false;
  (event.target as HTMLInputElement | null)?.blur();
}

function open() {
  const folder = current.value;
  if (!folder) return;
  close(() => emit("select", { path: folder.path, name: folder.name }));
}

function cancel() {
  close(() => emit("cancel"));
}

// Fade the overlay out, then hand control back to the caller. The delay matches
// the overlay's 0.24s opacity transition so it finishes fading before unmount.
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
  const root = await home();
  const listing = await listDir(root);
  trail.value = [{ name: listing.name, path: listing.path }];
  entries.value = listing.entries;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", measure);
  requestAnimationFrame(() => {
    shown.value = true;
  });
  void settle();
  // Release the scroll lock once the entrance rows have landed, so the scrollbar
  // only ever appears against a settled list — never mid-animation.
  window.setTimeout(() => {
    navigating.value = false;
    measure();
  }, TRANSITION_MS);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", measure);
});
</script>

<template>
  <motion.div
    class="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-ground px-8"
    :initial="{ opacity: 0 }"
    :animate="{ opacity: shown ? 1 : 0 }"
    :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
    role="dialog"
    aria-modal="true"
    aria-label="Open a project folder"
  >
    <!-- Ghost layer: outgoing rows fade out exactly where they sat. -->
    <div class="pointer-events-none absolute inset-0">
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

    <motion.div
      class="relative flex w-full max-w-md flex-col"
      :initial="{ y: 10, scale: 0.98 }"
      :animate="{ y: shown ? 0 : 10, scale: shown ? 1 : 0.98 }"
      :transition="spring"
    >
      <!-- Manual path entry: type/paste an absolute path to jump there. -->
      <div class="picker-path" :class="{ 'picker-path-error': pathError }">
        <svg
          class="shrink-0 opacity-45"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <input
          v-model="pathInput"
          type="text"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          placeholder="Go to path…"
          aria-label="Go to path"
          @input="pathError = false"
          @keydown.enter.stop.prevent="submitPath"
          @keydown.esc.stop.prevent="revertPath"
        />
      </div>

      <!-- Breadcrumbs + focused level as one keyed list. Persisting rows keep
           their :key (no re-animate, stay crisp) and ride the FLIP; incoming
           rows fade in; outgoing rows leave via the ghost layer above. -->
      <div
        ref="scrollEl"
        class="picker-scroll relative flex max-h-[56vh] w-full flex-col items-start overflow-x-hidden py-1"
        :class="navigating ? 'overflow-y-hidden' : 'overflow-y-auto'"
        :style="{ maskImage, WebkitMaskImage: maskImage }"
        @scroll="measure"
      >
        <motion.button
          v-for="row in rows"
          :key="row.path"
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
          :style="{ marginLeft: `${rowIndent(row)}px` }"
          :initial="itemHidden"
          :animate="itemShown"
          :transition="enter"
          @click="row.kind === 'crumb' ? climbTo(row.index) : descend(row)"
        >
          <span class="picker-travel">
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
                <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
              </svg>
            </span>
            <span class="picker-label">{{ row.name }}</span>
          </span>
        </motion.button>

        <p
          v-if="entries.length === 0"
          class="picker-label px-3 py-2.5 text-muted"
          :style="{ marginLeft: `${childIndent + 20}px` }"
        >
          No subfolders
        </p>
      </div>

      <!-- Footer: open the folder currently in focus, or back out. -->
      <div
        class="mt-6 flex items-center gap-6"
        :style="{ marginLeft: `${childIndent + 32}px` }"
      >
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
        </button>
      </div>
    </motion.div>
  </motion.div>
</template>

<style scoped>
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

/* Manual path entry — borderless, calm; a faint underline on focus. */
.picker-path {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  padding: 0.5rem 0.75rem;
  color: var(--muted);
  border-radius: 10px;
  box-shadow: 0 0 0 1px transparent;
  transition:
    box-shadow 0.18s ease,
    color 0.18s ease;
}
.picker-path:focus-within {
  color: var(--ink-soft);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 12%, transparent);
}
.picker-path-error {
  color: var(--accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
}
.picker-path input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: inherit;
  font-family: var(--font-mono);
  font-size: 12.5px;
  letter-spacing: -0.01em;
}
.picker-path input::placeholder {
  color: var(--muted);
  opacity: 0.7;
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
