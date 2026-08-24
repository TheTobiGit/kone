<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type CSSProperties,
} from "vue";
import { onClickOutside } from "@vueuse/core";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  Cancel01Icon,
  CheckmarkCircle01Icon,
  Download01Icon,
  SparklesIcon,
  PaintBoardIcon,
} from "@hugeicons/core-free-icons";
import { useSound } from "~/composables/useSound";
import { useTheme } from "~/composables/useTheme";
import {
  buildTheme,
  extractThemeSpec,
  type SchemeSpec,
  type ThemeSpec,
} from "~/theme/build";
import {
  colorsFor,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeKind,
  type ThemeScheme,
} from "~/theme/roles";

const props = defineProps<{
  open: boolean;
  /** Existing theme to edit or duplicate. If omitted, starts a fresh theme. */
  theme?: ThemeDefinition | null;
  /** If true, edits the theme in-place under its existing id. */
  isEditing?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  saved: [theme: ThemeDefinition];
}>();

const { cue } = useSound();
const {
  theme: currentAppTheme,
  saveCustomTheme,
  updateCustomTheme,
  previewTheme,
  cancelPreview,
  exportThemeJson,
} = useTheme();

// ── Animation & Anchoring ───────────────────────────────────────────────────
const shown = ref(false);
const closing = ref(false);
const contentEl = ref<HTMLElement | null>(null);
const cardRef = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

const hostStyle = ref<CSSProperties>({});
let anchorEl: HTMLElement | null = null;
let anchorRO: ResizeObserver | null = null;

function anchorToDrawer() {
  const drawer = document.querySelector<HTMLElement>(".settings-scroll");
  if (drawer !== anchorEl) {
    anchorRO?.disconnect();
    anchorEl = drawer;
    if (drawer) {
      anchorRO = new ResizeObserver(anchorToDrawer);
      anchorRO.observe(drawer);
    }
  }
  if (!drawer) return;
  const rect = drawer.getBoundingClientRect();
  hostStyle.value = {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

function maxCardHeight(): number {
  const raw = hostStyle.value.height;
  if (typeof raw === "string" && raw.endsWith("px")) {
    const host = Number.parseFloat(raw);
    if (Number.isFinite(host)) return Math.max(160, host - 48);
  }
  const stage = cardRef.value instanceof HTMLElement ? cardRef.value.parentElement : null;
  if (stage) return stage.clientHeight;
  return Math.round(window.innerHeight * 0.84);
}

function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = Math.min(el.offsetHeight, maxCardHeight());
}

function onWindowResize() {
  syncHeight();
  anchorToDrawer();
}

const cardSpring = {
  type: "spring",
  stiffness: 320,
  damping: 24,
  mass: 0.9,
} as const;

const collapseMorph = {
  duration: 0.26,
  ease: [0.22, 1, 0.36, 1],
} as const;

// ── Form State ──────────────────────────────────────────────────────────────
const label = ref("My Custom Theme");
const blurb = ref("A personalized theme crafted in kone.");
const kind = ref<ThemeKind>("adaptive");
const fixedAppearance = ref<ThemeScheme>("dark");
const activeTab = ref<ThemeScheme>("dark");

// Scheme specs
const lightSpec = ref<SchemeSpec>({
  ground: "#f6f5f3",
  accent: "#d97757",
});

const darkSpec = ref<SchemeSpec>({
  ground: "#0f1115",
  accent: "#d97757",
});

const liveAppPreview = ref(false);

// ── Collapsible Sections ────────────────────────────────────────────────────
type Section = "identity" | "palette" | "tuning";
const openSection = ref<Section | null>(props.isEditing ? "palette" : "identity");

const HINTS = {
  identity: "Name, description, and appearance mode.",
  palette: "Ground canvas and primary accent voice.",
  tuning: "Hand-tune specific token overrides.",
} as const;

function focusOpenRow() {
  contentEl.value?.querySelector<HTMLElement>(".ca-row.is-open [data-autofocus]")?.focus();
}

function toggle(s: Section) {
  const opening = openSection.value !== s;
  openSection.value = opening ? s : null;
  cue(opening ? "expand" : "collapse");
  void nextTick(() => {
    syncHeight();
    if (opening) focusOpenRow();
  });
}

function copyActiveTheme() {
  const current = currentAppTheme.value;
  const spec = extractThemeSpec(current);
  label.value = props.isEditing ? current.label : `${current.label} (Custom)`;
  blurb.value = current.blurb;
  kind.value = spec.kind;
  if (spec.kind === "fixed") {
    fixedAppearance.value = spec.appearance;
    activeTab.value = spec.appearance;
    if (spec.appearance === "light") lightSpec.value = { ...spec.palette };
    else darkSpec.value = { ...spec.palette };
  } else {
    lightSpec.value = { ...spec.light };
    darkSpec.value = { ...spec.dark };
  }
  cue("success");
  void nextTick(() => syncHeight());
}

// ── Built Draft Definition ──────────────────────────────────────────────────
const draftSpec = computed<ThemeSpec>(() => {
  const id =
    props.isEditing && props.theme
      ? props.theme.id
      : `custom-${Date.now().toString(36)}`;
  if (kind.value === "fixed") {
    return {
      id,
      label: label.value.trim() || "Untitled Theme",
      blurb: blurb.value.trim() || "Custom theme",
      kind: "fixed",
      appearance: fixedAppearance.value,
      palette: fixedAppearance.value === "light" ? lightSpec.value : darkSpec.value,
    };
  }
  return {
    id,
    label: label.value.trim() || "Untitled Theme",
    blurb: blurb.value.trim() || "Custom theme",
    kind: "adaptive",
    light: lightSpec.value,
    dark: darkSpec.value,
  };
});

const draftTheme = computed<ThemeDefinition>(() => buildTheme(draftSpec.value));

const currentScheme = computed<ThemeScheme>(() => {
  if (kind.value === "fixed") return fixedAppearance.value;
  return activeTab.value;
});

const currentColors = computed<ThemeColors>(() =>
  colorsFor(draftTheme.value, currentScheme.value),
);

const activeSpec = computed<SchemeSpec>({
  get() {
    return currentScheme.value === "light" ? lightSpec.value : darkSpec.value;
  },
  set(val) {
    if (currentScheme.value === "light") lightSpec.value = val;
    else darkSpec.value = val;
  },
});

function normalizeHex(input: string): string {
  let s = input.trim();
  if (!s) return "";
  if (!s.startsWith("#")) s = "#" + s;
  return s;
}

function updateActiveSpecKey(key: keyof SchemeSpec, rawValue: string) {
  const value = normalizeHex(rawValue);
  const current = currentScheme.value === "light" ? { ...lightSpec.value } : { ...darkSpec.value };
  if (!value) {
    delete current[key];
  } else {
    // @ts-expect-error dynamic key assignment
    current[key] = value;
  }
  if (currentScheme.value === "light") lightSpec.value = current;
  else darkSpec.value = current;
}

// Reset all optional token overrides on the current scheme back to auto
function resetOverrides() {
  const current = currentScheme.value === "light" ? { ...lightSpec.value } : { ...darkSpec.value };
  const base = { ground: current.ground, accent: current.accent };
  if (currentScheme.value === "light") lightSpec.value = base;
  else darkSpec.value = base;
  cue("toggle");
  void nextTick(() => syncHeight());
}

// Check how many manual overrides exist on the active spec
const overrideCount = computed(() => {
  const spec = activeSpec.value;
  let count = 0;
  if (spec.accentSecondary) count++;
  if (spec.highlight) count++;
  if (spec.accentInk) count++;
  if (spec.raised) count++;
  if (spec.strip) count++;
  if (spec.ink) count++;
  if (spec.folder) count++;
  if (spec.codeBg) count++;
  return count;
});

// Bead Wash Gradient for the Hero Preview
const heroWash = computed(() => {
  const c = currentColors.value;
  const s = currentScheme.value;
  const accentAt = s === "dark" ? "30% 76%" : "70% 24%";
  const secondAt = s === "dark" ? "80% 20%" : "20% 80%";
  return [
    `radial-gradient(circle at ${accentAt} in oklab, ${c.accent} 0%, color-mix(in oklab, ${c.accent} 62%, transparent) 30%, transparent 62%)`,
    `radial-gradient(circle at ${secondAt} in oklab, color-mix(in oklab, ${c.accentSecondary} 42%, transparent) 0%, transparent 58%)`,
  ].join(", ");
});

// Row summaries when closed
const summaries = computed(() => ({
  identity: `${label.value || "Untitled"} · ${kind.value === "adaptive" ? "Adaptive" : fixedAppearance.value === "dark" ? "Fixed Dark" : "Fixed Light"}`,
  palette: `${activeSpec.value.ground} · ${activeSpec.value.accent}`,
  tuning: overrideCount.value > 0
    ? `${overrideCount.value} manual override${overrideCount.value === 1 ? "" : "s"}`
    : "All 47 roles auto-derived",
}));

watch(
  [draftTheme, currentScheme, liveAppPreview],
  ([theme, s, live]) => {
    if (live) {
      previewTheme(theme, s);
    } else {
      cancelPreview();
    }
  },
  { immediate: true },
);

// ── Lifecycle & Close ───────────────────────────────────────────────────────
function closeWithTransition(done: () => void) {
  if (closing.value) return;
  closing.value = true;
  shown.value = false;
  cancelPreview();
  window.setTimeout(done, 240);
}

function cancel() {
  if (closing.value) return;
  closeWithTransition(() => emit("close"));
}

onClickOutside(cardRef, () => {
  if (props.open) cancel();
});

const canSubmit = computed(() => !!label.value.trim());

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    cancel();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    if (canSubmit.value) {
      e.preventDefault();
      save();
    }
    return;
  }
  if (e.key === "Enter") {
    if (document.activeElement instanceof HTMLButtonElement) return;
    if (!canSubmit.value) return;
    e.preventDefault();
    save();
    return;
  }
  if (e.key === "Tab") {
    const root = contentEl.value;
    if (!root) return;
    const els = Array.from(
      root.querySelectorAll<HTMLElement>(
        'input, button:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = els[0];
    const last = els[els.length - 1];
    if (!first || !last) return;
    const active = document.activeElement as HTMLElement | null;
    const inTrap = active != null && els.includes(active);
    const atEdge = e.shiftKey ? active === first : active === last;
    if (atEdge || !inTrap) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }
}

let opener: HTMLElement | null = null;

onMounted(async () => {
  if (props.theme) {
    const spec = extractThemeSpec(props.theme);
    label.value = props.isEditing ? props.theme.label : `${props.theme.label} (Copy)`;
    blurb.value = props.theme.blurb;
    kind.value = spec.kind;
    if (spec.kind === "fixed") {
      fixedAppearance.value = spec.appearance;
      activeTab.value = spec.appearance;
      if (spec.appearance === "light") lightSpec.value = { ...spec.palette };
      else darkSpec.value = { ...spec.palette };
    } else {
      lightSpec.value = { ...spec.light };
      darkSpec.value = { ...spec.dark };
    }
  }

  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onWindowResize);
  await nextTick();
  anchorToDrawer();
  syncHeight();
  ro = new ResizeObserver(syncHeight);
  if (contentEl.value) ro.observe(contentEl.value);
  focusOpenRow();
  requestAnimationFrame(() => {
    shown.value = true;
  });
});

onBeforeUnmount(() => {
  cancelPreview();
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onWindowResize);
  ro?.disconnect();
  anchorRO?.disconnect();
  opener?.focus();
});

// ── Saving & Export ─────────────────────────────────────────────────────────
const errorMessage = ref<string | null>(null);

function save() {
  if (!label.value.trim()) {
    errorMessage.value = "Please name your theme.";
    cue("error");
    return;
  }
  try {
    let saved: ThemeDefinition;
    if (props.isEditing && props.theme) {
      saved = updateCustomTheme(props.theme.id, draftSpec.value);
    } else {
      saved = saveCustomTheme(draftSpec.value);
    }
    cancelPreview();
    cue("success");
    closeWithTransition(() => {
      emit("saved", saved);
      emit("close");
    });
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : "Failed to save theme.";
    cue("error");
  }
}

function handleExport() {
  const jsonStr = exportThemeJson(draftTheme.value);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${label.value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "custom-theme"}.json`;
  a.click();
  URL.revokeObjectURL(url);
  cue("success");
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="pointer-events-none fixed inset-0 z-50" :style="hostStyle">
      <!-- Scrim over sidebar drawer -->
      <motion.div
        class="ca-scrim pointer-events-auto absolute inset-0"
        :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
        :animate="{
          opacity: shown ? 1 : 0,
          backdropFilter: shown ? 'blur(4px)' : 'blur(0px)',
        }"
        :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
        @click="cancel"
      />

      <div class="pointer-events-none absolute inset-0 flex items-end justify-end p-6">
        <motion.div
          ref="cardRef"
          class="ca-card pointer-events-auto relative z-20 flex w-full max-w-lg flex-col overflow-hidden"
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
          :aria-label="isEditing ? 'Edit theme' : 'New theme'"
        >
          <div ref="contentEl" class="flex shrink-0 flex-col">
            <!-- Header band with concave-scooped corners -->
            <div class="ca-band ca-header">
              <span class="ca-eyebrow">{{ isEditing ? "Edit theme" : "New theme" }}</span>
              <div class="flex items-center gap-3">
                <button type="button" class="tem__hdr-action text-muted" title="Copy from active theme" @click="copyActiveTheme">
                  <HugeiconsIcon :icon="SparklesIcon" :size="12" :stroke-width="1.8" aria-hidden="true" />
                  <span>Copy active</span>
                </button>
                <button type="button" class="tem__hdr-action text-muted" title="Export as JSON" @click="handleExport">
                  <HugeiconsIcon :icon="Download01Icon" :size="12" :stroke-width="1.8" aria-hidden="true" />
                  <span>Export</span>
                </button>
                <button type="button" class="ca-close" aria-label="Close (Esc)" title="Close (Esc)" @click="cancel">
                  <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" />
                </button>
              </div>
            </div>

            <!-- Hero Live Swatch & Palette Strip Card -->
            <div
              class="tem__hero"
              :style="{
                backgroundColor: currentColors.ground,
                borderColor: currentColors.lineSoft,
              }"
              @click="kind === 'adaptive' && (activeTab = activeTab === 'light' ? 'dark' : 'light', cue('toggle'))"
            >
              <div class="tem__hero-main">
                <!-- Glowing Bead Swatch -->
                <span
                  class="tem__hero-bead"
                  :style="{
                    backgroundColor: currentColors.ground,
                    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${currentColors.ink} 14%, transparent)`,
                  }"
                  aria-hidden="true"
                >
                  <span class="tem__hero-wash" :style="{ backgroundImage: heroWash }" />
                </span>

                <div class="tem__hero-meta">
                  <span class="tem__hero-title" :style="{ color: currentColors.ink }">
                    {{ label || "Untitled Theme" }}
                  </span>
                  <div class="tem__hero-sub">
                    <span class="tem__hero-desc" :style="{ color: currentColors.muted }">
                      {{ blurb || "Custom theme" }}
                    </span>
                    <!-- 5-Color Harmonic Swatch Dots -->
                    <div class="tem__swatch-dots" aria-hidden="true">
                      <span class="tem__swatch-dot" :style="{ backgroundColor: currentColors.ground, boxShadow: `inset 0 0 0 1px ${currentColors.lineSoft}` }" title="Ground" />
                      <span class="tem__swatch-dot" :style="{ backgroundColor: currentColors.accent }" title="Accent" />
                      <span class="tem__swatch-dot" :style="{ backgroundColor: currentColors.accentSecondary }" title="Secondary" />
                      <span class="tem__swatch-dot" :style="{ backgroundColor: currentColors.raised, boxShadow: `inset 0 0 0 1px ${currentColors.lineSoft}` }" title="Surface" />
                      <span class="tem__swatch-dot" :style="{ backgroundColor: currentColors.ink }" title="Ink" />
                    </div>
                  </div>
                </div>
              </div>

              <!-- Scheme quick toggle when adaptive -->
              <div
                v-if="kind === 'adaptive'"
                class="tem__hero-scheme-toggle"
                :style="{
                  backgroundColor: currentColors.sunken,
                  boxShadow: `inset 0 0 0 1px ${currentColors.lineSoft}`,
                }"
                @click.stop
              >
                <button
                  type="button"
                  class="tem__scheme-pill"
                  :class="{ 'is-active': activeTab === 'light' }"
                  :style="{
                    backgroundColor: activeTab === 'light' ? currentColors.raised : 'transparent',
                    color: activeTab === 'light' ? currentColors.ink : currentColors.muted,
                    boxShadow: activeTab === 'light' ? `0 1px 3px color-mix(in srgb, ${currentColors.ink} 12%, transparent)` : 'none',
                  }"
                  @click="activeTab = 'light'; cue('toggle')"
                >
                  Light
                </button>
                <button
                  type="button"
                  class="tem__scheme-pill"
                  :class="{ 'is-active': activeTab === 'dark' }"
                  :style="{
                    backgroundColor: activeTab === 'dark' ? currentColors.raised : 'transparent',
                    color: activeTab === 'dark' ? currentColors.ink : currentColors.muted,
                    boxShadow: activeTab === 'dark' ? `0 1px 3px color-mix(in srgb, ${currentColors.ink} 12%, transparent)` : 'none',
                  }"
                  @click="activeTab = 'dark'; cue('toggle')"
                >
                  Dark
                </button>
              </div>
            </div>

            <!-- Error Banner if any -->
            <div v-if="errorMessage" class="tem__error-bar" role="alert">
              <HugeiconsIcon :icon="AlertCircleIcon" :size="13" />
              <span>{{ errorMessage }}</span>
            </div>

            <!-- Stacked Collapsible Rows (Kone Signature Pattern) -->
            <div class="ca-rows">
              <!-- ── ROW 1: Identity & Mode ─────────────────────────── -->
              <section class="ca-row" :class="{ 'is-open': openSection === 'identity' }">
                <button
                  type="button"
                  class="ca-row-head"
                  :aria-expanded="openSection === 'identity'"
                  @click="toggle('identity')"
                >
                  <span class="ca-row-label">Identity</span>
                  <span class="ca-row-value">
                    {{ openSection === 'identity' ? HINTS.identity : summaries.identity }}
                  </span>
                  <span class="ca-chevron" aria-hidden="true">
                    <HugeiconsIcon :icon="ArrowDown01Icon" :size="14" :stroke-width="2" />
                  </span>
                </button>

                <AnimatePresence :initial="false">
                  <motion.div
                    v-if="openSection === 'identity'"
                    key="identity-body"
                    class="ca-row-body"
                    :initial="{ opacity: 0, height: 0 }"
                    :animate="{ opacity: 1, height: 'auto' }"
                    :exit="{ opacity: 0, height: 0 }"
                    :transition="collapseMorph"
                  >
                    <div class="tem__pane tem__pane--gap">
                      <div class="tem__fields-row">
                        <label class="ca-field flex-1">
                          <input
                            v-model="label"
                            data-autofocus
                            type="text"
                            class="ca-input"
                            placeholder="Name — Nordic Moss, Amber Gold…"
                            maxlength="40"
                            autocomplete="off"
                            spellcheck="false"
                            aria-label="Theme name"
                          />
                        </label>
                        <label class="ca-field flex-1">
                          <input
                            v-model="blurb"
                            type="text"
                            class="ca-input"
                            placeholder="One-line description…"
                            maxlength="80"
                            autocomplete="off"
                            spellcheck="false"
                            aria-label="Theme description"
                          />
                        </label>
                      </div>

                      <div class="tem__segmented" role="radiogroup" aria-label="Theme Kind">
                        <button
                          type="button"
                          role="radio"
                          class="tem__seg-btn"
                          :class="{ 'is-active': kind === 'adaptive' }"
                          :aria-checked="kind === 'adaptive'"
                          @click="kind = 'adaptive'; cue('toggle'); nextTick(() => syncHeight())"
                        >
                          Adaptive (Light + Dark)
                        </button>
                        <button
                          type="button"
                          role="radio"
                          class="tem__seg-btn"
                          :class="{ 'is-active': kind === 'fixed' && fixedAppearance === 'dark' }"
                          :aria-checked="kind === 'fixed' && fixedAppearance === 'dark'"
                          @click="kind = 'fixed'; fixedAppearance = 'dark'; activeTab = 'dark'; cue('toggle'); nextTick(() => syncHeight())"
                        >
                          Fixed Dark
                        </button>
                        <button
                          type="button"
                          role="radio"
                          class="tem__seg-btn"
                          :class="{ 'is-active': kind === 'fixed' && fixedAppearance === 'light' }"
                          :aria-checked="kind === 'fixed' && fixedAppearance === 'light'"
                          @click="kind = 'fixed'; fixedAppearance = 'light'; activeTab = 'light'; cue('toggle'); nextTick(() => syncHeight())"
                        >
                          Fixed Light
                        </button>
                      </div>
                    </div>
                  </motion.div>
                </AnimatePresence>
              </section>

              <!-- ── ROW 2: Palette & Colors ────────────────────────── -->
              <section class="ca-row" :class="{ 'is-open': openSection === 'palette' }">
                <button
                  type="button"
                  class="ca-row-head"
                  :aria-expanded="openSection === 'palette'"
                  @click="toggle('palette')"
                >
                  <span class="ca-row-label">Palette & Colors</span>
                  <span class="ca-row-value">
                    {{ openSection === 'palette' ? HINTS.palette : summaries.palette }}
                  </span>
                  <span class="ca-chevron" aria-hidden="true">
                    <HugeiconsIcon :icon="ArrowDown01Icon" :size="14" :stroke-width="2" />
                  </span>
                </button>

                <AnimatePresence :initial="false">
                  <motion.div
                    v-if="openSection === 'palette'"
                    key="palette-body"
                    class="ca-row-body"
                    :initial="{ opacity: 0, height: 0 }"
                    :animate="{ opacity: 1, height: 'auto' }"
                    :exit="{ opacity: 0, height: 0 }"
                    :transition="collapseMorph"
                  >
                    <div class="tem__pane">
                      <!-- The Two Core Dials: Ground & Accent -->
                      <div class="tem__dials-grid">
                        <div class="tem__dial-card">
                          <div class="tem__dial-meta">
                            <span class="tem__dial-label">Ground Canvas</span>
                            <span class="tem__dial-sub">The page background</span>
                          </div>
                          <div class="tem__dial-input-wrap">
                            <input
                              v-model="activeSpec.ground"
                              type="color"
                              class="tem__color-native"
                              aria-label="Ground color"
                            />
                            <input
                              v-model="activeSpec.ground"
                              type="text"
                              class="tem__dial-hex"
                              placeholder="#000000"
                              maxlength="9"
                              spellcheck="false"
                            />
                          </div>
                        </div>

                        <div class="tem__dial-card">
                          <div class="tem__dial-meta">
                            <span class="tem__dial-label">Accent Voice</span>
                            <span class="tem__dial-sub">Primary brand focus</span>
                          </div>
                          <div class="tem__dial-input-wrap">
                            <input
                              v-model="activeSpec.accent"
                              type="color"
                              class="tem__color-native"
                              aria-label="Accent color"
                            />
                            <input
                              v-model="activeSpec.accent"
                              type="text"
                              class="tem__dial-hex"
                              placeholder="#d97757"
                              maxlength="9"
                              spellcheck="false"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                </AnimatePresence>
              </section>

              <!-- ── ROW 3: Fine-Tuning (Optional) ──────────────────── -->
              <section class="ca-row" :class="{ 'is-open': openSection === 'tuning' }">
                <button
                  type="button"
                  class="ca-row-head"
                  :aria-expanded="openSection === 'tuning'"
                  @click="toggle('tuning')"
                >
                  <span class="ca-row-label">Fine-Tuning</span>
                  <span class="ca-row-value">
                    {{ openSection === 'tuning' ? HINTS.tuning : summaries.tuning }}
                  </span>
                  <span class="ca-chevron" aria-hidden="true">
                    <HugeiconsIcon :icon="ArrowDown01Icon" :size="14" :stroke-width="2" />
                  </span>
                </button>

                <AnimatePresence :initial="false">
                  <motion.div
                    v-if="openSection === 'tuning'"
                    key="tuning-body"
                    class="ca-row-body"
                    :initial="{ opacity: 0, height: 0 }"
                    :animate="{ opacity: 1, height: 'auto' }"
                    :exit="{ opacity: 0, height: 0 }"
                    :transition="collapseMorph"
                  >
                    <div class="tem__pane">
                      <!-- Reset button if overrides exist -->
                      <div v-if="overrideCount > 0" class="tem__tuning-bar">
                        <span class="tem__tuning-note">{{ overrideCount }} manual override{{ overrideCount === 1 ? '' : 's' }} active</span>
                        <button type="button" class="tem__reset-btn" @click="resetOverrides">
                          Reset all to auto
                        </button>
                      </div>

                      <div class="tem__pane--tuning">
                        <div class="tem__tuning-item">
                          <span class="tem__tuning-label">Second Voice</span>
                          <div class="tem__dial-input-wrap">
                            <input
                              :value="activeSpec.accentSecondary || currentColors.accentSecondary"
                              type="color"
                              class="tem__color-native"
                              aria-label="Second voice color"
                              @input="updateActiveSpecKey('accentSecondary', ($event.target as HTMLInputElement).value)"
                            />
                            <input
                              :value="activeSpec.accentSecondary || ''"
                              type="text"
                              class="tem__dial-hex"
                              placeholder="Auto"
                              spellcheck="false"
                              @input="updateActiveSpecKey('accentSecondary', ($event.target as HTMLInputElement).value)"
                            />
                          </div>
                        </div>

                        <div class="tem__tuning-item">
                          <span class="tem__tuning-label">Highlight Mark</span>
                          <div class="tem__dial-input-wrap">
                            <input
                              :value="activeSpec.highlight || currentColors.highlight"
                              type="color"
                              class="tem__color-native"
                              aria-label="Highlight mark color"
                              @input="updateActiveSpecKey('highlight', ($event.target as HTMLInputElement).value)"
                            />
                            <input
                              :value="activeSpec.highlight || ''"
                              type="text"
                              class="tem__dial-hex"
                              placeholder="Auto"
                              spellcheck="false"
                              @input="updateActiveSpecKey('highlight', ($event.target as HTMLInputElement).value)"
                            />
                          </div>
                        </div>

                        <div class="tem__tuning-item">
                          <span class="tem__tuning-label">Raised Surface</span>
                          <div class="tem__dial-input-wrap">
                            <input
                              :value="activeSpec.raised || currentColors.raised"
                              type="color"
                              class="tem__color-native"
                              aria-label="Raised surface color"
                              @input="updateActiveSpecKey('raised', ($event.target as HTMLInputElement).value)"
                            />
                            <input
                              :value="activeSpec.raised || ''"
                              type="text"
                              class="tem__dial-hex"
                              placeholder="Auto"
                              spellcheck="false"
                              @input="updateActiveSpecKey('raised', ($event.target as HTMLInputElement).value)"
                            />
                          </div>
                        </div>

                        <div class="tem__tuning-item">
                          <span class="tem__tuning-label">Sidebar Strip</span>
                          <div class="tem__dial-input-wrap">
                            <input
                              :value="activeSpec.strip || currentColors.strip"
                              type="color"
                              class="tem__color-native"
                              aria-label="Sidebar strip color"
                              @input="updateActiveSpecKey('strip', ($event.target as HTMLInputElement).value)"
                            />
                            <input
                              :value="activeSpec.strip || ''"
                              type="text"
                              class="tem__dial-hex"
                              placeholder="Auto"
                              spellcheck="false"
                              @input="updateActiveSpecKey('strip', ($event.target as HTMLInputElement).value)"
                            />
                          </div>
                        </div>

                        <div class="tem__tuning-item">
                          <span class="tem__tuning-label">Primary Ink</span>
                          <div class="tem__dial-input-wrap">
                            <input
                              :value="activeSpec.ink || currentColors.ink"
                              type="color"
                              class="tem__color-native"
                              aria-label="Primary ink color"
                              @input="updateActiveSpecKey('ink', ($event.target as HTMLInputElement).value)"
                            />
                            <input
                              :value="activeSpec.ink || ''"
                              type="text"
                              class="tem__dial-hex"
                              placeholder="Auto"
                              spellcheck="false"
                              @input="updateActiveSpecKey('ink', ($event.target as HTMLInputElement).value)"
                            />
                          </div>
                        </div>

                        <div class="tem__tuning-item">
                          <span class="tem__tuning-label">Folder Mark</span>
                          <div class="tem__dial-input-wrap">
                            <input
                              :value="activeSpec.folder || currentColors.folder"
                              type="color"
                              class="tem__color-native"
                              aria-label="Folder mark color"
                              @input="updateActiveSpecKey('folder', ($event.target as HTMLInputElement).value)"
                            />
                            <input
                              :value="activeSpec.folder || ''"
                              type="text"
                              class="tem__dial-hex"
                              placeholder="Auto"
                              spellcheck="false"
                              @input="updateActiveSpecKey('folder', ($event.target as HTMLInputElement).value)"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                </AnimatePresence>
              </section>
            </div>

            <!-- Footer Band with concave-scooped corners -->
            <div class="ca-band ca-footer">
              <label class="tem__live-preview-box">
                <input v-model="liveAppPreview" type="checkbox" />
                <span>Live preview</span>
              </label>

              <div class="flex items-center gap-4">
                <button type="button" class="ca-action text-muted" @click="cancel">
                  Cancel
                </button>
                <button
                  type="button"
                  class="ca-action ca-forward text-ink"
                  :disabled="!canSubmit"
                  @click="save"
                >
                  {{ isEditing ? "Save changes" : "Create theme" }}
                  <span class="ca-forward-arrow" aria-hidden="true">→</span>
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ca-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}

.ca-card {
  background: var(--panel);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  max-height: 100%;
}

/* ── Bands ────────────────────────────────────────────────────────────────── */
.ca-band {
  --band-bg: var(--band);
  --band-arc: 14px;
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}

.ca-band::before,
.ca-band::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}

.ca-header::before,
.ca-header::after {
  top: 100%;
}

.ca-header::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}

.ca-header::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}

.ca-footer::before,
.ca-footer::after {
  bottom: 100%;
}

.ca-footer::before {
  left: 0;
  background: radial-gradient(circle at top right, transparent var(--band-arc), var(--band-bg) 0);
}

.ca-footer::after {
  right: 0;
  background: radial-gradient(circle at top left, transparent var(--band-arc), var(--band-bg) 0);
}

/* ── Header ───────────────────────────────────────────────────────────────── */
.ca-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ca-eyebrow {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--muted);
}

.tem__hdr-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  padding: 0;
  background: transparent;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.14s ease, opacity 0.14s ease;
}

.tem__hdr-action:hover {
  color: var(--ink);
  opacity: 0.9;
}

.ca-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.14s ease, color 0.14s ease;
}

.ca-close:hover {
  background: var(--hover);
  color: var(--ink);
}

/* ── Hero Swatch Card ─────────────────────────────────────────────────────── */
.tem__hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  margin: 8px 10px 0;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  cursor: pointer;
  transition: background-color 200ms ease, transform 140ms ease;
}

.tem__hero:hover {
  transform: translateY(-1px);
}

.tem__hero-main {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.tem__hero-bead {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
}

.tem__hero-wash {
  position: absolute;
  inset: -12%;
  border-radius: 50%;
  filter: blur(3.5px);
}

.tem__hero-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 3px;
}

.tem__hero-title {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tem__hero-sub {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tem__hero-desc {
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tem__swatch-dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.tem__swatch-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tem__hero-scheme-toggle {
  display: flex;
  padding: 2px;
  border-radius: 7px;
  gap: 2px;
}

.tem__scheme-pill {
  height: 22px;
  padding-inline: 8px;
  border: none;
  background: transparent;
  font-size: 11px;
  font-weight: 500;
  border-radius: 5px;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}

/* ── Error Bar ────────────────────────────────────────────────────────────── */
.tem__error-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 10px 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
  font-size: 11.5px;
}

/* ── Rows ─────────────────────────────────────────────────────────────────── */
.ca-rows {
  display: flex;
  flex-direction: column;
  padding: 0.5rem 0.5rem 0.35rem;
  gap: 2px;
}

.ca-row {
  border-radius: 12px;
  transition: background-color 0.24s ease;
}

.ca-row.is-open {
  background: color-mix(in srgb, var(--ink) 3.5%, transparent);
}

.ca-row-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  border: 0;
  border-radius: 12px;
  padding: 0.6rem 0.6rem 0.6rem 0.65rem;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.ca-row:not(.is-open) .ca-row-head:hover {
  background: color-mix(in srgb, var(--ink) 4%, transparent);
}

.ca-row-label {
  flex: none;
  color: var(--ink);
  font-size: 13.5px;
  letter-spacing: -0.01em;
}

.ca-row-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  letter-spacing: -0.005em;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.9;
  transition: opacity 0.2s ease;
}

.ca-row.is-open .ca-row-value {
  opacity: 0.7;
}

.ca-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 18px;
  color: var(--muted);
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

.ca-row.is-open .ca-chevron {
  transform: rotate(180deg);
}

.ca-row-body {
  overflow: hidden;
}

.tem__pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0.15rem 0.75rem 0.75rem;
}

.tem__pane--gap {
  gap: 8px;
}

.tem__pane--tuning {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.tem__tuning-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 2px;
}

.tem__tuning-note {
  font-size: 10.5px;
  color: var(--muted);
}

.tem__reset-btn {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  padding: 0;
  transition: opacity 120ms ease;
}

.tem__reset-btn:hover {
  opacity: 0.8;
}

/* ── Dials Grid (Ground & Accent) ─────────────────────────────────────────── */
.tem__dials-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.tem__dial-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: var(--raised);
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--ink) 5%, transparent);
}

.tem__dial-meta {
  display: flex;
  flex-direction: column;
}

.tem__dial-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
}

.tem__dial-sub {
  font-size: 10px;
  color: var(--muted);
}

.tem__dial-input-wrap {
  display: flex;
  align-items: center;
  gap: 5px;
}

.tem__color-native {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
  background: transparent;
  outline: none;
}

.tem__dial-hex {
  width: 68px;
  height: 22px;
  padding-inline: 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11.5px;
  outline: none;
}

/* ── Identity Form ────────────────────────────────────────────────────────── */
.tem__fields-row {
  display: flex;
  gap: 12px;
  padding: 0.2rem 0.25rem 0.1rem;
}

.ca-field {
  display: flex;
  align-items: center;
}

.ca-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  letter-spacing: -0.01em;
  outline: none;
}

.ca-input::placeholder {
  color: var(--muted);
}

.ca-input::selection {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}

.tem__segmented {
  display: flex;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  padding: 2px;
  border-radius: 7px;
  gap: 2px;
}

.tem__seg-btn {
  flex: 1;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-weight: 500;
  border-radius: 5px;
  cursor: pointer;
  transition: all 120ms ease;
}

.tem__seg-btn.is-active {
  background: var(--raised);
  color: var(--ink);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

/* ── Fine-Tuning Overrides ────────────────────────────────────────────────── */
.tem__tuning-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 8px;
  background: var(--raised);
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, var(--ink) 4%, transparent);
}

.tem__tuning-label {
  font-size: 11px;
  color: var(--ink-soft);
}

/* ── Footer ───────────────────────────────────────────────────────────────── */
.ca-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.ca-action {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}

.ca-action:hover:not(:disabled) {
  opacity: 0.7;
}

.ca-action:disabled {
  cursor: default;
  opacity: 0.4;
}

.ca-forward-arrow {
  color: var(--accent);
  font-weight: 500;
  transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.ca-forward:not(:disabled):hover .ca-forward-arrow {
  transform: translateX(3px);
}

.tem__live-preview-box {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--muted);
  cursor: pointer;
}

.tem__live-preview-box input {
  cursor: pointer;
  accent-color: var(--accent);
}

@media (prefers-reduced-motion: reduce) {
  .ca-card,
  .ca-row,
  .ca-chevron,
  .tem__hero,
  .ca-action {
    transition: none !important;
  }
}
</style>
