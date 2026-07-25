<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion } from "motion-v";
import ProviderLogo from "~/components/ProviderLogo.vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon, StarIcon, Settings02Icon, FlashIcon } from "@hugeicons/core-free-icons";
import { EFFORT_META, type BrandKey, type EffortTier, type PickerProvider } from "~/utils/modelCatalog";
import type { ProviderKind } from "~/types/desktop";

// The model picker — a persistent left rail of providers next to a masked model
// list, wearing the same shell as our folder/location picker: a scrim + an
// elastic card anchored bottom-right. Click a provider to swap the list; click a
// model to select it outright. The composer's own brain-stack control
// (AgentComposer.vue) also cycles effort, but each model row here carries its
// own settings bar (gear icon) with the same reasoning-effort cycle, so both
// surfaces need to agree on which tier is actually active.
//
// One rail entry per installed, logged-in provider (Codex, Claude, …), each
// with its own live catalog. Selecting a model from a provider other than the
// active one switches the running engine — the payload carries `provider` so
// the host (ProjectView) can restart the session on the right CLI. Favorites is
// the one extra rail tab, a pseudo-provider that re-lists starred models from
// every provider (each row keeps a handle on its real origin — see `favorites`).

const props = defineProps<{
  /** Every installed provider's catalog (families with real efforts). */
  providers: PickerProvider[];
  /** Which provider the session is currently running on — its matching model is
   *  the one marked current, and it's the rail tab opened first. */
  activeProvider: ProviderKind;
  /** The active raw model id — marked as current. For Codex this is a bare
   *  family id (e.g. `gpt-5.6-terra`); it does NOT carry the effort. */
  modelId?: string;
  /** The active reasoning-effort tier. Needed alongside `modelId` because a
   *  synthetic ladder's rungs all share one `modelId` — tier is the only thing
   *  that tells them apart. */
  reasoning?: EffortTier;
  /** Is the active model's real "fast" service tier on for this session? */
  fastMode?: boolean;
}>();

const emit = defineEmits<{
  /** Commit a provider + model + effort + fast-mode, and close the picker. */
  select: [picked: { provider: ProviderKind; modelId: string; tier: EffortTier; fastMode: boolean }];
  /** Live-apply a tweak (reasoning effort/fast mode) without closing — rides
   *  straight to the composer input so the setting takes effect and sticks as
   *  you adjust. Only fired for the active provider (a cross-provider tweak is
   *  staged until you select, since it can't apply to the running session). */
  apply: [picked: { provider: ProviderKind; modelId: string; tier: EffortTier; fastMode: boolean }];
  cancel: [];
}>();

// ── data model ────────────────────────────────────────────────────────────────
// `id` is a unique picker key (bookkeeping only — :key, comparisons against a
// pending selection); `modelId` is what's actually sent to the backend. They
// diverge for a synthetic ladder, where every tier shares one `modelId`.
type MEffort = { id: string; modelId: string; tier: EffortTier };
type MModel = {
  key: string;
  label: string;
  brand: BrandKey;
  vendor: string;
  efforts: MEffort[];
  /** Index into `efforts` a plain model click resolves to. */
  defaultEffortIndex: number;
  /** This model's real "fast" service tier, when it has one. */
  fastTier?: { id: string; label: string };
  /** The provider this model runs on — carried through so a select/apply can
   *  tell the host which engine to run (and, under Favorites, which origin a
   *  starred row belongs to). */
  providerId: ProviderKind;
  /**
   * Only set for rows shown under Favorites: the provider this favourite was
   * starred from. Its `ready` overrides the (pseudo) Favorites provider —
   * kept so a favourited model still resolves against its real origin rather
   * than the Favorites placeholder.
   */
  origin?: { label: string; ready: boolean };
};
type MProvider = {
  id: string;
  label: string;
  sub: string;
  brand: BrandKey;
  ready: boolean;
  models: MModel[];
};

// One rail entry per real provider, mapped straight from the live catalogs the
// host handed in. Keeping this a list (not a single value) lets the rail,
// seedPending, and Favorites all walk providers uniformly.
const realProviders = computed<MProvider[]>(() =>
  props.providers.map((p) => ({
    id: p.id,
    label: p.label,
    sub: p.sub,
    brand: p.brand,
    ready: p.ready,
    models: p.models.map((o) => ({
      key: `${p.id}:${o.key}`,
      label: o.label,
      brand: o.brand,
      vendor: o.vendor,
      efforts: o.efforts.map((e) => ({ id: `${p.id}:${e.id}`, modelId: e.modelId, tier: e.tier })),
      defaultEffortIndex: o.defaultEffortIndex,
      providerId: p.id,
      ...(o.fastTier ? { fastTier: o.fastTier } : {}),
    })),
  })),
);

// ── Favorites ───────────────────────────────────────────────────────────────
// A live shelf of the models the user has starred, drawn from every installed
// provider. Only real (ready) models can be favourited — which keeps the
// bring-your-own-subscription rule intact: everything on this shelf actually
// applies. Each row keeps a handle on the provider it came from (its `origin`) so
// selecting it works exactly as it would in that provider's own list.
const favorites = computed<MProvider>(() => {
  const picks: MModel[] = [];
  for (const p of realProviders.value) {
    for (const m of p.models) {
      if (favoritedKeys.value.has(m.key)) {
        picks.push({ ...m, origin: { label: p.label, ready: p.ready } });
      }
    }
  }
  return {
    id: "favorites",
    label: "Favorites",
    sub: "Starred models",
    brand: "codex",
    ready: false,
    models: picks,
  };
});

// Favorites leads the rail — but only once something's been starred. With an
// empty shelf the tab would go nowhere, so it stays hidden until it has content.
const providers = computed<MProvider[]>(() =>
  favorites.value.models.length ? [favorites.value, ...realProviders.value] : realProviders.value,
);

// ── navigation ──────────────────────────────────────────────────────────────
const provider = ref<MProvider | null>(null);

// A click on a non-ready provider's row only focuses it — a quiet checkmark,
// never applied. (No provider is non-ready today; kept so a future provider
// can be browsed before it's wired up.) Seeded from the current session model
// on open.
const pending = ref<{ provider: MProvider; model: MModel; effort: MEffort; fastMode: boolean } | null>(null);

// The effort a model currently resolves to: the exact (modelId, tier) match if
// there is one, else any effort sharing this modelId (a synthetic ladder's
// other rungs), else the family default. A plain `modelId` match alone can't
// disambiguate a synthetic ladder — every rung there shares one modelId — so
// the tier has to be checked first.
function matchEffort(m: MModel): MEffort | undefined {
  return (
    m.efforts.find((e) => e.modelId === props.modelId && e.tier === props.reasoning) ??
    m.efforts.find((e) => e.modelId === props.modelId) ??
    m.efforts[m.defaultEffortIndex] ??
    m.efforts[0]
  );
}

// Fast mode only carries over from the session for the model it's actually
// active on — any other row starts from off, same as effort falls back to the
// family default rather than a stale tier.
function matchFastMode(m: MModel): boolean {
  return isCurrentModel(m) ? (props.fastMode ?? false) : false;
}

function seedPending() {
  // Walk the REAL providers so the active model resolves to its true home, not
  // its (duplicated) Favorites row. Check the active provider first so the seed
  // lands on the engine the session is actually running.
  const ordered = [...realProviders.value].sort(
    (a, b) => Number(b.id === props.activeProvider) - Number(a.id === props.activeProvider),
  );
  for (const p of ordered) {
    for (const m of p.models) {
      const e = m.efforts.find((x) => x.modelId === props.modelId && x.tier === props.reasoning);
      if (e) {
        pending.value = { provider: p, model: m, effort: e, fastMode: props.fastMode ?? false };
        provider.value = p;
        return;
      }
    }
  }
  // No match — open the active provider's tab (or the first) so the list isn't blank.
  provider.value =
    realProviders.value.find((p) => p.id === props.activeProvider) ?? realProviders.value[0] ?? null;
}
function openProvider(p: MProvider) {
  provider.value = p;
}
function focus(m: MModel, e: MEffort, fastMode = matchFastMode(m)) {
  if (!provider.value) return;
  pending.value = { provider: provider.value, model: m, effort: e, fastMode };
}
// Readiness is per-row under Favorites (each favourite carries its origin),
// otherwise it's the current provider's.
function modelReady(m: MModel): boolean {
  return m.origin ? m.origin.ready : (provider.value?.ready ?? false);
}
// A model click applies it. Effort precedence: a tweak in its open settings bar
// wins; else the effort already applied to this model (so re-picking the active
// model keeps its setting); else the family default. Only ready models can be
// selected.
function selectModel(m: MModel) {
  if (!modelReady(m)) return;
  const isPendingModel = pending.value?.model.key === m.key;
  const e = isPendingModel ? pending.value!.effort : matchEffort(m);
  const fastMode = isPendingModel ? pending.value!.fastMode : matchFastMode(m);
  if (!provider.value || !e) return;
  close(() => emit("select", { provider: m.providerId, modelId: e.modelId, tier: e.tier, fastMode }));
}

// Whether this model row is the one active in the session — it must both run on
// the active provider and carry the active model id (row granularity is
// per-model, not per-tier). The provider guard keeps a model from lighting up as
// "current" while you're browsing a different engine's list.
function isCurrentModel(m: MModel): boolean {
  return m.providerId === props.activeProvider && m.efforts.some((e) => e.modelId === props.modelId);
}
function isPending(id: string): boolean {
  return pending.value?.effort.id === id;
}
function defaultEffortId(m: MModel): string {
  return (m.efforts[m.defaultEffortIndex] ?? m.efforts[0])?.id ?? "";
}

// The reasoning effort currently set for a model: the pending effort if this row
// is the one being tuned, else its resting default. Drives the row's brain-stack
// indicator — which matches the settings dial. Returns null for a `base`-tier
// model (no reasoning to set), so its row shows no reasoning indicator.
function reasoningMeta(m: MModel) {
  const e = pending.value?.model.key === m.key ? pending.value.effort : matchEffort(m);
  if (!e || e.tier === "base") return null;
  return EFFORT_META[e.tier];
}

// Mirrors reasoningMeta: is fast mode on for this row right now — the pending
// toggle if this row is the one being tuned, else its resting (session) state.
function fastModeOn(m: MModel): boolean {
  return pending.value?.model.key === m.key ? pending.value.fastMode : matchFastMode(m);
}

// The set of favourited model keys. Only ready (real) models are ever added, so
// the Favorites shelf stays fully applicable. Seeded on open with the current /
// first Codex model so the shelf isn't empty on first sight.
const favoritedKeys = ref<Set<string>>(new Set());
const activeSettingsModelKey = ref<string | null>(null);

function isFavorited(key: string): boolean {
  return favoritedKeys.value.has(key);
}

// Star / unstar — ready models only. Reassign the Set so the Favorites
// computed recomputes.
function toggleFavorite(m: MModel) {
  if (!modelReady(m)) return;
  const next = new Set(favoritedKeys.value);
  if (next.has(m.key)) next.delete(m.key);
  else next.add(m.key);
  favoritedKeys.value = next;
}

function toggleSettings(m: MModel) {
  if (!modelReady(m)) return;
  if (activeSettingsModelKey.value === m.key) {
    activeSettingsModelKey.value = null;
  } else {
    activeSettingsModelKey.value = m.key;
    // Seed the dial from the effort CURRENTLY applied to this model (when it's
    // the active one), else its resting default — so the bar reflects reality.
    const e = matchEffort(m);
    if (e && provider.value) {
      focus(m, e);
    }
  }
}

// A live tweak (effort/fast mode) can only ride straight to the running session
// when the tuned model is on the ACTIVE provider — a cross-provider tweak has no
// live session to apply to, so it stays staged in `pending` until the user
// selects (which switches engines). This gate keeps `apply` a pure in-session
// nudge, never a silent provider switch.
function applyLive(fastMode: boolean) {
  const p = pending.value;
  if (!p || !modelReady(p.model)) return;
  if (p.model.providerId !== props.activeProvider) return;
  emit("apply", { provider: p.model.providerId, modelId: p.effort.modelId, tier: p.effort.tier, fastMode });
}

// Reasoning effort — cycle through a family's real efforts. For an active-
// provider model this applies live: the composer's active model + input update
// immediately and the choice sticks, without closing the picker.
function cycleEffort() {
  if (!pending.value) return;
  const efforts = pending.value.model.efforts;
  if (efforts.length <= 1) return;
  const currentIndex = efforts.findIndex((e) => e.id === pending.value!.effort.id);
  const nextIndex = (currentIndex + 1) % efforts.length;
  const next = efforts[nextIndex]!;
  pending.value.effort = next;
  applyLive(pending.value.fastMode);
}

// Fast mode — a plain on/off for the model's real "fast" service tier. Applies
// live exactly like cycleEffort.
function toggleFastMode() {
  if (!pending.value?.model.fastTier) return;
  pending.value.fastMode = !pending.value.fastMode;
  applyLive(pending.value.fastMode);
}

function brainStack(count?: number): number[] {
  return Array.from({ length: Math.max(1, count ?? 1) }, (_, i) => i);
}

// Is there anything to configure? Drives whether the gear button shows, so it
// never opens an empty bar. A model with only one effort and no fast tier has
// no settings — context window is a fact, not a switch, so it never counts.
function hasSettings(m: MModel): boolean {
  return m.efforts.length > 1 || Boolean(m.fastTier);
}

// ── confirm / cancel with the card's exit ─────────────────────────────────────
const shown = ref(false);
const closing = ref(false);
function close(done: () => void) {
  if (closing.value) return;
  closing.value = true;
  shown.value = false;
  window.setTimeout(done, 240);
}
function cancel() {
  close(() => emit("cancel"));
}

// ── elastic height (mirrors FolderPickerModal) ────────────────────────────────
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;
function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}
// When the provider changes: close any open settings bar (it belongs to a row
// that's no longer shown) and re-measure.
watch(provider, () => {
  activeSettingsModelKey.value = null;
  void nextTick(syncHeight);
});
// Unstarring the last favourite hides its tab — step off it if it's open.
watch(
  () => favorites.value.models.length,
  (n) => {
    if (n === 0 && provider.value?.id === "favorites") {
      provider.value = realProviders.value[0] ?? null;
    }
  },
);

let opener: HTMLElement | null = null;
onMounted(() => {
  opener = document.activeElement as HTMLElement | null;
  seedPending();
  // Seed the shelf with the current model (or the first real one) so Favorites
  // reads as a live place from the start rather than an empty tab.
  const seed = pending.value?.provider.ready
    ? pending.value.model.key
    : realProviders.value[0]?.models[0]?.key;
  if (seed) favoritedKeys.value = new Set([seed]);
  window.addEventListener("resize", syncHeight);
  void nextTick(() => {
    syncHeight();
    ro = new ResizeObserver(syncHeight);
    if (contentEl.value) ro.observe(contentEl.value);
    requestAnimationFrame(() => (shown.value = true));
  });
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", syncHeight);
  ro?.disconnect();
  opener?.focus();
});

const cardSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-end justify-end overflow-hidden p-6" @keydown.esc.stop.prevent="cancel">
    <motion.div
      class="mp-scrim absolute inset-0"
      :initial="{ opacity: 0, backdropFilter: 'blur(0px)' }"
      :animate="{ opacity: shown ? 1 : 0, backdropFilter: shown ? 'blur(4px)' : 'blur(0px)' }"
      :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
      @click="cancel"
    />

    <motion.div
      class="mp-card relative z-20 w-full overflow-hidden"
      :style="{ height: cardHeight === null ? 'auto' : `${cardHeight}px` }"
      :initial="{ opacity: 0, y: 12, scale: 0.96 }"
      :animate="{ opacity: shown ? 1 : 0, y: shown ? 0 : 12, scale: shown ? 1 : 0.96 }"
      :transition="cardSpring"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a model"
    >
      <div
        ref="contentEl"
        class="mp shrink-0"
        :style="{ '--provider-count': providers.length }"
      >
        <div class="mp-body-grid">
          <aside class="mp-rail" aria-label="Model providers">
            <button
              v-for="p in providers"
              :key="p.id"
              type="button"
              class="mp-provider"
              :class="{ 'mp-provider--on': p.id === provider?.id }"
              :aria-label="p.label"
              :aria-pressed="p.id === provider?.id"
              :title="p.label"
              @click="openProvider(p)"
            >
              <svg v-if="p.id === 'favorites'" class="mp-star" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 3.6l2.42 4.9 5.41.79-3.92 3.82.93 5.39L12 15.98l-4.84 2.52.93-5.39L4.17 9.29l5.41-.79z"
                  fill="currentColor"
                  fill-opacity="0.16"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linejoin="round"
                />
              </svg>
              <ProviderLogo v-else :brand="p.brand" :size="20" />
            </button>
          </aside>

          <!-- The model list is the dark content well inside the lighter shell. -->
          <div class="mp-content relative">
            <Transition name="mp-swap" mode="out-in">
              <div v-if="provider" :key="provider.id" class="mp-scroll">
                <p v-if="!provider.models.length" class="mp-empty">
                  {{ provider.id === 'favorites'
                    ? 'No favorites yet — star a model to keep it here.'
                    : 'No models available.' }}
                </p>
                <button
                  v-for="m in provider.models"
                  :key="m.key"
                  type="button"
                  class="mp-row group"
                  :class="{ 'mp-row--on': isCurrentModel(m) || isPending(defaultEffortId(m)) }"
                  @click="selectModel(m)"
                >
                  <span class="mp-icon"><ProviderLogo :brand="m.brand" :size="17" /></span>
                  <span class="mp-body">
                    <span class="mp-label">{{ m.label }}</span>
                    <span class="mp-meta">
                      <span
                        v-if="reasoningMeta(m)"
                        class="mp-meta-brains"
                        :class="{ 'mp-stack--glow': reasoningMeta(m)!.glow }"
                        :title="`Reasoning effort: ${reasoningMeta(m)!.label}`"
                      >
                        <HugeiconsIcon
                          v-for="i in brainStack(reasoningMeta(m)!.brains)"
                          :key="i"
                          :icon="AiBrain01Icon"
                          :size="13"
                          :stroke-width="1.8"
                          :style="{ color: reasoningMeta(m)!.hue }"
                        />
                      </span>
                      <HugeiconsIcon
                        v-if="fastModeOn(m)"
                        :icon="FlashIcon"
                        :size="12"
                        :stroke-width="2"
                        class="mp-meta-fast"
                        title="Fast mode is on"
                      />
                    </span>
                  </span>
                  <!-- Actions: Favorite & Settings — real models only. The current
                       model keeps them shown; others reveal them on hover. -->
                  <span
                    v-if="modelReady(m)"
                    class="mp-actions"
                    :class="{ 'mp-actions--shown': isCurrentModel(m) }"
                    @click.stop
                  >
                    <button
                      type="button"
                      class="mp-action-btn"
                      :class="{ 'mp-action-btn--active': isFavorited(m.key) }"
                      :title="isFavorited(m.key) ? 'Unstar model' : 'Favorite model'"
                      @click.stop="toggleFavorite(m)"
                    >
                      <HugeiconsIcon :icon="StarIcon" :size="13" :stroke-width="1.8" />
                    </button>
                    <button
                      v-if="hasSettings(m)"
                      type="button"
                      class="mp-action-btn"
                      :class="{ 'mp-action-btn--active': activeSettingsModelKey === m.key }"
                      title="Model settings"
                      @click.stop="toggleSettings(m)"
                    >
                      <HugeiconsIcon :icon="Settings02Icon" :size="13" :stroke-width="1.8" />
                    </button>
                  </span>
                </button>
              </div>
            </Transition>
          </div>
        </div>

        <!-- Shell Bottom: Full-bleed control strip, revealed when clicking Settings on a model -->
        <div v-if="activeSettingsModelKey && pending" class="mp-shell-bottom">
          <!-- Reasoning Effort Chooser: Clickable brain-stack + effort level text -->
          <div v-if="pending.model.efforts.length > 1" class="mp-footer-group">
            <button
              type="button"
              class="mp-effort-toggle"
              :aria-label="`Reasoning effort: ${EFFORT_META[pending.effort.tier]?.label}. Click to cycle.`"
              @click.stop="cycleEffort"
            >
              <span class="mp-stack" :class="{ 'mp-stack--glow': EFFORT_META[pending.effort.tier]?.glow }">
                <HugeiconsIcon
                  v-for="i in brainStack(EFFORT_META[pending.effort.tier]?.brains)"
                  :key="i"
                  :icon="AiBrain01Icon"
                  :size="14"
                  :stroke-width="1.8"
                  :style="{ color: EFFORT_META[pending.effort.tier]?.hue ?? '#a78bfa' }"
                />
              </span>
              <span
                class="mp-effort-level-text"
                :style="{ color: EFFORT_META[pending.effort.tier]?.hue ?? 'var(--ink)' }"
              >
                {{ EFFORT_META[pending.effort.tier]?.label }}
              </span>
            </button>
          </div>

          <!-- Fast mode: a plain on/off pill for the model's real "fast" tier. -->
          <div v-if="pending.model.fastTier" class="mp-footer-group">
            <button
              type="button"
              class="mp-fast-toggle"
              :class="{ 'mp-fast-toggle--on': pending.fastMode }"
              :aria-pressed="pending.fastMode"
              :aria-label="`${pending.model.fastTier.label}: ${pending.fastMode ? 'on' : 'off'}. Click to toggle.`"
              @click.stop="toggleFastMode"
            >
              <HugeiconsIcon :icon="FlashIcon" :size="14" :stroke-width="1.8" />
              <span class="mp-fast-toggle-text">{{ pending.model.fastTier.label }}</span>
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  </div>
</template>

<style scoped>
.mp-scrim {
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}
.mp-card {
  max-width: 500px;
  background: color-mix(in srgb, var(--ink) 7%, var(--surface, var(--ground)));
  border-radius: 22px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
.mp {
  display: flex;
  flex-direction: column;
}

.mp-body-grid {
  /* Floor of 300px: with Codex as the only real provider (Favorites is the one
     other rail tab), the provider-count formula alone gives a cramped 44-98px
     well — nowhere near enough room for a model list. */
  --provider-stack-height: max(
    calc(var(--provider-count) * 44px + (var(--provider-count) - 1) * 10px),
    300px
  );
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  grid-template-rows: var(--provider-stack-height);
  padding: 0;
}

.mp-rail {
  grid-column: 1;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  padding: 4px 0 0;
}
.mp-provider {
  position: relative;
  display: inline-flex;
  width: 44px;
  height: 44px;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  opacity: 0.48;
  transition:
    opacity 0.18s ease,
    transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.mp-provider:hover {
  opacity: 0.78;
  transform: translateY(-1px);
}
.mp-provider:active { transform: scale(0.96); }
.mp-provider--on {
  opacity: 1;
}
.mp-star {
  width: 20px;
  height: 20px;
  color: var(--accent);
}

/* ── List ─────────────────────────────────────────────────────────────────── */
.mp-content {
  grid-column: 2;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  height: var(--provider-stack-height);
  min-height: 0;
  overflow: hidden;
  border-radius: 18px;
  background: var(--ground);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 7%, transparent);
}
.mp-scroll {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px;
  scrollbar-width: none;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
}
.mp-scroll::-webkit-scrollbar { width: 0; height: 0; }

.mp-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 11px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  color: var(--ink);
  opacity: 0.72;
  transition:
    opacity 0.18s ease,
    background 0.16s ease,
    transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.mp-row:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.mp-row:active {
  transform: scale(0.985);
}
.mp-row--on {
  opacity: 1;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
}
.mp-row--on:hover {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}

.mp-meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 2px;
  flex-shrink: 0;
}

/* The reasoning indicator: a compact brain-stack whose count / glow / hue match
   the effort currently set for the model (mirrors the settings dial). */
.mp-meta-brains {
  display: inline-flex;
  align-items: center;
  opacity: 0.8;
  transition: opacity 0.14s ease;
}
.mp-meta-brains > :deep(svg) { margin-left: -4px; }
.mp-meta-brains > :deep(svg:first-child) { margin-left: 0; }
.mp-meta-brains.mp-stack--glow > :deep(svg) { filter: drop-shadow(0 0 4px currentColor); }
.mp-row:hover .mp-meta-brains { opacity: 1; }

.mp-meta-fast {
  color: #f5b300;
  filter: drop-shadow(0 0 3px rgba(245, 179, 0, 0.5));
}

.mp-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  flex-shrink: 0;
}

.mp-body { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; }
.mp-label { font-size: 15px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mp-empty {
  margin: auto;
  padding: 22px 14px;
  text-align: center;
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted);
  opacity: 0.7;
}

.mp-actions {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.16s ease;
}
.mp-row:hover .mp-actions,
.mp-actions--shown,
.mp-action-btn--active {
  opacity: 1;
}

.mp-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  opacity: 0.65;
  cursor: pointer;
  transition: color 0.14s ease, opacity 0.14s ease, transform 0.14s ease;
}
.mp-action-btn:hover {
  color: var(--ink);
  opacity: 1;
}
.mp-action-btn:active {
  transform: scale(0.92);
}
.mp-action-btn--active {
  color: var(--accent);
  opacity: 1;
}

/* ── Shell Bottom Controls ────────────────────────────────────────────────── */
.mp-shell-bottom {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  flex-wrap: wrap;
  padding: 2px 14px 4px;
  margin-top: 0;
}

.mp-footer-group {
  display: flex;
  align-items: center;
}

.mp-stack { display: inline-flex; align-items: center; }
.mp-stack > :deep(svg) { margin-left: -5px; }
.mp-stack > :deep(svg:first-child) { margin-left: 0; }
.mp-stack--glow > :deep(svg) { filter: drop-shadow(0 0 4px currentColor); }

.mp-effort-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  font-size: 15px;
  font-weight: 500;
  border: 0;
  background: transparent;
  cursor: pointer;
  opacity: 0.88;
  transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.mp-effort-toggle:hover {
  opacity: 1;
  transform: translateY(-1px);
}
.mp-effort-toggle:active {
  transform: translateY(0) scale(0.95);
}

.mp-effort-level-text {
  font-weight: 500;
  transition: color 0.18s ease;
}

.mp-fast-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  font-size: 15px;
  font-weight: 500;
  border: 0;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  opacity: 0.72;
  transition: opacity 0.18s ease, color 0.18s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.mp-fast-toggle:hover {
  opacity: 1;
  transform: translateY(-1px);
}
.mp-fast-toggle:active {
  transform: translateY(0) scale(0.95);
}
.mp-fast-toggle--on {
  color: #f5b300;
  opacity: 1;
  filter: drop-shadow(0 0 4px rgba(245, 179, 0, 0.4));
}

/* ── Provider swap ────────────────────────────────────────────────────────── */
.mp-swap-enter-active,
.mp-swap-leave-active {
  transition: opacity 0.2s ease, transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
.mp-swap-enter-from { opacity: 0; transform: translateX(-16px); }
.mp-swap-leave-to { opacity: 0; transform: translateX(16px); }

@media (prefers-reduced-motion: reduce) {
  .mp-swap-enter-active,
  .mp-swap-leave-active { transition-duration: 0.01s; }
  .mp-card { transition-duration: 0.01s; }
}
</style>
