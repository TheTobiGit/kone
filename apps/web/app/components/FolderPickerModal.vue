<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { motion } from "motion-v";

// Standalone "open a project" overlay: the scrim + elastic card shell around a
// `FolderBrowser`. The card's height springs as the listing grows and shrinks;
// the browser itself (address bar, list, footer, all the navigation) lives in
// `FolderBrowser`, which the clone card also embeds — so the two entry points
// share one browser and only differ in their shell. (By design the card is
// anchored bottom-right over a scrim, not a centred dialog.)

withDefaults(defineProps<{ confirmVerb?: string; title?: string }>(), {
  confirmVerb: "Open",
  title: "Open a project folder",
});

const emit = defineEmits<{
  select: [folder: { path: string; name: string }];
  cancel: [];
}>();

// Drives the modal's open/close fade + scale.
const shown = ref(false);

// ── elastic height ────────────────────────────────────────────────────────────
// A ResizeObserver on the browser wrapper feeds its measured height into an
// inline `height`, and the card's CSS `transition: height` gives the springy
// settle as the listing reflows. Past a cap the list scrolls inside instead.
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;
function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}

// Guards Enter (schedules `select`) then Escape landing within the same exit
// window from firing a second close — only the first close wins.
const closing = ref(false);

// Fade + scale the modal out, then hand control back to the caller. The delay
// matches the 0.24s exit transition so it finishes leaving before unmount.
function close(done: () => void) {
  if (closing.value) return;
  closing.value = true;
  shown.value = false;
  window.setTimeout(done, 240);
}

// The browser reports intent; the shell plays the card's exit, then re-emits.
function onSelect(folder: { path: string; name: string }) {
  close(() => emit("select", folder));
}
function onCancel() {
  close(() => emit("cancel"));
}

// The browser fires `ready` once its first listing settles — size the card to
// it, start tracking reflows, then reveal.
function onReady() {
  syncHeight();
  ro = new ResizeObserver(syncHeight);
  if (contentEl.value) ro.observe(contentEl.value);
  requestAnimationFrame(() => {
    shown.value = true;
  });
}

// Whatever had focus before the modal opened — restored on close so the
// trigger (e.g. the "Open" tile on the home screen) gets focus back.
let opener: HTMLElement | null = null;

onMounted(() => {
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("resize", syncHeight);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", syncHeight);
  ro?.disconnect();
  opener?.focus();
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
  <div class="fixed inset-0 z-50 flex items-end justify-end overflow-hidden p-6">
    <!-- Scrim: click to dismiss. The dim and the blur ramp together on one
         tween so they read as a single coalescing effect (we animate the
         backdrop blur explicitly rather than revealing a static blur through an
         opacity fade — which snaps the blur in a beat after the dim). -->
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
      :aria-label="title"
    >
      <div ref="contentEl" class="shrink-0">
        <FolderBrowser
          :confirm-verb="confirmVerb"
          @select="onSelect"
          @cancel="onCancel"
          @ready="onReady"
        />
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
/* Scrim behind the card — a soft dim over whatever's underneath. */
.modal-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}

/* The elastic card, anchored bottom-right. `transition: height` gives it the
   springy settle as it grows and shrinks with the listing; a hairline ring
   sits it on the scrim without a heavy drop shadow. */
.modal-card {
  background: var(--panel);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  /* Decelerating ease with no overshoot: resize smoothly instead of springing
     past, so the header/footer frame doesn't bounce. */
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  /* Bottom-anchor the content: the footer stays welded to the card's lower edge
     as the height transition plays; the height change is taken up at the top. */
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
</style>
