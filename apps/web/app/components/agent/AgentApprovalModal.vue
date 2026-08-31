<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion } from "motion-v";
import ApprovalPrompt from "~/components/agent/ApprovalPrompt.vue";
import type { PendingApproval } from "~/composables/useAgent";
import type { ApprovalDecision, ApprovalRequest } from "~/types/desktop";
import { useModalExit } from "~/composables/useModalExit";

// The agent's request for a go-ahead before it runs something, in the same
// scrim + elastic card shell the pickers and the question modal wear — anchored
// bottom-centre where the agent composer sits, since it takes the composer's
// place while the turn is parked on this decision. The ask itself — the kind
// chip, the headline, the three decisions — lives in ApprovalPrompt, which the
// subagent shell also embeds, so the two surfaces never fork the wording.

const props = defineProps<{
  requestId: string;
  approval: ApprovalRequest;
  /** The full pending-approval queue this ask belongs to, when the host passes
   *  it. Enables the "1/N" position readout and the 1–9 digit shortcuts to jump
   *  to a queued ask. Absent → the single-ask behaviour, unchanged. */
  queue?: PendingApproval[];
}>();

const emit = defineEmits<{
  decide: [requestId: string, decision: ApprovalDecision];
}>();

// The ask on screen — the head of the queue when one is passed, otherwise the
// lone request. Digits 1–9 jump; Enter/Esc always act on the CURRENT ask.
const index = ref(0);
watch(
  () => props.queue?.length ?? 0,
  (newLen) => {
    if (newLen === 0) {
      index.value = 0;
    } else if (index.value >= newLen) {
      index.value = Math.max(0, newLen - 1);
    }
  },
);
const queueActive = computed(() => (props.queue?.length ?? 0) > 1);
const active = computed(() => {
  const q = props.queue;
  if (q && q.length > 0) return q[Math.min(index.value, q.length - 1)]!;
  return { requestId: props.requestId, approval: props.approval };
});
function jumpTo(n: number): void {
  const q = props.queue;
  if (!q || q.length <= 1) return;
  index.value = Math.max(0, Math.min(n, q.length - 1));
}

function prev(): void {
  const q = props.queue;
  if (!q || q.length <= 1) return;
  index.value = Math.max(0, index.value - 1);
}

function next(): void {
  const q = props.queue;
  if (!q || q.length <= 1) return;
  index.value = Math.min(q.length - 1, index.value + 1);
}

function decide(decision: ApprovalDecision): void {
  if (closing.value) return;
  const reqId = active.value.requestId;
  const remaining = props.queue?.length ?? 1;

  if (decision === "reject-and-stop" || remaining <= 1) {
    // Final ask in the queue or full turn abort: play exit animation and close.
    close(() => emit("decide", reqId, decision));
  } else {
    // Multi-step queue: settle the current ask and smoothly transition to the next.
    emit("decide", reqId, decision);
    nextTick(() => syncHeight());
  }
}

// it reads as one surface, but bottom-centre over the composer's spot ──────────
const { shown, closing, close } = useModalExit();
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}

// Enter decides with "allow once" — the calm, one-shot default. Escape rejects.
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    decide("allow-once");
  } else if (e.key === "Escape") {
    e.preventDefault();
    decide("reject-once");
  } else if (queueActive.value) {
    if (e.key === "ArrowLeft" || e.key === "[") {
      e.preventDefault();
      prev();
    } else if (e.key === "ArrowRight" || e.key === "]") {
      e.preventDefault();
      next();
    } else if (/^[1-9]$/.test(e.key)) {
      // Jump to the Nth queued ask — 1 is the head.
      e.preventDefault();
      jumpTo(Number(e.key) - 1);
    }
  }
}

let opener: HTMLElement | null = null;

onMounted(async () => {
  // SAFETY: activeElement is the element focused just before open; null is allowed by the type.
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
      <div ref="contentEl" class="approve-card flex shrink-0 flex-col">
        <ApprovalPrompt
          :approval="active.approval"
          :queue-index="index"
          :queue-total="props.queue?.length ?? 0"
          @decide="decide"
          @prev="prev"
          @next="next"
        />
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
.modal-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}
.modal-card {
  background: var(--panel);
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
