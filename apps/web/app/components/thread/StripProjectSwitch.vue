<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { motion, AnimatePresence } from "motion-v";
import type { StudioDestination } from "~/types/studio";
import { useStripProjectMenu } from "~/composables/useStripProjectMenu";

// The strip's project label, and the way to any other project.
//
// The corner names the project its columns belong to; pointing at that name
// lists the others and picking one travels there. It is the same move as ⌘⌥↓,
// aimed instead of stepped — with more than two projects in play, stepping past
// the ones in between is a worse way to reach the fourth than naming it.
//
// A plain label while there is nowhere else to go, so the corner never offers a
// control that does nothing.

const props = defineProps<{
  /** The project's folder name — what the corner reads. */
  repo: string;
  /** The project's absolute path, shown on hover so two same-named projects
   *  still read apart. */
  projectPath?: string;
  /** Every project the plane can travel to, in the camera's own top-to-bottom
   *  order, this one included. The plane hands one list to every row rather
   *  than minting a different one per row, so the order listed here is the
   *  order travelling down the axis would visit. */
  destinations?: StudioDestination[];
}>();

const emit = defineEmits<{
  /** Travel to another project's row. The plane owns the camera. */
  switch: [projectPath: string];
}>();

const host = ref<HTMLElement | null>(null);
const menu = useStripProjectMenu(() => host.value);

/** Everywhere but here. */
const otherProjects = computed(() =>
  (props.destinations ?? []).filter((d) => d.projectPath !== props.projectPath),
);

// Roving focus, because the list claims to be a menu. A menu that cannot be
// walked with the arrow keys is a list of buttons wearing a promise — either
// the keyboard reaches the entries or the role has to go, and reaching them is
// the useful half. Focus enters on a keyboard-latched open, so Escape has
// somewhere to fire from; a hover-opened list is left alone, since moving focus
// out from under a pointer steals it from whatever the user was typing in.
const rows = ref<HTMLButtonElement[]>([]);

function focusAt(index: number): void {
  const list = rows.value;
  if (list.length === 0) return;
  const wrapped = ((index % list.length) + list.length) % list.length;
  list[wrapped]?.focus();
}

function step(delta: number): void {
  const at = rows.value.findIndex((el) => el === document.activeElement);
  focusAt(at < 0 ? (delta > 0 ? 0 : -1) : at + delta);
}

async function toggle(): Promise<void> {
  const wasOpen = menu.open.value;
  menu.toggle();
  if (wasOpen || !menu.open.value) return;
  await nextTick();
  focusAt(0);
}

/** Close before travelling: the camera is about to move a whole row, and a menu
 *  still hanging over the corner it left would arrive with it. */
function pick(projectPath: string): void {
  menu.close();
  emit("switch", projectPath);
}

/** Escape from inside the list has to put focus back on the trigger, or the
 *  next Tab would resume from a button that no longer exists. */
const trigger = ref<HTMLButtonElement | null>(null);
function closeToTrigger(): void {
  menu.close();
  trigger.value?.focus();
}
</script>

<template>
  <div
    ref="host"
    class="here"
    @mouseenter="otherProjects.length ? menu.enter() : undefined"
    @mouseleave="menu.leave()"
  >
    <button
      v-if="otherProjects.length"
      ref="trigger"
      type="button"
      class="here__name"
      :class="{ 'is-open': menu.open.value }"
      :title="projectPath"
      aria-haspopup="menu"
      :aria-expanded="menu.open.value"
      @click="toggle()"
      @keydown.escape="menu.close()"
      @keydown.down.prevent="toggle()"
    >
      {{ repo }}
    </button>
    <span v-else class="here__name" :title="projectPath">{{ repo }}</span>

    <AnimatePresence>
      <motion.div
        v-if="menu.open.value && otherProjects.length"
        class="switch"
        role="menu"
        aria-label="Go to another project"
        :initial="{ opacity: 0, y: -6 }"
        :animate="{ opacity: 1, y: 0 }"
        :exit="{ opacity: 0, y: -6 }"
        :transition="{ type: 'spring', stiffness: 520, damping: 36, mass: 0.6 }"
        @keydown.escape="closeToTrigger()"
        @keydown.down.prevent="step(1)"
        @keydown.up.prevent="step(-1)"
        @keydown.home.prevent="focusAt(0)"
        @keydown.end.prevent="focusAt(-1)"
      >
        <button
          v-for="p in otherProjects"
          :key="p.projectPath"
          ref="rows"
          type="button"
          role="menuitem"
          class="switch__row"
          :title="p.projectPath"
          @click="pick(p.projectPath)"
        >
          <span class="switch__name">{{ p.name }}</span>
          <span
            class="switch__count"
            :aria-label="p.columns === 1 ? '1 column' : `${p.columns} columns`"
            >{{ p.columns || "—" }}</span
          >
        </button>
      </motion.div>
    </AnimatePresence>
  </div>
</template>

<style scoped>
/* The corner the project name sits in, and the anchor its drop-down hangs
   from. The nav it lives in is centred and click-through; this is the one part
   of it that takes a pointer. */
.here {
  position: absolute;
  right: 2rem;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: auto;
}
/* Frameless shells: clear the fixed caption cluster (`--caption-inset`) and
   stay clickable inside the studio's window drag band. */
.frameless .here {
  right: calc(2rem + var(--caption-inset));
  -webkit-app-region: no-drag;
}
.here__name {
  display: block;
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
  user-select: none;
  text-align: right;
  transition: color 0.18s ease;
}
button.here__name {
  cursor: pointer;
}
button.here__name:hover,
.here__name.is-open {
  color: var(--ink);
}
button.here__name:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 26%, transparent);
  outline-offset: 3px;
  border-radius: 4px;
}

/* Hangs under the name, right edges aligned, so the list grows into the empty
   corner instead of over the columns. */
.switch {
  position: absolute;
  top: calc(100% + 0.55rem);
  right: 0;
  z-index: 1;
  min-width: 11rem;
  max-width: 17rem;
  padding: 0.25rem;
  border-radius: 0.75rem;
  background-color: color-mix(in srgb, var(--ground) 96%, transparent);
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--ink) 5%, transparent) inset,
    0 16px 40px -18px rgb(0 0 0 / 0.32);
}
/* The gap between the name and the list is dead space the pointer has to
   cross. Roofing it keeps that crossing inside the hover region, so the list
   stays put for a pointer heading straight at it rather than relying on the
   close delay alone. */
.switch::before {
  content: "";
  position: absolute;
  right: 0;
  bottom: 100%;
  left: 0;
  height: 0.55rem;
}

.switch__row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.4rem 0.5rem;
  border-radius: 0.5rem;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.15s ease;
}
.switch__row:hover,
.switch__row:focus-visible {
  outline: none;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}

.switch__name {
  flex: 1;
  min-width: 0;
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.2;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* How many columns are waiting there — a count, not a badge. An em dash for a
   project with a place on the plane but nothing open on it, so the column
   still reads as answered rather than blank. */
.switch__count {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
</style>
