<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type CSSProperties } from "vue";
import { onClickOutside } from "@vueuse/core";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { CheckmarkCircle01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { registerImportedThemes, themes as libraryThemes } from "~/theme/library";
import { useModalExit } from "~/composables/useModalExit";
import {
  importOpenVsxThemeExtension,
  popularThemes,
  searchOpenVsxThemes,
  type OpenVsxThemeExtension,
} from "~/theme/openvsx";

// "Community themes" browser, in the same scrim + elastic card shell the
// clone/create/picker modals wear: bottom-right, a recessed band header and
// footer, and a springy height that follows the results. One row per
// extension; adding one imports every colour theme it ships (light and dark
// siblings arrive as one adaptive theme). Rows stay put after adding so a
// family can be picked up in one visit.
//
// It is a search surface, not a storefront: results carry a name, a publisher,
// an install count and a license — no icons, no ratings — and only open-source
// themes are ever offered.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { cue } = useSound();

const query = ref("");
const results = ref<OpenVsxThemeExtension[]>([]);
const status = ref<"idle" | "loading" | "error">("idle");
const errorMsg = ref("");
const adding = ref(new Set<string>());
const searchInput = ref<HTMLInputElement | null>(null);

// ── catalog ─────────────────────────────────────────────────────────────────
// The picker opens on the registry's most downloaded themes instead of an
// empty page; typing a query swaps to search results, clearing the query
// brings the catalog back.

const catalog = ref<OpenVsxThemeExtension[]>([]);
const catalogLoading = ref(true);
const showingCatalog = computed(() => query.value.trim() === "");
const displayed = computed(() => (showingCatalog.value ? catalog.value : results.value));
let catalogSeq = 0;

async function loadCatalog() {
  const seq = ++catalogSeq;
  catalogLoading.value = true;
  try {
    const found = await popularThemes();
    if (seq !== catalogSeq) return;
    catalog.value = found;
  } catch {
    // An unavailable registry leaves the picker on its hint rather than an
    // error — nothing the user did deserves a scolding.
    if (seq !== catalogSeq) return;
    catalog.value = [];
  } finally {
    if (seq === catalogSeq) catalogLoading.value = false;
  }
}

/** The skeleton holds the list while the catalog (or a search) is in flight. */
const skeletonOn = computed(() =>
  showingCatalog.value ? catalogLoading.value : status.value === "loading",
);

// ── what's already here ─────────────────────────────────────────────────────
// Extensions whose themes are already in the library are marked as added:
// the row remains in view with an "Added" pill and is deactivated.

const importedSources = computed(
  () => new Set(libraryThemes.value.flatMap((t) => (t.source ? [t.source.toLowerCase()] : []))),
);

function isAdded(extId: string): boolean {
  return importedSources.value.has(extId.toLowerCase());
}

// ── search ──────────────────────────────────────────────────────────────────
let searchSeq = 0;
let controller: AbortController | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function clearSearchState() {
  searchSeq += 1;
  catalogSeq += 1;
  controller?.abort();
  controller = null;
  results.value = [];
  status.value = "idle";
  errorMsg.value = "";
}

async function runSearch() {
  const q = query.value.trim();
  const seq = ++searchSeq;
  controller?.abort();
  if (!q) {
    results.value = [];
    status.value = "idle";
    errorMsg.value = "";
    return;
  }
  controller = new AbortController();
  status.value = "loading";
  errorMsg.value = "";
  try {
    const found = await searchOpenVsxThemes(q, { signal: controller.signal });
    if (seq !== searchSeq) return;
    results.value = found;
    status.value = "idle";
  } catch (cause) {
    if (seq !== searchSeq) return;
    if (cause instanceof DOMException && cause.name === "AbortError") return;
    results.value = [];
    status.value = "error";
    errorMsg.value = cause instanceof Error ? cause.message : "The search failed.";
  }
}

function onQueryInput() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void runSearch(), 350);
}

// ── import ──────────────────────────────────────────────────────────────────
async function addExtension(ext: OpenVsxThemeExtension) {
  if (adding.value.has(ext.id) || isAdded(ext.id)) return;
  adding.value = new Set(adding.value).add(ext.id);
  try {
    const themes = await importOpenVsxThemeExtension(ext);
    registerImportedThemes(themes);
    cue("success");
  } catch (cause) {
    errorMsg.value =
      cause instanceof Error ? cause.message : "That theme couldn't be imported.";
    cue("error");
  } finally {
    const next = new Set(adding.value);
    next.delete(ext.id);
    adding.value = next;
  }
}

/** Install counts read like versions of a number, not raw counters. */
function formatDownloads(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

/** Just the host a theme's source lives on — enough to judge provenance
 *  without pasting a whole repository URL into a row. */
function sourceHost(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ── the shared modal shell ──────────────────────────────────────────────────
// Elastic card + scrim, fading and springing in/out exactly like the clone and
// picker modals: `shown` drives the tween, `close` plays the exit first and
// only then hands back to the caller.

const { shown, closing, close } = useModalExit();
const contentEl = ref<HTMLElement | null>(null);
const scrollEl = ref<HTMLElement | null>(null);
const cardRef = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

// ── sidebar anchoring ───────────────────────────────────────────────────────
// The shell lives inside the settings sidebar, not over the whole screen: the
// host (and its scrim) is fixed to the drawer's rect, so the dim only covers
// the sidebar and the card lands in its bottom-right corner. Without a
// measurement the host falls back to the full viewport, so a missing drawer
// degrades to the ordinary shell rather than misplacing the card.

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

/** How tall the card may grow: the padded host, so it never spills the drawer. */
function maxCardHeight(): number {
  const raw = String(hostStyle.value.height ?? "");
  if (raw.endsWith("px")) {
    const host = Number.parseFloat(raw);
    if (Number.isFinite(host)) return Math.max(160, host - 48);
  }
  const stage = cardRef.value instanceof HTMLElement ? cardRef.value.parentElement : null;
  if (stage) return stage.clientHeight;
  return Math.round(window.innerHeight * 0.72);
}

function syncHeight() {
  const body = contentEl.value;
  const scroll = scrollEl.value;
  if (!body) return;
  const chrome = scroll ? body.offsetHeight - scroll.offsetHeight : 0;
  const list = scroll ? Math.max(scroll.scrollHeight, scroll.clientHeight) : body.offsetHeight;
  const natural = scroll ? chrome + list : body.offsetHeight;
  cardHeight.value = Math.min(natural, maxCardHeight());
}

function cancel() {
  if (closing.value) return;
  close(() => emit("close"));
}

// Clicks anywhere outside the card dismiss it — the scrim catches the drawer
// itself, this catches the rest of the app (the scrim never covers it).
onClickOutside(cardRef, () => {
  if (props.open) cancel();
});

// Esc dismisses; Tab stays inside the card.
function focusableEls(): HTMLElement[] {
  const root = contentEl.value;
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>('input, button:not(:disabled), [tabindex]:not([tabindex="-1"])'),
  );
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    cancel();
    return;
  }
  if (event.key !== "Tab") return;
  const els = focusableEls();
  const first = els[0];
  const last = els[els.length - 1];
  if (!first || !last) return;
  // SAFETY: activeElement is only compared against focusableEls(), which
  // selects HTMLElements via querySelectorAll<HTMLElement>; anything else
  // simply misses in the includes() check.
  const active = document.activeElement as HTMLElement | null;
  const inTrap = active != null && els.includes(active);
  const atEdge = event.shiftKey ? active === first : active === last;
  if (atEdge || !inTrap) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

// Whatever had focus before the modal opened — restored on close.
let opener: HTMLElement | null = null;

onMounted(async () => {
  // SAFETY: activeElement is null when nothing is focused; otherwise the
  // focused element is a focusable HTML control, and only opener?.focus()
  // ever reads it back — matching opener's declared type.
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onWindowResize);
  await nextTick();
  syncHeight();
  anchorToDrawer();
  void loadCatalog();
  ro = new ResizeObserver(syncHeight);
  if (contentEl.value) ro.observe(contentEl.value);
  if (scrollEl.value) ro.observe(scrollEl.value);
  requestAnimationFrame(() => {
    shown.value = true;
    searchInput.value?.focus();
  });
});

function onWindowResize() {
  syncHeight();
  anchorToDrawer();
}

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onWindowResize);
  ro?.disconnect();
  anchorRO?.disconnect();
  clearTimeout(debounceTimer);
  clearSearchState();
  opener?.focus();
});

const cardSpring = {
  type: "spring",
  stiffness: 300,
  damping: 22,
  mass: 0.9,
} as const;
</script>

<template>
  <Teleport to="body">
    <!-- The host is fixed to the sidebar's rect (or the viewport when the
         drawer can't be found), so the shell never covers more than the
         sidebar. -->
    <div v-if="open" class="pointer-events-none fixed inset-0 z-50" :style="hostStyle">
      <!-- Scrim: dim + blur ramp together on one tween, matching the pickers —
           but only over the sidebar. -->
      <motion.div
        class="modal-scrim pointer-events-auto absolute inset-0"
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
          class="modal-card pointer-events-auto relative flex w-full max-w-md flex-col overflow-hidden"
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
          aria-label="Community themes"
        >
        <div ref="contentEl" class="tb-body flex h-full min-h-0 flex-col">
          <!-- Recessed header band with the arc scoops flowing into the card
               walls — the shared modal shell signature. -->
          <div class="picker-header">
            <span class="picker-band-title">Community themes</span>
            <button type="button" class="picker-action text-muted" @click="cancel">
              Cancel
            </button>
          </div>

          <div class="tb__search">
            <HugeiconsIcon class="tb__search-icon" :icon="Search01Icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
            <input
              ref="searchInput"
              v-model="query"
              class="tb__input"
              type="text"
              placeholder="Search for a theme — dracula, nord, ayu…"
              spellcheck="false"
              autocomplete="off"
              @input="onQueryInput"
            />
          </div>

          <div ref="scrollEl" class="picker-scroll tb__scroll">
            <!-- Skeleton and shelf share one scrollport. The leaving skeleton
                 is taken out of flow so the card height follows the incoming
                 list instead of stacking both. -->
            <Transition name="tb-cross">
              <div
                v-if="skeletonOn"
                key="skeleton"
                class="tb__skeleton"
                role="status"
                aria-label="Loading themes"
              >
                <div v-for="n in 6" :key="n" class="tb__skel-row" :style="{ '--i': n - 1 }">
                  <div class="tb__skel-main">
                    <span
                      class="tb__skel-name tb__shimmer"
                      :style="{ width: `${42 + ((n * 17) % 28)}%` }"
                    />
                    <span
                      class="tb__skel-sub tb__shimmer"
                      :style="{ width: `${58 + ((n * 11) % 22)}%` }"
                    />
                    <span
                      class="tb__skel-desc tb__shimmer"
                      :style="{ width: `${72 + ((n * 13) % 18)}%` }"
                    />
                  </div>
                  <span class="tb__skel-action tb__shimmer" />
                </div>
              </div>
              <div v-else key="shelf" class="tb__shelf">
                <p v-if="showingCatalog && catalog.length === 0 && status === 'idle'" class="tb__hint">
                  The registry's most downloaded themes appear here; search to find a specific one. Only
                  open-source themes are offered.
                </p>

                <p v-if="status === 'error'" class="tb__error" role="alert">{{ errorMsg }}</p>

                <p
                  v-else-if="
                    !showingCatalog && query.trim() && status !== 'loading' && results.length === 0
                  "
                  class="tb__hint"
                >
                  Nothing found for that name.
                </p>

                <div v-if="displayed.length > 0" class="tb__results">
                  <button
                    v-for="(ext, i) in displayed"
                    :key="ext.id"
                    type="button"
                    class="tb__row"
                    :class="{ 'tb__row--added': isAdded(ext.id) }"
                    :style="{ '--i': Math.min(i, 11) }"
                    :disabled="isAdded(ext.id) || adding.has(ext.id)"
                    @click="addExtension(ext)"
                  >
                    <span class="tb__meta">
                      <span class="tb__name">
                        {{ ext.name }}
                        <span v-if="sourceHost(ext.sourceUrl)" class="tb__src">{{ sourceHost(ext.sourceUrl) }}</span>
                      </span>
                      <span class="tb__sub">
                        {{ ext.publisher }} · {{ formatDownloads(ext.downloadCount) }} installs ·
                        {{ ext.license }}
                      </span>
                      <span v-if="ext.description" class="tb__desc">{{ ext.description }}</span>
                    </span>
                    <span class="tb__action" aria-hidden="true">
                      <template v-if="adding.has(ext.id)">Adding…</template>
                      <template v-else-if="isAdded(ext.id)">
                        <HugeiconsIcon :icon="CheckmarkCircle01Icon" :size="11" :stroke-width="2.2" class="tb__action-icon" aria-hidden="true" />
                        Added
                      </template>
                      <template v-else>Add</template>
                    </span>
                  </button>
                </div>
              </div>
            </Transition>
          </div>

          <!-- Footer band (scoops up into the card walls) — the one honest
               note about where the results come from. -->
          <div class="picker-footer tb__footer">From Open VSX. Added themes stay on this machine.</div>
          </div>
        </motion.div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}

.modal-card {
  background: var(--panel);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  max-height: 100%;
}

.tb-body {
  --band-bg: var(--band);
  --band-arc: 14px;
  min-height: 0;
}

/* ── bands (the shared shell's header/footer) ─────────────────────────────── */
.picker-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}

.picker-header::before,
.picker-header::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}

.picker-header::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.picker-header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.picker-band-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

.picker-action {
  display: inline-flex;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}

.picker-action:hover:not(:disabled) {
  opacity: 0.7;
}

.picker-action:disabled {
  cursor: default;
  opacity: 0.4;
}

.picker-footer {
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}

.picker-footer::before,
.picker-footer::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  bottom: 100%;
  pointer-events: none;
}

.picker-footer::before {
  left: 0;
  background: radial-gradient(
    circle at top right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.picker-footer::after {
  right: 0;
  background: radial-gradient(
    circle at top left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.tb__footer {
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
}

/* ── search field ─────────────────────────────────────────────────────────── */
.tb__search {
  display: flex;
  align-items: center;
  margin: 12px 12px 0;
  padding: 8px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  flex-shrink: 0;
  transition: background 0.18s ease;
}

.tb__search:focus-within {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}

.tb__search-icon {
  flex-shrink: 0;
  margin-right: 8px;
  color: var(--muted);
}

.tb__input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: none;
  font-size: 13px;
  color: var(--ink);
}

.tb__input::placeholder {
  color: var(--muted);
}

/* ── results ──────────────────────────────────────────────────────────────── */
.tb__scroll {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 12px 12px;
}

/* Six skeleton rows, not a viewport-tall empty well — the card opens at a
   shelf's size, then springs if the real list is taller. */
.picker-header,
.tb__search,
.picker-footer {
  flex-shrink: 0;
}

.tb__hint {
  margin: 8px 4px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--muted);
  text-wrap: pretty;
}

/* ── skeleton ─────────────────────────────────────────────────────────────── */
/* Rows in the theme-row geometry (name / sub / description over a right-hand
   pill) so the list holds its shape while the catalog is in flight; the house
   shimmer — a soft sweep across a low-contrast fill, no hard highlight. */
.tb__skeleton,
.tb__shelf {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
}

.tb__skel-row {
  --i: 0;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 9px 10px;
  border-radius: 10px;
  animation: tb-skel-in 420ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: calc(var(--i) * 48ms);
}

.tb__skel-main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.tb__skel-name {
  height: 13px;
  border-radius: 5px;
}

.tb__skel-sub {
  height: 10px;
  border-radius: 4px;
}

.tb__skel-desc {
  height: 10px;
  width: 90%;
  border-radius: 4px;
}

.tb__skel-action {
  flex: none;
  width: 44px;
  height: 24px;
  border-radius: 8px;
}

.tb__shimmer {
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
  animation: tb-shimmer 1.35s ease-in-out infinite;
  animation-delay: calc(var(--i, 0) * 90ms);
}

@keyframes tb-shimmer {
  from {
    background-position: 180% 0, 0 0;
  }
  to {
    background-position: -80% 0, 0 0;
  }
}

@keyframes tb-skel-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* Leaving skeleton is pulled out of flow so height follows the incoming shelf. */
.tb-cross-enter-active,
.tb-cross-leave-active {
  transition:
    opacity 220ms ease,
    transform 420ms cubic-bezier(0.22, 1, 0.36, 1);
}

.tb-cross-leave-active {
  position: absolute;
  inset-inline: 0;
  top: 0;
}

.tb-cross-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.tb-cross-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .tb__shimmer,
  .tb__skel-row,
  .tb__row {
    animation: none;
  }

  .tb-cross-enter-active,
  .tb-cross-leave-active {
    transition: none;
  }
}

.tb__error {
  margin: 8px 4px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--danger);
  text-wrap: pretty;
}

.tb__results {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tb__row {
  --i: 0;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  padding: 9px 10px;
  border-radius: 10px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.18s ease;
  animation: tb-row-in 480ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: calc(var(--i) * 28ms);
}

@keyframes tb-row-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.tb__row:hover:not(:disabled) {
  background-color: var(--hover);
}

.tb__row:disabled {
  cursor: default;
}

.tb__row:focus-visible {
  outline: none;
  background-color: var(--hover);
}

.tb__meta {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.tb__name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
}

.tb__src {
  min-width: 0;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--faint);
  text-overflow: ellipsis;
  overflow: hidden;
}

.tb__sub {
  font-size: 11px;
  color: var(--muted);
}

.tb__desc {
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--muted);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.tb__action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  margin-top: 1px;
  padding: 4px 9px;
  border-radius: 8px;
  font-size: 11px;
  color: var(--ink-soft);
  background: color-mix(in oklab, var(--accent) 9%, transparent);
  transition: background-color 0.16s ease;
}

.tb__row:hover:not(:disabled) .tb__action {
  background: color-mix(in oklab, var(--accent) 14%, transparent);
}

.tb__row:disabled .tb__action {
  color: var(--ink-soft);
  background: color-mix(in oklab, var(--ok) 11%, transparent);
}

.tb__action-icon {
  color: var(--ok);
}

/* Match the pickers' quiet scrollbar. */
.tb__scroll {
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 16%, transparent) transparent;
}

.tb__scroll::-webkit-scrollbar {
  width: 10px;
}

.tb__scroll::-webkit-scrollbar-track {
  background: transparent;
}

.tb__scroll::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
  border: 3px solid transparent;
  background-clip: content-box;
}

.tb__scroll:hover::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
}
</style>
