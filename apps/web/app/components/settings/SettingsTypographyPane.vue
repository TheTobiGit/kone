<script setup lang="ts">
import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon, TextFontIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import FontPickerModal from "~/components/settings/FontPickerModal.vue";
import TypographyStepRow from "~/components/settings/TypographyStepRow.vue";
import {
  clampCodeFontSize,
  clampComposerFontSize,
  clampInterfaceFontSize,
  clampLineHeightBody,
  clampMeasure,
  MAX_CODE_FONT_SIZE,
  MAX_COMPOSER_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MAX_LINE_HEIGHT_BODY,
  MAX_MEASURE,
  MIN_CODE_FONT_SIZE,
  MIN_COMPOSER_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
  MIN_LINE_HEIGHT_BODY,
  MIN_MEASURE,
} from "~/theme/typography";
import { fontLabel, stackFor, type FontKind } from "~/theme/fonts";

// Typography: the faces and sizes text wears. One line per setting — the name
// on the left, what it's set to on the right — under the group it belongs to.
// Faces open the font picker (each row wears its own face, so the choice reads
// before it's opened); sizes step. The app behind the drawer is the preview:
// every change paints live.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ back: [] }>();

const { cue } = useSound();
const { prefs, setFamily, setSize, setLineHeightBody, setMeasure, setSmoothing, resetTypography } =
  useTypography();

// ── faces ────────────────────────────────────────────────────────────────────
const FACE_ROWS: { kind: FontKind; title: string }[] = [
  { kind: "sans", title: "Interface" },
  { kind: "serif", title: "Wordmark" },
  { kind: "mono", title: "Code" },
  { kind: "composer", title: "Composer" },
];

const pickerFor = ref<FontKind | null>(null);
function openPicker(kind: FontKind) {
  pickerFor.value = kind;
  cue("expand");
}
function onPick(value: string) {
  if (pickerFor.value) setFamily(pickerFor.value, value);
  cue("toggle");
}

function faceValue(kind: FontKind): string {
  return fontLabel(prefs.value[kind]);
}
// An unset row previews in its own stack, not the interface face: the default
// serif and mono stacks read nothing like the sans one, and the preview has to
// show what Default actually means. Composer is the exception — it inherits
// the interface face until pointed elsewhere.
const FACE_FALLBACK = {
  sans: "var(--font-sans)",
  serif: "var(--font-serif)",
  mono: "var(--font-mono)",
  composer: "var(--font-sans)",
} satisfies Record<FontKind, string>;
function faceStack(kind: FontKind): string {
  const value = prefs.value[kind].trim();
  return value ? stackFor(kind, value) : FACE_FALLBACK[kind];
}

// ── steppers ─────────────────────────────────────────────────────────────────
interface StepRow {
  key: string;
  title: string;
  value: string;
  downDisabled: boolean;
  upDisabled: boolean;
  step: (delta: 1 | -1) => void;
}

function sizeRow(
  key: "sizeInterface" | "sizeComposer" | "sizeCode",
  title: string,
  min: number,
  max: number,
  clamp: (n: number) => number,
): StepRow {
  const kind = key === "sizeInterface" ? "interface" : key === "sizeComposer" ? "composer" : "code";
  const current = computed(() => prefs.value[key]);
  return {
    key,
    title,
    value: `${current.value}px`,
    downDisabled: current.value <= min,
    upDisabled: current.value >= max,
    step: (delta) => setSize(kind, clamp(current.value + delta)),
  };
}

const sizeRows = computed<StepRow[]>(() => [
  sizeRow("sizeInterface", "Interface", MIN_INTERFACE_FONT_SIZE, MAX_INTERFACE_FONT_SIZE, clampInterfaceFontSize),
  sizeRow("sizeComposer", "Composer", MIN_COMPOSER_FONT_SIZE, MAX_COMPOSER_FONT_SIZE, clampComposerFontSize),
  sizeRow("sizeCode", "Code", MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE, clampCodeFontSize),
]);

const leadingRow = computed<StepRow>(() => {
  const current = prefs.value.lineHeightBody;
  const next = (delta: 1 | -1) =>
    clampLineHeightBody(Math.round((current + delta * 0.05) * 100) / 100);
  return {
    key: "leading",
    title: "Leading",
    value: current.toFixed(2),
    downDisabled: current <= MIN_LINE_HEIGHT_BODY,
    upDisabled: current >= MAX_LINE_HEIGHT_BODY,
    step: (delta) => setLineHeightBody(next(delta)),
  };
});

const measureRow = computed<StepRow>(() => {
  const current = prefs.value.measure;
  return {
    key: "measure",
    title: "Measure",
    value: `${current}ch`,
    downDisabled: current <= MIN_MEASURE,
    upDisabled: current >= MAX_MEASURE,
    step: (delta) => setMeasure(clampMeasure(current + delta)),
  };
});

function onReset() {
  resetTypography();
  cue("toggle");
}
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Personalization / Typography"
    :breadcrumb-icon="TextFontIcon"
    label="Typography settings"
    @back="emit('back')"
  >
    <template #actions>
      <button type="button" class="ty__reset" :tabindex="open ? 0 : -1" @click="onReset">
        Reset
      </button>
    </template>

    <div class="ty">
      <div class="ty__group">
        <h2 class="ty__heading">Faces</h2>
        <div class="ty__rows">
          <div v-for="row in FACE_ROWS" :key="row.kind" class="ty__row">
            <h3 class="ty__title">{{ row.title }}</h3>
            <div class="ty__value">
              <button
                type="button"
                class="ty__pick"
                :tabindex="open ? 0 : -1"
                :aria-label="`Change the ${row.title} typeface`"
                @click="openPicker(row.kind)"
              >
                <span class="ty__pick-name" :style="{ fontFamily: faceStack(row.kind) }">
                  {{ faceValue(row.kind) }}
                </span>
                <HugeiconsIcon
                  class="ty__pick-chev"
                  :class="{ 'ty__pick-chev--on': pickerFor === row.kind }"
                  :icon="ArrowRight01Icon"
                  :size="15"
                  :stroke-width="1.8"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="ty__group">
        <h2 class="ty__heading">Sizes</h2>
        <div class="ty__rows">
          <TypographyStepRow
            v-for="row in sizeRows"
            :key="row.key"
            :title="row.title"
            :value="row.value"
            :down-disabled="row.downDisabled"
            :up-disabled="row.upDisabled"
            :open="open"
            :decrease-label="`Decrease ${row.title} size`"
            :increase-label="`Increase ${row.title} size`"
            @step="row.step($event); cue('toggle')"
          />
        </div>
      </div>

      <div class="ty__group">
        <h2 class="ty__heading">Reading</h2>
        <div class="ty__rows">
          <TypographyStepRow
            v-for="row in [leadingRow, measureRow]"
            :key="row.key"
            :title="row.title"
            :value="row.value"
            :down-disabled="row.downDisabled"
            :up-disabled="row.upDisabled"
            :open="open"
            :decrease-label="`Decrease ${row.title}`"
            :increase-label="`Increase ${row.title}`"
            @step="row.step($event); cue('toggle')"
          />

          <div class="ty__row">
            <h3 class="ty__title">Smoothing</h3>
            <button
              type="button"
              role="switch"
              :aria-checked="prefs.smoothing"
              :tabindex="open ? 0 : -1"
              aria-label="Font smoothing"
              class="ty__switch"
              @click="setSmoothing(!prefs.smoothing); cue('toggle')"
            >
              <span class="ty__switch-track" :class="{ 'ty__switch-track--on': prefs.smoothing }">
                <span class="ty__switch-knob" :class="{ 'ty__switch-knob--on': prefs.smoothing }" />
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <template #foot>
      Faces and sizes for the next thing you read — a pane already open keeps what it has.
    </template>
  </SettingsPageShell>

  <Teleport to="body">
    <FontPickerModal
      v-if="pickerFor"
      :kind="pickerFor"
      :current="prefs[pickerFor]"
      :open="open"
      @pick="onPick"
      @close="pickerFor = null"
    />
  </Teleport>
</template>

<style scoped>
.ty {
  --ty-ease: cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  max-width: 60rem;
  padding-block: 8px 4rem;
  animation: ty-in 400ms var(--ty-ease) backwards;
}
@keyframes ty-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.ty__reset {
  display: inline-flex;
  align-items: center;
  height: 27px;
  padding-inline: 11px;
  border-radius: 8px;
  font-size: 11px;
  color: var(--ink-soft);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 140ms ease;
}
.ty__reset:hover {
  background-color: var(--hover);
}
.ty__reset:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── groups ─────────────────────────────────────────────────────────────── */
.ty__group {
  padding-block: 0.5rem 1.5rem;
}
.ty__group + .ty__group {
  margin-top: 0.5rem;
}
.ty__heading {
  font-size: 10px;
  letter-spacing: 0.08em;
  line-height: 1;
  text-transform: uppercase;
  color: var(--muted);
}

/* ── setting / value rows ───────────────────────────────────────────────── */
.ty__rows {
  display: flex;
  flex-direction: column;
  gap: 22px;
  margin-top: 18px;
}
.ty__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px 40px;
}
@media (max-width: 620px) {
  .ty__row {
    grid-template-columns: minmax(0, 1fr);
  }
}
.ty__value {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  min-width: 0;
}
.ty__title {
  font-size: 14px;
  line-height: 1.4;
  color: var(--ink);
}

/* The value reads as the answer to the label: muted until you go for it. */
.ty__pick {
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: box-shadow 140ms ease;
}
.ty__pick:hover .ty__pick-name,
.ty__pick:hover .ty__pick-chev {
  color: var(--ink);
}
.ty__pick:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.ty__pick-name {
  font-size: 14px;
  line-height: 1.2;
  color: var(--muted);
  transition: color 140ms ease;
}
.ty__pick-chev {
  flex-shrink: 0;
  color: var(--muted);
  transition:
    color 140ms ease,
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ty__pick-chev--on {
  transform: rotate(90deg);
}

/* The drawer's own switch, borrowed for the one boolean here. */
.ty__switch {
  display: inline-flex;
  cursor: pointer;
}
.ty__switch:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
  border-radius: 999px;
}
.ty__switch-track {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 34px;
  height: 20px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 14%, transparent);
  transition: background-color 200ms ease;
}
.ty__switch-track--on {
  background-color: var(--ink);
}
.ty__switch-knob {
  position: absolute;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background-color: var(--ground);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 10%, transparent);
  transform: translateX(2px);
  transition: transform 200ms ease-out;
}
.ty__switch-knob--on {
  transform: translateX(16px);
}

@media (prefers-reduced-motion: reduce) {
  .ty {
    animation: none;
  }
}
</style>
