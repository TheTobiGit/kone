<script setup lang="ts">
import { computed, ref, type Ref } from "vue";
import {
  AlertCircleIcon,
  CheckmarkCircle01Icon,
  Delete01Icon,
  Store02Icon,
  SwatchIcon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import AppearanceMiniature from "~/components/AppearanceMiniature.vue";
import ThemeBrowseModal from "~/components/ThemeBrowseModal.vue";
import {
  colorsFor,
  schemesOf,
  type AppearanceMode,
  type ThemeDefinition,
  type ThemeScheme,
} from "~/theme/roles";
import { themeGroups } from "~/theme/library";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ back: [] }>();

const { cue } = useSound();
const { mode, modeLocked, themeId, theme, scheme, setMode, setTheme, importThemes, removeImportedTheme, isImported } = useTheme();

const MODES = ["system", "light", "dark"] as const satisfies readonly AppearanceMode[];

const MODE_LABEL: Record<AppearanceMode, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function chooseMode(m: AppearanceMode) {
  if (modeLocked.value || mode.value === m) return;
  setMode(m);
  cue("toggle");
}

// ── Mode tiles ───────────────────────────────────────────────────────────────
// Each tile is kone drawn small in the *selected theme's* colours for that
// scheme, so the choice is made by looking rather than by reading three words.
// The System tile is the same miniature twice, split down the middle, which is
// the only honest picture of "whichever one the machine is in".

const modeTiles = computed(() =>
  MODES.map((m) => ({
    mode: m,
    label: MODE_LABEL[m],
    panes:
      m === "system"
        ? ([
            { clip: "left" as const, colors: colorsFor(theme.value, "light") },
            { clip: "right" as const, colors: colorsFor(theme.value, "dark") },
          ])
        : [{ clip: undefined, colors: colorsFor(theme.value, m) }],
  })),
);

/** What the locked pane shows instead of the row: the one appearance it has. */
const lockedTile = computed(() => ({
  label: theme.value.appearance === "dark" ? "Dark" : "Light",
  colors: colorsFor(theme.value, scheme.value),
}));

const lockNote = computed(() =>
  modeLocked.value
    ? `${theme.value.label} is designed as ${
        theme.value.appearance === "dark" ? "a dark" : "a light"
      } theme, so the interface stays ${theme.value.appearance} whatever your system is doing.`
    : "",
);

// ── Roving focus, shared by both radiogroups ─────────────────────────────────

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

// ── Theme cards ──────────────────────────────────────────────────────────────
// A card carries the theme's own light and dark as two soft-lit beads rather
// than flat swatches: a palette is a ground with colour *in* it, and a blurred
// wash off the accent says that where a hard disc can only say "orange".

interface Bead {
  key: ThemeScheme;
  ground: string;
  ink: string;
  wash: string;
}

interface ThemeRow {
  id: string;
  label: string;
  blurb: string;
  beads: Bead[];
  index: number;
  imported: boolean;
}

/** The bead's paint: the ground as the base, the accent as a contained glow,
 *  the second voice as a quieter tint from the far corner. */
function beadWash(theme: ThemeDefinition, s: ThemeScheme): string {
  const c = colorsFor(theme, s);
  const accentAt = s === "dark" ? "30% 76%" : "70% 24%";
  const secondAt = s === "dark" ? "80% 20%" : "20% 80%";
  return [
    `radial-gradient(circle at ${accentAt} in oklab, ${c.accent} 0%, color-mix(in oklab, ${c.accent} 62%, transparent) 30%, transparent 62%)`,
    `radial-gradient(circle at ${secondAt} in oklab, color-mix(in oklab, ${c.accentSecondary} 42%, transparent) 0%, transparent 58%)`,
  ].join(", ");
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
      blurb: t.blurb,
      imported: isImported(t.id),
      beads: schemesOf(t).map((s) => {
        const c = colorsFor(t, s);
        return { key: s, ground: c.ground, ink: c.ink, wash: beadWash(t, s) };
      }),
      index: index++,
    })),
  }));
});

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

// ── Import ───────────────────────────────────────────────────────────────────
// VS Code colour-theme files picked from disk become kone themes: the editor
// canvas and accent grow a full palette, light/dark siblings pair into one
// adaptive theme, and the rest is derived. What a file couldn't become is said
// out loud under the masthead, not buried in a toast.

const fileInput = ref<HTMLInputElement>();
const notice = ref<{ kind: "ok" | "error"; text: string } | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function showNotice(kind: "ok" | "error", text: string) {
  notice.value = { kind, text };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = null;
  }, 9000);
}

async function onFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length === 0) return;

  const result = await importThemes(files);
  const first = result.failures[0];
  if (!first) {
    cue("success");
    const n = result.added.length;
    showNotice("ok", `Imported ${n} ${n === 1 ? "theme" : "themes"}.`);
    return;
  }
  const more = result.failures.length - 1;
  const suffix = more > 0 ? ` (and ${more} more)` : "";
  if (result.added.length > 0) {
    cue("toggle");
    showNotice(
      "error",
      `Imported ${result.added.length}. Couldn't import ${first.name} — ${first.reason}${suffix}`,
    );
    return;
  }
  cue("error");
  showNotice("error", `Couldn't import ${first.name} — ${first.reason}${suffix}`);
}

function removeRow(id: string) {
  removeImportedTheme(id);
  cue("toggle");
}

// ── Community browse ─────────────────────────────────────────────────────────
const browseOpen = ref(false);
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Personalization / Appearance"
    :breadcrumb-icon="SwatchIcon"
    label="Appearance settings"
    @back="emit('back')"
  >
    <template #actions>
      <button type="button" class="ap__import" :tabindex="open ? 0 : -1" @click="browseOpen = true">
        <HugeiconsIcon :icon="Store02Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
        Browse themes
      </button>
      <button type="button" class="ap__import" :tabindex="open ? 0 : -1" @click="fileInput?.click()">
        <HugeiconsIcon :icon="Upload01Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
        Import theme
      </button>
      <input
        ref="fileInput"
        type="file"
        multiple
        accept=".json,application/json"
        class="ap__file"
        aria-hidden="true"
        tabindex="-1"
        @change="onFilesPicked"
      />
    </template>

    <template #lede>
      <div class="ap__lede">
        <p
          v-if="notice"
          class="ap__notice"
          :class="`ap__notice--${notice.kind}`"
          :role="notice.kind === 'error' ? 'alert' : 'status'"
        >
          <HugeiconsIcon
            :icon="notice.kind === 'ok' ? CheckmarkCircle01Icon : AlertCircleIcon"
            :size="13"
            :stroke-width="1.8"
            aria-hidden="true"
          />
          {{ notice.text }}
        </p>
      </div>
    </template>

    <div class="ap">
      <!-- ── Appearance ──────────────────────────────────────────────────── -->
      <section class="ap__section">
        <div
          v-if="!modeLocked"
          class="ap__modes"
          role="radiogroup"
          aria-label="Appearance mode"
        >
          <button
            v-for="(tile, i) in modeTiles"
            :key="tile.mode"
            :ref="(el) => setModeEl(el, i)"
            type="button"
            role="radio"
            class="ap__mode"
            :class="{ 'ap__mode--on': mode === tile.mode }"
            :aria-checked="mode === tile.mode"
            :tabindex="open ? (mode === tile.mode ? 0 : -1) : -1"
            @click="chooseMode(tile.mode)"
            @keydown="onModeKeydown($event, i)"
          >
            <span class="ap__frame">
              <AppearanceMiniature
                v-for="pane in tile.panes"
                :key="pane.clip ?? 'full'"
                :colors="pane.colors"
                :clip="pane.clip"
              />
            </span>
            <span class="ap__mode-label">{{ tile.label }}</span>
          </button>
        </div>

        <div v-else class="ap__locked">
          <span class="ap__frame ap__frame--locked">
            <AppearanceMiniature :colors="lockedTile.colors" />
          </span>
          <p class="ap__locked-note">{{ lockNote }}</p>
        </div>
      </section>

      <!-- ── Themes ──────────────────────────────────────────────────────── -->
      <div class="ap__themes" role="radiogroup" aria-label="Theme">
        <section v-for="group in groups" :key="group.key" class="ap__section">
          <h3 class="ap__title">{{ group.label }}</h3>
          <p class="ap__note">{{ group.note }}</p>

          <div class="ap__grid">
            <div
              v-for="row in group.rows"
              :key="row.id"
              :ref="(el) => setThemeEl(el, row.index)"
              role="radio"
              class="ap__card"
              :class="{ 'ap__card--on': row.id === themeId, 'ap__card--imported': row.imported }"
              :aria-checked="row.id === themeId"
              :aria-label="`${row.label} — ${row.blurb}`"
              :tabindex="open ? (row.id === themeId ? 0 : -1) : -1"
              @click="chooseTheme(row.id)"
              @keydown="onThemeKeydown($event, row.index)"
            >
              <span class="ap__beads" aria-hidden="true">
                <span
                  v-for="(bead, bi) in row.beads"
                  :key="bead.key"
                  class="ap__bead"
                  :style="{
                    backgroundColor: bead.ground,
                    marginLeft: bi > 0 ? '-14px' : undefined,
                    zIndex: row.beads.length - bi,
                    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${bead.ink} 12%, transparent)`,
                  }"
                >
                  <span class="ap__bead-wash" :style="{ backgroundImage: bead.wash }" />
                </span>
              </span>

              <span class="ap__meta">
                <span class="ap__name">{{ row.label }}</span>
                <span class="ap__blurb">{{ row.blurb }}</span>
              </span>

              <button
                v-if="row.imported"
                type="button"
                class="ap__remove"
                :tabindex="open ? 0 : -1"
                :aria-label="`Remove ${row.label}`"
                @click.stop="removeRow(row.id)"
                @keydown.stop
              >
                <HugeiconsIcon
                  :icon="Delete01Icon"
                  :size="13"
                  :stroke-width="1.8"
                  aria-hidden="true"
                />
              </button>

              <svg
                v-if="row.id === themeId"
                class="ap__check"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>
        </section>
      </div>
    </div>
  </SettingsPageShell>

  <ThemeBrowseModal v-if="browseOpen" :open="browseOpen" @close="browseOpen = false" />
</template>

<style scoped>
.ap {
  --ap-ease: cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  gap: 40px;
  max-width: 60rem;
  padding-block: 8px 4rem;
  animation: ap-in 400ms var(--ap-ease) backwards;
}

/* ── Masthead import ──────────────────────────────────────────────────────── */

.ap__file {
  display: none;
}

.ap__import {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding-inline: 11px;
  border-radius: 8px;
  font-size: 11px;
  color: var(--ink-soft);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 140ms ease;
}

.ap__import:hover {
  background-color: var(--hover);
}

.ap__import:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── Import notice ────────────────────────────────────────────────────────── */

/* display: contents so the line sits in the shell's flow under the masthead,
   aligned like the pane's own content. */
.ap__lede {
  display: contents;
}

.ap__notice {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 12px 1rem 0;
  padding: 7px 12px;
  border-radius: 9px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--muted);
  animation: ap-in 240ms var(--ap-ease) backwards;
}

.ap__notice--ok {
  background-color: color-mix(in oklab, var(--ok) 10%, transparent);
  color: var(--ink-soft);
}

.ap__notice--ok svg {
  color: var(--ok);
}

.ap__notice--error {
  background-color: color-mix(in oklab, var(--danger) 9%, transparent);
  color: var(--ink-soft);
}

.ap__notice--error svg {
  color: var(--danger);
}

@keyframes ap-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.ap__section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ap__title {
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--faint);
}

.ap__note {
  margin: 0 0 14px;
  max-width: 44ch;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--muted);
}

/* ── Appearance mode ──────────────────────────────────────────────────────── */

/* Capped well short of the page measure: three tiles at full width become the
   subject of the pane, and the subject is the theme list. */
.ap__modes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  max-width: 41rem;
}

.ap__mode {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  outline: none;
  text-align: left;
}

/* The frame is the only place in the pane that draws a hairline, because a
   miniature of the interface needs an edge to *be* an interface. */
.ap__frame {
  position: relative;
  display: block;
  aspect-ratio: 16 / 10;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 9%, transparent);
  transition:
    transform 320ms var(--ap-ease),
    box-shadow 220ms var(--ap-ease);
}

.ap__mode:hover .ap__frame {
  transform: translateY(-2px);
}

.ap__mode--on .ap__frame {
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--ink) 9%, transparent),
    0 0 0 2px var(--accent);
}

.ap__mode:focus-visible .ap__frame {
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--ink) 9%, transparent),
    0 0 0 2px var(--focus);
}

.ap__mode-label {
  font-size: 12.5px;
  color: var(--muted);
  transition: color 200ms ease;
}

.ap__mode:hover .ap__mode-label,
.ap__mode--on .ap__mode-label {
  color: var(--ink);
}

.ap__locked {
  display: flex;
  align-items: center;
  gap: 20px;
}

.ap__frame--locked {
  flex: 0 0 auto;
  width: 176px;
}

.ap__locked-note {
  margin: 0;
  max-width: 40ch;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--muted);
}

/* ── Themes ───────────────────────────────────────────────────────────────── */

.ap__themes {
  display: flex;
  flex-direction: column;
  gap: 34px;
}

.ap__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(268px, 1fr));
  gap: 4px;
}

.ap__card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
  padding: 12px 34px 12px 12px;
  border-radius: 14px;
  cursor: pointer;
  outline: none;
  background-color: transparent;
  transition:
    background-color 220ms var(--ap-ease),
    box-shadow 220ms var(--ap-ease);
}

.ap__card:hover {
  background-color: var(--hover);
}

/* Lighter than `--selected`, which is tuned for a list row you are navigating.
   A theme you already chose should not out-shout the fourteen you have not. */
.ap__card--on {
  background-color: color-mix(in oklab, var(--accent) 7%, transparent);
}

.ap__card:focus-visible {
  box-shadow: inset 0 0 0 2px var(--focus);
}

/* Held at the width of a pair so a one-scheme theme's single bead doesn't pull
   its name left — the names have to line up down the page across all three
   groups, or the list stops reading as one list. */
.ap__beads {
  display: flex;
  flex: 0 0 66px;
  align-items: center;
}

.ap__bead {
  position: relative;
  display: block;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  transition: transform 320ms var(--ap-ease);
}

/* The wash overspills and blurs, so the accent reads as light in the ground
   rather than a disc printed on it. */
.ap__bead-wash {
  position: absolute;
  inset: -12%;
  border-radius: 50%;
  filter: blur(3px);
}

.ap__card:hover .ap__bead:first-child,
.ap__card--on .ap__bead:first-child {
  transform: translateX(-2px);
}

.ap__card:hover .ap__bead:last-child:not(:first-child),
.ap__card--on .ap__bead:last-child:not(:first-child) {
  transform: translateX(2px);
}

.ap__meta {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.ap__name {
  font-size: 13.5px;
  color: color-mix(in oklab, var(--ink) 74%, transparent);
  transition: color 200ms ease;
}

.ap__card:hover .ap__name,
.ap__card--on .ap__name {
  color: var(--ink);
}

.ap__blurb {
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--muted);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

/* Imported cards carry their own dismissal. It only appears when the row is
   being looked at — hover or keyboard focus — so fourteen themes do not all
   wear a delete glyph at once. */
.ap__remove {
  position: absolute;
  top: 50%;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-top: -11px;
  border-radius: 7px;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 140ms ease,
    background-color 140ms ease,
    color 140ms ease;
}

.ap__card:hover .ap__remove,
.ap__remove:focus-visible {
  opacity: 1;
}

.ap__remove:hover {
  background-color: var(--hover);
  color: var(--ink);
}

.ap__remove:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* The check steps left of the removal glyph so an active imported theme shows
   both: it is selected *and* it can go. */
.ap__card--imported .ap__check {
  right: 36px;
}

.ap__check {
  position: absolute;
  top: 50%;
  right: 12px;
  width: 13px;
  height: 13px;
  margin-top: -6.5px;
  color: var(--accent);
  animation: ap-check 260ms cubic-bezier(0.175, 0.885, 0.32, 1.275) backwards;
}

@keyframes ap-check {
  from {
    opacity: 0;
    transform: scale(0.6);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ap {
    animation: none;
  }
  .ap__frame,
  .ap__bead,
  .ap__card,
  .ap__check,
  .ap__notice,
  .ap__remove {
    transition: none;
    animation: none;
  }
  .ap__mode:hover .ap__frame {
    transform: none;
  }
}
</style>
