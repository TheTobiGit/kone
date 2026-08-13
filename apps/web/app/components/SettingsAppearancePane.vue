<script setup lang="ts">
import { computed, ref, type Ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { SwatchIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import { colorsFor, schemesOf, type AppearanceMode, type ThemeColors } from "~/theme/roles";
import { themeGroups } from "~/theme/themes";

// The appearance page: the two knobs that decide how the interface looks — the
// mode (which of the theme's schemes is painted) and the theme (the whole
// palette). The mode tiles preview the interface itself rather than a swatch: a
// miniature ground with one raised card on it, drawn from the theme's own role
// values, so the tile is the palette's truth and not a picture of it. The
// System tile shows both schemes at once, split down a diagonal, because that is
// what following the OS means — the interface as either, until the OS picks.
//
// A theme designed as a single appearance takes the mode out of play. The tiles
// stay on the page rather than disappearing — a control that vanishes reads as a
// bug — but they go inert and say why, and the stored mode is left untouched so
// it comes back the moment a theme that follows it is chosen again.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ back: [] }>();

const { cue } = useSound();
const { mode, modeLocked, themeId, theme, setMode, setTheme } = useTheme();

const MODES = ["system", "light", "dark"] as const satisfies readonly AppearanceMode[];

// ── the mode tiles ──────────────────────────────────────────────────────────
// The miniature is four colours from the scheme's role table: the ground the
// card sits on, the raised card itself, ink for the two text lines and the
// accent dot. The line colour is ink softened over its own ground — at
// miniature scale full-strength ink reads as bars rather than text. Only these
// four role values are read from the definition; everything else on the pane
// is roles and mixes.
interface MiniColors {
  ground: string;
  card: string;
  line: string;
  dot: string;
}

function miniFor(colors: ThemeColors): MiniColors {
  return {
    ground: colors.ground,
    card: colors.raised,
    line: `color-mix(in srgb, ${colors.ink} 62%, ${colors.ground})`,
    dot: colors.accent,
  };
}

interface MiniLayer {
  key: string;
  /** Clip that cuts this layer out of a split tile; absent on whole tiles. */
  clip?: string;
  mini: MiniColors;
}

interface ModeTile {
  mode: AppearanceMode;
  label: string;
  layers: MiniLayer[];
}

const tiles = computed<ModeTile[]>(() => {
  // `colorsFor` rather than the raw table: a fixed theme ships one scheme, and
  // asking it for the other returns the one it has. That is the honest preview —
  // both halves of the System tile show what selecting it would actually paint.
  const light = miniFor(colorsFor(theme.value, "light"));
  const dark = miniFor(colorsFor(theme.value, "dark"));
  return MODES.map((m) => {
    if (m === "system") {
      return {
        mode: m,
        label: "System",
        layers: [
          { key: "light", mini: light, clip: "polygon(0 0, 100% 0, 0 100%)" },
          { key: "dark", mini: dark, clip: "polygon(100% 0, 100% 100%, 0 100%)" },
        ],
      };
    }
    return {
      mode: m,
      label: m === "light" ? "Light" : "Dark",
      layers: [{ key: m, mini: m === "light" ? light : dark }],
    };
  });
});

function chooseMode(m: AppearanceMode) {
  if (modeLocked.value || mode.value === m) return;
  setMode(m);
  cue("toggle");
}

/** Why the mode is inert, named after the theme that took it out of play. */
const lockNote = computed(() =>
  modeLocked.value
    ? `${theme.value.label} is designed as ${theme.value.appearance === "dark" ? "a dark" : "a light"} theme, so the interface stays ${theme.value.appearance}.`
    : "",
);

// Roving focus, the way a native radiogroup behaves: arrows move the selection
// and the focus together, Enter/Space select. A modified arrow is the board's
// own focus-thread chord and must pass straight through. Both lists on this
// pane — the three mode tiles and the theme rows — walk the same pattern, so
// the key handling lives here once and each list only supplies its items, its
// select action and its focusable rows.
interface RovingList {
  count: number;
  choose: (index: number) => void;
  els: Ref<HTMLElement[]>;
}

function onRovingKeydown(e: KeyboardEvent, i: number, list: RovingList) {
  if (!props.open) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    list.choose(i);
    return;
  }

  const forward = e.key === "ArrowDown" || e.key === "ArrowRight";
  const back = e.key === "ArrowUp" || e.key === "ArrowLeft";
  if (!forward && !back) return;
  e.preventDefault();
  const next = (i + (forward ? 1 : -1) + list.count) % list.count;
  list.choose(next);
  list.els.value[next]?.focus();
}

const modeEls = ref<HTMLElement[]>([]);
function setModeEl(el: unknown, i: number) {
  if (el instanceof HTMLElement) modeEls.value[i] = el;
}

function onModeKeydown(e: KeyboardEvent, i: number) {
  onRovingKeydown(e, i, {
    count: MODES.length,
    choose: (next) => {
      const option = MODES[next];
      if (option) chooseMode(option);
    },
    els: modeEls,
  });
}

// ── the theme list ──────────────────────────────────────────────────────────
// Grouped, because the groups are the behaviour: a theme that follows the
// appearance setting and one that overrides it are different kinds of choice,
// and the only honest place to say which is which is above the themes it
// applies to. Rows keep a flat index across the groups so arrow keys walk the
// whole list as one radiogroup, which is what it still is.
interface ThemeRow {
  id: string;
  label: string;
  /** One bead per scheme the theme actually ships: two adaptive, one fixed. */
  beads: { key: string; ground: string; accent: string }[];
  index: number;
}

const groups = computed(() => {
  let index = 0;
  return themeGroups().map((group) => ({
    key: group.key,
    label: group.label,
    note: group.note,
    rows: group.themes.map<ThemeRow>((t) => ({
      id: t.id,
      label: t.label,
      beads: schemesOf(t).map((scheme) => {
        const colors = colorsFor(t, scheme);
        return { key: scheme, ground: colors.ground, accent: colors.accent };
      }),
      index: index++,
    })),
  }));
});

/** The themes in the order the rows are laid out, so roving lands where it looks. */
const orderedThemes = computed(() => groups.value.flatMap((g) => g.rows));

function chooseTheme(id: string) {
  if (themeId.value === id) return;
  setTheme(id);
  cue("toggle");
}

const themeEls = ref<HTMLElement[]>([]);
function setThemeEl(el: unknown, i: number) {
  if (el instanceof HTMLElement) themeEls.value[i] = el;
}

function onThemeKeydown(e: KeyboardEvent, i: number) {
  onRovingKeydown(e, i, {
    count: orderedThemes.value.length,
    choose: (next) => {
      const row = orderedThemes.value[next];
      if (row) chooseTheme(row.id);
    },
    els: themeEls,
  });
}
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Personalization / Appearance"
    :breadcrumb-icon="SwatchIcon"
    label="Appearance settings"
    @back="emit('back')"
  >
    <div class="ap">
      <!-- Mode: three miniatures of the interface, one per appearance. The
           selected mode is the one ringed in accent — the tile is the preview,
           so the hairline frame around it is all the confirmation the state
           needs. -->
      <section class="ap__section-block" aria-label="Appearance mode">
        <p class="ap__section">Mode</p>
        <div
          class="ap__modes"
          :class="{ 'ap__modes--locked': modeLocked }"
          role="radiogroup"
          aria-label="Appearance mode"
          :aria-disabled="modeLocked"
        >
          <div
            v-for="(tile, i) in tiles"
            :key="tile.mode"
            :ref="(el) => setModeEl(el, i)"
            role="radio"
            class="ap__tile"
            :class="{ 'ap__tile--on': !modeLocked && mode === tile.mode }"
            :aria-checked="!modeLocked && mode === tile.mode"
            :tabindex="open && !modeLocked ? (mode === tile.mode ? 0 : -1) : -1"
            @click="chooseMode(tile.mode)"
            @keydown="onModeKeydown($event, i)"
          >
            <div class="ap__mini" aria-hidden="true">
              <div
                v-for="layer in tile.layers"
                :key="layer.key"
                class="ap__split"
                :style="layer.clip ? { clipPath: layer.clip } : undefined"
              >
                <div class="ap__split-bg" :style="{ backgroundColor: layer.mini.ground }"></div>
                <div class="ap__card" :style="{ backgroundColor: layer.mini.card }">
                  <span class="ap__dot" :style="{ backgroundColor: layer.mini.dot }"></span>
                  <span class="ap__line" :style="{ backgroundColor: layer.mini.line }"></span>
                  <span
                    class="ap__line ap__line--short"
                    :style="{ backgroundColor: layer.mini.line }"
                  ></span>
                </div>
              </div>
            </div>
            <span class="ap__tile-label">{{ tile.label }}</span>
          </div>
        </div>
        <p v-if="modeLocked" class="ap__note">{{ lockNote }}</p>
      </section>

      <!-- Theme: one borderless row per theme, its identity told by its beads —
           each shipped scheme's ground with that scheme's accent at its centre,
           so a theme that carries both appearances shows two and one designed as
           a single appearance shows one. The active row is the one carrying the
           accent mark; the rest stay quiet. -->
      <section class="ap__themes" aria-label="Theme">
        <p class="ap__section">Theme</p>
        <div class="ap__groups" role="radiogroup" aria-label="Theme">
          <section v-for="group in groups" :key="group.key" class="ap__group">
            <p class="ap__group-head">
              <span class="ap__group-label">{{ group.label }}</span>
              <span class="ap__group-note">{{ group.note }}</span>
            </p>
            <ul class="ap__list">
              <li v-for="row in group.rows" :key="row.id">
                <button
                  type="button"
                  :ref="(el) => setThemeEl(el, row.index)"
                  role="radio"
                  class="ap__row"
                  :class="{ 'ap__row--on': row.id === themeId }"
                  :aria-checked="row.id === themeId"
                  :tabindex="open ? (row.id === themeId ? 0 : -1) : -1"
                  @click="chooseTheme(row.id)"
                  @keydown="onThemeKeydown($event, row.index)"
                >
                  <span class="ap__mark" aria-hidden="true">
                    <span v-if="row.id === themeId" class="ap__mark-dot"></span>
                  </span>
                  <span class="ap__name">{{ row.label }}</span>
                  <span class="ap__beads" aria-hidden="true">
                    <span
                      v-for="bead in row.beads"
                      :key="bead.key"
                      class="ap__bead"
                      :style="{ backgroundColor: bead.ground }"
                    >
                      <span class="ap__bead-dot" :style="{ backgroundColor: bead.accent }"></span>
                    </span>
                  </span>
                </button>
              </li>
            </ul>
          </section>
        </div>
      </section>
    </div>

    <template #foot>
      Appearance lives on this machine only — your theme and mode never leave it.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.ap {
  --ap-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --ap-t-micro: 140ms;
  --ap-t-enter: 320ms;
  display: flex;
  flex-direction: column;
  gap: 2rem;
  /* One measure for both sections: wide enough that a miniature reads as a
     picture of the interface, narrow enough that it stays a miniature. */
  max-width: 30rem;
  /* The pane note sits over the bottom-left; the last row needs room under it. */
  padding-bottom: 2.75rem;
}

@keyframes ap-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* Both sections carry a label over their content, so the page reads as two
   equal choices rather than one titled list and one loose row of tiles. */
.ap__section-block,
.ap__themes {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ── mode tiles ───────────────────────────────────────────────────────────── */
.ap__modes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  animation: ap-in var(--ap-t-enter) var(--ap-ease) backwards;
}

/* The tile is the preview and the control in one. The hover wash pads out past
   the miniature so the tile reads as tappable without the miniature pretending
   the preview changed. */
.ap__tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border-radius: 14px;
  cursor: pointer;
  transition: background-color var(--ap-t-micro) ease;
}
.ap__tile:hover {
  background-color: var(--hover);
}

/* Inert, not hidden: the tiles still show what the three appearances look like
   under this theme, they just stop being a choice. Reaching for one and getting
   nothing is the point — the line underneath explains it. */
.ap__modes--locked {
  opacity: 0.45;
}
.ap__modes--locked .ap__tile {
  cursor: default;
}
.ap__modes--locked .ap__tile:hover {
  background-color: transparent;
}
.ap__tile:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* The rounded ground field of the miniature, clipped so a split tile's
   diagonal can't bleed past the corner. */
.ap__mini {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  border-radius: 12px;
  overflow: hidden;
}
/* Selected is a hairline ring in accent and nothing else — no fill, no shadow,
   no border of its own. */
.ap__tile--on .ap__mini {
  box-shadow: 0 0 0 1px var(--accent);
}

/* Each layer is a full miniature clipped to its share of the tile: one whole
   layer for Light and Dark, two diagonal halves for System. */
.ap__split {
  position: absolute;
  inset: 0;
}
.ap__split-bg {
  position: absolute;
  inset: 0;
}

.ap__card {
  position: absolute;
  inset: 9px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px;
  border-radius: 7px;
}
.ap__dot {
  width: 5px;
  height: 5px;
  margin-inline-start: auto;
  border-radius: 50%;
}
.ap__line {
  display: block;
  height: 3px;
  width: 100%;
  border-radius: 2px;
}
.ap__line--short {
  width: 55%;
}

.ap__tile-label {
  font-size: 13px;
  line-height: 1.2;
  color: var(--muted);
  transition: color var(--ap-t-micro) ease;
}
.ap__tile--on .ap__tile-label {
  color: var(--ink);
}

/* ── theme list ───────────────────────────────────────────────────────────── */
.ap__themes {
  animation: ap-in var(--ap-t-enter) var(--ap-ease) backwards;
  animation-delay: 60ms;
}

.ap__section {
  padding-inline: 2px;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.ap__note {
  padding-inline: 2px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted);
}

/* The groups are spaced apart rather than ruled apart — the gap and the heading
   do the separating, so the list stays a list. */
.ap__groups {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.ap__group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* Label and note on one line: the note is the whole reason the group exists, so
   it sits with the name rather than under it as a second paragraph. */
.ap__group-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  padding-inline: 2px;
  padding-bottom: 2px;
}
.ap__group-label {
  font-size: 12px;
  line-height: 1.3;
  color: var(--ink-soft);
}
.ap__group-note {
  font-size: 11px;
  line-height: 1.3;
  color: var(--faint);
}

.ap__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* One borderless row per theme: the wash on hover is the only surface, and the
   active row's difference is the accent mark alone. */
.ap__row {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 10px;
  width: 100%;
  padding: 9px 8px;
  border-radius: 10px;
  cursor: pointer;
  transition: background-color var(--ap-t-micro) ease;
}
.ap__row:hover {
  background-color: var(--hover);
}
.ap__row:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* The mark's column is always reserved, so labels line up whether or not the
   row carries the mark. */
.ap__mark {
  display: flex;
  align-items: center;
  justify-content: center;
}
.ap__mark-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--accent);
}

.ap__name {
  font-size: 13px;
  line-height: 1.25;
  text-align: left;
  color: var(--ink);
}

.ap__beads {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* A bead is one scheme's ground with that scheme's accent at its centre — the
   two colours a scheme is defined by, shown as the surfaces they are. */
.ap__bead {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  /* Each bead carries one scheme's ground, so on any page one of the pair is
     the same colour as the surface behind it. The hairline is what keeps it a
     bead instead of a hole. */
  box-shadow: inset 0 0 0 1px var(--line);
}
.ap__bead-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

@media (prefers-reduced-motion: reduce) {
  .ap__modes,
  .ap__themes {
    animation: none;
  }
}
</style>
