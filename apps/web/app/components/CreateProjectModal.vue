<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { FolderAddIcon, Folder01Icon } from "@hugeicons/core-free-icons";
import ToggleSwitch from "~/components/ui/ToggleSwitch.vue";

// "Create a new project" modal — the sibling of GitHubCloneModal, sharing its
// elastic card + scrim shell, its header/footer bands, and its in-place morph.
// The default sheet is pared to what matters first — name the project, choose
// where it lives — and an "Advanced" panel morphs in for the rest: initialize
// git (branch, README, .gitignore) and/or run a setup command (a scaffolder) in
// the new folder. All of it rides the git.create bridge.
//
// Form state lives in `useCreateProject` (module scope) so it survives the
// unmount while the user detours through the location browser.

const emit = defineEmits<{
  // Creation finished — open this folder as the project.
  create: [folder: { path: string; name: string }];
  cancel: [];
}>();

const {
  name,
  trimmedName,
  valid,
  busy,
  phase,
  createError,
  parentDisplay,
  projectPathDisplay,
  useGit,
  useReadme,
  useRemote,
  repoName,
  visibility,
  command,
  ensureHome,
  setParent,
  create,
} = useCreateProject();

const { cue } = useSound();

// A failed create gets a quiet error cue as its message surfaces. Success is
// sounded once by the parent when it opens the freshly-created folder.
watch(phase, (next, prev) => {
  if (next === "error" && prev !== "error") cue("error");
});

// Which view fills the card: the create form (with its creating readout), the
// location browser, or the "More" panel. `phase` drives form↔creating.
const view = ref<"form" | "dest" | "more">("form");

// Drives the modal's open/close fade + scale.
const shown = ref(false);

const nameInput = ref<HTMLInputElement | null>(null);
const browser = ref<{ focusPath: () => void } | null>(null);
const gitSwitch = ref<{ focus: () => void } | null>(null);

// A quiet mark on the "More" button when any of its options is engaged.
const moreActive = computed(
  () => useGit.value || useRemote.value || command.value.trim().length > 0,
);

// Git and its GitHub remote move together: enabling the remote implies a local
// repo; disabling git drops the remote. Handled right at each toggle so the two
// never transiently desync (rather than a reactive two-way watch).
function setGit(on: boolean) {
  useGit.value = on;
  if (!on) useRemote.value = false;
}
function setRemote(on: boolean) {
  useRemote.value = on;
  if (on) useGit.value = true;
}

// The visibility segment is its own control (not a ToggleSwitch), so it plays
// the same discrete cue itself — only when the choice actually changes.
function setVisibility(next: "public" | "private") {
  if (visibility.value === next) return;
  cue("toggle");
  visibility.value = next;
}

// ── elastic height ────────────────────────────────────────────────────────────
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;
function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}

// Guards Enter-then-Escape landing in the same exit window from firing twice.
const closing = ref(false);

function close(done: () => void) {
  if (closing.value) return;
  closing.value = true;
  shown.value = false;
  window.setTimeout(done, 240);
}

function cancel() {
  if (closing.value || phase.value === "done" || busy.value) return;
  close(() => emit("cancel"));
}

// ── location browser (in-place view) ──────────────────────────────────────────
function openDest() {
  if (busy.value) return;
  view.value = "dest";
}
function onDestSelect(folder: { path: string; name: string }) {
  setParent(folder.path);
  view.value = "form";
}
function onDestBack() {
  view.value = "form";
}

// ── "more" panel (in-place view) ──────────────────────────────────────────────
function openMore() {
  if (busy.value) return;
  view.value = "more";
}
function closeMore() {
  view.value = "form";
}

// Move focus with each morph: into the browser's address bar / the git toggle on
// the way in, back to the name field on the way home.
watch(view, (next) => {
  void nextTick(() => {
    if (next === "dest") browser.value?.focusPath();
    else if (next === "more") gitSwitch.value?.focus();
    else if (!busy.value) nameInput.value?.focus();
  });
});

async function submit() {
  if (!valid.value || busy.value) return;
  cue("press");
  const folder = await create();
  if (folder) close(() => emit("create", folder));
}

// ── keyboard ────────────────────────────────────────────────────────────────
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
    else if (view.value === "more") closeMore();
    else cancel();
    return;
  }
  if (event.key === "Enter") {
    if (view.value !== "form") return; // only the base form submits on Enter
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
    if (!busy.value) nameInput.value?.focus();
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", syncHeight);
  ro?.disconnect();
  opener?.focus();
});

// Springy pop for the card's entrance (mirrors the other launcher modals).
const cardSpring = {
  type: "spring",
  stiffness: 300,
  damping: 22,
  mass: 0.9,
} as const;

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
// The height collapse/expand shared by the More panel's sub-groups.
const collapseMorph = { duration: 0.26, ease: [0.22, 1, 0.36, 1] } as const;
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-end justify-end overflow-hidden p-6">
    <!-- Scrim: dim + blur ramp together on one tween; unchanged across morphs. -->
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
      aria-label="Create a new project"
    >
      <div ref="contentEl" class="flex shrink-0 flex-col">
        <AnimatePresence mode="popLayout" :initial="false">
          <!-- ── CREATE (form / creating) ── -->
          <motion.div
            v-if="view === 'form'"
            key="create"
            class="flex flex-col px-4 py-4"
            :initial="{ opacity: 0, y: 10, filter: 'blur(3px)' }"
            :animate="{ opacity: 1, y: 0, filter: 'blur(0px)' }"
            :exit="{ opacity: 0, y: -10, filter: 'blur(3px)' }"
            :transition="viewMorph"
          >
            <!-- Header band: just Cancel (no title). -->
            <div
              class="cp-band cp-header -mx-4 -mt-4 mb-4 flex items-center justify-end"
            >
              <button
                type="button"
                class="cp-action shrink-0 text-muted"
                :disabled="busy || phase === 'done'"
                @click="cancel"
              >
                Cancel
              </button>
            </div>

            <div class="relative">
              <AnimatePresence mode="popLayout" :initial="false">
                <!-- ── FORM ── -->
                <motion.div
                  v-if="phase !== 'creating' && phase !== 'done'"
                  key="form"
                  class="flex flex-col"
                  :initial="{ opacity: 0, y: 6 }"
                  :animate="{ opacity: 1, y: 0, filter: 'blur(0px)' }"
                  :exit="{ opacity: 0, y: -8, filter: 'blur(3px)' }"
                  :transition="bodyMorph"
                >
                  <!-- Name — the star. Borderless; reads as text until focused,
                       with a leading glyph, exactly like the clone reference. -->
                  <label class="cp-field group">
                    <span class="cp-field-glyph">
                      <HugeiconsIcon
                        :icon="FolderAddIcon"
                        :size="18"
                        :stroke-width="1.7"
                        aria-hidden="true"
                      />
                    </span>
                    <input
                      ref="nameInput"
                      v-model="name"
                      type="text"
                      class="cp-input"
                      spellcheck="false"
                      autocomplete="off"
                      autocapitalize="off"
                      autocorrect="off"
                      placeholder="project-name"
                      aria-label="Project name"
                      @keydown.enter.stop.prevent="submit"
                    />
                  </label>

                  <!-- Only a quiet hint when the name won't do — no path echo;
                       the destination is shown by the location row below. -->
                  <p
                    v-if="trimmedName && !valid"
                    class="cp-resolved is-hint"
                  >
                    That isn’t a valid folder name
                  </p>

                  <!-- Location row: one line — click to repoint the parent. -->
                  <button type="button" class="cp-dest" @click="openDest">
                    <span class="cp-dest-glyph">
                      <HugeiconsIcon
                        :icon="Folder01Icon"
                        :size="15"
                        :stroke-width="1.6"
                        aria-hidden="true"
                      />
                    </span>
                    <span class="cp-dest-label">Create in</span>
                    <span class="cp-dest-path">{{ parentDisplay }}</span>
                    <span class="cp-dest-edit" aria-hidden="true">Change</span>
                  </button>

                  <!-- Create failure: the underlying message, surfaced quietly. -->
                  <p
                    v-if="phase === 'error' && createError"
                    class="cp-error"
                    role="alert"
                  >
                    {{ createError }}
                  </p>
                </motion.div>

                <!-- ── CREATING ── -->
                <motion.div
                  v-else
                  key="creating"
                  class="flex flex-col"
                  :initial="{ opacity: 0, y: 10, filter: 'blur(3px)' }"
                  :animate="{ opacity: 1, y: 0, filter: 'blur(0px)' }"
                  :exit="{ opacity: 0, y: 6 }"
                  :transition="bodyMorph"
                >
                  <div class="cp-prog-head">
                    <span class="cp-prog-name">{{ trimmedName }}</span>
                    <span class="cp-prog-into">→ {{ projectPathDisplay }}</span>
                  </div>
                  <div class="cp-track">
                    <span
                      class="cp-track-bar"
                      :class="phase === 'done' ? 'is-done' : 'is-sweeping'"
                    />
                  </div>
                  <div class="cp-prog-meta">
                    <span class="cp-stage">{{
                      phase === "done"
                        ? "Ready"
                        : command.trim()
                          ? "Running setup…"
                          : "Creating…"
                    }}</span>
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>

            <!-- Footer band: Advanced on the left, the create action on the
                 right — eased out once creation starts. -->
            <AnimatePresence :initial="false">
              <motion.div
                v-if="phase !== 'creating' && phase !== 'done'"
                key="footer"
                class="cp-band cp-footer -mx-4 -mb-4 mt-4 flex items-center justify-between gap-4"
                :exit="{ opacity: 0, y: 10 }"
                :transition="{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }"
              >
                <button
                  type="button"
                  class="cp-action cp-more text-muted"
                  :class="{ 'is-active': moreActive }"
                  @click="openMore"
                >
                  More
                  <span
                    v-if="moreActive"
                    class="cp-more-dot"
                    aria-hidden="true"
                  />
                </button>
                <button
                  type="button"
                  class="cp-action cp-submit text-ink"
                  :disabled="!valid"
                  @click="submit"
                >
                  Create
                  <span v-if="trimmedName" class="text-ink-soft"
                    >“{{ trimmedName }}”</span
                  >
                  <span class="cp-submit-arrow" aria-hidden="true">→</span>
                </button>
              </motion.div>
            </AnimatePresence>
          </motion.div>

          <!-- ── MORE PANEL ── -->
          <motion.div
            v-else-if="view === 'more'"
            key="more"
            class="flex flex-col px-4 py-4"
            :initial="{ opacity: 0, y: 10, filter: 'blur(3px)' }"
            :animate="{ opacity: 1, y: 0, filter: 'blur(0px)' }"
            :exit="{ opacity: 0, y: -10, filter: 'blur(3px)' }"
            :transition="viewMorph"
          >
            <div
              class="cp-band cp-header -mx-4 -mt-4 mb-4 flex items-center gap-4"
            >
              <span class="cp-eyebrow">More</span>
              <button
                type="button"
                class="cp-action shrink-0 text-ink"
                @click="closeMore"
              >
                Done
              </button>
            </div>

            <div class="cp-more-scroll">
              <!-- GIT — init a local repo, with the one universal seed. -->
              <section class="cp-sec">
                <p class="cp-sec-label">Git</p>
                <div class="cp-row">
                  <span class="cp-row-label">Initialize a repository</span>
                  <ToggleSwitch
                    ref="gitSwitch"
                    :model-value="useGit"
                    aria-label="Initialize a git repository"
                    @update:model-value="setGit"
                  />
                </div>
                <AnimatePresence :initial="false">
                  <motion.div
                    v-if="useGit"
                    key="git-opts"
                    class="cp-subgroup"
                    :initial="{ opacity: 0, height: 0 }"
                    :animate="{ opacity: 1, height: 'auto' }"
                    :exit="{ opacity: 0, height: 0 }"
                    :transition="collapseMorph"
                  >
                    <div class="cp-row cp-subrow">
                      <span class="cp-row-label">Add a README</span>
                      <ToggleSwitch v-model="useReadme" aria-label="Add a README" />
                    </div>
                  </motion.div>
                </AnimatePresence>
              </section>

              <!-- GITHUB — create + push a remote (implies git). -->
              <section class="cp-sec">
                <p class="cp-sec-label">GitHub</p>
                <div class="cp-row">
                  <span class="cp-row-label">Create a repository</span>
                  <ToggleSwitch
                    :model-value="useRemote"
                    aria-label="Create a GitHub repository"
                    @update:model-value="setRemote"
                  />
                </div>
                <AnimatePresence :initial="false">
                  <motion.div
                    v-if="useRemote"
                    key="remote-opts"
                    class="cp-subgroup"
                    :initial="{ opacity: 0, height: 0 }"
                    :animate="{ opacity: 1, height: 'auto' }"
                    :exit="{ opacity: 0, height: 0 }"
                    :transition="collapseMorph"
                  >
                    <label class="cp-row cp-subrow cp-row-input">
                      <span class="cp-row-label">Name</span>
                      <input
                        v-model="repoName"
                        type="text"
                        class="cp-inline-input cp-inline-wide"
                        spellcheck="false"
                        autocomplete="off"
                        autocapitalize="off"
                        autocorrect="off"
                        :placeholder="trimmedName || 'project-name'"
                        aria-label="Repository name"
                      />
                    </label>
                    <div class="cp-row cp-subrow">
                      <span class="cp-row-label">Visibility</span>
                      <div
                        class="cp-seg"
                        role="group"
                        aria-label="Repository visibility"
                      >
                        <button
                          type="button"
                          class="cp-seg-opt"
                          :class="{ 'is-on': visibility === 'private' }"
                          :aria-pressed="visibility === 'private'"
                          @click="setVisibility('private')"
                        >
                          Private
                        </button>
                        <button
                          type="button"
                          class="cp-seg-opt"
                          :class="{ 'is-on': visibility === 'public' }"
                          :aria-pressed="visibility === 'public'"
                          @click="setVisibility('public')"
                        >
                          Public
                        </button>
                      </div>
                    </div>
                  </motion.div>
                </AnimatePresence>
              </section>

              <!-- SETUP — a shell command run in the new folder. -->
              <section class="cp-sec">
                <p class="cp-sec-label">Setup</p>
                <label class="cp-cmd-field">
                  <span class="cp-cmd-sigil" aria-hidden="true">$</span>
                  <input
                    v-model="command"
                    type="text"
                    class="cp-cmd-input"
                    spellcheck="false"
                    autocomplete="off"
                    autocapitalize="off"
                    autocorrect="off"
                    placeholder="npm create vite@latest ."
                    aria-label="Setup command to run in the new folder"
                  />
                </label>
                <p class="cp-cmd-hint">Runs in the new folder after it’s created.</p>
              </section>
            </div>
          </motion.div>

          <!-- ── LOCATION BROWSER ── -->
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
              confirm-verb="Create in"
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

/* ── bands ── (concave-scooped recessed surfaces; same construction as clone) */
.cp-band {
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.cp-eyebrow {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.cp-band::before,
.cp-band::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.cp-header::before,
.cp-header::after {
  top: 100%;
}
.cp-header::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.cp-header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.cp-footer::before,
.cp-footer::after {
  bottom: 100%;
}
.cp-footer::before {
  left: 0;
  background: radial-gradient(
    circle at top right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.cp-footer::after {
  right: 0;
  background: radial-gradient(
    circle at top left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

/* ── name field ── borderless; reads as text until focused. Leading glyph
   firms on focus. Matches the clone reference field. */
.cp-field {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.25rem 0;
}
.cp-field-glyph {
  display: inline-flex;
  flex: none;
  color: var(--muted);
  opacity: 0.7;
  transition: opacity 0.18s ease, color 0.18s ease;
}
.cp-field:focus-within .cp-field-glyph {
  color: var(--ink-soft);
  opacity: 1;
}
.cp-input {
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
.cp-input::placeholder {
  color: var(--muted);
}
.cp-input::selection {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}

/* Quiet hint beneath the field when the name won't do — warm, aligned under
   the input past the glyph. */
.cp-resolved {
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
.cp-resolved.is-hint {
  color: color-mix(in srgb, var(--diff-del) 78%, var(--ink));
}

/* ── location row ── one borderless line; the row is the button that opens the
   browser. Lifted verbatim from the clone modal's destination row. */
.cp-dest {
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
.cp-dest-glyph {
  display: inline-flex;
  flex: none;
  align-self: center;
  color: var(--muted);
  opacity: 0.8;
  transition: color 0.18s ease, opacity 0.18s ease;
}
.cp-dest-label {
  flex: none;
  font-size: 13px;
  letter-spacing: -0.01em;
  color: var(--muted);
}
.cp-dest-path {
  flex: 0 1 auto;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: -0.01em;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--ink) 16%, transparent);
  text-underline-offset: 3px;
  transition: text-decoration-color 0.18s ease;
}
.cp-dest-edit {
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
.cp-dest:hover .cp-dest-glyph {
  color: var(--ink-soft);
  opacity: 1;
}
.cp-dest:hover .cp-dest-path {
  text-decoration-color: color-mix(in srgb, var(--ink) 42%, transparent);
}
.cp-dest:hover .cp-dest-edit,
.cp-dest:focus-visible .cp-dest-edit {
  opacity: 1;
  transform: translateX(0);
}
.cp-dest:focus-visible {
  outline: none;
}
.cp-dest:focus-visible .cp-dest-path {
  text-decoration-color: color-mix(in srgb, var(--accent) 60%, transparent);
}

/* ── error ── quiet failure line beneath the form, in a warm red. */
.cp-error {
  margin-top: 0.875rem;
  padding-left: calc(18px + 0.625rem);
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: -0.01em;
  line-height: 1.35;
  color: color-mix(in srgb, var(--diff-del) 82%, var(--ink));
}

/* ── "more" panel ── three quiet sections (Git · GitHub · Setup), each led by a
   mono eyebrow. No dividers — section spacing carries the grouping. Caps at a
   scrollable height so a fully-expanded panel never outgrows the viewport. */
.cp-more-scroll {
  max-height: min(58vh, 480px);
  overflow-y: auto;
  overflow-x: hidden;
  margin-right: -0.5rem;
  padding-right: 0.5rem;
}
.cp-sec + .cp-sec {
  margin-top: 1.6rem;
}
.cp-sec-label {
  margin-bottom: 0.6rem;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}

.cp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 34px;
}
.cp-row-label {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13.5px;
  letter-spacing: -0.01em;
  color: var(--ink);
}

/* Sub-rows tuck under their toggle: indented, a step quieter than the parent,
   with a hairline-free guide implied by the indent alone. */
.cp-subgroup {
  overflow: hidden;
}
.cp-subrow {
  padding-left: 0.9rem;
  min-height: 32px;
}
.cp-subrow + .cp-subrow {
  margin-top: 0.1rem;
}
.cp-subrow .cp-row-label {
  font-size: 13px;
  color: var(--ink-soft);
}

.cp-inline-input {
  flex: none;
  width: 9rem;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ink);
  caret-color: var(--accent);
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: -0.01em;
  text-align: right;
  outline: none;
}
.cp-inline-input.cp-inline-wide {
  width: 12rem;
}
.cp-inline-input::placeholder {
  color: var(--muted);
}
.cp-inline-input::selection {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}

/* Visibility segmented control — two pills in a recessed track, active one
   raised on the surface. */
.cp-seg {
  display: inline-flex;
  flex: none;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}
.cp-seg-opt {
  border: 0;
  padding: 0.22rem 0.75rem;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: color 0.18s ease, background 0.18s ease;
}
.cp-seg-opt:hover {
  color: var(--ink-soft);
}
.cp-seg-opt.is-on {
  color: var(--ink);
  background: var(--surface, var(--ground));
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.14);
}
.cp-seg-opt:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
  outline-offset: 2px;
}

/* ── setup command ── a terminal line on a flat filled surface, styled like the
   home search input: no border, no focus ring — just the fill. A $ sigil warms
   on focus and a hint sits beneath. */
.cp-cmd-field {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.6rem 0.75rem;
  border-radius: 11px;
  background: var(--hover, color-mix(in srgb, var(--ink) 4%, transparent));
  transition: background 0.18s ease;
}
.cp-cmd-sigil {
  flex: none;
  font-family: var(--font-mono);
  font-size: 13.5px;
  color: var(--muted);
  transition: color 0.18s ease;
}
.cp-cmd-field:focus-within .cp-cmd-sigil {
  color: var(--accent);
}
.cp-cmd-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ink);
  caret-color: var(--accent);
  font-family: var(--font-mono);
  font-size: 13.5px;
  letter-spacing: -0.01em;
  outline: none;
}
.cp-cmd-input::placeholder {
  color: var(--muted);
}
.cp-cmd-input::selection {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}
.cp-cmd-hint {
  margin-top: 0.5rem;
  font-size: 11.5px;
  letter-spacing: -0.01em;
  color: var(--muted);
}

/* ── creating readout ── mirrors the clone progress readout. */
.cp-prog-head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.25rem 0 0.75rem;
  min-width: 0;
}
.cp-prog-name {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.cp-prog-into {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: -0.01em;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cp-track {
  position: relative;
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  overflow: hidden;
}
.cp-track-bar {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
}
.cp-track-bar.is-sweeping {
  width: 38%;
  animation: cp-sweep 1.1s cubic-bezier(0.65, 0, 0.35, 1) infinite;
}
.cp-track-bar.is-done {
  width: 100%;
  transition: width 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes cp-sweep {
  0% {
    transform: translateX(-110%);
  }
  100% {
    transform: translateX(370%);
  }
}
.cp-prog-meta {
  margin-top: 0.5rem;
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: -0.01em;
}
.cp-stage {
  color: var(--ink-soft);
}
@media (prefers-reduced-motion: reduce) {
  .cp-track-bar.is-sweeping {
    animation: none;
    width: 100%;
    opacity: 0.6;
  }
}

/* ── actions ── (identical to the clone modal's) */
.cp-action {
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
.cp-action:hover {
  opacity: 0.7;
}
.cp-action:disabled {
  cursor: default;
  opacity: 0.4;
}
.cp-more {
  gap: 0.35rem;
}
.cp-more.is-active {
  color: var(--ink-soft);
}
.cp-more-dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--accent);
}
.cp-submit-arrow {
  color: var(--accent);
  font-weight: 500;
  transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.cp-submit:not(:disabled):hover .cp-submit-arrow {
  transform: translateX(3px);
}
</style>
