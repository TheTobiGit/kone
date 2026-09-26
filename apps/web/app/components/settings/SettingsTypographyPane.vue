<script setup lang="ts">
import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon, Tick02Icon, TextFontIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import SettingsBanner from "~/components/settings/SettingsBanner.vue";
import FontPickerModal from "~/components/settings/FontPickerModal.vue";
import TypeRuler from "~/components/settings/TypeRuler.vue";
import ToggleSwitch from "~/components/ui/ToggleSwitch.vue";
import {
  DEFAULT_TYPOGRAPHY_PREFS,
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
  interfaceZoomFactor,
  type TypographyPrefs,
} from "~/theme/typography";
import { fontLabel, stackFor, type FontKind } from "~/theme/fonts";

// Typography: how text reads across the app. A voice to start from, then the
// faces, the sizes and the room the lines get. Every change paints live across
// the app behind the page, so the app itself is the preview.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ back: [] }>();

const { cue } = useSound();
const {
  prefs,
  setFamily,
  setSize,
  setLineHeightBody,
  setMeasure,
  setSmoothing,
  setLigatures,
  patchTypography,
  resetTypography,
} = useTypography();

// ── voices ───────────────────────────────────────────────────────────────────
// Whole settings, not patches: picking a voice sets every knob, so each one is
// a known starting point rather than a change stacked on whatever was there.
interface Voice {
  id: string;
  name: string;
  line: string;
  prefs: TypographyPrefs;
}
const voice = (id: string, name: string, line: string, patch: Partial<TypographyPrefs>): Voice => ({
  id,
  name,
  line,
  prefs: { ...DEFAULT_TYPOGRAPHY_PREFS, ...patch },
});
const VOICES: Voice[] = [
  voice("kone", "kone", "Geist at an easy read.", {}),
  voice("compact", "Compact", "More on screen, closer lines.", {
    sizeInterface: 15,
    sizeComposer: 13,
    sizeCode: 11,
    lineHeightBody: 1.45,
    measure: 64,
  }),
  voice("roomy", "Roomy", "Bigger type, lines with air.", {
    sizeInterface: 17,
    sizeComposer: 15,
    sizeCode: 13,
    lineHeightBody: 1.7,
    measure: 72,
  }),
  voice("native", "Native", "The system's own faces.", { sans: "system-ui", composer: "system-ui" }),
  // Named faces ending in a generic family: the ui-* keywords aren't honoured
  // everywhere, and the generic guarantees the voice still reads as mono or
  // serif on a machine without the named face.
  voice("terminal", "Terminal", "Write your messages in mono.", { composer: "Menlo, monospace", sizeComposer: 13 }),
  // Fraunces ships with the app, so this voice looks the same on every machine.
  voice("letter", "Letter", "Serif headings, and a serif to write in.", {
    serif: "Fraunces",
    composer: "Fraunces",
    sizeComposer: 15,
    lineHeightBody: 1.65,
  }),
];

// A voice is the faces, sizes and spacing. How the screen draws them —
// smoothing, ligatures — is a preference of its own that picking a voice
// leaves alone, and that never makes a voice stop reading as picked.
const RENDERING = new Set<keyof TypographyPrefs>(["smoothing", "ligatures"]);
// SAFETY: DEFAULT_TYPOGRAPHY_PREFS is a complete TypographyPrefs literal, so
// its own keys are exactly the prefs' keys.
const KEYS = (Object.keys(DEFAULT_TYPOGRAPHY_PREFS) as (keyof TypographyPrefs)[]).filter((k) => !RENDERING.has(k));
const activeVoice = computed(() => VOICES.find((v) => KEYS.every((k) => v.prefs[k] === prefs.value[k]))?.id ?? null);

function pickVoice(v: Voice) {
  patchTypography(Object.fromEntries(KEYS.map((k) => [k, v.prefs[k]])));
  cue("select");
}

/** The stack a voice's face previews in. Composer falls back to the voice's
 *  interface face, the way the app does. */
function voiceStack(v: Voice, kind: "sans" | "composer"): string {
  const value = (kind === "composer" && !v.prefs.composer ? v.prefs.sans : v.prefs[kind]).trim();
  return value ? stackFor(kind, value) : "var(--font-sans)";
}
/** The miniature's display glyph: the voice's headings face when it has one,
 *  since that's the face its replies open with. */
function voiceGlyphStack(v: Voice): string {
  return v.prefs.serif.trim() ? stackFor("serif", v.prefs.serif) : voiceStack(v, "sans");
}

// ── faces ────────────────────────────────────────────────────────────────────
// The faces something in the app wears. The composer and the headings inherit
// the interface face until they're pointed elsewhere.
const FACES: { kind: FontKind; title: string; glyph: string }[] = [
  { kind: "sans", title: "Interface", glyph: "Aa" },
  { kind: "serif", title: "Headings", glyph: "Hh" },
  { kind: "composer", title: "Composer", glyph: "Ag" },
  { kind: "mono", title: "Code", glyph: "{ }" },
];
// The banner keeps to the three faces every screen shows.
const ART_FACES = FACES.filter((f) => f.kind !== "serif");
const FACE_FALLBACK = {
  sans: "var(--font-sans)",
  serif: "var(--font-heading, var(--font-sans))",
  mono: "var(--font-mono)",
  composer: "var(--font-composer)",
} satisfies Record<FontKind, string>;
function faceStack(kind: FontKind): string {
  const value = prefs.value[kind].trim();
  return value ? stackFor(kind, value) : FACE_FALLBACK[kind];
}
/** A face's name as the card shows it: the first family of a list, since the
 *  rest are only fallbacks. */
function faceName(kind: FontKind): string {
  if ((kind === "composer" || kind === "serif") && !prefs.value[kind].trim()) return "Same as interface";
  return fontLabel(prefs.value[kind]).split(",")[0]!.replace(/["']/g, "").trim();
}

const pickerFor = ref<FontKind | null>(null);
function openPicker(kind: FontKind) {
  pickerFor.value = kind;
  cue("expand");
}
function onPick(value: string) {
  if (pickerFor.value) setFamily(pickerFor.value, value);
  cue("toggle");
}

// ── banner ───────────────────────────────────────────────────────────────────
const stats = computed(() => [
  { label: "Scale", value: pct(prefs.value.sizeInterface) },
  { label: "Code", value: `${prefs.value.sizeCode}px` },
  { label: "Leading", value: prefs.value.lineHeightBody.toFixed(2) },
]);

const px = (n: number) => `${n}px`;
// The interface size is a zoom on the whole window, so it reads as one.
const pct = (n: number) => `${Math.round(interfaceZoomFactor(n) * 100)}%`;

function onReset() {
  resetTypography();
  cue("toggle");
}
</script>

<template>
  <SettingsPageShell
    :open="props.open"
    breadcrumb="Personalization / Typography"
    :breadcrumb-icon="TextFontIcon"
    label="Typography settings"
    @back="emit('back')"
  >
    <template #actions>
      <button type="button" class="ty__reset" :tabindex="props.open ? 0 : -1" @click="onReset">Reset</button>
    </template>

    <div class="ty">
      <SettingsBanner
        title="Typography"
        lede="How text reads across kone: the faces it wears, the sizes it takes, and the room its lines get."
        :stats="stats"
      >
        <template #art>
          <div class="ty-art">
            <span
              v-for="(f, i) in ART_FACES"
              :key="f.kind"
              class="ty-art__tile"
              :style="{ '--i': i, fontFamily: faceStack(f.kind) }"
            >
              {{ f.glyph }}
            </span>
          </div>
        </template>
      </SettingsBanner>

      <!-- ── voices ── -->
      <section class="ty__section" aria-labelledby="ty-voices">
        <header class="ty__head">
          <h2 id="ty-voices" class="ty__heading">Voices</h2>
          <span class="ty__rule" aria-hidden="true" />
        </header>
        <div class="ty-voices" role="radiogroup" aria-labelledby="ty-voices">
          <button
            v-for="(v, i) in VOICES"
            :key="v.id"
            type="button"
            role="radio"
            class="ty-voice"
            :class="{ 'is-on': activeVoice === v.id }"
            :aria-checked="activeVoice === v.id"
            :tabindex="props.open ? 0 : -1"
            :style="{ '--i': i, '--vl': v.prefs.lineHeightBody, '--vs': v.prefs.sizeInterface, '--vm': v.prefs.measure }"
            @click="pickVoice(v)"
          >
            <span class="ty-voice__art" aria-hidden="true">
              <span class="ty-voice__glyph" :style="{ fontFamily: voiceGlyphStack(v) }">Aa</span>
              <span class="ty-voice__lines">
                <i style="width: 92%" />
                <i style="width: 100%" />
                <i style="width: 64%" />
              </span>
              <span class="ty-voice__draft" :style="{ fontFamily: voiceStack(v, 'composer') }">Ag</span>
            </span>
            <span class="ty-voice__text">
              <span class="ty-voice__name">{{ v.name }}</span>
              <span class="ty-voice__line">{{ v.line }}</span>
            </span>
            <span v-if="activeVoice === v.id" class="ty-voice__tick" aria-hidden="true">
              <HugeiconsIcon :icon="Tick02Icon" :size="13" :stroke-width="2.2" />
            </span>
          </button>
        </div>
      </section>

      <!-- ── faces ── -->
      <section class="ty__section" aria-labelledby="ty-faces">
        <header class="ty__head">
          <h2 id="ty-faces" class="ty__heading">Faces</h2>
          <span class="ty__rule" aria-hidden="true" />
        </header>
        <div class="ty-faces">
          <button
            v-for="f in FACES"
            :key="f.kind"
            type="button"
            class="ty-face"
            :class="{ 'is-picking': pickerFor === f.kind }"
            :tabindex="props.open ? 0 : -1"
            :aria-label="`${f.title} typeface: ${faceName(f.kind)}. Change`"
            @click="openPicker(f.kind)"
          >
            <span class="ty-face__glyph" :style="{ fontFamily: faceStack(f.kind) }" aria-hidden="true">
              {{ f.glyph }}
            </span>
            <span class="ty-face__title">{{ f.title }}</span>
            <span class="ty-face__name" :style="{ fontFamily: faceStack(f.kind) }">
              {{ faceName(f.kind) }}
              <HugeiconsIcon class="ty-face__go" :icon="ArrowRight01Icon" :size="12" :stroke-width="2" />
            </span>
          </button>
        </div>
      </section>

      <!-- Sizes and reading side by side: without a preview beside them, a
           full-width ruler would stretch each tick a long way apart. -->
      <div class="ty__pair">
        <section class="ty__section" aria-labelledby="ty-sizes">
          <header class="ty__head">
            <h2 id="ty-sizes" class="ty__heading">Sizes</h2>
            <span class="ty__rule" aria-hidden="true" />
          </header>
          <div class="ty__rulers">
            <TypeRuler
              keys="⌘ − / ⌘ +"
              title="Interface scale"
              :model-value="prefs.sizeInterface"
              :min="MIN_INTERFACE_FONT_SIZE"
              :max="MAX_INTERFACE_FONT_SIZE"
              :default-value="DEFAULT_TYPOGRAPHY_PREFS.sizeInterface"
              :format="pct"
              :open="props.open"
              settle
              @update:model-value="setSize('interface', $event)"
            />
            <TypeRuler
              title="Composer"
              :model-value="prefs.sizeComposer"
              :min="MIN_COMPOSER_FONT_SIZE"
              :max="MAX_COMPOSER_FONT_SIZE"
              :default-value="DEFAULT_TYPOGRAPHY_PREFS.sizeComposer"
              :format="px"
              :open="props.open"
              @update:model-value="setSize('composer', $event)"
            />
            <TypeRuler
              title="Code"
              :model-value="prefs.sizeCode"
              :min="MIN_CODE_FONT_SIZE"
              :max="MAX_CODE_FONT_SIZE"
              :default-value="DEFAULT_TYPOGRAPHY_PREFS.sizeCode"
              :format="px"
              :open="props.open"
              @update:model-value="setSize('code', $event)"
            />
          </div>
        </section>

        <section class="ty__section" aria-labelledby="ty-reading">
          <header class="ty__head">
            <h2 id="ty-reading" class="ty__heading">Reading</h2>
            <span class="ty__rule" aria-hidden="true" />
          </header>
          <div class="ty__rulers">
            <TypeRuler
              title="Leading"
              :model-value="prefs.lineHeightBody"
              :min="MIN_LINE_HEIGHT_BODY"
              :max="MAX_LINE_HEIGHT_BODY"
              :step="0.05"
              :default-value="DEFAULT_TYPOGRAPHY_PREFS.lineHeightBody"
              :format="(n) => n.toFixed(2)"
              :open="props.open"
              @update:model-value="setLineHeightBody($event)"
            />
            <TypeRuler
              title="Measure"
              :model-value="prefs.measure"
              :min="MIN_MEASURE"
              :max="MAX_MEASURE"
              :default-value="DEFAULT_TYPOGRAPHY_PREFS.measure"
              :format="(n) => `${n}ch`"
              :open="props.open"
              @update:model-value="setMeasure($event)"
            />
          </div>
        </section>
      </div>

      <!-- ── rendering ── -->
      <section class="ty__section" aria-labelledby="ty-rendering">
        <header class="ty__head">
          <h2 id="ty-rendering" class="ty__heading">Rendering</h2>
          <span class="ty__rule" aria-hidden="true" />
        </header>
        <div class="ty__pair">
          <div class="ty__switch-row">
            <span class="ty__switch-copy">
              <span class="ty__switch-title">Smoothing</span>
              <span class="ty__switch-hint">Thinner, lighter strokes on Retina screens.</span>
            </span>
            <ToggleSwitch
              :model-value="prefs.smoothing"
              aria-label="Font smoothing"
              @update:model-value="setSmoothing($event); cue('toggle')"
            />
          </div>
          <div class="ty__switch-row">
            <span class="ty__switch-copy">
              <span class="ty__switch-title">Ligatures</span>
              <span class="ty__switch-hint">
                Join <code class="ty__lig">=&gt;</code> into an arrow, in code faces that draw one.
              </span>
            </span>
            <ToggleSwitch
              :model-value="prefs.ligatures"
              aria-label="Ligatures"
              @update:model-value="setLigatures($event); cue('toggle')"
            />
          </div>
        </div>
      </section>
    </div>

    <template #foot>Every change paints live, here and across the app behind this page.</template>
  </SettingsPageShell>

  <Teleport to="body">
    <FontPickerModal
      v-if="pickerFor"
      :kind="pickerFor"
      :current="prefs[pickerFor]"
      :open="props.open"
      @pick="onPick"
      @close="pickerFor = null"
    />
  </Teleport>
</template>

<style scoped>
.ty {
  --ty-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --ty-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  display: flex;
  flex-direction: column;
  gap: 30px;
  max-width: 60rem;
  padding-block: 2px 4rem;
  container-type: inline-size;
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
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.ty__reset:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.ty__reset:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── banner art: the three faces, live ── */
.ty-art {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ty-art__tile {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  border-radius: 15px;
  background: var(--panel);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 6%, transparent);
  font-size: 21px;
  letter-spacing: -0.02em;
  color: var(--ink);
  animation: ty-rise 520ms var(--ty-spring) calc(var(--i) * 70ms + 140ms) backwards;
}
.ty-art__tile:nth-child(2) {
  transform: translateY(-8px);
  color: var(--accent);
}
@keyframes ty-rise {
  from {
    opacity: 0;
    translate: 0 8px;
    scale: 0.85;
  }
}

/* ── section heads ── */
.ty__section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.ty__head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding-inline: 2px;
}
.ty__heading {
  margin: 0;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  line-height: 1;
  color: var(--ink-soft);
}
.ty__rule {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--ink) 11%, transparent), transparent);
}
.ty__pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 30px;
}
@container (min-width: 640px) {
  .ty__pair {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 40px;
  }
}

/* ── voices ── */
.ty-voices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
@container (min-width: 560px) {
  .ty-voices {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
.ty-voice {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 8px 12px;
  border-radius: 16px;
  text-align: start;
  cursor: pointer;
  outline: none;
  transition: transform 220ms var(--ty-ease);
  animation: ty-deal 460ms var(--ty-ease) calc(var(--i) * 30ms + 60ms) backwards;
}
@keyframes ty-deal {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
.ty-voice:active {
  transform: scale(0.985);
}
/* Focus rings the miniature, not the whole card: around the card it doubled
   up with the picked voice's own ring. */
.ty-voice:focus-visible .ty-voice__art {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.ty-voice.is-on:focus-visible .ty-voice__art {
  box-shadow:
    inset 0 0 0 1.5px color-mix(in oklab, var(--accent) 55%, transparent),
    0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
/* The miniature: the voice's display face, three lines spaced at its
   leading and scaled by its size, and its composer face in a little field. */
.ty-voice__art {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  height: 78px;
  padding: 12px 14px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--ink) 3.5%, transparent);
  overflow: hidden;
  transition:
    background-color 220ms ease,
    box-shadow 220ms ease;
}
.ty-voice:hover .ty-voice__art {
  background: color-mix(in srgb, var(--ink) 5.5%, transparent);
}
.ty-voice.is-on .ty-voice__art {
  background: color-mix(in oklab, var(--accent) 9%, transparent);
  box-shadow: inset 0 0 0 1.5px color-mix(in oklab, var(--accent) 55%, transparent);
}
.ty-voice__glyph {
  font-size: calc(var(--vs) * 1.55px);
  line-height: 1;
  letter-spacing: -0.02em;
  color: var(--ink);
  transition: transform 380ms var(--ty-spring);
}
.ty-voice:hover .ty-voice__glyph {
  transform: translateY(-2px) scale(1.06);
}
.ty-voice__lines {
  display: flex;
  flex: 1;
  flex-direction: column;
  /* Exaggerated on purpose: at true scale the voices' differences are a
     pixel or two, too little to choose between at a glance. */
  gap: calc((var(--vl) - 1) * 28px + 1px);
  max-width: calc(var(--vm) * 1.2%);
  padding-top: 4px;
}
.ty-voice__lines i {
  display: block;
  height: calc(var(--vs) * 0.19px);
  border-radius: 2px;
  background: color-mix(in srgb, var(--ink) 16%, transparent);
  transition: background-color 220ms ease;
}
.ty-voice.is-on .ty-voice__lines i {
  background: color-mix(in oklab, var(--accent) 34%, transparent);
}
.ty-voice__draft {
  position: absolute;
  right: 10px;
  bottom: 9px;
  padding: 2px 7px;
  border-radius: 7px;
  background: var(--panel);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  font-size: 12px;
  line-height: 1.3;
  color: var(--ink-soft);
}
.ty-voice__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-inline: 4px;
  min-width: 0;
}
.ty-voice__name {
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.25;
  color: var(--ink);
}
.ty-voice__line {
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
  transition: color 200ms ease;
}
.ty-voice:hover .ty-voice__line {
  color: var(--ink-soft);
}
.ty-voice__tick {
  position: absolute;
  top: 14px;
  right: 14px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--panel);
  animation: ty-pop 360ms var(--ty-spring);
}
@keyframes ty-pop {
  from {
    transform: scale(0.4);
    opacity: 0;
  }
}

/* ── faces ── */
.ty-faces {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
@container (min-width: 640px) {
  .ty-faces {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
.ty-face {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
  padding: 12px 12px 11px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--ink) 3%, transparent);
  text-align: start;
  cursor: pointer;
  outline: none;
  transition:
    background-color 200ms ease,
    transform 220ms var(--ty-ease);
}
.ty-face:hover,
.ty-face.is-picking {
  background: color-mix(in srgb, var(--ink) 5.5%, transparent);
}
.ty-face:active {
  transform: scale(0.985);
}
.ty-face:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.ty-face__glyph {
  margin-bottom: 8px;
  font-size: 28px;
  line-height: 1;
  letter-spacing: -0.02em;
  color: var(--ink);
  transition:
    color 200ms ease,
    transform 380ms var(--ty-spring);
}
.ty-face:hover .ty-face__glyph,
.ty-face.is-picking .ty-face__glyph {
  color: var(--accent);
  transform: translateY(-2px);
}
.ty-face__title {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  line-height: 1.3;
  color: var(--muted);
}
.ty-face__name {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  font-size: 12.5px;
  line-height: 1.35;
  color: var(--ink-soft);
  text-align: left;
}
.ty-face__go {
  flex-shrink: 0;
  opacity: 0;
  transform: translateX(-3px);
  transition:
    opacity 160ms ease,
    transform 260ms var(--ty-spring);
}
.ty-face:hover .ty-face__go,
.ty-face:focus-visible .ty-face__go {
  opacity: 1;
  transform: none;
}

/* ── rulers ── */
.ty__rulers {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ty__switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.ty__switch-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ty__switch-title {
  font-size: 13.5px;
  line-height: 1.3;
  color: var(--ink);
}
.ty__switch-hint {
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
  text-wrap: pretty;
}
.ty__lig {
  padding: 0 0.3em;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: var(--font-mono);
  font-size: 0.95em;
  color: var(--ink-soft);
}

@media (prefers-reduced-motion: reduce) {
  .ty-art__tile,
  .ty-voice,
  .ty-voice__tick {
    animation: none;
  }
  .ty-voice,
  .ty-voice__glyph,
  .ty-face,
  .ty-face__glyph,
  .ty-face__go {
    transition: none;
    transform: none;
  }
}
</style>
