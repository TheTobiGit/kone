<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowLeft01Icon,
  AiBrain01Icon,
  GitBranchIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import FileIcon from "~/components/file/FileIcon.vue";
import type { ChangeItem } from "~/types/change";
import type {
  GitActionProgressEvent,
  GitCommit,
  GitRunStackedActionResult,
  GitStackedAction,
} from "~/types/desktop";

const props = defineProps<{
  projectPath: string;
  branch: string | null;
  changes: ChangeItem[];
  refresh?: () => Promise<void>;
}>();

const emit = defineEmits<{
  close: [];
  committed: [result: GitRunStackedActionResult];
}>();

const git = useGit();
const { cue } = useSound();

type ModalStep = "select" | "message" | "success";
const step = ref<ModalStep>("select");

// ── Selection State ──────────────────────────────────────────────────────────
const selectedPaths = ref<Set<string>>(new Set());

function initSelection() {
  const staged = props.changes.filter((c) => c.staged);
  if (staged.length > 0) {
    selectedPaths.value = new Set(staged.map((c) => c.path));
  } else {
    selectedPaths.value = new Set(props.changes.map((c) => c.path));
  }
}

function togglePath(path: string) {
  cue("toggle");
  const next = new Set(selectedPaths.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  selectedPaths.value = next;
}

function toggleAll() {
  cue("toggle");
  if (selectedPaths.value.size === props.changes.length) {
    selectedPaths.value = new Set();
  } else {
    selectedPaths.value = new Set(props.changes.map((c) => c.path));
  }
}

const selectedChanges = computed(() =>
  props.changes.filter((c) => selectedPaths.value.has(c.path)),
);

const selectedAdded = computed(() =>
  selectedChanges.value.reduce((acc, c) => acc + (c.added || 0), 0),
);

const selectedRemoved = computed(() =>
  selectedChanges.value.reduce((acc, c) => acc + (c.removed || 0), 0),
);

const allSelected = computed(
  () => props.changes.length > 0 && selectedPaths.value.size === props.changes.length,
);

// ── Message & AI State ───────────────────────────────────────────────────────
const summary = ref("");
const description = ref("");
const isGenerating = ref(false);
const isSubmitting = ref(false);
const submitProgress = ref("Committing changes…");
const errorMessage = ref<string | null>(null);

const summaryInput = ref<HTMLInputElement | null>(null);
const bodyInput = ref<HTMLTextAreaElement | null>(null);

function grow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
watch(description, () => grow(bodyInput.value));

function goToMessage() {
  if (selectedPaths.value.size === 0) return;
  cue("press");
  step.value = "message";
  void nextTick(() => {
    summaryInput.value?.focus();
  });
}

function goBackToSelect() {
  if (isSubmitting.value) return;
  cue("press");
  step.value = "select";
}

async function generateAiMessage() {
  if (isGenerating.value) return;
  cue("press");
  isGenerating.value = true;
  errorMessage.value = null;

  try {
    const stagedSummary = selectedChanges.value
      .map((c) => `${c.deleted ? "D" : c.isNew ? "A" : "M"}\t${c.path}`)
      .join("\n");

    const res = await git.generateCommitMessage(props.projectPath, {
      branch: props.branch,
      stagedSummary,
    });

    if (res.subject) {
      animateTypewriter(res.subject, res.body);
    }
  } catch {
    errorMessage.value = "Failed to generate commit message";
  } finally {
    isGenerating.value = false;
  }
}

function animateTypewriter(targetSubject: string, targetBody?: string) {
  summary.value = "";
  description.value = "";

  let i = 0;
  const speed = Math.max(10, Math.min(22, Math.floor(500 / targetSubject.length)));
  const interval = window.setInterval(() => {
    if (i < targetSubject.length) {
      summary.value += targetSubject[i];
      i++;
    } else {
      window.clearInterval(interval);
      if (targetBody) {
        description.value = targetBody;
        void nextTick(() => grow(bodyInput.value));
      }
    }
  }, speed);
}

// ── Execution & Success Timeline ─────────────────────────────────────────────
const commitResult = ref<GitRunStackedActionResult | null>(null);
const recentCommits = ref<GitCommit[]>([]);
let unlistenProgress: (() => void) | null = null;

async function executeCommit(action: GitStackedAction = "commit_push") {
  if (!summary.value.trim() || isSubmitting.value) return;
  cue("press");
  isSubmitting.value = true;
  errorMessage.value = null;
  submitProgress.value = action.includes("push") ? "Committing and pushing…" : "Committing changes…";

  try {
    const res = await git.runStackedAction(props.projectPath, {
      dir: props.projectPath,
      action,
      message: summary.value.trim(),
      body: description.value.trim() || undefined,
      filePaths: Array.from(selectedPaths.value),
    });

    commitResult.value = res;
    cue("success");

    try {
      const logs = await git.log(props.projectPath, 3);
      recentCommits.value = logs;
    } catch {
      recentCommits.value = [];
    }

    void props.refresh?.();
    step.value = "success";
    emit("committed", res);
  } catch (err) {
    cue("error");
    errorMessage.value = err instanceof Error ? err.message : String(err);
  } finally {
    isSubmitting.value = false;
  }
}

function handleDone() {
  cue("press");
  close(() => emit("close"));
}

function parseFilePath(fullPath: string) {
  const parts = fullPath.split("/");
  const fileName = parts.pop() ?? fullPath;
  const dirName = parts.length > 0 ? parts.join("/") + "/" : "";
  return { fileName, dirName };
}

// ── Modal Shell State ────────────────────────────────────────────────────────
const shown = ref(false);
const closing = ref(false);
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}

watch(step, () => {
  void nextTick(() => {
    syncHeight();
  });
});

function close(done: () => void) {
  if (closing.value) return;
  closing.value = true;
  shown.value = false;
  window.setTimeout(done, 240);
}

function onCancel() {
  if (isSubmitting.value) return;
  close(() => emit("close"));
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    if (step.value === "message" && !isSubmitting.value) {
      goBackToSelect();
    } else {
      onCancel();
    }
  } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    if (step.value === "select" && selectedPaths.value.size > 0) {
      e.preventDefault();
      goToMessage();
    } else if (step.value === "message" && summary.value.trim() && !isSubmitting.value) {
      e.preventDefault();
      void executeCommit();
    }
  }
}

let opener: HTMLElement | null = null;

onMounted(async () => {
  // SAFETY: activeElement in browser DOM is an Element, cast to HTMLElement | null for focus restoration.
  opener = document.activeElement as HTMLElement | null;
  initSelection();
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", syncHeight);

  await nextTick();
  syncHeight();
  ro = new ResizeObserver(syncHeight);
  if (contentEl.value) ro.observe(contentEl.value);

  requestAnimationFrame(() => {
    shown.value = true;
  });

  unlistenProgress = git.onActionProgress((ev: GitActionProgressEvent) => {
    submitProgress.value = ev.message;
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", syncHeight);
  ro?.disconnect();
  opener?.focus();
  unlistenProgress?.();
});

const cardSpring = {
  type: "spring",
  stiffness: 300,
  damping: 24,
  mass: 0.9,
} as const;

const morphSpring = {
  type: "spring",
  stiffness: 360,
  damping: 34,
  mass: 0.8,
} as const;

const viewMorph = {
  y: morphSpring,
  opacity: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
  filter: { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
} as const;
</script>

<template>
  <!-- Bottom right anchor matching CreateProjectModal & GitHubCloneModal -->
  <div class="fixed inset-0 z-50 flex items-end justify-end overflow-hidden p-6">
    <!-- Scrim -->
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

    <!-- Modal Card Shell -->
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
      aria-label="Commit changes"
    >
      <div ref="contentEl" class="flex shrink-0 flex-col">
        <AnimatePresence mode="popLayout" :initial="false">
          <!-- ── STEP 1: SELECT FILES ───────────────────────────────────────── -->
          <motion.div
            v-if="step === 'select'"
            key="select"
            class="flex flex-col px-4 py-4"
            :initial="{ opacity: 0, y: 10, filter: 'blur(3px)' }"
            :animate="{ opacity: 1, y: 0, filter: 'blur(0px)' }"
            :exit="{ opacity: 0, y: -10, filter: 'blur(3px)' }"
            :transition="viewMorph"
          >
            <!-- Header Band: Eyebrow + Cancel -->
            <div class="commit-band commit-header -mx-4 -mt-4 mb-3 flex items-center justify-between">
              <span class="commit-eyebrow">Select files</span>
              <button
                type="button"
                class="commit-action text-muted"
                @click="onCancel"
              >
                Cancel
              </button>
            </div>

            <!-- Select All & Counts -->
            <div class="flex items-center justify-between pb-2">
              <button type="button" class="select-all-btn" @click="toggleAll">
                <span class="commit-mark" :class="{ 'is-checked': allSelected }">
                  <HugeiconsIcon v-if="allSelected" :icon="Tick02Icon" :size="11" :stroke-width="2.5" />
                </span>
                <span>{{ allSelected ? 'Deselect all' : 'Select all changed' }}</span>
              </button>
              <span class="commit-diffstat font-mono text-xs text-muted">
                <span v-if="selectedAdded > 0" class="text-diff-add">+{{ selectedAdded }}</span>
                <span v-if="selectedRemoved > 0" class="text-diff-del ml-1.5">−{{ selectedRemoved }}</span>
              </span>
            </div>

            <!-- File List -->
            <div class="commit-scroll flex max-h-[46vh] flex-col gap-0.5 overflow-y-auto -mx-2 px-2 py-0.5">
              <button
                v-for="c in changes"
                :key="c.path"
                type="button"
                class="commit-row flex items-center justify-between w-full text-left"
                :class="{ 'is-picked': selectedPaths.has(c.path) }"
                @click="togglePath(c.path)"
              >
                <div class="flex items-center gap-2.5 min-w-0">
                  <span class="commit-mark" :class="{ 'is-checked': selectedPaths.has(c.path) }">
                    <HugeiconsIcon v-if="selectedPaths.has(c.path)" :icon="Tick02Icon" :size="11" :stroke-width="2.5" />
                  </span>
                  <FileIcon :path="c.path" :size="15" class="shrink-0" />
                  <div class="flex flex-col min-w-0">
                    <span class="text-[13.5px] font-semibold leading-tight truncate text-ink">
                      {{ parseFilePath(c.path).fileName }}
                    </span>
                    <span v-if="parseFilePath(c.path).dirName" class="text-[11.5px] font-mono text-muted truncate">
                      {{ parseFilePath(c.path).dirName }}
                    </span>
                  </div>
                </div>

                <div class="flex items-center gap-1.5 font-mono text-xs shrink-0 pl-2">
                  <span v-if="c.added > 0" class="text-diff-add">+{{ c.added }}</span>
                  <span v-if="c.removed > 0" class="text-diff-del">−{{ c.removed }}</span>
                </div>
              </button>
            </div>

            <!-- Footer Band: File count on left, Continue action on right -->
            <div class="commit-band commit-footer -mx-4 -mb-4 mt-3 flex items-center justify-between gap-4">
              <span class="text-xs font-mono text-muted">
                {{ selectedPaths.size === 0 ? 'No files selected' : `${selectedPaths.size} of ${changes.length} files` }}
              </span>
              <button
                type="button"
                class="commit-action commit-submit text-ink"
                :disabled="selectedPaths.size === 0"
                @click="goToMessage"
              >
                Continue
                <span class="commit-submit-arrow" aria-hidden="true">→</span>
              </button>
            </div>
          </motion.div>

          <!-- ── STEP 2: WRITE MESSAGE & AI ─────────────────────────────────── -->
          <motion.div
            v-else-if="step === 'message'"
            key="message"
            class="flex flex-col px-4 py-4"
            :initial="{ opacity: 0, y: 10, filter: 'blur(3px)' }"
            :animate="{ opacity: 1, y: 0, filter: 'blur(0px)' }"
            :exit="{ opacity: 0, y: -10, filter: 'blur(3px)' }"
            :transition="viewMorph"
          >
            <!-- Header Band: Back + Branch info + Cancel -->
            <div class="commit-band commit-header -mx-4 -mt-4 mb-3 flex items-center justify-between">
              <button
                type="button"
                class="commit-action text-muted flex items-center gap-1"
                :disabled="isSubmitting"
                @click="goBackToSelect"
              >
                <HugeiconsIcon :icon="ArrowLeft01Icon" :size="13" />
                <span>Files</span>
              </button>

              <span class="flex items-center gap-1.5 font-mono text-xs text-ink-soft">
                <HugeiconsIcon :icon="GitBranchIcon" :size="12" class="text-muted" />
                <span>{{ branch || 'main' }}</span>
                <span class="text-muted">({{ selectedPaths.size }})</span>
              </span>

              <button
                type="button"
                class="commit-action text-muted"
                :disabled="isSubmitting"
                @click="onCancel"
              >
                Cancel
              </button>
            </div>

            <!-- Form: Seamless inputs -->
            <div class="flex flex-col gap-2 py-1">
              <label class="commit-field group">
                <input
                  ref="summaryInput"
                  v-model="summary"
                  type="text"
                  class="commit-input"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder="Summary of changes"
                  aria-label="Commit summary"
                  :disabled="isSubmitting"
                  @keydown.enter.prevent="bodyInput?.focus()"
                />
              </label>

              <textarea
                ref="bodyInput"
                v-model="description"
                rows="2"
                class="commit-textarea"
                placeholder="Description (optional)"
                aria-label="Commit description"
                :disabled="isSubmitting"
              />

              <p v-if="errorMessage" class="commit-error" role="alert">
                {{ errorMessage }}
              </p>
            </div>

            <!-- Footer Band: AI on left, Commit / Push actions on right -->
            <div class="commit-band commit-footer -mx-4 -mb-4 mt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                class="commit-action text-muted flex items-center gap-1.5"
                :disabled="isGenerating || isSubmitting"
                @click="generateAiMessage"
              >
                <HugeiconsIcon
                  :icon="AiBrain01Icon"
                  :size="14"
                  :stroke-width="1.7"
                  class="text-accent"
                  :class="{ 'animate-spin': isGenerating }"
                />
                <span>{{ isGenerating ? 'Generating…' : (summary ? 'Regenerate' : 'Generate') }}</span>
              </button>

              <div class="flex items-center gap-4">
                <button
                  type="button"
                  class="commit-action text-muted"
                  :disabled="!summary.trim() || isSubmitting"
                  @click="executeCommit('commit')"
                >
                  Commit only
                </button>
                <button
                  type="button"
                  class="commit-action commit-submit text-ink"
                  :disabled="!summary.trim() || isSubmitting"
                  @click="executeCommit('commit_push')"
                >
                  <span>{{ isSubmitting ? submitProgress : 'Push to origin' }}</span>
                  <span v-if="!isSubmitting" class="commit-submit-arrow" aria-hidden="true">→</span>
                </button>
              </div>
            </div>
          </motion.div>

          <!-- ── STEP 3: SUCCESS TIMELINE ───────────────────────────────────── -->
          <motion.div
            v-else-if="step === 'success'"
            key="success"
            class="flex flex-col px-4 py-4"
            :initial="{ opacity: 0, y: 10, filter: 'blur(3px)' }"
            :animate="{ opacity: 1, y: 0, filter: 'blur(0px)' }"
            :exit="{ opacity: 0, y: -10, filter: 'blur(3px)' }"
            :transition="viewMorph"
          >
            <!-- Header Band -->
            <div class="commit-band commit-header -mx-4 -mt-4 mb-3 flex items-center justify-between">
              <span class="commit-eyebrow">
                {{ commitResult?.pushed ? 'Pushed to origin' : 'Committed' }}
              </span>
              <button
                type="button"
                class="commit-action text-muted"
                @click="handleDone"
              >
                Done
              </button>
            </div>

            <!-- Commit Readout -->
            <div class="flex flex-col gap-3 py-1">
              <div class="flex items-start gap-2.5">
                <span class="commit-mark is-checked mt-0.5 shrink-0">
                  <HugeiconsIcon :icon="Tick02Icon" :size="11" :stroke-width="2.5" />
                </span>
                <div class="flex flex-col min-w-0">
                  <span class="text-[14px] font-semibold text-ink leading-snug">
                    {{ commitResult?.subject || summary }}
                  </span>
                  <p v-if="description.trim()" class="text-xs text-muted mt-1 whitespace-pre-wrap leading-relaxed">
                    {{ description }}
                  </p>
                  <div class="flex items-center gap-2 mt-2 font-mono text-[11.5px] text-muted">
                    <span v-if="commitResult?.commitSha" class="commit-sha">
                      {{ commitResult.commitSha.slice(0, 7) }}
                    </span>
                    <span>{{ commitResult?.branch || branch }}</span>
                    <span class="text-diff-add">+{{ selectedAdded }}</span>
                    <span class="text-diff-del">−{{ selectedRemoved }}</span>
                    <span>just now</span>
                  </div>
                </div>
              </div>

              <!-- Preceding Commits -->
              <div v-if="recentCommits.length > 0" class="flex flex-col gap-1.5 pt-2 border-t border-border-soft opacity-60">
                <div
                  v-for="c in recentCommits.slice(0, 2)"
                  :key="c.hash"
                  class="flex items-center justify-between text-xs"
                >
                  <span class="truncate text-ink-soft">{{ c.subject }}</span>
                  <span class="font-mono text-muted shrink-0 pl-2">{{ c.short }}</span>
                </div>
              </div>
            </div>

            <!-- Footer Band -->
            <div class="commit-band commit-footer -mx-4 -mb-4 mt-4 flex items-center justify-between gap-4">
              <button
                type="button"
                class="commit-action text-muted"
                @click="step = 'select'; summary = ''; description = '';"
              >
                New commit
              </button>
              <button
                type="button"
                class="commit-action commit-submit text-ink"
                @click="handleDone"
              >
                Done
                <span class="commit-submit-arrow" aria-hidden="true">→</span>
              </button>
            </div>
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
  --band-bg: var(--band);
  --band-arc: 14px;
  background: var(--panel);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

/* ── bands ── (concave-scooped recessed surfaces matching CreateProjectModal / GitHubCloneModal) */
.commit-band {
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.commit-eyebrow {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.commit-band::before,
.commit-band::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.commit-header::before,
.commit-header::after {
  top: 100%;
}
.commit-header::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.commit-header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.commit-footer::before,
.commit-footer::after {
  bottom: 100%;
}
.commit-footer::before {
  left: 0;
  background: radial-gradient(
    circle at top right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.commit-footer::after {
  right: 0;
  background: radial-gradient(
    circle at top left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

/* ── actions ── */
.commit-action {
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
.commit-action:hover {
  opacity: 0.7;
}
.commit-action:disabled {
  cursor: default;
  opacity: 0.4;
}
.commit-submit-arrow {
  color: var(--accent);
  font-weight: 500;
  transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.commit-submit:not(:disabled):hover .commit-submit-arrow {
  transform: translateX(3px);
}

/* ── inputs ── */
.commit-field {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.25rem 0;
}
.commit-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  outline: none;
}
.commit-input::placeholder {
  color: var(--muted);
  font-weight: 500;
}
.commit-input::selection {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}

.commit-textarea {
  width: 100%;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ink-soft);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.45;
  outline: none;
  resize: none;
}
.commit-textarea::placeholder {
  color: var(--muted);
}
.commit-textarea::selection {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}

.commit-error {
  font-family: var(--font-mono);
  font-size: 11.5px;
  letter-spacing: -0.01em;
  line-height: 1.35;
  color: color-mix(in srgb, var(--diff-del) 82%, var(--ink));
}

/* ── file selection rows ── */
.select-all-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  background: transparent;
  border: 0;
  padding: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.16s ease;
}
.select-all-btn:hover {
  color: var(--ink-soft);
}

.commit-mark {
  display: inline-flex;
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: 4px;
  align-items: center;
  justify-content: center;
  color: var(--ground);
  background: transparent;
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 22%, transparent);
  transition: background-color 0.16s ease, box-shadow 0.16s ease;
}
.commit-mark.is-checked {
  background: var(--ink);
  box-shadow: inset 0 0 0 1.5px var(--ink);
}

.commit-row {
  border-radius: 8px;
  padding: 0.45rem 0.5rem;
  color: var(--ink);
  transition: background-color 0.15s ease;
}
.commit-row:hover {
  background-color: var(--hover);
}

.commit-sha {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--hover);
  color: var(--ink);
  font-weight: 600;
}

.text-diff-add {
  color: var(--diff-add);
}
.text-diff-del {
  color: var(--diff-del);
}

/* ── scrollbar ── */
.commit-scroll {
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 16%, transparent) transparent;
}
.commit-scroll::-webkit-scrollbar {
  width: 8px;
}
.commit-scroll::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: content-box;
}
</style>
