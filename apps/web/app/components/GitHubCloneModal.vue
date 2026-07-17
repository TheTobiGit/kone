<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { GithubIcon, Folder01Icon } from "@hugeicons/core-free-icons";

// "Clone from GitHub" modal — the elastic card + scrim shell (bottom-right,
// height springs as its content reflows). Paste a repo reference, choose where
// it lands, and clone; the body then morphs into a progress readout and, on
// completion, hands the freshly-cloned folder up to be opened.
//
// Choosing a destination doesn't hand off to a separate modal — it morphs a
// `FolderBrowser` into THIS card in place (same card, same scrim), so the whole
// thing reads as one surface reshaping rather than two components trading. The
// card just has three views: the form, the destination browser, and progress.
//
// Form state lives in `useGitClone` (module scope) so it survives across those
// view swaps.

const emit = defineEmits<{
  // Clone finished (mock) — open this folder as the project.
  clone: [folder: { path: string; name: string }];
  cancel: [];
}>();

const {
  raw,
  repo,
  valid,
  busy,
  phase,
  progress,
  stage,
  cloneError,
  destParentDisplay,
  destPathDisplay,
  setDestParent,
  ensureHome,
  runClone,
  abort,
} = useGitClone();

const { cue } = useSound();

// A failed clone gets a quiet error cue as its message surfaces. Success is
// sounded once by the parent when it opens the freshly-cloned folder, so it
// isn't doubled here.
watch(phase, (next, prev) => {
  if (next === "error" && prev !== "error") cue("error");
});

// Which view fills the card. Progress is driven by `phase` within the form view;
// `view` only toggles the form/progress side against the destination browser.
const view = ref<"form" | "dest">("form");

// Drives the modal's open/close fade + scale.
const shown = ref(false);

const urlInput = ref<HTMLInputElement | null>(null);
const browser = ref<{ focusPath: () => void } | null>(null);

// ── elastic height ────────────────────────────────────────────────────────────
// A ResizeObserver feeds the inner block's height into an inline `height`, and
// the card's CSS `transition: height` gives the springy settle as the body swaps
// between the form, the destination browser, and the progress readout.
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;
function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}

// Guards Enter-then-Escape landing in the same exit window from firing twice.
const closing = ref(false);

// Fade + scale the card out, then hand control back to the parent (which
// unmounts us). The delay matches the 0.24s exit transition.
function close(done: () => void) {
  if (closing.value) return;
  closing.value = true;
  shown.value = false;
  window.setTimeout(done, 240);
}

function cancel() {
  // Hold steady through the final "done" beat — the clone succeeded and is
  // committing; don't let a stray Escape emit cancel over it.
  if (closing.value || phase.value === "done") return;
  // Cancelling mid-clone aborts it (kills git, sweeps the partial folder) and
  // then closes — "Cancel" means abandon the whole operation.
  if (busy.value) abort();
  close(() => emit("cancel"));
}

// ── destination browser (in-place view) ──────────────────────────────────────
// "Choose…" morphs the folder browser into the card; picking a folder (or
// backing out) morphs straight back to the form. No scrim change, no second
// modal — it's the same card throughout.
function openDest() {
  if (busy.value) return;
  view.value = "dest";
}
function onDestSelect(folder: { path: string; name: string }) {
  setDestParent(folder.path);
  view.value = "form";
}
function onDestBack() {
  view.value = "form";
}

// Move focus with the morph: into the browser's address bar on the way in (its
// own onMounted also does this), back to the reference field on the way out.
watch(view, (next) => {
  void nextTick(() => {
    if (next === "dest") browser.value?.focusPath();
    else if (!busy.value) urlInput.value?.focus();
  });
});

async function submit() {
  if (!valid.value || busy.value) return;
  const folder = await runClone();
  if (folder) close(() => emit("clone", folder));
}

// Progress as a whole-number percent for the caption.
const percent = computed(() => Math.round(progress.value * 100));

// ── keyboard ────────────────────────────────────────────────────────────────
// Escape backs out of the destination browser (or cancels from the form);
// Enter submits the clone (only from the form — the browser handles its own).
// A light focus trap keeps Tab inside the card across either view.
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
  if (event.key === "Escape") {
    event.preventDefault();
    if (view.value === "dest") onDestBack();
    else cancel();
    return;
  }
  if (event.key === "Enter") {
    if (view.value === "dest") return; // the browser owns Enter while it's up
    if (document.activeElement instanceof HTMLButtonElement) return;
    event.preventDefault();
    void submit();
    return;
  }
  if (event.key === "Tab") {
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

// Whatever had focus before the modal opened — restored on close.
let opener: HTMLElement | null = null;

onMounted(async () => {
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", syncHeight);
  await ensureHome();
  syncHeight();
  ro = new ResizeObserver(syncHeight);
  if (contentEl.value) ro.observe(contentEl.value);
  requestAnimationFrame(() => {
    shown.value = true;
    if (!busy.value) urlInput.value?.focus();
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", syncHeight);
  ro?.disconnect();
  opener?.focus();
});

// Springy pop for the card's entrance (mirrors the folder picker).
const cardSpring = {
  type: "spring",
  stiffness: 300,
  damping: 22,
  mass: 0.9,
} as const;

// Shared spring for the in-card morphs. The form and progress states also share
// a travelling anchor (the repo name, matched by `layout-id`) that glides
// between them, so `bodyMorph` carries `layout`. The form↔browser view swap
// doesn't share an element, so it rides `viewMorph` (no layout).
const morphSpring = {
  type: "spring",
  stiffness: 360,
  damping: 34,
  mass: 0.8,
} as const;
const bodyMorph = {
  layout: morphSpring,
  y: morphSpring,
  opacity: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
  filter: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
} as const;
const viewMorph = {
  y: morphSpring,
  opacity: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
  filter: { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
} as const;
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-end justify-end overflow-hidden p-6">
    <!-- Scrim: dim + blur ramp together on one tween. It stays put across the
         form ↔ destination-browser morph — the card's content changes, the
         background never does. -->
    <motion.div
      class="modal-scrim absolute inset-0"
      :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
      :animate="{
        opacity: shown ? 1 : 0,
        backdropFilter: shown ? 'blur(4px)' : 'blur(0px)',
      }"
      :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
      @click="cancel"
    />

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
      aria-label="Clone a repository from GitHub"
    >
      <!-- The whole card body swaps between the clone view (form/progress) and
           the destination browser. `popLayout` floats the leaver out of flow so
           the card measures the incoming view cleanly and its height springs to
           it — the two views read as one surface reshaping. -->
      <div ref="contentEl" class="flex shrink-0 flex-col">
        <AnimatePresence mode="popLayout" :initial="false">
          <!-- ── CLONE (form / progress) ── -->
          <motion.div
            v-if="view === 'form'"
            key="clone"
            class="flex flex-col px-5 py-4"
            :initial="{ opacity: 0, y: 10, filter: 'blur(3px)' }"
            :animate="{ opacity: 1, y: 0, filter: 'blur(0px)' }"
            :exit="{ opacity: 0, y: -10, filter: 'blur(3px)' }"
            :transition="viewMorph"
          >
            <!-- Header band: mono eyebrow + Cancel. -->
            <div
              class="clone-band clone-header -mx-5 -mt-4 mb-4 flex items-center gap-4"
            >
              <span class="clone-eyebrow flex items-center gap-2">
                <HugeiconsIcon
                  :icon="GithubIcon"
                  :size="14"
                  :stroke-width="1.8"
                  aria-hidden="true"
                />
                Clone from GitHub
              </span>
              <button
                type="button"
                class="clone-action shrink-0 text-muted"
                :disabled="phase === 'done'"
                @click="cancel"
              >
                Cancel
              </button>
            </div>

            <!-- Body morphs between the form and the progress readout; the two
                 share the repo-name anchor (layout-id) travelling between them. -->
            <div class="relative">
              <AnimatePresence mode="popLayout" :initial="false">
                <!-- ── FORM ── -->
                <motion.div
                  v-if="phase !== 'cloning' && phase !== 'done'"
                  key="form"
                  class="flex flex-col"
                  :initial="{ opacity: 0, y: 6 }"
                  :animate="{ opacity: 1, y: 0, filter: 'blur(0px)' }"
                  :exit="{ opacity: 0, y: -8, filter: 'blur(3px)' }"
                  :transition="bodyMorph"
                >
                  <!-- Reference field — the star. Borderless; reads as text
                       until focused. Leading GitHub mark. -->
                  <label class="clone-field group">
                    <span class="clone-field-glyph">
                      <HugeiconsIcon
                        :icon="GithubIcon"
                        :size="18"
                        :stroke-width="1.7"
                        aria-hidden="true"
                      />
                    </span>
                    <input
                      ref="urlInput"
                      v-model="raw"
                      type="text"
                      class="clone-input"
                      spellcheck="false"
                      autocomplete="off"
                      autocapitalize="off"
                      autocorrect="off"
                      placeholder="owner/repo or https://github.com/…"
                      aria-label="GitHub repository — owner/repo or a URL"
                      @keydown.enter.stop.prevent="submit"
                    />
                  </label>

                  <!-- Resolved reference: the canonical owner/repo once it
                       parses, or a quiet hint when it doesn't. -->
                  <p
                    v-if="raw.trim()"
                    class="clone-resolved"
                    :class="{ 'is-hint': !valid }"
                  >
                    <template v-if="repo">
                      <span class="clone-resolved-owner">{{ repo.owner }}/</span
                      ><motion.span
                        layout-id="clone-repo-name"
                        class="clone-resolved-name"
                        :transition="morphSpring"
                        >{{ repo.name }}</motion.span
                      >
                    </template>
                    <template v-else
                      >That doesn’t look like a GitHub repository</template
                    >
                  </p>

                  <!-- Destination row: one quiet line — the path itself is the
                       affordance; clicking it morphs the folder browser into
                       this card. No separate "Choose…" button. -->
                  <button
                    type="button"
                    class="clone-dest"
                    @click="openDest"
                  >
                    <span class="clone-dest-glyph">
                      <HugeiconsIcon
                        :icon="Folder01Icon"
                        :size="15"
                        :stroke-width="1.6"
                        aria-hidden="true"
                      />
                    </span>
                    <span class="clone-dest-label">Clone into</span>
                    <span class="clone-dest-path">{{ destParentDisplay }}</span>
                    <span class="clone-dest-edit" aria-hidden="true">Change</span>
                  </button>

                  <!-- Clone failure: git's own message, surfaced quietly. The
                       form stays intact so the reference/destination can be
                       fixed and re-submitted. -->
                  <p
                    v-if="phase === 'error' && cloneError"
                    class="clone-error"
                    role="alert"
                  >
                    {{ cloneError }}
                  </p>
                </motion.div>

                <!-- ── PROGRESS ── -->
                <motion.div
                  v-else
                  key="progress"
                  class="flex flex-col"
                  :initial="{ opacity: 0, y: 10, filter: 'blur(3px)' }"
                  :animate="{ opacity: 1, y: 0, filter: 'blur(0px)' }"
                  :exit="{ opacity: 0, y: 6 }"
                  :transition="bodyMorph"
                >
                  <div class="clone-prog-head">
                    <motion.span
                      layout-id="clone-repo-name"
                      class="clone-resolved-name"
                      :transition="morphSpring"
                      >{{ repo?.name }}</motion.span
                    >
                    <span class="clone-prog-into">→ {{ destPathDisplay }}</span>
                  </div>
                  <!-- Progress track: an accent fill that grows with the clone. -->
                  <div
                    class="clone-track"
                    role="progressbar"
                    :aria-valuenow="percent"
                    aria-valuemin="0"
                    aria-valuemax="100"
                  >
                    <span class="clone-fill" :style="{ width: `${percent}%` }" />
                  </div>
                  <div class="clone-prog-meta">
                    <span class="clone-stage">{{
                      phase === "done" ? "Done" : stage
                    }}</span>
                    <span class="clone-percent">{{ percent }}%</span>
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>

            <!-- Footer band: the clone action, eased out once the clone starts. -->
            <AnimatePresence :initial="false">
              <motion.div
                v-if="phase !== 'cloning' && phase !== 'done'"
                key="footer"
                class="clone-band clone-footer -mx-5 -mb-4 mt-4 flex items-center justify-end"
                :exit="{ opacity: 0, y: 10 }"
                :transition="{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }"
              >
                <button
                  type="button"
                  class="clone-action clone-submit text-ink"
                  :disabled="!valid"
                  @click="submit"
                >
                  Clone
                  <span v-if="repo" class="text-ink-soft">“{{ repo.name }}”</span>
                  <span class="clone-submit-arrow" aria-hidden="true">→</span>
                </button>
              </motion.div>
            </AnimatePresence>
          </motion.div>

          <!-- ── DESTINATION BROWSER ── -->
          <motion.div
            v-else
            key="dest"
            class="flex flex-col"
            :initial="{ opacity: 0, y: 10, filter: 'blur(3px)' }"
            :animate="{ opacity: 1, y: 0, filter: 'blur(0px)' }"
            :exit="{ opacity: 0, y: -10, filter: 'blur(3px)' }"
            :transition="viewMorph"
          >
            <FolderBrowser
              ref="browser"
              embedded
              confirm-verb="Clone into"
              cancel-label="Back"
              @select="onDestSelect"
              @cancel="onDestBack"
            />
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
/* Scrim + card lifted from FolderPickerModal so the two modals read as the same
   surface — a soft dim, an elastic card anchored bottom-right, a hairline ring
   instead of a heavy shadow. */
.modal-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}
.modal-card {
  --band-bg: color-mix(in srgb, var(--ink) 2%, var(--surface, var(--ground)));
  --band-arc: 14px;
  background: var(--surface, var(--ground));
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

/* ── bands ── (concave-scooped recessed surfaces; same construction as the
   picker's header/footer) */
.clone-band {
  position: relative;
  padding: 0.625rem 1.25rem;
  background-color: var(--band-bg);
}
.clone-eyebrow {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.clone-band::before,
.clone-band::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.clone-header::before,
.clone-header::after {
  top: 100%;
}
.clone-header::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.clone-header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.clone-footer::before,
.clone-footer::after {
  bottom: 100%;
}
.clone-footer::before {
  left: 0;
  background: radial-gradient(
    circle at top right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.clone-footer::after {
  right: 0;
  background: radial-gradient(
    circle at top left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

/* ── reference field ── */
.clone-field {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.25rem 0;
}
.clone-field-glyph {
  display: inline-flex;
  flex: none;
  color: var(--muted);
  opacity: 0.7;
  transition: opacity 0.18s ease;
}
.clone-field:focus-within .clone-field-glyph {
  color: var(--ink-soft);
  opacity: 1;
}
.clone-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 15px;
  letter-spacing: -0.01em;
  outline: none;
}
.clone-input::placeholder {
  color: var(--muted);
}
.clone-input::selection {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}

/* Resolved reference beneath the field — mono, quiet. The repo name firms to
   full ink; the owner + the invalid/empty hint recede. */
.clone-resolved {
  margin-top: 0.375rem;
  padding-left: calc(18px + 0.625rem);
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: -0.01em;
  line-height: 1.2;
  color: var(--ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.clone-resolved.is-hint {
  color: var(--muted);
}
.clone-resolved-owner {
  color: var(--muted);
}
.clone-resolved-name {
  color: var(--ink);
  font-weight: 600;
}

/* ── destination row ── one line, borderless; the whole row is the button that
   opens the browser. Glyph · "Clone into" · path (fills, truncates) · Change. */
.clone-dest {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  width: 100%;
  margin-top: 1rem;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.clone-dest-glyph {
  display: inline-flex;
  flex: none;
  align-self: center;
  color: var(--muted);
  opacity: 0.8;
  transition: color 0.18s ease, opacity 0.18s ease;
}
.clone-dest-label {
  flex: none;
  font-size: 13px;
  letter-spacing: -0.01em;
  color: var(--muted);
}
.clone-dest-path {
  flex: 0 1 auto;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: -0.01em;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* A quiet underline that firms on hover — the "this is editable" cue. */
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--ink) 16%, transparent);
  text-underline-offset: 3px;
  transition: text-decoration-color 0.18s ease;
}
.clone-dest-edit {
  flex: none;
  margin-left: auto;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
  opacity: 0;
  transform: translateX(-2px);
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.clone-dest:hover .clone-dest-glyph {
  color: var(--ink-soft);
  opacity: 1;
}
.clone-dest:hover .clone-dest-path {
  text-decoration-color: color-mix(in srgb, var(--ink) 42%, transparent);
}
.clone-dest:hover .clone-dest-edit,
.clone-dest:focus-visible .clone-dest-edit {
  opacity: 1;
  transform: translateX(0);
}
.clone-dest:focus-visible {
  outline: none;
}
.clone-dest:focus-visible .clone-dest-path {
  text-decoration-color: color-mix(in srgb, var(--accent) 60%, transparent);
}

/* ── error ── quiet failure line beneath the form, in a warm red. */
.clone-error {
  margin-top: 0.875rem;
  padding-left: calc(18px + 0.625rem);
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: -0.01em;
  line-height: 1.35;
  color: color-mix(in srgb, var(--diff-del) 82%, var(--ink));
}

/* ── progress ── */
.clone-prog-head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.25rem 0 0.75rem;
  min-width: 0;
}
.clone-prog-into {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: -0.01em;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.clone-track {
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  overflow: hidden;
}
.clone-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  /* Follows the rAF-driven width smoothly, and eases the final snap to 100%. */
  transition: width 0.12s linear;
}
.clone-prog-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 0.5rem;
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: -0.01em;
}
.clone-stage {
  color: var(--ink-soft);
}
.clone-percent {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* ── actions ── */
.clone-action {
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
.clone-action:hover {
  opacity: 0.7;
}
.clone-action:disabled {
  cursor: default;
  opacity: 0.4;
}
/* The submit arrow eases in from the accent as a small forward cue. */
.clone-submit-arrow {
  color: var(--accent);
  font-weight: 500;
  transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.clone-submit:not(:disabled):hover .clone-submit-arrow {
  transform: translateX(3px);
}
</style>
