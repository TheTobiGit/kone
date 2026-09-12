<script setup lang="ts">
// A list row's overflow: the actions that should not be one wrong click away.
//
// The row's right edge can hold about three targets at 22px before it stops
// reading as a group and starts reading as a toolbar. Everything past that goes
// behind this — and so does anything destructive, whether or not there is room,
// because "delete" as a bare button in a list of rows is a mistake waiting for
// a fast cursor.
//
// The panel is fixed-positioned off the trigger's rect and teleported out,
// because the row lives inside a scroller with `overflow: auto` — a panel
// positioned inside it would be clipped by the pane it is trying to sit over.
// That trade is why it closes on any scroll: fixed coordinates stop being true
// the moment the list moves under them, and a menu that has drifted off its row
// is worse than one that shut.

import { nextTick, ref } from "vue";
import { onClickOutside, useEventListener } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import type { HugeIcon } from "~/utils/toolPresentation";

/** Every inbox row action, inline or overflow. One union so a menu pick
 *  resolves to its runner without a string switch at the call site. */
export type RowActionId = "pin" | "unread" | "delete" | "done" | "archive" | "restore";

export type RowMenuItem = {
  id: RowActionId;
  label: string;
  icon: HugeIcon;
  /** Irreversible, and styled to say so. */
  danger?: boolean;
};

const props = defineProps<{
  items: RowMenuItem[];
  /** What this menu is the overflow *of* — read out in place of "more". */
  label: string;
}>();

const emit = defineEmits<{ pick: [id: RowActionId] }>();

/** Whether the panel is up. Modelled rather than kept private because the
 *  panel is teleported out of the row: the row's actions fade with the cursor,
 *  and without being told the menu is still open they would fade out from under
 *  a panel that is very much still there. */
const open = defineModel<boolean>("open", { default: false });

const { cue } = useSound();

const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
// Pinned at open time rather than computed live: nothing may move the row while
// the panel is up (a scroll closes it), so one read is the whole story.
const at = ref({ top: 0, right: 0 });

const MENU_WIDTH = 168;
const GAP = 4;

function close(): void {
  open.value = false;
}

function toggle(): void {
  if (open.value) {
    close();
    return;
  }
  const box = trigger.value?.getBoundingClientRect();
  if (!box) return;
  cue("press");
  // Right-aligned to the trigger and hung below it, then folded up when the row
  // is near the bottom of the window — the panel is short enough that flipping
  // is always enough and it never needs to be squeezed.
  const below = box.bottom + GAP;
  const flip = below + 132 > window.innerHeight;
  at.value = {
    top: flip ? Math.max(GAP, box.top - GAP - 132) : below,
    right: Math.max(GAP, window.innerWidth - box.right),
  };
  open.value = true;
  void nextTick(() => {
    panel.value?.querySelector<HTMLButtonElement>("button")?.focus();
  });
}

function pick(id: RowActionId): void {
  close();
  emit("pick", id);
}

onClickOutside(panel, close, { ignore: [trigger] });
// Capture, so a scroll inside the list pane closes it and not only a scroll of
// the window — the pane is the thing that actually moves.
useEventListener(window, "scroll", close, { capture: true, passive: true });
useEventListener(window, "resize", close);
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (!open.value || e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  close();
  trigger.value?.focus();
});
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="rm__trigger"
    :class="{ 'rm__trigger--on': open }"
    :aria-label="props.label"
    :aria-expanded="open"
    aria-haspopup="menu"
    :title="props.label"
    @click.stop="toggle"
  >
    <HugeiconsIcon :icon="MoreHorizontalIcon" :size="14" :stroke-width="1.9" aria-hidden="true" />
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="rm__panel"
      role="menu"
      :aria-label="props.label"
      :style="{
        top: `${at.top}px`,
        right: `${at.right}px`,
        '--rm-w': `${MENU_WIDTH}px`,
      }"
    >
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        role="menuitem"
        class="rm__item"
        :class="{ 'rm__item--danger': item.danger }"
        @click.stop="pick(item.id)"
      >
        <HugeiconsIcon :icon="item.icon" :size="14" :stroke-width="1.9" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.rm__trigger {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  color: var(--faint);
  background: transparent;
  cursor: pointer;
  transition:
    color 140ms ease,
    background-color 200ms cubic-bezier(0.33, 1, 0.68, 1);
}
.rm__trigger:hover,
.rm__trigger--on {
  color: var(--ink-soft);
  background: var(--selected);
  transition-duration: 90ms;
}

.rm__panel {
  position: fixed;
  z-index: 80;
  width: var(--rm-w);
  padding: 4px;
  border-radius: 12px;
  background: var(--raised);
  box-shadow:
    0 0 0 1px var(--line-soft),
    0 12px 28px -12px rgb(0 0 0 / 0.28);
  animation: rm-in 130ms cubic-bezier(0.22, 1, 0.36, 1);
}

.rm__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: 8px;
  font-family: var(--font-sans);
  font-size: 12.5px;
  text-align: left;
  color: var(--ink-soft);
  background: transparent;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.rm__item:hover {
  background: var(--hover);
}
.rm__item--danger {
  color: var(--danger);
}
.rm__item--danger:hover {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}

@keyframes rm-in {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rm__panel {
    animation: none;
  }
}
</style>
