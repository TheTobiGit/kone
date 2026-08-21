<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type CSSProperties } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { Cancel01Icon, ShuffleIcon, SparklesIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import AgentCapabilitiesEditor from "~/components/AgentCapabilitiesEditor.vue";
import AgentPoliciesEditor from "~/components/AgentPoliciesEditor.vue";
import { useAgentRoster } from "~/composables/useAgentRoster";
import { useSound } from "~/composables/useSound";
import { agentFace, type Agent, type FacePaint } from "~/utils/agents";
import type { AgentModelRef } from "~/types/desktop";

// Making an agent, in the shared modal shell — scrim, elastic card, scooped
// header/footer bands — walked as a stepper. Four stops: who the agent is
// (name, role, face paint together, since the paint is the visible half of
// identity), how it works, what it may reach for, what it may never do. Each
// stop holds one concern and carries almost no prose of its own: the
// placeholders teach, and the stepper's Next/Back rhythm replaces the old
// everything-at-once rail.
//
// The one thing a maker sets about a face is its paint (a marble body and the
// ink drawn on it) — that is the whole of what `createAgent` keeps and the
// whole of what the roster later draws, so the preview in the header is the
// real marble it will become, not a promise of something richer the store
// cannot hold.

const emit = defineEmits<{
  close: [];
  created: [agent: Agent];
}>();

const { createAgent } = useAgentRoster();
const { cue } = useSound();

// ── steps ─────────────────────────────────────────────────────────────────────
type Step = "identity" | "instructions" | "capabilities" | "policies";
const STEPS: { id: Step; label: string }[] = [
  { id: "identity", label: "Identity" },
  { id: "instructions", label: "Instructions" },
  { id: "capabilities", label: "Capabilities" },
  { id: "policies", label: "Policies" },
];
const step = ref<Step>("identity");
const stepIndex = computed(() => STEPS.findIndex((s) => s.id === step.value));
const stepLabel = computed(() => STEPS[stepIndex.value]?.label ?? "");

function goTo(index: number) {
  const next = STEPS[index];
  if (!next || next.id === step.value) return;
  step.value = next.id;
  cue("toggle");
  void nextTick(() => {
    syncHeight();
    focusStep();
  });
}

function next() {
  if (!canLeaveIdentity.value) return;
  goTo(stepIndex.value + 1);
}

function back() {
  goTo(stepIndex.value - 1);
}

// ── form state ────────────────────────────────────────────────────────────────
const name = ref("");
const role = ref("");
const instructions = ref("");
const model = ref<AgentModelRef | null>(null);
const deniedCommands = ref<string[]>([]);
const deniedPaths = ref<string[]>([]);
const isSubmitting = ref(false);
const errorMsg = ref<string | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const instructionsInput = ref<HTMLTextAreaElement | null>(null);

const canLeaveIdentity = computed(() => name.value.trim().length > 0 && !isSubmitting.value);
const canCreate = computed(() => name.value.trim().length > 0 && !isSubmitting.value);

/** Move focus to the entry field of the step just opened, where one exists.
 *  The editor steps manage their own focus; reaching into them would fight
 *  their internal tab order. */
function focusStep() {
  if (step.value === "identity") nameInput.value?.focus();
  else if (step.value === "instructions") instructionsInput.value?.focus();
}

// ── palette ───────────────────────────────────────────────────────────────────
// A curated set of body/ink pairs. Deliberately no house accent and no second
// accent: those two are kone's and Gideon's own voices, and a fresh agent should
// read as a colleague beside them, not a copy of either.
interface Swatch {
  id: string;
  name: string;
  paint: FacePaint;
}
const SWATCHES: Swatch[] = [
  { id: "sage", name: "Sage", paint: { body: "#5c7f6a", ink: "#ffffff" } },
  { id: "terracotta", name: "Terracotta", paint: { body: "#b8654a", ink: "#ffffff" } },
  { id: "cobalt", name: "Cobalt", paint: { body: "#4b6fa8", ink: "#ffffff" } },
  { id: "amethyst", name: "Amethyst", paint: { body: "#8a6a86", ink: "#ffffff" } },
  { id: "clay", name: "Amber clay", paint: { body: "#c08a5b", ink: "#18181b" } },
  { id: "slate", name: "Slate", paint: { body: "#6b7391", ink: "#ffffff" } },
  { id: "rose", name: "Rose", paint: { body: "#a86f6f", ink: "#ffffff" } },
  { id: "emerald", name: "Emerald", paint: { body: "#5f7a76", ink: "#ffffff" } },
];
const selected = ref<Swatch>(SWATCHES[0]!);

function pick(swatch: Swatch) {
  if (selected.value.id === swatch.id) return;
  selected.value = swatch;
  cue("toggle");
}

function shuffle() {
  const pool = SWATCHES.filter((s) => s.id !== selected.value.id);
  const next = pool[Math.floor(Math.random() * pool.length)];
  if (next) {
    selected.value = next;
    cue("press");
  }
}

// The live face: the exact marble the roster will draw, shown in the header so
// it stays visible on every step.
const faceSvg = computed(() => agentFace(selected.value.paint));

// ── card entrance / exit ────────────────────────────────────────────────────
const shown = ref(false);
const closing = ref(false);
const cardSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;

// Step morphs ride the same spring family as the other modals' view changes.
const stepMorph = {
  y: { type: "spring", stiffness: 360, damping: 34, mass: 0.8 },
  opacity: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
  filter: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
} as const;

// Play the card's exit, then hand control back to the caller. The delay matches
// the 0.24s exit transition so it finishes leaving before the parent unmounts.
function fadeOut(done: () => void) {
  if (closing.value) return;
  closing.value = true;
  shown.value = false;
  window.setTimeout(done, 240);
}

function close() {
  if (closing.value || isSubmitting.value) return;
  cue("collapse");
  fadeOut(() => emit("close"));
}

async function handleCreate() {
  const trimmed = name.value.trim();
  if (!trimmed || isSubmitting.value) return;

  isSubmitting.value = true;
  errorMsg.value = null;
  try {
    const created = await createAgent({
      name: trimmed,
      role: role.value.trim() || undefined,
      instructions: instructions.value.trim() || undefined,
      face: selected.value.paint,
      // Only send a model the maker actually pinned — an untouched picker is
      // "no preference", which the draft says by leaving the field off.
      model: model.value ?? undefined,
      // A prohibition is only sent when the maker set one — an untouched pair of
      // lists is "forbids nothing", which the draft says by leaving it off.
      policies:
        deniedCommands.value.length || deniedPaths.value.length
          ? { deniedCommands: deniedCommands.value, deniedPaths: deniedPaths.value }
          : undefined,
    });
    if (!created) {
      errorMsg.value = "Could not create the agent — check the fields and try again.";
      cue("error");
      isSubmitting.value = false;
      return;
    }
    cue("success");
    fadeOut(() => emit("created", created));
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : "Creation failed.";
    cue("error");
    isSubmitting.value = false;
  }
}

// ── keyboard ────────────────────────────────────────────────────────────────
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    if (canCreate.value) {
      e.preventDefault();
      void handleCreate();
    }
    return;
  }
  if (e.key === "Enter") {
    // A textarea spends Enter on newlines; a button spends it on clicking.
    if (document.activeElement instanceof HTMLTextAreaElement) return;
    if (document.activeElement instanceof HTMLButtonElement) return;
    e.preventDefault();
    if (stepIndex.value === STEPS.length - 1) void handleCreate();
    else next();
    return;
  }
  if (e.key === "Tab") {
    const root = contentEl.value;
    if (!root) return;
    const els = Array.from(
      root.querySelectorAll<HTMLElement>(
        'input, textarea, button:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = els[0];
    const last = els[els.length - 1];
    if (!first || !last) return;
    const active = document.activeElement as HTMLElement | null;
    const inTrap = active != null && els.includes(active);
    const atEdge = e.shiftKey ? active === first : active === last;
    if (atEdge || !inTrap) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }
}

// ── sidebar anchoring ─────────────────────────────────────────────────────
// The shell lives inside the settings drawer, not over the whole screen: the
// host (and its scrim) is fixed to the drawer's rect, so the dim only covers
// the sidebar and the card lands in its bottom-right corner. Without a
// measurement the host falls back to the full viewport, so a missing drawer
// degrades to the ordinary shell rather than misplacing the card.
const hostStyle = ref<CSSProperties>({});
let anchorEl: HTMLElement | null = null;
let anchorRO: ResizeObserver | null = null;

function anchorToDrawer() {
  const drawer = document.querySelector<HTMLElement>(".settings-scroll");
  if (drawer !== anchorEl) {
    anchorRO?.disconnect();
    anchorEl = drawer;
    if (drawer) {
      anchorRO = new ResizeObserver(anchorToDrawer);
      anchorRO.observe(drawer);
    }
  }
  if (!drawer) return;
  const rect = drawer.getBoundingClientRect();
  hostStyle.value = {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

// ── elastic height (mirrors the other modals) ────────────────────────────────
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

/** How tall the card may grow: the padded host, so it never spills the drawer. */
function maxCardHeight(): number {
  const raw = hostStyle.value.height;
  if (typeof raw === "string" && raw.endsWith("px")) {
    const host = Number.parseFloat(raw);
    if (Number.isFinite(host)) return Math.max(160, host - 48);
  }
  return Math.round(window.innerHeight * 0.72);
}

function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = Math.min(el.offsetHeight, maxCardHeight());
}

function onWindowResize() {
  syncHeight();
  anchorToDrawer();
}

let opener: HTMLElement | null = null;
onMounted(() => {
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onWindowResize);
  void nextTick(() => {
    anchorToDrawer();
    syncHeight();
    ro = new ResizeObserver(syncHeight);
    if (contentEl.value) ro.observe(contentEl.value);
    nameInput.value?.focus();
    requestAnimationFrame(() => (shown.value = true));
  });
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onWindowResize);
  ro?.disconnect();
  anchorRO?.disconnect();
  opener?.focus();
});
</script>

<template>
  <!-- Teleported to the body: this modal is mounted inside the settings drawer,
       whose aside is overflow-hidden and sits under a transformed stage. That
       transform makes a fixed child resolve against the drawer rather than the
       viewport, so without the teleport the scrim and card get clipped to the
       drawer's box. -->
  <Teleport to="body">
    <!-- The host is fixed to the drawer's rect (or the viewport when the drawer
         can't be found), so the shell never covers more than the sidebar. -->
    <div
      class="pointer-events-none fixed inset-0 z-50"
      :style="hostStyle"
    >
    <motion.div
      class="ca-scrim pointer-events-auto absolute inset-0"
      :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
      :animate="{ opacity: shown ? 1 : 0, backdropFilter: shown ? 'blur(4px)' : 'blur(0px)' }"
      :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
      @click="close"
    />

    <div class="pointer-events-none absolute inset-0 flex items-end justify-end p-6">
    <motion.div
      class="ca-card pointer-events-auto relative z-20 w-full max-w-md overflow-hidden"
      :style="{ height: cardHeight === null ? 'auto' : `${cardHeight}px` }"
      :initial="{ opacity: 0, y: 12, scale: 0.96 }"
      :animate="{ opacity: shown ? 1 : 0, y: shown ? 0 : 12, scale: shown ? 1 : 0.96 }"
      :transition="cardSpring"
      role="dialog"
      aria-modal="true"
      aria-label="Create an agent"
    >
      <div ref="contentEl" class="flex shrink-0 flex-col">
        <!-- Header band: the live marble, the step name, the count, cancel. -->
        <div class="ca-band ca-header">
          <span class="ca-face" aria-hidden="true" v-html="faceSvg" />
          <span class="ca-eyebrow">{{ stepLabel }}</span>
          <span class="ca-count">{{ stepIndex + 1 }} / {{ STEPS.length }}</span>
          <button type="button" class="ca-close" aria-label="Close" title="Close (Esc)" @click="close">
            <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" />
          </button>
        </div>

        <!-- Stepper track: one segment per step, filled up to here. -->
        <div class="ca-track" aria-label="Steps">
          <button
            v-for="(s, i) in STEPS"
            :key="s.id"
            type="button"
            class="ca-seg"
            :class="{ 'is-on': i <= stepIndex }"
            :aria-label="s.label"
            :aria-current="i === stepIndex ? 'step' : undefined"
            :disabled="i > stepIndex && !canLeaveIdentity"
            @click="goTo(i)"
          />
        </div>

        <!-- Body: one concern at a time, morphing between stops. -->
        <div class="ca-stage relative">
          <AnimatePresence mode="popLayout" :initial="false">
            <motion.div
              :key="step"
              class="flex flex-col"
              :initial="{ opacity: 0, y: 10, filter: 'blur(3px)' }"
              :animate="{ opacity: 1, y: 0, filter: 'blur(0px)' }"
              :exit="{ opacity: 0, y: -10, filter: 'blur(3px)' }"
              :transition="stepMorph"
            >
              <!-- Identity: name, role, and the paint together — the visible
                   half of who the agent is. -->
              <div v-if="step === 'identity'" class="ca-pane">
                <label class="ca-field">
                  <span class="ca-glyph">
                    <HugeiconsIcon :icon="UserGroupIcon" :size="17" :stroke-width="1.7" aria-hidden="true" />
                  </span>
                  <input
                    ref="nameInput"
                    v-model="name"
                    type="text"
                    class="ca-input"
                    placeholder="Name — Doc Writer, Reviewer, Sentinel"
                    maxlength="64"
                    spellcheck="false"
                    autocomplete="off"
                    aria-label="Agent name"
                  />
                </label>
                <label class="ca-field">
                  <span class="ca-glyph">
                    <HugeiconsIcon :icon="SparklesIcon" :size="16" :stroke-width="1.7" aria-hidden="true" />
                  </span>
                  <input
                    v-model="role"
                    type="text"
                    class="ca-input"
                    placeholder="Role — architecture, security & review"
                    maxlength="120"
                    spellcheck="false"
                    autocomplete="off"
                    aria-label="Agent role"
                  />
                </label>
                <div class="ca-paint">
                  <div class="ca-paint-head">
                    <span class="ca-microlabel">Face</span>
                    <button type="button" class="ca-shuffle" title="Roll a colour" aria-label="Roll a colour" @click="shuffle">
                      <HugeiconsIcon :icon="ShuffleIcon" :size="13" :stroke-width="2" />
                    </button>
                  </div>
                  <div class="ca-swatches" role="radiogroup" aria-label="Face colour">
                    <button
                      v-for="s in SWATCHES"
                      :key="s.id"
                      type="button"
                      role="radio"
                      :aria-checked="selected.id === s.id"
                      :title="s.name"
                      class="ca-swatch"
                      :class="{ 'ca-swatch--on': selected.id === s.id }"
                      @click="pick(s)"
                    >
                      <span class="ca-dot" :style="{ backgroundColor: s.paint.body }" />
                    </button>
                  </div>
                </div>
              </div>

              <!-- Instructions -->
              <div v-else-if="step === 'instructions'" class="ca-pane">
                <textarea
                  ref="instructionsInput"
                  v-model="instructions"
                  class="ca-textarea"
                  rows="7"
                  placeholder="How it works — habits and rules. e.g. Verify before claiming. Run the tests before saying done."
                  aria-label="Standing instructions"
                />
              </div>

              <!-- Capabilities -->
              <div v-else-if="step === 'capabilities'" class="ca-pane">
                <AgentCapabilitiesEditor v-model:model="model" />
              </div>

              <!-- Policies -->
              <div v-else-if="step === 'policies'" class="ca-pane">
                <AgentPoliciesEditor
                  v-model:denied-commands="deniedCommands"
                  v-model:denied-paths="deniedPaths"
                />
              </div>
            </motion.div>
          </AnimatePresence>
        </div>

        <p v-if="errorMsg" class="ca-error" role="alert">{{ errorMsg }}</p>

        <!-- Footer band: back on the left, the forward action on the right. -->
        <div class="ca-band ca-footer">
          <button
            v-if="stepIndex > 0"
            type="button"
            class="ca-action text-muted"
            @click="back"
          >
            Back
          </button>
          <span v-else class="ca-foot-spacer" />
          <button
            v-if="stepIndex < STEPS.length - 1"
            type="button"
            class="ca-action ca-forward text-ink"
            :disabled="!canLeaveIdentity"
            @click="next"
          >
            Next
            <span class="ca-forward-arrow" aria-hidden="true">→</span>
          </button>
          <button
            v-else
            type="button"
            class="ca-action ca-forward text-ink"
            :disabled="!canCreate"
            @click="handleCreate"
          >
            {{ isSubmitting ? "Creating…" : "Create agent" }}
            <span class="ca-forward-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </motion.div>
    </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ca-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}

/* The card: the shared shell fill, radius and hairline ring. Bottom-anchored so
   the foot stays welded to the lower edge as the height springs. */
.ca-card {
  background: var(--panel);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  max-height: 100%;
}

/* ── bands ── concave-scooped recessed surfaces, same construction as the
   project and clone modals. */
.ca-band {
  --band-bg: var(--band);
  --band-arc: 14px;
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.ca-band::before,
.ca-band::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.ca-header::before,
.ca-header::after {
  top: 100%;
}
.ca-header::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.ca-header::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}
.ca-footer::before,
.ca-footer::after {
  bottom: 100%;
}
.ca-footer::before {
  left: 0;
  background: radial-gradient(circle at top right, transparent var(--band-arc), var(--band-bg) 0);
}
.ca-footer::after {
  right: 0;
  background: radial-gradient(circle at top left, transparent var(--band-arc), var(--band-bg) 0);
}

/* ── header ── */
.ca-header {
  display: flex;
  align-items: center;
  gap: 0.55rem;
}
.ca-face {
  display: inline-flex;
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  filter: drop-shadow(0 2px 4px color-mix(in srgb, #000 16%, transparent));
}
.ca-face :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
.ca-eyebrow {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--muted);
}
.ca-count {
  flex: none;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--muted);
  opacity: 0.75;
}
.ca-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  margin-right: -0.25rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.14s ease, color 0.14s ease;
}
.ca-close:hover {
  background: var(--hover);
  color: var(--ink);
}

/* ── stepper track ── */
.ca-track {
  display: flex;
  gap: 5px;
  padding: 0.7rem 1rem 0.1rem;
}
.ca-seg {
  flex: 1 1 0;
  height: 3px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 9%, transparent);
  cursor: pointer;
  transition: background-color 0.28s ease;
}
.ca-seg.is-on {
  background: var(--accent);
}
.ca-seg:disabled {
  cursor: default;
}
.ca-seg:not(:disabled):hover {
  background: color-mix(in srgb, var(--accent) 45%, transparent);
}
.ca-seg.is-on:not(:disabled):hover {
  background: var(--accent);
}

/* ── stage ── */
.ca-stage {
  padding: 0.85rem 1rem 1rem;
  min-height: 15rem;
}
.ca-pane {
  display: flex;
  flex-direction: column;
  gap: 0.95rem;
}

/* ── fields ── borderless; reads as text until focused, with a leading glyph
   that firms on focus. Matches the project modal's name field. */
.ca-field {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.2rem 0;
}
.ca-glyph {
  display: inline-flex;
  flex: none;
  color: var(--muted);
  opacity: 0.7;
  transition: opacity 0.18s ease, color 0.18s ease;
}
.ca-field:focus-within .ca-glyph {
  color: var(--ink-soft);
  opacity: 1;
}
.ca-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ink);
  font-size: 13.5px;
  letter-spacing: -0.01em;
  outline: none;
}
.ca-input::placeholder {
  color: var(--muted);
}
.ca-input::selection {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}

/* Instructions keep a surface — multiline text needs walls. */
.ca-textarea {
  width: 100%;
  border: 0;
  border-radius: 11px;
  padding: 0.6rem 0.75rem;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 7%, transparent);
  color: var(--ink);
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5;
  resize: none;
  outline: none;
  transition: box-shadow 0.15s ease, background-color 0.15s ease;
}
.ca-textarea::placeholder {
  color: var(--placeholder);
}
.ca-textarea:focus {
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
}

/* ── paint ── */
.ca-paint-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}
.ca-microlabel {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}
.ca-shuffle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.14s ease, color 0.14s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.ca-shuffle:hover {
  color: var(--ink);
  transform: translateY(-1px);
}
.ca-shuffle:active {
  transform: scale(0.94);
}
.ca-swatches {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 8px;
}
.ca-swatch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  border: 0;
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
  opacity: 0.75;
  transition: background-color 0.15s ease, opacity 0.15s ease, box-shadow 0.15s ease;
}
.ca-swatch:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.ca-swatch--on {
  opacity: 1;
  background: color-mix(in oklab, var(--accent) 10%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 30%, transparent);
}
.ca-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #000 15%, transparent);
}

/* ── error ── quiet failure line beneath the stage. */
.ca-error {
  margin: 0 1rem 0.6rem;
  font-size: 11.5px;
  letter-spacing: -0.01em;
  line-height: 1.35;
  color: color-mix(in srgb, var(--diff-del) 82%, var(--ink));
}

/* ── footer ── */
.ca-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.ca-foot-spacer {
  flex: none;
}
.ca-action {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.ca-action:hover:not(:disabled) {
  opacity: 0.7;
}
.ca-action:disabled {
  cursor: default;
  opacity: 0.4;
}
.ca-forward-arrow {
  color: var(--accent);
  font-weight: 500;
  transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.ca-forward:not(:disabled):hover .ca-forward-arrow {
  transform: translateX(3px);
}

@media (prefers-reduced-motion: reduce) {
  .ca-card {
    transition-duration: 0.01s;
  }
}
</style>
