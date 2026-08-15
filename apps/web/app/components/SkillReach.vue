<script setup lang="ts">
import { computed, ref } from "vue";
import type { SkillState, WritableSkillState } from "~/types/desktop";

// How far a skill reaches, as a ladder rather than a switch. Claude Code offers
// four rungs and kone offers exactly those four; Codex and OpenCode offer two,
// and the ladder shows two. Nothing here invents a rung a CLI cannot honour —
// the settings file is the source of truth, and a control that writes nothing is
// worse than no control, so an origin with no switch renders no ladder at all
// and the page says so in words instead.

const props = defineProps<{
  state: SkillState;
  /** Which rungs this skill's own CLI can actually be set to. */
  writable: WritableSkillState[];
  busy?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ pick: [WritableSkillState] }>();

/** The rung a person reads, against the value the settings file holds. The
 *  order is the ladder's order: most reach at the left, none at the right. */
const RUNGS: { value: WritableSkillState; label: string; note: string }[] = [
  { value: "enabled", label: "On", note: "The agent reaches for it on its own." },
  {
    value: "name-only",
    label: "Name only",
    note: "The agent knows it exists but won't load it unasked.",
  },
  {
    value: "user-invocable-only",
    label: "When asked",
    note: "It only runs when you ask for it by name.",
  },
  { value: "disabled", label: "Off", note: "The agent won't use this skill at all." },
];

const rungs = computed(() => RUNGS.filter((r) => props.writable.includes(r.value)));

/** The rung index the thumb sits under. A state kone cannot place (it should
 *  not happen, but a settings file is a file a person can edit) parks the thumb
 *  rather than drawing it somewhere untrue. */
const activeIndex = computed(() => rungs.value.findIndex((r) => r.value === props.state));

/** The pending rung, so a slow settings write moves the thumb at once and the
 *  row it belongs to does not sit still under the click. Cleared by the parent
 *  handing back a new `state`. */
const pending = ref<WritableSkillState | null>(null);

const thumbIndex = computed(() => {
  if (pending.value) {
    const i = rungs.value.findIndex((r) => r.value === pending.value);
    if (i >= 0) return i;
  }
  return activeIndex.value;
});

function pick(value: WritableSkillState) {
  if (props.disabled || props.busy || value === props.state) return;
  pending.value = value;
  emit("pick", value);
}

const activeNote = computed(() => rungs.value[thumbIndex.value]?.note ?? "");
</script>

<template>
  <div class="reach">
    <div
      class="reach__track"
      :class="{ 'reach__track--busy': busy }"
      role="radiogroup"
      aria-label="How far this skill reaches"
      :style="{ '--reach-count': rungs.length }"
    >
      <span
        v-if="thumbIndex >= 0"
        class="reach__thumb"
        :style="{ '--reach-at': thumbIndex }"
        aria-hidden="true"
      />
      <button
        v-for="r in rungs"
        :key="r.value"
        type="button"
        role="radio"
        class="reach__rung"
        :class="{ 'is-on': r.value === (pending ?? state) }"
        :aria-checked="r.value === state"
        :disabled="disabled || busy"
        @click="pick(r.value)"
      >
        {{ r.label }}
      </button>
    </div>
    <p class="reach__note">{{ activeNote }}</p>
  </div>
</template>

<style scoped>
.reach {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

/* A recessed lane the rungs sit in — the app's one shape for "pick exactly one
   of these", borrowed from nothing and bordered by nothing. */
.reach__track {
  position: relative;
  display: grid;
  grid-template-columns: repeat(var(--reach-count), minmax(0, 1fr));
  gap: 2px;
  width: 100%;
  max-width: 420px;
  padding: 3px;
  border-radius: 11px;
  background-color: var(--sunken);
}
.reach__track--busy {
  cursor: progress;
}

/* The thumb is one cell wide and slides between them, so the change reads as a
   move along a ladder rather than two independent buttons blinking. */
.reach__thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc((100% - 6px - (var(--reach-count) - 1) * 2px) / var(--reach-count));
  transform: translateX(calc(var(--reach-at) * (100% + 2px)));
  border-radius: 8px;
  background-color: var(--raised-high);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.05);
  transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
}

.reach__rung {
  position: relative;
  z-index: 1;
  padding: 6px 4px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.2;
  color: var(--muted);
  white-space: nowrap;
  cursor: pointer;
  transition: color 160ms ease;
}
.reach__rung:hover:not(:disabled) {
  color: var(--ink-soft);
}
.reach__rung.is-on {
  color: var(--ink);
}
.reach__rung:disabled {
  cursor: default;
}
.reach__rung:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* The chosen rung explains itself in a full sentence — the labels are short
   enough to be ambiguous on their own, and this is a destructive-adjacent
   setting where a guess is expensive. */
.reach__note {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
  text-wrap: pretty;
}

@media (prefers-reduced-motion: reduce) {
  .reach__thumb {
    transition: none;
  }
}
</style>
