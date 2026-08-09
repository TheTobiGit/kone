<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { motion } from "motion-v";
import ApprovalPrompt from "~/components/ApprovalPrompt.vue";
import type { ApprovalDecision, ApprovalRequest } from "~/types/desktop";

// The agent's request for a go-ahead before it runs something, in the same
// scrim + elastic card shell the pickers and the question modal wear — anchored
// bottom-centre where the agent composer sits, since it takes the composer's
// place while the turn is parked on this decision. The ask itself — the kind
// chip, the headline, the three decisions — lives in ApprovalPrompt, which the
// subagent shell also embeds, so the two surfaces never fork the wording.

const props = defineProps<{
  requestId: string;
  approval: ApprovalRequest;
}>();

const emit = defineEmits<{
  decide: [requestId: string, decision: ApprovalDecision];
}>();

function decide(decision: ApprovalDecision): void {
  close(() => emit("decide", props.requestId, decision));
}

// ── shell (scrim + elastic card) — lifted from the pickers / question modal so
// it reads as one surface, but bottom-centre over the composer's spot ──────────
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

// Enter decides with "allow once" — the calm, one-shot default. Escape rejects.
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    decide("allow-once");
  } else if (e.key === "Escape") {
    e.preventDefault();
    decide("reject-once");
  }
}

let opener: HTMLElement | null = null;

onMounted(async () => {
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", syncHeight);
  await nextTick();
  syncHeight();
  ro = new ResizeObserver(syncHeight);
  if (contentEl.value) ro.observe(contentEl.value);
  requestAnimationFrame(() => {
    shown.value = true;
  });
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
  <div class="fixed inset-0 z-40 flex items-end justify-center overflow-hidden p-6 pb-8">
    <!-- Scrim: a soft dim + blur, matching the pickers. The turn is parked on
         this decision, so the scrim is inert — the only way forward is to pick. -->
    <motion.div
      class="modal-scrim absolute inset-0"
      :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
      :animate="{
        opacity: shown ? 1 : 0,
        backdropFilter: shown ? 'blur(4px)' : 'blur(0px)',
      }"
      :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
    />

    <motion.div
      class="modal-card relative z-20 w-full max-w-lg overflow-hidden"
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
      aria-label="The agent wants to run something"
    >
      <div ref="contentEl" class="approve-card">
        <ApprovalPrompt
          :approval="approval"
          @decide="decide"
        />
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
/* Scrim + card lifted from the pickers so the surfaces read as one family — a
   soft dim, a hairline ring instead of a heavy shadow, an elastic height. This
   one anchors bottom-centre, in the agent composer's spot. */
.modal-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}
.modal-card {
  background: var(--surface, var(--ground));
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

/* The card's inner column — the prompt owns its own bands, so this host just
   lays it out and lets it size itself. */
.approve-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
</style>
