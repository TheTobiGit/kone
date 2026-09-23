<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AiBrain01Icon,
  Copy01Icon,
  Download01Icon,
  PencilEdit01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import ThreadProjectRows from "~/components/thread/ThreadProjectRows.vue";
import { useThreadExport } from "~/composables/useThreadExport";
import type { ThreadExportFormat } from "~/types/desktop";
import { THREAD_EXPORT_FORMAT_LABELS, THREAD_EXPORT_FORMATS } from "~/utils/threadExport";
import { describeModelId, EFFORT_META, type BrandKey, type EffortTier } from "~/utils/modelCatalog";
import { PROVIDER_LABEL } from "~/utils/usageProviders";
import { formatContextTokens as fmt } from "~/utils/formatContextTokens";
import { brainStack } from "~/utils/subagentRuns";
import type { ThreadSession } from "~/composables/useAgent";
import type { GitRemote, ProviderKind, ThreadEnvMode } from "~/types/desktop";

// The thread-info drop-down — the natural read-out of a conversation's name.
// Clicking the column title opens this beneath it: the thread's own name leads,
// with the model, its settings and a real token breakdown below, on the ground
// surface with one hairline ring, a soft low shadow and a recessed head band
// whose bottom corners round off. It reads the live session refs, so a running
// turn keeps the state and token rows current while it's open; the one thing it
// writes is the name, which edits in place on the Name row.

const props = defineProps<{
  session: ThreadSession;
  /** Viewport rect of the title that opened the panel — the anchor. */
  anchor: DOMRect;
  // Where the thread works, handed through to the Project group — see
  // ThreadProjectRows for what each one shows.
  repo?: string;
  projectPath?: string;
  branch?: string;
  origin?: GitRemote | null;
  worktreePath?: string | null;
  envMode?: ThreadEnvMode | null;
}>();

const emit = defineEmits<{ close: []; rename: [title: string] }>();

const { cue } = useSound();

const s = props.session;

const name = computed(() => s.title.value || "New thread");

// ── rename ──────────────────────────────────────────────────────────────────
// The Name row is where a thread gets its name: its value is a field, not a
// read-out. Enter commits, Esc reverts, blur commits — the owner does the write,
// so a store refusal can still put the old name back under us.
const editing = ref(false);
const draft = ref("");
const nameInput = ref<HTMLInputElement | null>(null);

function startEdit(): void {
  if (editing.value) return;
  cue("press");
  draft.value = s.title.value;
  editing.value = true;
  void nextTick(() => {
    nameInput.value?.focus();
    nameInput.value?.select();
  });
}
function cancelEdit(): void {
  editing.value = false;
  draft.value = "";
}
function commitEdit(): void {
  if (!editing.value) return;
  const next = draft.value.trim();
  editing.value = false;
  draft.value = "";
  if (!next || next === s.title.value) return;
  emit("rename", next);
}
const PROVIDER_BRAND = {
  codex: "codex",
  claudeAgent: "claude",
  opencode: "opencode",
  cursor: "cursor",
  droid: "droid",
  antigravity: "antigravity",
} satisfies Record<ProviderKind, BrandKey>;

const providerKind = computed(() => s.provider?.value);
const providerBrand = computed<BrandKey>(() =>
  providerKind.value ? PROVIDER_BRAND[providerKind.value] : "generic",
);
const providerLabel = computed(() =>
  providerKind.value ? PROVIDER_LABEL[providerKind.value] ?? providerKind.value : "",
);

const brand = computed(() => describeModelId(s.model.value).brand);
const modelName = computed(() => describeModelId(s.model.value).name);

// Reasoning wears the same brain-stack as the model picker: a tier's brain
// count and hue read at a glance, its label spelling it out.
const effort = computed(() => {
  // SAFETY: EFFORT_META[tier] below falls back to ?? EFFORT_META.medium, so a
  // string outside EffortTier can only miss the lookup, never misbehave.
  const tier = String(s.reasoning.value ?? "").toLowerCase() as EffortTier;
  return EFFORT_META[tier] ?? EFFORT_META.medium;
});

// Status is shown only when it carries meaning: a live turn, or an error. A
// merely-ready idle thread says nothing — the name is the story, not the state.
const working = computed(() => {
  const st = String(s.sessionState.value);
  return st === "running" || st === "starting";
});
const errored = computed(() => String(s.sessionState.value) === "error");
const showStatus = computed(() => working.value || errored.value);
const statusLabel = computed(() => (errored.value ? "Error" : "Working"));

const threadId = computed(() => s.threadId.value);
const shortId = computed(() => {
  const id = threadId.value;
  if (!id) return null;
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
});

const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;
async function copyId(): Promise<void> {
  const id = threadId.value;
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = false), 1400);
  } catch {
    /* clipboard blocked — silently no-op */
  }
}

// ── export ────────────────────────────────────────────────────────────────────
// A transcript of this thread, saved through the main process's native save
// dialog — the renderer never touches the filesystem. Markdown carries a
// bounded excerpt of long tool output, JSON carries every byte. While a turn
// runs the button parks: the backend would refuse the export anyway, so the
// title says to wait rather than letting the click fail.
const exporter = useThreadExport();
const exportFormat = ref<ThreadExportFormat>("markdown");
const exportFormats = THREAD_EXPORT_FORMATS;

function pickExportFormat(next: ThreadExportFormat): void {
  if (next === exportFormat.value) return;
  exportFormat.value = next;
  cue("toggle");
}

const exportBusy = computed(
  () => exporter.phase.value === "dialog" || exporter.phase.value === "exporting",
);
const exportDisabled = computed(() => working.value || exportBusy.value);
const exportButtonTitle = computed(() =>
  working.value
    ? "Wait for the current turn to finish before exporting."
    : "Save this thread as a file",
);
const exportButtonLabel = computed(() => {
  const phase = exporter.phase.value;
  if (phase === "dialog") return "Choose a location…";
  if (phase === "exporting") return "Saving…";
  return "Export thread";
});
const exportTone = computed(() => {
  const phase = exporter.phase.value;
  if (phase === "saved") return "ok";
  if (phase === "failed") return "error";
  return "muted";
});

async function onExport(): Promise<void> {
  if (exportDisabled.value) return;
  cue("press");
  await exporter.runExport(threadId.value, s.title.value, exportFormat.value);
  if (exporter.phase.value === "saved") cue("success");
  else if (exporter.phase.value === "failed") cue("error");
}

// ── token breakdown ─────────────────────────────────────────────────────────
// Every row renders only when its number is real: a fresh thread that has not
// run yet reports nothing, so the section says so rather than drawing an empty
// ring that would read as "nothing consumed".
const usage = computed(() => s.tokenUsage.value);
const ctxUsed = computed(() => {
  const u = usage.value;
  if (!u) return undefined;
  const n = u.contextUsed ?? u.total;
  return n !== undefined && n !== null && Number.isFinite(n) ? n : undefined;
});
const ctxWindow = computed(() => {
  const m = usage.value?.contextWindow;
  return m !== undefined && m !== null && Number.isFinite(m) && m > 0 ? m : undefined;
});
const tokenRows = computed(() => {
  const u = usage.value;
  if (!u)
    // SAFETY: the array literal is empty, so its element type vacuously
    // matches the token-row shape the non-empty branch below builds.
    return [] as { label: string; value: string }[];
  const out: { label: string; value: string }[] = [];
  if (ctxUsed.value !== undefined && ctxWindow.value !== undefined) {
    const remaining = ctxWindow.value - ctxUsed.value;
    if (remaining > 0) out.push({ label: "Remaining", value: fmt(remaining) });
  }
  if (u.input !== undefined && u.input !== null && Number.isFinite(u.input)) out.push({ label: "Input", value: fmt(u.input) });
  if (u.output !== undefined && u.output !== null && Number.isFinite(u.output)) out.push({ label: "Output", value: fmt(u.output) });
  if (u.total !== undefined && u.total !== null && Number.isFinite(u.total)) out.push({ label: "Total", value: fmt(u.total) });
  return out;
});
const hasTokens = computed(() => tokenRows.value.length > 0);

// ── positioning ─────────────────────────────────────────────────────────────
const panel = ref<HTMLElement | null>(null);
const PANEL_W = 320;
const MARGIN = 12;
const pos = computed(() => {
  const a = props.anchor;
  const vw = "window" in globalThis ? window.innerWidth : 1280;
  const centre = a.left + a.width / 2;
  let left = centre - PANEL_W / 2;
  left = Math.max(MARGIN, Math.min(left, vw - PANEL_W - MARGIN));
  return { top: `${a.bottom + 8}px`, left: `${left}px` };
});

function onKey(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  // Esc backs out one step at a time: it drops a name edit first, and only
  // closes the panel once there is no edit left to abandon.
  if (editing.value) {
    cancelEdit();
    return;
  }
  emit("close");
}
// The panel is pinned to a rect captured once, so anything that moves its
// anchor closes it. A scroll *inside* the panel moves nothing — and the name
// field scrolls itself the moment a long name reaches its right edge, which
// would otherwise close the panel mid-rename.
function onScroll(e: Event): void {
  const t = e.target;
  if (t instanceof Node && panel.value?.contains(t)) return;
  emit("close");
}
function onResize(): void {
  emit("close");
}
onMounted(() => {
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize, true);
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<template>
  <Teleport to="body">
    <div class="tip">
      <button type="button" class="tip__catch" aria-label="Close thread info" @click="emit('close')" />
      <div ref="panel" class="tip__panel" role="dialog" aria-label="Thread info" :style="pos">
        <header class="tip__head">
          <span class="tip__title">Details</span>
          <span v-if="showStatus" class="tip__state" :data-tone="errored ? 'error' : 'live'">
            <span class="tip__state-dot" aria-hidden="true" />
            {{ statusLabel }}
          </span>
        </header>

        <dl class="tip__rows">
          <div class="tip__row tip__row--name" :data-editing="editing ? '' : undefined">
            <dt>Name</dt>
            <dd class="tip__name">
              <input
                v-if="editing"
                ref="nameInput"
                v-model="draft"
                class="tip__name-input"
                aria-label="Thread name"
                maxlength="120"
                @keydown.enter.prevent="commitEdit()"
                @blur="commitEdit()"
              />
              <template v-else>
                <span class="tip__name-value" :title="name">{{ name }}</span>
                <button type="button" class="tip__edit" aria-label="Rename thread" @click="startEdit()">
                  <HugeiconsIcon :icon="PencilEdit01Icon" :size="12" :stroke-width="1.9" aria-hidden="true" />
                  Edit
                </button>
              </template>
            </dd>
          </div>
          <div v-if="providerLabel" class="tip__row">
            <dt>Provider</dt>
            <dd class="tip__provider" :title="providerLabel">
              <ProviderLogo v-if="providerBrand !== 'generic'" :brand="providerBrand" :size="14" />
              <span>{{ providerLabel }}</span>
            </dd>
          </div>
          <div class="tip__row">
            <dt>Model</dt>
            <dd class="tip__model" :title="modelName">
              <ProviderLogo v-if="brand !== 'generic'" :brand="brand" :size="14" />
              <span>{{ modelName }}</span>
            </dd>
          </div>
          <div class="tip__row">
            <dt>Reasoning</dt>
            <dd class="tip__reasoning">
              <span class="tip__brains" :class="{ 'tip__brains--glow': effort.glow }" aria-hidden="true">
                <HugeiconsIcon
                  v-for="i in brainStack(effort.brains)"
                  :key="i"
                  :icon="AiBrain01Icon"
                  :size="13"
                  :stroke-width="2"
                  :style="{ color: effort.hue }"
                />
              </span>
              <span>{{ effort.label }}</span>
            </dd>
          </div>
          <div v-if="s.isSideChat.value" class="tip__row">
            <dt>Kind</dt>
            <dd>Side chat</dd>
          </div>
          <div v-if="s.forkContext?.value?.forkKind === 'handoff'" class="tip__row">
            <dt>Handed off</dt>
            <dd>
              {{
                s.forkContext.value.sourceProvider
                  ? `From ${PROVIDER_LABEL[s.forkContext.value.sourceProvider]}`
                  : "From another provider"
              }}
            </dd>
          </div>

          <ThreadProjectRows
            :repo="repo"
            :project-path="projectPath"
            :branch="branch"
            :origin="origin"
            :worktree-path="worktreePath"
            :env-mode="envMode"
          />

          <p class="tip__section">Context</p>
          <template v-if="hasTokens">
            <div v-for="r in tokenRows" :key="r.label" class="tip__row">
              <dt>{{ r.label }}</dt>
              <dd>{{ r.value }}</dd>
            </div>
          </template>
          <div v-else class="tip__row">
            <dt>Tokens</dt>
            <dd class="tip__muted">Not reported yet</dd>
          </div>

          <p class="tip__section">Identity</p>
          <div class="tip__row">
            <dt>Thread ID</dt>
            <dd class="tip__id">
              <template v-if="shortId">
                <code>{{ shortId }}</code>
                <button type="button" class="tip__copy" :aria-label="copied ? 'Copied' : 'Copy thread ID'" @click="copyId">
                  <HugeiconsIcon :icon="copied ? Tick02Icon : Copy01Icon" :size="12" :stroke-width="2" />
                </button>
              </template>
              <span v-else class="tip__muted">Not started</span>
            </dd>
          </div>

          <p class="tip__section">Export</p>
          <div class="tip__row">
            <dt>Format</dt>
            <dd class="tip__formats" role="radiogroup" aria-label="Export format">
              <button
                v-for="f in exportFormats"
                :key="f"
                type="button"
                role="radio"
                class="tip__format"
                :class="{ 'tip__format--on': f === exportFormat }"
                :aria-checked="f === exportFormat"
                @click="pickExportFormat(f)"
              >
                {{ THREAD_EXPORT_FORMAT_LABELS[f] }}
              </button>
            </dd>
          </div>
          <div class="tip__export-line">
            <button
              type="button"
              class="tip__export"
              :disabled="exportDisabled"
              :title="exportButtonTitle"
              @click="onExport()"
            >
              <HugeiconsIcon :icon="Download01Icon" :size="13" :stroke-width="2" aria-hidden="true" />
              {{ exportButtonLabel }}
            </button>
          </div>
          <p
            v-if="exporter.message.value"
            class="tip__export-status"
            :data-tone="exportTone"
            role="status"
          >
            {{ exporter.message.value }}
          </p>
        </dl>
      </div>
    </div>
  </Teleport>
</template>

<style scoped src="./threadInfoRows.css"></style>

<style scoped>
.tip {
  position: fixed;
  inset: 0;
  z-index: 60;
}
.tip__catch {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: default;
}
.tip__panel {
  position: absolute;
  width: min(320px, calc(100vw - 24px));
  background: var(--panel);
  border-radius: 18px;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 22px 48px -20px color-mix(in srgb, #000 42%, transparent);
  overflow: hidden;
  transform-origin: top center;
  animation: tip-in 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes tip-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .tip__panel { animation: none; }
}
.tip__head {
  --band-bg: var(--band);
  --band-arc: 14px;
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 0.95rem 0.7rem;
  background-color: var(--band-bg);
}
.tip__head :deep(.plogo) {
  flex: none;
  opacity: 0.9;
}
.tip__head::before,
.tip__head::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}
.tip__head::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.tip__head::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}
.tip__title {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.3;
  color: var(--ink-soft);
}
.tip__reasoning {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tip__brains {
  display: inline-flex;
  align-items: center;
}
.tip__brains > :deep(svg) {
  margin-left: -5px;
}
.tip__brains > :deep(svg:first-child) {
  margin-left: 0;
}
.tip__brains--glow > :deep(svg) {
  filter: drop-shadow(0 0 3px currentColor);
}
.tip__provider,
.tip__model {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.tip__provider :deep(.plogo),
.tip__model :deep(.plogo) {
  flex: none;
  opacity: 0.9;
}
.tip__provider span,
.tip__model span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tip__state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  font-size: 11px;
  font-weight: 560;
  color: color-mix(in srgb, var(--accent) 70%, var(--ink));
}
.tip__state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.tip__state[data-tone="error"] {
  color: var(--danger, #d9544f);
}
.tip__state[data-tone="error"] .tip__state-dot {
  background: var(--danger, #d9544f);
}
.tip__rows {
  margin: 0;
  padding: 0.5rem 0.95rem 0.85rem;
  display: flex;
  flex-direction: column;
}
/* Name — the row reads like every other value until it's touched. Edit rides
   the row's right edge out of flow, over a fade the long name slides under, so
   it costs no space and appearing never nudges the name one pixel. */
.tip__row--name {
  min-height: 28px;
}
.tip__name {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: 1 1 auto;
  overflow: visible; /* the field's focus ring must not be clipped by the row */
}
.tip__name-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tip__edit {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 7px 0 18px;
  border: 0;
  border-radius: 6px;
  background: linear-gradient(to right, transparent, var(--panel) 18px);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease;
}
.tip__row--name:hover .tip__edit,
.tip__row--name:focus-within .tip__edit,
.tip__edit:focus-visible {
  opacity: 1;
}
.tip__edit:hover,
.tip__edit:focus-visible {
  color: var(--ink);
  background: linear-gradient(
    to right,
    transparent,
    color-mix(in srgb, var(--ink) 8%, var(--panel)) 18px
  );
}
.tip__edit:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
}
.tip__name-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 2px 6px;
  border: 0;
  border-radius: 7px;
  background: var(--hover);
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink);
  text-align: right;
}
.tip__name-input:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
}
.tip__id {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tip__id code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink);
}
.tip__copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.tip__copy:hover {
  background: var(--hover);
  color: var(--ink);
}
/* Export — the format reads as two quiet words (the set one in ink), the
   action as a bordered button, and the answer as one status line under it.
   Success borrows the accent, failure the danger wash; the quiet answers
   (cancelled, nothing to export yet) sit in muted. */
.tip__formats {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  overflow: visible;
}
.tip__format {
  padding: 0;
  border: 0;
  background: transparent;
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.15s ease;
}
.tip__format:hover,
.tip__format--on {
  color: var(--ink);
}
.tip__format:focus-visible {
  outline: none;
  border-radius: 4px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
}
.tip__export-line {
  display: flex;
  justify-content: flex-end;
  padding: 6px 0 2px;
}
.tip__export {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 8px;
  background: transparent;
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 550;
  color: var(--ink);
  cursor: pointer;
  transition: background-color 0.15s ease, opacity 0.15s ease;
}
.tip__export:hover:not(:disabled) {
  background: var(--hover);
}
.tip__export:disabled {
  opacity: 0.45;
  cursor: default;
}
.tip__export:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
}
.tip__export-status {
  margin: 2px 0 0;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--muted);
  text-align: right;
  overflow-wrap: anywhere;
}
.tip__export-status[data-tone="ok"] {
  color: color-mix(in srgb, var(--accent) 75%, var(--ink));
}
.tip__export-status[data-tone="error"] {
  color: var(--danger, #d9544f);
}
</style>
