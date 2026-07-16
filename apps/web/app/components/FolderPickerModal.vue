<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { motion } from "motion-v";
import { Magnet } from "~/components/ui/magnet";

// In-app folder browser (elastic modal shell). Same focus-stack brain as the
// full-page `FolderPicker` — via `useFolderPicker` — but housed in a card
// anchored to the bottom-right corner over a scrim (by design — not a centred
// dialog). The card's height springs open and closed as the listing grows and
// shrinks: navigate into a folder with more children and the modal stretches
// down; climb back out and it draws itself back up. Past a cap the list
// scrolls inside instead of pushing the modal off-screen.

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
  canAscend,
  parentName,
  ascend,
  descend,
  climbTo,
  goToPath,
  childDirs,
  homePath,
  init,
  entries,
  error,
  readError,
} = useFolderPicker();

// Drives the modal's open/close fade + scale.
const shown = ref(false);

// ── header address bar ──────────────────────────────────────────────────────
// The header shows the focused folder's path as an editable field, with the
// home directory shown as `~`. It tracks `current` while the user browses;
// typing autocompletes the folder name against the parent's children, Enter
// jumps to the path, and a failed jump (or Escape) restores it.
const pathInput = ref<HTMLInputElement | null>(null);
const pathDraft = ref("");

// `~/…` for display; expanded back to absolute for filesystem calls. (goToPath
// re-expands on its own, but autocomplete needs the absolute parent too.)
function collapse(path: string): string {
  const home = homePath.value;
  if (!home) return path;
  if (path === home) return "~/"; // home itself always keeps the trailing slash
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}
function expand(display: string): string {
  const home = homePath.value;
  if (!home) return display;
  if (display === "~") return home;
  if (display.startsWith("~/")) return home + display.slice(1);
  return display;
}

watch(current, (folder) => (pathDraft.value = collapse(folder?.path ?? "")), {
  immediate: true,
});

// Autocomplete: on each keystroke (not deletions, caret at end), find the first
// child of the parent directory that the trailing segment prefixes, append the
// remainder, and select it — so continued typing overwrites it and Tab / → / /
// accept it.
async function onType(event: Event) {
  const el = event.target as HTMLInputElement;
  const value = el.value;
  pathDraft.value = value;
  const inputType = (event as InputEvent).inputType ?? "";
  if (inputType.startsWith("delete")) return;
  if (el.selectionStart !== value.length) return;

  const frag = value.slice(value.lastIndexOf("/") + 1);
  if (!frag) return;
  const expanded = expand(value);
  const cut = expanded.lastIndexOf("/");
  const parent = cut <= 0 ? "/" : expanded.slice(0, cut);
  const names = await childDirs(parent);
  if (el.value !== value) return; // field moved on while we listed
  const match = names.find(
    (n) =>
      n.length > frag.length && n.toLowerCase().startsWith(frag.toLowerCase()),
  );
  if (!match) return;

  // frag + match share display/absolute form (only the home prefix differs),
  // so we can splice the completion straight onto the displayed value.
  const completed = value + match.slice(frag.length);
  el.value = completed;
  pathDraft.value = completed;
  el.setSelectionRange(value.length, completed.length);
}

// Tab / → accept the selected completion; `/` accepts it then descends.
function onFieldKeydown(event: KeyboardEvent) {
  const el = pathInput.value;
  if (!el || el.selectionStart === el.selectionEnd) return;
  if (event.key === "Tab" || event.key === "ArrowRight") {
    event.preventDefault();
  } else if (event.key !== "/") {
    return;
  }
  const end = el.value.length;
  el.setSelectionRange(end, end); // collapse selection to the end (accept)
  pathDraft.value = el.value;
}

// Flips true briefly to drive the address bar's shake + error tint (see
// `.picker-path-input.is-error` below), then clears itself.
const pathError = ref(false);
let pathErrorTimer: number | null = null;
function triggerPathError() {
  if (pathErrorTimer) window.clearTimeout(pathErrorTimer);
  pathError.value = false;
  // Re-trigger the animation even if it's already mid-shake from a previous
  // attempt: drop the class a frame before reapplying it.
  requestAnimationFrame(() => {
    pathError.value = true;
    pathErrorTimer = window.setTimeout(() => {
      pathError.value = false;
    }, 600);
  });
}

async function submitPath() {
  const result = await goToPath(pathDraft.value);
  if (result === "ok") {
    pathInput.value?.blur();
  } else if (result === "invalid") {
    pathDraft.value = collapse(current.value?.path ?? ""); // bad path — restore
    triggerPathError();
  }
  // "busy" (a navigation was already in flight): leave the field exactly as
  // the user left it — don't restore it, don't blur it out from under them.
}

function resetPath() {
  pathDraft.value = collapse(current.value?.path ?? "");
  pathInput.value?.blur();
}

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

// Guards against Enter (schedules `select`) then Escape landing within the
// same 240ms exit window and firing a second close — only the first close
// wins, and open()/cancel() bail out early rather than even trying.
const closing = ref(false);

// Shared by the Open button (opens the focused folder) and a double-clicked
// entry (opens that entry directly, bypassing the "descend into it" that a
// single click would do) — both just close-then-select a folder.
function openFolder(folder: { path: string; name: string } | null) {
  if (closing.value) return;
  if (!folder) return;
  close(() => emit("select", { path: folder.path, name: folder.name }));
}

function open() {
  openFolder(current.value);
}

function cancel() {
  if (closing.value) return;
  close(() => emit("cancel"));
}

// ── single-click-descend vs. double-click-open ──────────────────────────────
// A single click on an entry descends into it (see `descend`), which reflows
// the list — so a naive `@dblclick` would already have navigated away by the
// time the second click landed. Instead every click is debounced: the first
// click schedules a delayed `descend` and the second click (detected via
// `event.detail`, which increments per click on the same element within the
// platform's double-click window) cancels that pending descend and opens the
// folder directly. The tradeoff is that single-click navigation now lands
// ~260ms late — imperceptible for browsing, but it's what buys the double-click
// its window to pre-empt it.
let clickTimer: number | null = null;
const DOUBLE_CLICK_DEBOUNCE_MS = 260;

function onEntryClick(row: Row, event: MouseEvent) {
  if (clickTimer !== null) {
    window.clearTimeout(clickTimer);
    clickTimer = null;
  }
  if (event.detail >= 2) {
    // Second click of a double-click: open this folder directly.
    openFolder({ path: row.path, name: row.name });
    return;
  }
  clickTimer = window.setTimeout(() => {
    descend(row);
    clickTimer = null;
  }, DOUBLE_CLICK_DEBOUNCE_MS);
}

// Fade + scale the modal out, then hand control back to the caller. The delay
// matches the 0.24s exit transition so it finishes leaving before unmount.
function close(done: () => void) {
  if (closing.value) return;
  closing.value = true;
  shown.value = false;
  window.setTimeout(done, 240);
}

// Focus-trap boundary: every focusable element inside the card's content
// block (address bar, Cancel, every row, Open) in DOM/tab order. `contentEl`
// covers the whole card body, so this is exactly the dialog's tab ring.
function focusableEls(): HTMLElement[] {
  const root = contentEl.value;
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'input, button:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

function onKeydown(event: KeyboardEvent) {
  // Type-to-focus: a printable key (Space excluded — that's for activating
  // whichever button is focused, not for hijacking focus) while the address
  // bar is unfocused jumps into it and continues from the folder in focus —
  // seeded with the current path plus a trailing slash, so the keystroke
  // lands as a child of where you are (and autocomplete resolves it against
  // the current folder).
  const field = pathInput.value;
  if (
    field &&
    document.activeElement !== field &&
    event.key.length === 1 &&
    event.key !== " " &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    field.focus();
    const base = collapse(current.value?.path ?? "");
    const seed = base.endsWith("/") ? base : base + "/";
    field.value = seed;
    pathDraft.value = seed;
    field.setSelectionRange(seed.length, seed.length);
    return; // let the character land right after the current path's slash
  }

  if (event.key === "Escape") {
    event.preventDefault();
    cancel();
    return;
  }

  if (event.key === "Enter") {
    // A focused button (Cancel / Open / a row) handles Enter itself via its
    // own native click activation — only synthesize the "open the focused
    // folder" shortcut when focus isn't already sitting on a button.
    if (document.activeElement instanceof HTMLButtonElement) return;
    event.preventDefault();
    open();
    return;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    // Keyboard-only list navigation: walk the visible `.picker-row` buttons.
    // ArrowDown off the address bar drops into the first row; ArrowUp off the
    // first row climbs back out to the address bar.
    const rowEls = Array.from(
      scrollEl.value?.querySelectorAll<HTMLButtonElement>(".picker-row") ?? [],
    );
    if (rowEls.length === 0) return;
    const idx = rowEls.indexOf(document.activeElement as HTMLButtonElement);
    event.preventDefault();
    if (event.key === "ArrowDown") {
      rowEls[idx === -1 ? 0 : Math.min(idx + 1, rowEls.length - 1)]?.focus();
    } else if (idx <= 0) {
      field?.focus();
    } else {
      rowEls[idx - 1]?.focus();
    }
    return;
  }

  if (event.key === "Tab") {
    // Simple focus trap: Tab / Shift+Tab cycles within the dialog instead of
    // walking out to the page behind the scrim.
    const els = focusableEls();
    const first = els[0];
    const last = els[els.length - 1];
    if (!first || !last) return;
    const active = document.activeElement as HTMLElement | null;
    const inTrap = active != null && els.includes(active);
    const atEdge = event.shiftKey ? active === first : active === last;
    if (atEdge || !inTrap) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }
}

// Whatever had focus before the modal opened — restored on close so the
// trigger (e.g. the "Open" tile on the home screen) gets focus back.
let opener: HTMLElement | null = null;

onMounted(async () => {
  opener = document.activeElement as HTMLElement | null;

  // Listeners attach — and `shown` eventually gets set — no matter what
  // happens below. Previously `init()` ran first and unguarded: a thrown
  // home-directory read left the modal invisible (`shown` never set),
  // Escape dead (listener never attached), and the caller's lock stuck
  // forever. `init()` now catches its own failures into `error`; the
  // try/finally here is just a backstop so nothing upstream can skip setup.
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", measure);
  try {
    await init();
  } finally {
    // Measure once the first listing (or error state) has painted, then
    // track every reflow.
    await settle();
    syncHeight();
    ro = new ResizeObserver(syncHeight);
    if (contentEl.value) ro.observe(contentEl.value);
    requestAnimationFrame(() => {
      shown.value = true;
      // Move focus into the dialog now that it's visible — the address bar
      // is the primary control, and ArrowDown from there drops into the
      // first row (see onKeydown's arrow handling).
      pathInput.value?.focus();
    });
    window.setTimeout(() => {
      navigating.value = false;
      measure();
    }, TRANSITION_MS);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", measure);
  ro?.disconnect();
  opener?.focus();
  if (clickTimer !== null) window.clearTimeout(clickTimer);
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
      role="dialog"
      aria-modal="true"
      aria-label="Open a project folder"
    >
      <!-- Vertical + left padding only: the scroll area runs to the card's right
           edge so its scrollbar sits at the edge (the footer re-pads its right). -->
      <div ref="contentEl" class="flex flex-col py-4 pl-4">
        <!-- Header: the focused folder's full path as an editable address bar,
             in a curved band that mirrors the footer — its bottom edge arcs
             DOWN into the walls. Type a path + Enter to jump there. -->
        <div class="picker-header -ml-4 -mt-4 mb-4 flex items-center gap-4">
          <input
            ref="pathInput"
            :value="pathDraft"
            class="picker-path-input"
            :class="{ 'is-error': pathError }"
            type="text"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            aria-label="Directory path — edit and press Enter to go there"
            @input="onType"
            @keydown="onFieldKeydown"
            @keydown.enter.stop.prevent="submitPath"
            @keydown.esc.stop.prevent="resetPath"
          />
          <button
            type="button"
            class="picker-action shrink-0 text-muted"
            @click="cancel"
          >
            Cancel
          </button>
        </div>

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
          <!-- init() failed to read anything at all (bad home dir): show a
               message in place of the list, Cancel still lets the user out. -->
          <template v-if="error">
            <p class="picker-label px-3 py-2.5 text-muted">{{ error }}</p>
          </template>

          <template v-else>
            <!-- Ascend above the trail's anchor (home, or "/" after a typed
                 path) — the only click-driven way up; typing a path in the
                 address bar is the other. Plain `.picker-row` button, deliberately
                 WITHOUT `data-path`, so the FLIP/ghost machinery (keyed off
                 `[data-path]`) never touches it. -->
            <button
              v-if="canAscend"
              type="button"
              class="picker-row group text-muted"
              style="margin-left: 0"
              :aria-label="`Go up to ${parentName}`"
              @click="ascend"
            >
              <span class="picker-travel">
                <span
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
                    <path d="m18 15-6-6-6 6" />
                  </svg>
                </span>
                <span class="picker-label">{{ parentName }}</span>
              </span>
            </button>

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
                @click="
                  row.kind === 'crumb' ? climbTo(row.index) : onEntryClick(row, $event)
                "
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
              {{ readError ? "Can't read this folder" : "No subfolders" }}
            </p>
          </template>
        </div>

        <!-- Footer: open the folder currently in focus, or back out. Breaks out
             of the content padding to sit as a full-bleed band with its own
             surface, clipped to the card's rounded bottom corners. -->
        <div
          class="picker-footer -mb-4 -ml-4 mt-4 flex items-center justify-end gap-6"
        >
          <button
            type="button"
            class="picker-action min-w-0 text-ink"
            :disabled="!current"
            @click="open"
          >
            <span class="picker-open-label"
              >Open <span class="text-ink-soft">“{{ current?.name }}”</span></span
            >
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
  /* Shared surface for the top (path) and bottom (actions) bands: all but the
     same as the card, only a hair recessed so a band barely reads as its own.
     `--band-arc` is the radius of the concave scoop at each band's inner edge. */
  --band-bg: color-mix(in srgb, var(--ink) 2%, var(--surface, var(--ground)));
  --band-arc: 14px;
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

/* Footer "Open …" variant — allowed to shrink so the branch truncates instead
   of wrapping the button onto a second line. */
.picker-git-inline {
  flex: 0 1 auto;
  min-width: 0;
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

/* Top + bottom bands — full-bleed recessed surfaces set off from the list.
   Each has a flat inner edge across the middle that arcs into the side walls at
   both ends (concave corners), so the band scoops to meet the card. The header
   scoops DOWN (arcs below it); the footer scoops UP (arcs above it). */
.picker-header,
.picker-footer {
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}

/* Each concave arc sits in a band-arc × band-arc box just past the band's inner
   corner; a radial-gradient carves the scoop, filling the wall-side quarter. */
.picker-header::before,
.picker-header::after,
.picker-footer::before,
.picker-footer::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}

/* Footer: arcs above, filled toward the bottom (wall + band side). */
.picker-footer::before,
.picker-footer::after {
  bottom: 100%;
}
.picker-footer::before {
  left: 0;
  background: radial-gradient(
    circle at top right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.picker-footer::after {
  right: 0;
  background: radial-gradient(
    circle at top left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

/* Header: arcs below, filled toward the top (wall + band side). */
.picker-header::before,
.picker-header::after {
  top: 100%;
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

/* Full path of the current selection as an editable address bar — quiet mono
   at rest, firming to full ink while focused. Borderless: it reads as text
   until you click in. Truncates (ellipsis) while unfocused. */
.picker-path-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  outline: none;
  transition: color 0.18s ease;
}
.picker-path-input:hover {
  color: var(--ink-soft);
}
.picker-path-input:focus {
  color: var(--ink);
  text-overflow: clip;
}
.picker-path-input::selection {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}

/* A submitted path that couldn't be read: a quick shake plus a warm-red tint
   that fades back to the resting mono color once the animation ends. */
.picker-path-input.is-error {
  animation: pathShake 0.4s cubic-bezier(0.36, 0.07, 0.19, 0.97);
  color: #c2745c;
}
@media (prefers-color-scheme: dark) {
  .picker-path-input.is-error {
    color: #dc8a6f;
  }
}
@keyframes pathShake {
  0%,
  100% {
    transform: translateX(0);
  }
  20%,
  60% {
    transform: translateX(-4px);
  }
  40%,
  80% {
    transform: translateX(4px);
  }
}

.picker-action {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}
/* "Open “name”" stays intact; only the git branch beside it truncates. */
.picker-open-label {
  flex: none;
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
