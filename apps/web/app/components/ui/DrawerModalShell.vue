<script lang="ts">
// Shared contracts for the drawer-anchored modal shell. Kept outside the
// setup block so callers can import the types without the component.
export interface DrawerModalSection<Section extends string> {
  id: Section;
  label: string;
}

// The sliver of the shell a caller drives after its own submit succeeds:
// play the exit, then hand control back so the modal never pops mid-flight.
export interface DrawerModalHandle {
  finish: (done: () => void) => void;
}
</script>

<script setup lang="ts" generic="Section extends string">
import { nextTick, onBeforeUnmount, onMounted, ref, type CSSProperties } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { ArrowDown01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import { useModalExit } from "~/composables/useModalExit";
import { useSound } from "~/composables/useSound";

// The drawer-anchored modal shell both creation cards share: scrim, elastic
// card, scooped header/footer bands, and a stack of collapsible rows where one
// row is open at a time. The caller owns the draft (form state, summaries,
// submit) and fills each row through a `row-<id>` slot; the shell owns
// everything around the draft — anchoring, height, keyboard, exit.
//
// One row open at a time: the panes are tall and several unfurled at once
// would outgrow the drawer and hide the action under a scroll. A closed row
// shows its summary, an open row shows the hint for what it is for, so the
// whole draft stays legible from the outside either way.
const props = defineProps<{
  sections: readonly DrawerModalSection<Section>[];
  hints: Record<Section, string>;
  summaries: Record<Section, string>;
  /** The row open on mount, or none for a resting state carried by summaries. */
  initialOpen: Section | null;
  eyebrow: string;
  /** Spoken name of the dialog. Named apart from `aria-label`, which the
   *  template compiler keeps as a native attribute instead of a prop. */
  dialogLabel: string;
  error: string | null;
  /** The footer's forward action text, busy state included — the caller composes it. */
  actionLabel: string;
  canSubmit: boolean;
  isSubmitting: boolean;
}>();

const emit = defineEmits<{
  close: [];
  submit: [];
}>();

const { cue } = useSound();
const { shown, closing, close: fadeOut } = useModalExit();
const cardSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;

// A row unfurls on the same tween the other modals' folds use.
const collapseMorph = { duration: 0.26, ease: [0.22, 1, 0.36, 1] } as const;

// The open row, or none — every row closed is a legitimate resting state, and
// the summaries carry the draft on their own.
const open = ref<Section | null>(props.initialOpen);

function toggle(id: Section) {
  const opening = open.value !== id;
  open.value = opening ? id : null;
  cue(opening ? "expand" : "collapse");
  void nextTick(() => {
    syncHeight();
    if (opening) focusOpenRow();
  });
}

/** Move focus to the entry field of the open row, where it marks one. Found
 *  by query rather than by template ref: the rows are a `v-for`, which
 *  collects every `ref` inside it into an array, and a per-row ref would
 *  arrive as a one-element list rather than the field itself. Panes without a
 *  marked field keep their own focus order. */
function focusOpenRow() {
  contentEl.value?.querySelector<HTMLElement>(".dm-row.is-open [data-autofocus]")?.focus();
}

function close() {
  if (closing.value || props.isSubmitting) return;
  cue("collapse");
  fadeOut(() => emit("close"));
}

function finish(done: () => void) {
  fadeOut(done);
}

defineExpose({ finish });

// ── keyboard ────────────────────────────────────────────────────────────────
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    if (props.canSubmit) {
      e.preventDefault();
      emit("submit");
    }
    return;
  }
  if (e.key === "Enter") {
    // A textarea spends Enter on newlines; a button spends it on clicking — and
    // a row header is a button, so Enter there opens the row rather than
    // firing the action behind the maker's back.
    if (document.activeElement instanceof HTMLTextAreaElement) return;
    if (document.activeElement instanceof HTMLButtonElement) return;
    if (!props.canSubmit) return;
    e.preventDefault();
    emit("submit");
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
    // SAFETY: els holds only focusable elements; includes() rejects anything else, so the
    // worst case is a spurious refocus at the edge.
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

// ── elastic height ──────────────────────────────────────────────────────────
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

/** How tall the card may grow: the padded host, so it never spills the drawer. */
function maxCardHeight(): number {
  const raw = String(hostStyle.value.height ?? "");
  if (raw.endsWith("px")) {
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
  // SAFETY: activeElement is the element focused just before open; null is allowed by the type.
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onWindowResize);
  void nextTick(() => {
    anchorToDrawer();
    syncHeight();
    ro = new ResizeObserver(syncHeight);
    if (contentEl.value) ro.observe(contentEl.value);
    focusOpenRow();
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
      class="dm-scrim pointer-events-auto absolute inset-0"
      :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
      :animate="{ opacity: shown ? 1 : 0, backdropFilter: shown ? 'blur(4px)' : 'blur(0px)' }"
      :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
      @click="close"
    />

    <div class="pointer-events-none absolute inset-0 flex items-end justify-end p-6">
    <motion.div
      class="dm-card pointer-events-auto relative z-20 w-full max-w-md overflow-hidden"
      :style="{ height: cardHeight === null ? 'auto' : `${cardHeight}px` }"
      :initial="{ opacity: 0, y: 12, scale: 0.96 }"
      :animate="{ opacity: shown ? 1 : 0, y: shown ? 0 : 12, scale: shown ? 1 : 0.96 }"
      :transition="cardSpring"
      role="dialog"
      aria-modal="true"
      :aria-label="dialogLabel"
    >
      <div ref="contentEl" class="flex shrink-0 flex-col">
        <!-- Header band: what this card makes, and cancel. -->
        <div class="dm-band dm-header">
          <span class="dm-eyebrow">{{ eyebrow }}</span>
          <button type="button" class="dm-close" aria-label="Close" title="Close (Esc)" @click="close">
            <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" />
          </button>
        </div>

        <!-- Body: rows, each folding open over the one below it. -->
        <div class="dm-rows">
          <section v-for="s in sections" :key="s.id" class="dm-row" :class="{ 'is-open': open === s.id }">
            <button
              type="button"
              class="dm-row-head"
              :aria-expanded="open === s.id"
              @click="toggle(s.id)"
            >
              <span class="dm-row-label">{{ s.label }}</span>
              <span class="dm-row-value">
                {{ open === s.id ? hints[s.id] : summaries[s.id] }}
              </span>
              <span class="dm-chevron" aria-hidden="true">
                <HugeiconsIcon :icon="ArrowDown01Icon" :size="15" :stroke-width="2" />
              </span>
            </button>

            <AnimatePresence :initial="false">
              <motion.div
                v-if="open === s.id"
                :key="`${s.id}-body`"
                class="dm-row-body"
                :initial="{ opacity: 0, height: 0 }"
                :animate="{ opacity: 1, height: 'auto' }"
                :exit="{ opacity: 0, height: 0 }"
                :transition="collapseMorph"
              >
                <div class="dm-pane">
                  <slot :name="`row-${s.id}`" />
                </div>
              </motion.div>
            </AnimatePresence>
          </section>
        </div>

        <p v-if="error" class="dm-error" role="alert">{{ error }}</p>

        <!-- Footer band: the one action this card exists for. -->
        <div class="dm-band dm-footer">
          <button type="button" class="dm-action text-muted" @click="close">Cancel</button>
          <button
            type="button"
            class="dm-action dm-forward text-ink"
            :disabled="!canSubmit"
            @click="emit('submit')"
          >
            {{ actionLabel }}
            <span class="dm-forward-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </motion.div>
    </div>
    </div>
  </Teleport>
</template>

<!-- Unscoped: the pane primitives below style caller-owned slot markup, which
     carries the caller's scope — a scoped block would never reach it. The dm-
     prefix keeps every rule to this shell. -->
<style>
.dm-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}

/* The card: the shared shell fill, radius and hairline ring. Bottom-anchored so
   the foot stays welded to the lower edge as the height springs. */
.dm-card {
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
.dm-band {
  --band-bg: var(--band);
  --band-arc: 14px;
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.dm-band::before,
.dm-band::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.dm-header::before,
.dm-header::after {
  top: 100%;
}
.dm-header::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.dm-header::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}
.dm-footer::before,
.dm-footer::after {
  bottom: 100%;
}
.dm-footer::before {
  left: 0;
  background: radial-gradient(circle at top right, transparent var(--band-arc), var(--band-bg) 0);
}
.dm-footer::after {
  right: 0;
  background: radial-gradient(circle at top left, transparent var(--band-arc), var(--band-bg) 0);
}

/* ── header ── */
.dm-header {
  display: flex;
  align-items: center;
  gap: 0.55rem;
}
.dm-eyebrow {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--muted);
}
.dm-close {
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
.dm-close:hover {
  background: var(--hover);
  color: var(--ink);
}

/* ── rows ── the concerns, stacked. No dividers and no boxes: a row is
   told apart from its neighbour by the space around it, and the open one by
   the faint wash it sits in. */
.dm-rows {
  display: flex;
  flex-direction: column;
  padding: 0.5rem 0.5rem 0.35rem;
}
.dm-row {
  border-radius: 12px;
  transition: background-color 0.24s ease;
}
.dm-row.is-open {
  background: color-mix(in srgb, var(--ink) 3.5%, transparent);
}
.dm-row-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  border: 0;
  border-radius: 12px;
  padding: 0.6rem 0.6rem 0.6rem 0.65rem;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.dm-row:not(.is-open) .dm-row-head:hover {
  background: color-mix(in srgb, var(--ink) 4%, transparent);
}
.dm-row-label {
  flex: none;
  color: var(--ink);
  font-size: 13.5px;
  letter-spacing: -0.01em;
}
/* What a closed row is holding, or what an open one is for — either way kept
   quiet and clipped to one line, so a long value can't push the chevron off the
   edge. */
.dm-row-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  letter-spacing: -0.005em;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.9;
  transition: opacity 0.2s ease;
}
/* Open, the line is the row's purpose rather than its value — lighter still,
   since the fields under it are what the eye is going to. */
.dm-row.is-open .dm-row-value {
  opacity: 0.7;
}
.dm-chevron {
  display: inline-flex;
  flex: none;
  color: var(--muted);
  transition: transform 0.26s cubic-bezier(0.22, 1, 0.36, 1), color 0.18s ease;
}
.dm-row.is-open .dm-chevron {
  color: var(--ink-soft);
  transform: rotate(180deg);
}
/* The fold itself — height is animated, so nothing inside it may overflow. */
.dm-row-body {
  overflow: hidden;
}
.dm-pane {
  display: flex;
  flex-direction: column;
  gap: 0.95rem;
  padding: 0.15rem 0.65rem 0.85rem;
}

/* ── fields ── borderless; reads as text until focused, with a leading glyph
   that firms on focus. Matches the project modal's name field. */
.dm-field {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.2rem 0;
}
.dm-glyph {
  display: inline-flex;
  flex: none;
  color: var(--muted);
  opacity: 0.7;
  transition: opacity 0.18s ease, color 0.18s ease;
}
.dm-field:focus-within .dm-glyph {
  color: var(--ink-soft);
  opacity: 1;
}
.dm-input {
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
.dm-input::placeholder {
  color: var(--muted);
}
.dm-input::selection {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}

/* Instructions share the identity fields' language — borderless text, no
   surface of its own — keeping only what multiline needs: room to grow and a
   line height prose can breathe in. */
.dm-textarea {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  font-family: inherit;
  line-height: 1.5;
  resize: none;
  outline: none;
}

/* A quiet line for when there is nothing to pick yet. */
.dm-empty {
  margin: 0;
  padding: 0.15rem 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--muted);
}

/* ── error ── quiet failure line beneath the stage. */
.dm-error {
  margin: 0 1rem 0.6rem;
  font-size: 11.5px;
  letter-spacing: -0.01em;
  line-height: 1.35;
  color: color-mix(in srgb, var(--diff-del) 82%, var(--ink));
}

/* ── footer ── */
.dm-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.dm-action {
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
.dm-action:hover:not(:disabled) {
  opacity: 0.7;
}
.dm-action:disabled {
  cursor: default;
  opacity: 0.4;
}
.dm-forward-arrow {
  color: var(--accent);
  font-weight: 500;
  transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.dm-forward:not(:disabled):hover .dm-forward-arrow {
  transform: translateX(3px);
}

@media (prefers-reduced-motion: reduce) {
  .dm-card {
    transition-duration: 0.01s;
  }
}
</style>
