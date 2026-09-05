<script setup lang="ts">
import { ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  Cancel01Icon,
  FastForwardIcon,
  GripVerticalIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import type { QueuedTurnEntry } from "~/composables/useAgent";
import { parseQueuedAttachments } from "~/composables/useAgent";

// Follow-ups parked behind the running turn. The host owns the list (send
// while busy enqueues; cancel/steer round-trip through the bridge); this
// strip owns how it reads — the label, the drag order, the row actions —
// and only reports back what changed.

const props = defineProps<{
  queued?: QueuedTurnEntry[];
}>();

const emit = defineEmits<{
  "remove-queued": [queueId: string];
  "send-now": [entry: QueuedTurnEntry];
  edit: [entry: QueuedTurnEntry];
  "reorder-queued": [queueIds: string[]];
}>();

// The chip label — the queued prompt's own words, or a compact attachment
// note for attachment-only follow-ups.
function queuedLabel(entry: QueuedTurnEntry): string {
  if (entry.input) return entry.input;
  const parsed = parseQueuedAttachments(entry.attachmentsJson);
  if (parsed && parsed.length > 0) {
    const first = parsed[0]?.name;
    if (first) return parsed.length > 1 ? `${first} +${parsed.length - 1}` : first;
  }
  return "Queued message";
}

// Drag order needs the from-index and the hover-index only: the dragged id is
// just queued[draggedIndex], so a third ref for it would restate the same row.
const draggedIndex = ref<number | null>(null);
const dragOverIndex = ref<number | null>(null);

function onQueueDragStart(e: DragEvent, item: QueuedTurnEntry, index: number) {
  draggedIndex.value = index;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", item.queueId);
  }
}

// One highlight for both dragover and dragenter: they did the same guard and
// the same assignment, so two handlers only doubled the edit surface.
function onQueueDragHighlight(_e: DragEvent, index: number) {
  if (draggedIndex.value === null || draggedIndex.value === index) return;
  dragOverIndex.value = index;
}

function onQueueDragLeave(_e: DragEvent, index: number) {
  if (dragOverIndex.value === index) {
    dragOverIndex.value = null;
  }
}

function onQueueDrop(_e: DragEvent, targetIndex: number) {
  const fromIndex = draggedIndex.value;
  if (fromIndex === null || fromIndex === targetIndex || !props.queued) {
    onQueueDragEnd();
    return;
  }
  const items = [...props.queued];
  const [moved] = items.splice(fromIndex, 1);
  if (moved) {
    items.splice(targetIndex, 0, moved);
    emit("reorder-queued", items.map((q) => q.queueId));
  }
  onQueueDragEnd();
}

function onQueueDragEnd() {
  draggedIndex.value = null;
  dragOverIndex.value = null;
}
</script>

<template>
  <!-- While a turn runs, Enter sends and the host's service durably queues the
       draft behind the running turn. The strip renders from the `queued` prop
       (the backend's turn.queued / turn.promoted / turn.queued-cancelled events
       drive the list); the stop cancels one row. It sits ABOVE the card in the
       same strip language as the context tray below it — the queued prompts
       live here until they promote, never in the thread. -->
  <Transition name="queue">
    <div v-if="queued?.length" class="queue" role="region" aria-label="Queued messages">
      <div
        v-for="(item, index) in queued"
        :key="item.queueId"
        class="queue__item"
        :class="{
          'queue__item--draggable': (queued?.length ?? 0) > 1,
          'queue__item--dragging': draggedIndex === index,
          'queue__item--drag-over': dragOverIndex === index && draggedIndex !== index,
        }"
        :draggable="(queued?.length ?? 0) > 1"
        :title="`Queued #${item.position} · ${queuedLabel(item)}`"
        @dragstart="onQueueDragStart($event, item, index)"
        @dragover.prevent="onQueueDragHighlight($event, index)"
        @dragenter.prevent="onQueueDragHighlight($event, index)"
        @dragleave="onQueueDragLeave($event, index)"
        @drop.prevent="onQueueDrop($event, index)"
        @dragend="onQueueDragEnd"
      >
        <span v-if="(queued?.length ?? 0) > 1" class="queue__grip" aria-hidden="true" title="Drag to reorder">
          <HugeiconsIcon :icon="GripVerticalIcon" :size="12" :stroke-width="1.8" />
        </span>
        <span class="queue__pos">{{ item.position }}</span>
        <span class="queue__text">{{ queuedLabel(item) }}</span>
        <div class="queue__actions">
          <button
            type="button"
            class="queue__action queue__action--send"
            title="Send now"
            aria-label="Send now"
            @click.stop="emit('send-now', item)"
          >
            <HugeiconsIcon :icon="FastForwardIcon" :size="12" :stroke-width="2" />
            <span>Send now</span>
          </button>
          <button
            type="button"
            class="queue__action queue__action--edit"
            title="Edit message"
            aria-label="Edit message"
            @click.stop="emit('edit', item)"
          >
            <HugeiconsIcon :icon="PencilEdit02Icon" :size="12" :stroke-width="2" />
            <span>Edit</span>
          </button>
          <button
            type="button"
            class="queue__action queue__action--stop"
            title="Stop message"
            aria-label="Stop queued message"
            @click.stop="emit('remove-queued', item.queueId)"
          >
            <HugeiconsIcon :icon="Cancel01Icon" :size="12" :stroke-width="2" />
            <span>Stop</span>
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Follow-ups parked behind the running turn. The mirror of the context tray
   below the card: the same sunken slab, the same small type, tucked in behind
   the card's edge so it reads as ground the composer is standing on. The tray
   tucks under the card's floor (rounded bottom, pulled up); this tucks under
   its roof (rounded top, pulled down) — the card's own layer covers the
   overlap, which is the whole tuck. */
.queue {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* Narrower than the card, like the tray, so it reads as something the card
     is standing under rather than a second bar bolted to its top. */
  width: calc(100% - 26px);
  /* No z-index of its own, on purpose — same reason as the tray. The card is
     already lifted above by its own z-index, which is all the tuck needs. */
  overflow: hidden;
  margin-bottom: -14px;
  padding: 6px 8px 20px;
  border-radius: 18px 18px 0 0;
  background: var(--sunken);
  pointer-events: auto;
}
.queue__item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 11.5px;
  line-height: 14px;
  white-space: nowrap;
  transition: background-color 0.12s ease, opacity 0.12s ease;
}
.queue__item--draggable {
  cursor: grab;
  user-select: none;
}
.queue__item--draggable:active {
  cursor: grabbing;
}
.queue__item--dragging {
  opacity: 0.35;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
}
.queue__item--drag-over {
  border-top: 2px solid var(--boost, #4f46e5);
}
.queue__grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 12px;
  color: var(--faint);
  opacity: 0.5;
  cursor: grab;
  transition: opacity 0.12s ease, color 0.12s ease;
}
.queue__item:hover .queue__grip {
  opacity: 0.9;
  color: var(--muted);
}
.queue__pos {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}
.queue__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-weight: 450;
  opacity: 0.88;
}
.queue__actions {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: none;
}
.queue__action {
  display: inline-flex;
  align-items: center;
  gap: 3.5px;
  height: 20px;
  padding: 0 6px;
  border: 0;
  border-radius: 5px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  color: var(--muted);
  font-family: var(--font-sans);
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.12s ease, background-color 0.12s ease, color 0.12s ease;
}
.queue__action:hover {
  background: color-mix(in srgb, var(--ink) 12%, transparent);
  color: var(--ink);
}
.queue__action--send:hover {
  background: color-mix(in srgb, var(--boost, #4f46e5) 15%, transparent);
  color: var(--boost, #4f46e5);
}
.queue__action--stop:hover {
  background: color-mix(in srgb, var(--danger, #ef4444) 15%, transparent);
  color: var(--danger, #ef4444);
}
.queue-enter-active,
.queue-leave-active {
  transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.queue-enter-from,
.queue-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
