<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { motion } from "motion-v";
import { Magnet } from "~/components/ui/magnet";
import type { GitBranch } from "~/types/desktop";

// "Switch branch" overlay — the same scrim + elastic card shell the folder and
// model pickers use (bottom-left anchored, a hairline ring, a springy height
// that settles as the list loads), wrapped around a list of the project's local
// branches. Picking one checks it out here, then waits (spinner up, scrim
// locked) for the app's git model to re-read — so the card only leaves once the
// new branch's changes are on screen — before it plays its exit and reports
// `switched`.

const props = defineProps<{
  projectPath: string;
  // Re-reads the open project's git model. Awaited after the checkout so the
  // picker doesn't leave until the new branch's changes have actually landed on
  // screen — a big tree can take a beat, and closing early would flash stale
  // counts behind the fading scrim.
  refresh?: () => Promise<void>;
}>();

const emit = defineEmits<{
  switched: [branch: string];
  cancel: [];
}>();

const git = useGit();

// ── branch data ───────────────────────────────────────────────────────────────
const branches = ref<GitBranch[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const switchingTo = ref<string | null>(null);
const switchError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const all = await git.branches(props.projectPath);
    // Local branches only — checking out a remote-tracking ref detaches HEAD.
    branches.value = all.filter((b) => !b.remote);
  } catch {
    loadError.value = "Couldn’t load branches";
  } finally {
    loading.value = false;
  }
}

async function choose(b: GitBranch) {
  if (b.current || switchingTo.value) return;
  switchingTo.value = b.name;
  switchError.value = null;
  try {
    await git.checkout(props.projectPath, b.name);
  } catch {
    switchingTo.value = null;
    switchError.value = "Couldn’t switch — commit or stash changes first";
    return;
  }
  // The checkout landed — keep the spinner up and the scrim locked while the app
  // re-reads git, so we only leave once the new branch's changes are on screen.
  // A refresh failure doesn't undo the switch, so fall through and close anyway.
  try {
    await props.refresh?.();
  } catch {
    /* the branch still moved; the live watcher will reconcile the read */
  }
  close(() => emit("switched", b.name));
}

// read as one surface ─────────────────────────────────────────────────────────
const shown = ref(false);
const closing = ref(false);
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}

// Fade + scale out, then hand back to the caller — the 240ms matches the exit.
function close(done: () => void) {
  if (closing.value) return;
  closing.value = true;
  shown.value = false;
  window.setTimeout(done, 240);
}
function onCancel() {
  // Locked while a checkout is in flight — dismissing here (scrim, Cancel or
  // Escape) would drop the scrim and hand the app back mid-switch.
  if (switchingTo.value) return;
  close(() => emit("cancel"));
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    onCancel();
  }
}

let opener: HTMLElement | null = null;

onMounted(async () => {
  // SAFETY: activeElement is the element focused just before open; null is allowed by the type.
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", syncHeight);
  // Reveal with the loading state, then let the ResizeObserver spring the card's
  // height as the list lands (and reflows on a switch error).
  await nextTick();
  syncHeight();
  ro = new ResizeObserver(syncHeight);
  if (contentEl.value) ro.observe(contentEl.value);
  requestAnimationFrame(() => {
    shown.value = true;
  });
  void load();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", syncHeight);
  ro?.disconnect();
  opener?.focus();
});

const cardSpring = {
  type: "spring",
  stiffness: 300,
  damping: 22,
  mass: 0.9,
} as const;
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-end justify-start overflow-hidden p-10">
    <motion.div
      class="modal-scrim absolute inset-0"
      :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
      :animate="{
        opacity: shown ? 1 : 0,
        backdropFilter: shown ? 'blur(4px)' : 'blur(0px)',
      }"
      :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
      @click="onCancel"
    />

    <motion.div
      class="modal-card relative z-20 w-fit max-w-md overflow-hidden"
      :style="{ height: cardHeight === null ? 'auto' : `${cardHeight}px` }"
      :initial="{ opacity: 0, y: 12, scale: 0.96 }"
      :animate="{
        opacity: shown ? 1 : 0,
        y: shown ? 0 : 12,
        scale: shown ? 1 : 0.96,
      }"
      :transition="cardSpring"
      role="dialog"
      aria-modal="true"
      aria-label="Switch branch"
    >
      <div ref="contentEl" class="branch-browser flex shrink-0 flex-col px-3 pb-3">
        <!-- Header band: title + dismiss, the same recessed band the folder
             browser wears. -->
        <div class="picker-header -mx-3 mb-3 flex items-center justify-between gap-4">
          <span class="branch-title">Switch branch</span>
          <button
            type="button"
            class="picker-action shrink-0 text-muted"
            :disabled="!!switchingTo"
            @click="onCancel"
          >
            Cancel
          </button>
        </div>

        <div
          class="picker-scroll relative flex max-h-[48vh] w-full flex-col items-start gap-0.5 overflow-y-auto overflow-x-hidden py-1"
        >
          <p v-if="loading" class="branch-note">Loading…</p>
          <p v-else-if="loadError" class="branch-note">{{ loadError }}</p>
          <p v-else-if="branches.length === 0" class="branch-note">No other branches</p>

          <Magnet
            v-for="b in branches"
            v-else
            :key="b.name"
            class="w-fit"
            inner-class="w-fit"
            :padding="12"
            :magnet-strength="9"
            :disabled="!!switchingTo"
            active-transition="transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)"
            inactive-transition="transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)"
          >
            <button
              type="button"
              role="menuitemradio"
              :aria-checked="b.current"
              :disabled="b.current || !!switchingTo"
              class="picker-row"
              :class="{ 'is-current': b.current }"
              @click="choose(b)"
            >
              <span v-if="switchingTo === b.name" class="branch-mark">
                <span class="branch-spin" aria-hidden="true" />
              </span>
              <span class="picker-label" :title="b.name">{{ b.name }}</span>
              <span v-if="b.current" class="branch-tag">current</span>
            </button>
          </Magnet>

          <p v-if="switchError" class="branch-note branch-note--err">{{ switchError }}</p>
        </div>
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
.modal-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}
.modal-card {
  background: var(--panel);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.branch-browser {
  --band-bg: var(--band);
  --band-arc: 14px;
}

/* Recessed header band with the arc scoops that flow into the card walls. */
.picker-header {
  position: relative;
  padding: 0.625rem 1rem;
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

.branch-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

.picker-action {
  display: inline-flex;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
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

/* Branch rows — quiet hover fill that hugs the content like the folder rows,
   so the row lights up as one readable line, not a full-width swath. */
.picker-row {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  width: fit-content;
  max-width: 100%;
  cursor: pointer;
  border-radius: 10px;
  padding: 0.625rem 0.75rem;
  text-align: left;
  color: var(--ink);
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
.picker-row.is-current {
  cursor: default;
}
.picker-row:disabled:not(.is-current) {
  cursor: default;
  opacity: 0.5;
}

.branch-mark {
  display: inline-flex;
  width: 16px;
  height: 16px;
  flex: none;
  align-items: center;
  justify-content: center;
  color: var(--accent);
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
.branch-tag {
  flex: none;
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--muted);
}

.branch-note {
  padding: 0.625rem 0.75rem;
  font-size: 14px;
  line-height: 1.35;
  color: var(--muted);
}
.branch-note--err {
  font-size: 12px;
  color: var(--diff-del-soft);
}

.branch-spin {
  width: 13px;
  height: 13px;
  border-radius: 9999px;
  border: 1.6px solid color-mix(in srgb, var(--ink) 22%, transparent);
  border-top-color: var(--accent);
  animation: branch-spin 0.6s linear infinite;
}
@keyframes branch-spin {
  to {
    transform: rotate(360deg);
  }
}

/* The list scrollbar matches the folder browser's — a quiet thumb that firms on
   hover, over a stable gutter so rows never shift. */
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
