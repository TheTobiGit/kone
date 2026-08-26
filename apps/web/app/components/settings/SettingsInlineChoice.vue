<script setup lang="ts">
import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";

// The value half of a one-line setting: the choice that's set, and — on click —
// the others laid out along the same line. It grows sideways rather than into a
// stack, so a pane of these stays a column of settings and a column of values.
//
// For a handful of short labels. A choice with many options, or one that needs
// more than a word each, wants its own surface (the model picker's card).

const props = withDefaults(
  defineProps<{
    options: readonly { id: string; label: string }[];
    /** The option that's set. */
    value: string;
    /** Names the setting for the radiogroup and the disclosure. */
    setting: string;
    /** False parks the controls out of the tab order (a pane behind the drawer). */
    tabbable?: boolean;
  }>(),
  { tabbable: true },
);

const emit = defineEmits<{ pick: [id: string] }>();

const { cue } = useSound();

const currentLabel = computed(
  () => props.options.find((o) => o.id === props.value)?.label ?? "",
);

const open = ref(false);
function toggle() {
  open.value = !open.value;
  cue(open.value ? "expand" : "collapse");
}

function pick(id: string) {
  open.value = false;
  if (id === props.value) return;
  emit("pick", id);
  cue("toggle");
}
</script>

<template>
  <div class="sic">
    <!-- Open, the options lay out along the line the value sat on. -->
    <div v-if="open" class="sic__opts" role="radiogroup" :aria-label="setting">
      <button
        v-for="o in options"
        :key="o.id"
        type="button"
        role="radio"
        class="sic__opt"
        :class="{ 'sic__opt--on': o.id === value }"
        :aria-checked="o.id === value"
        :tabindex="tabbable ? 0 : -1"
        @click="pick(o.id)"
      >
        {{ o.label }}
      </button>
    </div>

    <button
      type="button"
      class="sic__toggle"
      :tabindex="tabbable ? 0 : -1"
      :aria-expanded="open"
      :aria-label="`Change ${setting}`"
      @click="toggle"
    >
      <span v-if="!open" class="sic__value">{{ currentLabel }}</span>
      <HugeiconsIcon
        class="sic__chev"
        :class="{ 'sic__chev--on': open }"
        :icon="ArrowRight01Icon"
        :size="15"
        :stroke-width="1.8"
        aria-hidden="true"
      />
    </button>
  </div>
</template>

<style scoped>
.sic {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  min-width: 0;
}

/* No pill on either half: these are values, and the colour carries the state. */
.sic__opts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
}
.sic__opt {
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--muted);
  cursor: pointer;
  transition: color 140ms ease;
}
.sic__opt:hover,
.sic__opt--on {
  color: var(--ink);
}

.sic__toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}
.sic__value {
  font-size: 14px;
  line-height: 1.2;
  color: var(--muted);
  transition: color 140ms ease;
}
.sic__chev {
  flex-shrink: 0;
  color: var(--muted);
  transition:
    color 140ms ease,
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
/* Open, the chevron turns to point along the row it revealed. */
.sic__chev--on {
  transform: rotate(90deg);
}
.sic__toggle:hover .sic__value,
.sic__toggle:hover .sic__chev {
  color: var(--ink);
}

.sic__opt:focus-visible,
.sic__toggle:focus-visible {
  outline: none;
  border-radius: 6px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
</style>
