<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import ModalShell from "~/components/ui/ModalShell.vue";
import { useModalExit } from "~/composables/useModalExit";

// The card a trace opens in, over the thread, grown from the turn it traces.
// It grows out of that turn and shrinks back into it, like every card in kone,
// so the conversation stays put under the scrim. A recessed head band names the
// trace and closes it; a foot band carries the quiet facts. What the trace says
// goes between them, in the shared pieces styled at the end of this file.

const props = defineProps<{
  /** What the card is, in the head band and to assistive tech. */
  label: string;
  /** The turn's viewport rect — the grow's origin. */
  origin: DOMRect | null;
}>();

const emit = defineEmits<{
  /** Its exit has finished; unmount it now. */
  close: [];
}>();

const cardEl = ref<HTMLElement | null>(null);
const closeEl = ref<HTMLButtonElement | null>(null);
const originVars = ref<Record<string, string>>({});
const { shown, dismiss } = useModalExit();
function onClose(): void {
  dismiss(() => emit("close"));
}

// The thread answers Escape too. Taken in the capture phase and consumed, so
// one press closes this card and nothing behind it.
function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  onClose();
}

// Keep Tab inside the card — it's modal.
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const items = [...(cardEl.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
  if (items.length <= 1) {
    e.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

let opener: HTMLElement | null = null;
onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener("keydown", onEscape, { capture: true });
  // The card is centred by the overlay, so its place is only known once it is
  // laid out: measure it, then aim the grow at the turn from there.
  const card = cardEl.value?.getBoundingClientRect();
  const from = props.origin;
  if (card && from) {
    originVars.value = {
      "--ox": `${from.left + from.width / 2 - card.left}px`,
      "--oy": `${from.top + from.height / 2 - card.top}px`,
    };
  }
  requestAnimationFrame(() => (shown.value = true));
  closeEl.value?.focus();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onEscape, { capture: true });
  if (opener?.isConnected) opener.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <ModalShell v-slot="{ card }" :shown="shown" class="z-50" @dismiss="onClose">
      <div
        ref="cardEl"
        v-bind="card"
        class="tr"
        :style="originVars"
        role="dialog"
        aria-modal="true"
        :aria-label="label"
        @keydown="onKeydown"
      >
        <!-- Header band: what this card is, and close. -->
        <div class="tr-band tr-head">
          <span class="tr-eyebrow">{{ label }}</span>
          <button ref="closeEl" type="button" class="tr-close" aria-label="Close trace" title="Close (Esc)" @click="onClose">
            <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" />
          </button>
        </div>

        <div class="tr-body">
          <slot />
        </div>

        <!-- Foot band: when and where, quiet. -->
        <div class="tr-band tr-foot">
          <slot name="foot" />
        </div>
      </div>
    </ModalShell>
  </Teleport>
</template>

<style scoped>
.tr {
  position: relative;
  z-index: 1;
  width: min(620px, calc(100% - 32px));
  max-height: calc(100% - 40px);
  margin: auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 18px;
  background: var(--panel);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 10px 30px -18px color-mix(in srgb, var(--ink) 12%, transparent);
}
/* Grow out of the turn, and shrink back into it. */
.tr.is-in {
  animation: tr-grow 420ms cubic-bezier(0.34, 1.2, 0.64, 1) backwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
.tr.is-out {
  animation: tr-shrink var(--modal-exit) cubic-bezier(0.4, 0, 0.9, 1) forwards;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
@keyframes tr-grow {
  from { opacity: 0.35; transform: scale(0.2); }
  60% { opacity: 1; }
}
@keyframes tr-shrink {
  to { opacity: 0; transform: scale(0.2); }
}

/* ── bands ── the scooped recessed head and foot every kone modal wears. */
.tr-band {
  --band-bg: var(--band);
  --band-arc: 14px;
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  padding: 10px 16px;
  background-color: var(--band-bg);
  /* The band is a shade darker than the panel, so its quiet text takes a
     little more ink to keep 4.5:1. */
  --tr-quiet-band: color-mix(in srgb, var(--ink) 70%, var(--band-bg));
}
.tr-band::before,
.tr-band::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.tr-head::before,
.tr-head::after { top: 100%; }
.tr-head::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.tr-head::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}
.tr-foot::before,
.tr-foot::after { bottom: 100%; }
.tr-foot::before {
  left: 0;
  background: radial-gradient(circle at top right, transparent var(--band-arc), var(--band-bg) 0);
}
.tr-foot::after {
  right: 0;
  background: radial-gradient(circle at top left, transparent var(--band-arc), var(--band-bg) 0);
}
.tr-eyebrow {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--tr-quiet-band);
}
.tr-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-inline-end: -4px;
  border-radius: 8px;
  color: var(--tr-quiet-band);
  cursor: pointer;
  transition: background-color 0.14s ease, color 0.14s ease;
}
@media (hover: hover) {
  .tr-close:hover {
    background: var(--hover);
    color: var(--ink);
  }
}
.tr-close:focus-visible {
  outline: 2px solid var(--tr-ring);
  outline-offset: 1px;
}

.tr-body {
  min-height: 0;
  overflow-y: auto;
  padding: 22px 26px 26px;
  overscroll-behavior: contain;
  scrollbar-width: none;
}

/* ── foot ── the facts, one quiet line. */
.tr-foot {
  flex-wrap: wrap;
  gap: 2px 14px;
  min-height: 38px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--tr-quiet-band);
}

@media (max-width: 520px) {
  .tr-body { padding: 18px 18px 22px; }
}

@media (prefers-reduced-motion: reduce) {
  .tr.is-in { animation: tr-fade-in 200ms ease-out backwards; }
  .tr.is-out { animation: tr-fade-out var(--modal-exit) ease-out forwards; }
}
@keyframes tr-fade-in {
  from { opacity: 0; }
}
@keyframes tr-fade-out {
  to { opacity: 0; }
}
</style>

<!-- The pieces a trace fills the card with. Unscoped so each trace can use
     them in its own slot content; every class is `tr-` prefixed, so nothing
     outside a trace card picks them up. -->
<style>
.tr {
  --tr-ease: cubic-bezier(0.22, 1, 0.36, 1);
  /* Quiet text: --muted is too faint to read at 11px on the panel, so labels
     here mix ink into it until it clears 4.5:1. */
  --tr-quiet: color-mix(in srgb, var(--ink) 64%, var(--panel));
  /* Focus rings: enough ink to clear 3:1 against the panel in both schemes. */
  --tr-ring: color-mix(in srgb, var(--ink) 55%, var(--panel));
}
.tr-quote {
  /* A long turn scrolls in place rather than losing its end. */
  max-height: calc(14.5px * 1.55 * 4);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-inline-start: 14px;
  border-inline-start: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
  font-size: 14.5px;
  line-height: 1.55;
  color: var(--ink);
  white-space: pre-wrap;
  text-wrap: pretty;
}
.tr-aside {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--tr-quiet);
}
.tr-empty {
  margin-top: 22px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--tr-quiet);
}

.tr-figs {
  display: flex;
  flex-wrap: wrap;
  gap: 14px 40px;
  margin-top: 24px;
}
.tr-fig { display: flex; flex-direction: column; gap: 6px; }
.tr-fig__v {
  font-size: 30px;
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.tr-fig__k {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--tr-quiet);
}

.tr-sec { margin-top: 26px; }
.tr-sec__k {
  margin-bottom: 12px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--tr-quiet);
}
.tr-note {
  margin-top: 14px;
  text-wrap: pretty;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--tr-quiet);
}
.tr-note b {
  font-weight: 500;
  color: var(--ink);
}

.tr-fact {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.tr-fact--thread {
  white-space: normal;
  overflow-wrap: anywhere;
  color: var(--ink-soft);
}

.tr-skeleton {
  display: grid;
  gap: 10px;
  margin-top: 20px;
}
.tr-skeleton i {
  height: 12px;
  border-radius: 4px;
  background: var(--hover);
}
.tr-skeleton i:nth-child(1) { width: 34%; height: 36px; }
.tr-skeleton i:nth-child(2) { height: 64px; }
.tr-skeleton i:nth-child(3) { width: 70%; }

@media (max-width: 520px) {
  .tr-fig__v { font-size: 26px; }
}
</style>
