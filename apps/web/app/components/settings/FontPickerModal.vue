<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from "vue";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { useModalExit } from "~/composables/useModalExit";
import {
  curatedOptions,
  isMonospaceFamily,
  queryInstalledFontFamilies,
  stackFor,
  type FontKind,
  type FontOption,
} from "~/theme/fonts";

// The font picker: a search over the curated shelf plus everything installed
// on the machine, in the browsers' shell — bottom-right card, recessed band
// header and footer with the arc scoops flowing into the card walls, and the
// list riding between them. Every row wears its own face, so the list
// demonstrates rather than describes: the name *is* the preview.
//
// The mono kind only lists monospace families: cell-grid surfaces need every
// glyph on the same advance, and a proportional pick would strand the cursor.

const props = defineProps<{
  kind: FontKind;
  /** The stored value ("": default). */
  current: string;
  open: boolean;
}>();

const emit = defineEmits<{
  pick: [value: string];
  close: [];
}>();

const KIND_TITLE = {
  sans: "Interface typeface",
  serif: "Wordmark typeface",
  mono: "Code typeface",
  composer: "Composer typeface",
} satisfies Record<FontKind, string>;

const { shown, close } = useModalExit();
function cancel() {
  close(() => emit("close"));
}
function choose(value: string) {
  if (value !== props.current) emit("pick", value);
  cancel();
}

// ── host anchoring ──────────────────────────────────────────────────────────
// Same arrangement as the theme browser: the shell belongs to the drawer, with
// the viewport as the fallback when the drawer isn't measured.
const hostStyle = ref<CSSProperties>({});
function anchorToDrawer() {
  if (!("document" in globalThis)) return;
  const drawer = document.querySelector<HTMLElement>(".settings-scroll");
  if (!drawer) return;
  const rect = drawer.getBoundingClientRect();
  hostStyle.value = {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

// ── options ─────────────────────────────────────────────────────────────────
const suggested = computed<FontOption[]>(() => curatedOptions(props.kind));

interface InstalledState {
  families: string[];
  status: "loading" | "granted" | "denied" | "unsupported";
}
const installed = ref<InstalledState>({ families: [], status: "loading" });
const monospaceOnly = computed(() => props.kind === "mono");

async function loadInstalled() {
  installed.value = { families: [], status: "loading" };
  const state = await queryInstalledFontFamilies();
  if (state.status !== "granted") {
    installed.value = { families: [], status: state.status };
    return;
  }
  const families = monospaceOnly.value
    ? state.families.filter((family) => isMonospaceFamily(family))
    : state.families;
  installed.value = { families, status: "granted" };
}

const query = ref("");
const searchEl = ref<HTMLInputElement | null>(null);

function matches(name: string): boolean {
  const q = query.value.trim().toLowerCase();
  return q.length === 0 || name.toLowerCase().includes(q);
}

/** Esc in the search clears the query first and only leaves when empty. */
function onEsc() {
  if (query.value) query.value = "";
  else cancel();
}

const shownSuggested = computed(() => suggested.value.filter((o) => matches(o.label)));
const shownInstalled = computed(() =>
  installed.value.families
    .filter((family) => matches(family))
    .map((family) => ({
      id: family,
      label: family,
      stack: stackFor(props.kind, family),
    })),
);

/** A stored value from elsewhere (an agent steer, an older build) still gets
 *  a row, so the current pick is always visible and replaceable. */
const currentExtra = computed<FontOption | null>(() => {
  const value = props.current.trim();
  if (!value) return null;
  const known =
    suggested.value.some((o) => o.id === value) ||
    installed.value.families.includes(value);
  if (known) return null;
  return { id: value, label: value, stack: stackFor(props.kind, value) };
});

const empty = computed(
  () =>
    shownSuggested.value.length === 0 &&
    shownInstalled.value.length === 0 &&
    !currentExtra.value,
);

const footNote = computed(() => {
  if (installed.value.status === "denied") return "Installed fonts are hidden.";
  if (installed.value.status === "granted") return "Installed fonts stay on this machine.";
  return "Suggested faces ship with the app.";
});

let opener: HTMLElement | null = null;
function onWindowResize() {
  anchorToDrawer();
}

onMounted(() => {
  if (!("document" in globalThis)) return;
  // SAFETY: activeElement is null when nothing holds focus, otherwise the
  // focused element — opener restores exactly that on close.
  opener = document.activeElement as HTMLElement | null;
  anchorToDrawer();
  window.addEventListener("resize", onWindowResize);
  void loadInstalled();
  void nextTick(() => {
    requestAnimationFrame(() => {
      shown.value = true;
      searchEl.value?.focus();
    });
  });
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", onWindowResize);
  opener?.focus();
});
watch(
  () => props.kind,
  () => {
    query.value = "";
    void loadInstalled();
  },
);

const cardSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;
</script>

<template>
  <div
    class="pointer-events-none fixed inset-0 z-50"
    :style="hostStyle"
    @keydown.esc.stop.prevent="onEsc"
  >
    <motion.div
      class="fp-scrim pointer-events-auto absolute inset-0"
      :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
      :animate="{ opacity: shown ? 1 : 0, backdropFilter: shown ? 'blur(4px)' : 'blur(0px)' }"
      :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
      @click="cancel"
    />

    <div class="pointer-events-none absolute inset-0 flex items-end justify-end overflow-hidden p-6">
      <motion.div
        class="fp-card pointer-events-auto relative z-20 flex w-full max-w-md flex-col overflow-hidden"
        :initial="{ opacity: 0, y: 12, scale: 0.96 }"
        :animate="{ opacity: shown ? 1 : 0, y: shown ? 0 : 12, scale: shown ? 1 : 0.96 }"
        :transition="cardSpring"
        role="dialog"
        aria-modal="true"
        :aria-label="KIND_TITLE[kind]"
      >
        <div class="fp-body">
          <!-- Recessed header band with the arc scoops flowing into the card
               walls — the shared modal shell signature. -->
          <div class="fp-header">
            <span class="fp-band-title">{{ KIND_TITLE[kind] }}</span>
            <button type="button" class="fp-action" :tabindex="open ? 0 : -1" @click="cancel">
              Cancel
            </button>
          </div>

          <div class="fp-search">
            <HugeiconsIcon
              :icon="Search01Icon"
              :size="14"
              :stroke-width="1.8"
              class="fp-search__icon"
              aria-hidden="true"
            />
            <input
              ref="searchEl"
              v-model="query"
              class="fp-search__input"
              type="text"
              placeholder="Search typefaces…"
              aria-label="Search typefaces"
              spellcheck="false"
              autocomplete="off"
            />
            <button
              v-if="query"
              type="button"
              class="fp-search__clear"
              aria-label="Clear search"
              title="Clear search"
              :tabindex="open ? 0 : -1"
              @click.stop="query = ''"
            >
              <HugeiconsIcon :icon="Cancel01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
            </button>
          </div>

          <div class="fp-scroll" role="listbox" :aria-label="KIND_TITLE[kind]">
            <div v-if="installed.status === 'loading'" class="fp-shelf" role="status" aria-label="Loading typefaces">
              <div v-for="n in 6" :key="n" class="fp-skel-row" :style="{ '--i': n - 1 }">
                <span class="fp-skel-name fp-shimmer" :style="{ width: `${42 + ((n * 17) % 28)}%` }" />
              </div>
            </div>
            <div v-else class="fp-shelf">
              <button
                v-if="currentExtra"
                type="button"
                role="option"
                :aria-selected="true"
                class="fp-row fp-row--on"
                :tabindex="open ? 0 : -1"
                @click="choose(currentExtra.id)"
              >
                <span class="fp-meta">
                  <span class="fp-name" :style="{ fontFamily: currentExtra.stack }">{{ currentExtra.label }}</span>
                </span>
                <span class="fp-tag">Current</span>
              </button>

              <p v-if="shownSuggested.length" class="fp-section">Suggested</p>
              <button
                v-for="(o, i) in shownSuggested"
                :key="o.id || 'default'"
                type="button"
                role="option"
                :aria-selected="o.id === current"
                class="fp-row"
                :class="{ 'fp-row--on': o.id === current }"
                :style="{ '--i': Math.min(i, 11) }"
                :tabindex="open ? 0 : -1"
                @click="choose(o.id)"
              >
                <span class="fp-meta">
                  <span class="fp-name" :style="{ fontFamily: o.stack }">{{ o.label }}</span>
                </span>
                <span v-if="o.id === current" class="fp-tag">Current</span>
              </button>

              <template v-if="installed.status === 'granted' && shownInstalled.length">
                <p class="fp-section">On this Mac</p>
                <button
                  v-for="(o, i) in shownInstalled"
                  :key="o.id"
                  type="button"
                  role="option"
                  :aria-selected="o.id === current"
                  class="fp-row"
                  :class="{ 'fp-row--on': o.id === current }"
                  :style="{ '--i': Math.min(i, 11) }"
                  :tabindex="open ? 0 : -1"
                  @click="choose(o.id)"
                >
                  <span class="fp-meta">
                    <span class="fp-name" :style="{ fontFamily: o.stack }">{{ o.label }}</span>
                  </span>
                  <span v-if="o.id === current" class="fp-tag">Current</span>
                </button>
              </template>

              <p v-if="empty" class="fp-hint">Nothing found for that name.</p>
            </div>
          </div>

          <!-- Footer band (scoops up into the card walls) — the one honest
               note about where the faces come from. -->
          <div class="fp-footer">
            <span class="fp-footer__note">{{ footNote }}</span>
            <button
              v-if="installed.status === 'denied'"
              type="button"
              class="fp-action"
              :tabindex="open ? 0 : -1"
              @click="loadInstalled"
            >
              Try again
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  </div>
</template>

<style scoped>
.fp-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}
.fp-card {
  background: var(--panel);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  max-height: 100%;
}
.fp-body {
  --band-bg: var(--band);
  --band-arc: 14px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: min(430px, 100%);
}

/* ── bands (the shared shell's header/footer) ─────────────────────────── */
.fp-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.fp-header::before,
.fp-header::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}
.fp-header::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.fp-header::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}
.fp-band-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}
.fp-action {
  display: inline-flex;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  color: var(--muted);
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.fp-action:hover {
  opacity: 0.7;
}
.fp-action:focus-visible {
  outline: none;
  border-radius: 6px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.fp-footer {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.fp-footer::before,
.fp-footer::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  bottom: 100%;
  pointer-events: none;
}
.fp-footer::before {
  left: 0;
  background: radial-gradient(circle at top right, transparent var(--band-arc), var(--band-bg) 0);
}
.fp-footer::after {
  right: 0;
  background: radial-gradient(circle at top left, transparent var(--band-arc), var(--band-bg) 0);
}
.fp-footer__note {
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
}

/* ── search field ─────────────────────────────────────────────────────── */
.fp-search {
  display: flex;
  align-items: center;
  margin: 12px 12px 0;
  padding: 8px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  flex-shrink: 0;
  transition: background 0.18s ease;
}
.fp-search:focus-within {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}
.fp-search__icon {
  flex-shrink: 0;
  margin-right: 8px;
  color: var(--muted);
}
.fp-search__input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: none;
  font-size: 13px;
  color: var(--ink);
}
.fp-search__input::placeholder {
  color: var(--muted);
}
.fp-search__clear {
  display: inline-flex;
  flex: none;
  padding: 2px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.fp-search__clear:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}

/* ── results ──────────────────────────────────────────────────────────── */
.fp-scroll {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 12px 12px;
  scrollbar-width: none;
}
.fp-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.fp-header,
.fp-search,
.fp-footer {
  flex-shrink: 0;
}
.fp-shelf {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
}
.fp-section {
  margin: 8px 10px 2px;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
}
.fp-section:first-child {
  margin-top: 2px;
}
.fp-row {
  --i: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 9px 10px;
  border-radius: 10px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.18s ease;
  animation: fp-row-in 480ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: calc(var(--i) * 28ms);
}
@keyframes fp-row-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.fp-row:hover {
  background-color: var(--hover);
}
.fp-row:focus-visible {
  outline: none;
  background-color: var(--hover);
}
.fp-row--on {
  background-color: var(--hover);
}
.fp-meta {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}
.fp-name {
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The current pick, in the source tag's voice — a handle, not a badge. */
.fp-tag {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--faint);
}
.fp-hint {
  margin: 8px 4px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--muted);
  text-wrap: pretty;
}

/* Skeleton rows in the row geometry, so the list holds its shape while the
   installed fonts are in flight. */
.fp-skel-row {
  --i: 0;
  display: flex;
  padding: 9px 10px;
  animation: fp-row-in 420ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: calc(var(--i) * 48ms);
}
.fp-skel-name {
  height: 13px;
  border-radius: 5px;
}
.fp-shimmer {
  display: inline-block;
  background:
    linear-gradient(
      100deg,
      transparent 18%,
      color-mix(in srgb, var(--ink) 8%, transparent) 38%,
      color-mix(in srgb, var(--ink) 14%, transparent) 50%,
      color-mix(in srgb, var(--ink) 8%, transparent) 62%,
      transparent 82%
    ),
    color-mix(in srgb, var(--ink) 6.5%, transparent);
  background-size: 220% 100%, 100% 100%;
  background-repeat: no-repeat;
  animation: fp-shimmer 1.35s ease-in-out infinite;
  animation-delay: calc(var(--i, 0) * 90ms);
}
@keyframes fp-shimmer {
  from {
    background-position: 180% 0, 0 0;
  }
  to {
    background-position: -80% 0, 0 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fp-shimmer,
  .fp-skel-row,
  .fp-row {
    animation: none;
  }
}
</style>
