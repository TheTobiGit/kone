<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useStorage } from "@vueuse/core";
import { motion } from "motion-v";
import ProviderLogo from "~/components/ProviderLogo.vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon, StarIcon, Settings02Icon, FlashIcon, Search01Icon, Cancel01Icon, Clock01Icon } from "@hugeicons/core-free-icons";
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
  /** The active context-window id (Claude's 200k/1m auto-compact window), when
   *  the model exposes a choice; undefined falls back to the model's default. */
  contextWindow?: string;
}>();

type ModelPick = {
  provider: ProviderKind;
  modelId: string;
  tier: EffortTier;
  fastMode: boolean;
  contextWindow?: string;
};

const emit = defineEmits<{
  /** Commit a provider + model + effort + fast-mode + context-window, and close. */
  select: [picked: ModelPick];
  /** Live-apply a tweak (reasoning effort/fast mode/context window) without
   *  closing — rides straight to the composer input so the setting takes effect
   *  and sticks as you adjust. Only fired for the active provider (a
   *  cross-provider tweak is staged until you select, since it can't apply to
   *  the running session). */
  apply: [picked: ModelPick];
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
  /** True when the provider's catalog names this model's `fast` tier as its
   *  DEFAULT service tier — a first-time selection of this model should start
   *  with the fast toggle on rather than off. */
  fastDefault?: boolean;
  /** This model's context-window choices (Claude's 200k/1m auto-compact
   *  window), when it exposes more than one. */
  contextWindows?: { id: string; label: string; tokens: number; isDefault?: boolean }[];
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
      ...(o.fastDefault ? { fastDefault: o.fastDefault } : {}),
      ...(o.contextWindows ? { contextWindows: o.contextWindows } : {}),
    })),
  })),
);

// ── search ──────────────────────────────────────────────────────────────────
// A client-side filter over every provider's models. While a query is up the
// list swaps to ranked results across all providers: favorites first, then
// match quality (exact label, label prefix, label/vendor/raw-id/provider
// containment), then label order. The rail stays put — a result row carries
// its own provider (`providerId`/`origin`), so selecting one from another
// provider switches engines exactly like browsing its tab would.
const query = ref("");
const searching = computed(() => query.value.trim().length > 0);

function scoreModel(m: MModel, provider: MProvider, q: string): number {
  const label = m.label.toLowerCase();
  if (label === q) return 0;
  if (label.startsWith(q)) return 1;
  if (label.includes(q)) return 2;
  if (m.vendor.toLowerCase().includes(q)) return 3;
  if (m.key.toLowerCase().includes(q)) return 4;
  if (m.efforts.some((e) => e.modelId.toLowerCase().includes(q))) return 4;
  if (provider.label.toLowerCase().includes(q)) return 5;
  return -1;
}

type SearchHit = { model: MModel; score: number };

const searchResults = computed<SearchHit[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const p of realProviders.value) {
    for (const m of p.models) {
      if (seen.has(m.key)) continue;
      const score = scoreModel(m, p, q);
      if (score >= 0) {
        seen.add(m.key);
        hits.push({ model: m, score });
      }
    }
  }
  // Favorites ride along, deduped by key — a starred model's real row usually
  // already scored above; this catches anything only reachable through its
  // starred origin. Favorites are ranked first by the sort below.
  for (const m of favorites.value.models) {
    if (seen.has(m.key)) continue;
    const score = scoreModel(m, favorites.value, q);
    if (score >= 0) {
      seen.add(m.key);
      hits.push({ model: m, score });
    }
  }
  hits.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const af = isFavorited(a.model.key) ? 0 : 1;
    const bf = isFavorited(b.model.key) ? 0 : 1;
    if (af !== bf) return af - bf;
    return a.model.label.localeCompare(b.model.label);
  });
  return hits;
});

// The rows shown in the list well: ranked search results while a query is up,
// else the open provider tab's models. One list, one row markup.
const displayModels = computed<MModel[]>(() =>
  searching.value ? searchResults.value.map((h) => h.model) : (provider.value?.models ?? []),
);

function onSearchEsc() {
  // Esc in the search field clears the query first; a second Esc closes the
  // whole picker (the root handler would have done that had we not stopped it).
  if (query.value) query.value = "";
  else cancel();
}

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

// ── Recent ────────────────────────────────────────────────────────────────
// A live shelf of the models the user last selected, most-recent first, drawn
// from every installed provider. Mirrors Favorites: only real rows land here
// (we only record on a committed select), and each keeps a handle on its origin
// so picking one works exactly as it would in that provider's own list. Order
// follows `recentKeys` (an ordered list), not catalog order.
const recent = computed<MProvider>(() => {
  const byKey = new Map<string, { m: MModel; label: string; ready: boolean }>();
  for (const p of realProviders.value) {
    for (const m of p.models) byKey.set(m.key, { m, label: p.label, ready: p.ready });
  }
  const picks: MModel[] = [];
  for (const key of recentKeys.value) {
    const hit = byKey.get(key);
    if (hit) picks.push({ ...hit.m, origin: { label: hit.label, ready: hit.ready } });
  }
  return {
    id: "recent",
    label: "Recent",
    sub: "Recently used",
    brand: "codex",
    ready: false,
    models: picks,
  };
});

// Favorites and Recent lead the rail — but each only once it has content. With
// an empty shelf the tab would go nowhere, so it stays hidden until then.
const providers = computed<MProvider[]>(() => {
  const leading: MProvider[] = [];
  if (favorites.value.models.length) leading.push(favorites.value);
  if (recent.value.models.length) leading.push(recent.value);
  return [...leading, ...realProviders.value];
});

// ── navigation ──────────────────────────────────────────────────────────────
const provider = ref<MProvider | null>(null);

// A click on a non-ready provider's row only focuses it — a quiet checkmark,
// never applied. (No provider is non-ready today; kept so a future provider
// can be browsed before it's wired up.) Seeded from the current session model
// on open.
const pending = ref<{
  provider: MProvider;
  model: MModel;
  effort: MEffort;
  fastMode: boolean;
  /** The context-window id staged for this model — undefined for a
   *  single-window model (nothing to choose). */
  contextWindow?: string;
} | null>(null);

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
// active on — any other row starts from its catalog default (`fastDefault`,
// the provider's own default service tier), same as effort falls back to the
// family default rather than a stale tier.
function matchFastMode(m: MModel): boolean {
  return isCurrentModel(m) ? (props.fastMode ?? false) : (m.fastDefault ?? false);
}

// The context window a model resolves to: the session value for the active model
// (when the family still offers it), else the family's default. Any other model
// starts from its own default — same as effort/fast fall back rather than
// carrying a stale value. Undefined for a single-window model (no choice).
function matchContextWindow(m: MModel): string | undefined {
  const windows = m.contextWindows;
  if (!windows?.length) return undefined;
  if (isCurrentModel(m)) {
    const keep = windows.find((w) => w.id === props.contextWindow);
    if (keep) return keep.id;
  }
  return (windows.find((w) => w.isDefault) ?? windows[0])?.id;
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
        pending.value = {
          provider: p,
          model: m,
          effort: e,
          fastMode: props.fastMode ?? false,
          contextWindow: matchContextWindow(m),
        };
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
function focus(
  m: MModel,
  e: MEffort,
  fastMode = matchFastMode(m),
  contextWindow = matchContextWindow(m),
) {
  if (!provider.value) return;
  pending.value = { provider: provider.value, model: m, effort: e, fastMode, contextWindow };
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
  const contextWindow = isPendingModel ? pending.value!.contextWindow : matchContextWindow(m);
  if (!provider.value || !e) return;
  recordRecent(m.key);
  close(() => emit("select", { provider: m.providerId, modelId: e.modelId, tier: e.tier, fastMode, contextWindow }));
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
// the Favorites shelf stays fully applicable. Persisted to localStorage so the
// shelf survives the modal closing (it unmounts) and an app restart — Set has no
// native JSON form, so we serialise it as a plain array of keys.
const favoritedKeys = useStorage<Set<string>>(
  "kone:favorite-models",
  new Set<string>(),
  undefined,
  {
    serializer: {
      read: (raw) => new Set<string>(raw ? (JSON.parse(raw) as string[]) : []),
      write: (set) => JSON.stringify([...set]),
    },
  },
);
// The recently-selected model keys, most-recent first. Persisted to localStorage
// so the Recent shelf survives the modal closing (it unmounts) and an app
// restart. Capped so the tab stays a shortlist, not a full history.
const RECENT_CAP = 8;
const recentKeys = useStorage<string[]>("kone:recent-models", []);

const activeSettingsModelKey = ref<string | null>(null);

function isFavorited(key: string): boolean {
  return favoritedKeys.value.has(key);
}

// Record a committed pick at the head of the Recent shelf (deduped, capped).
function recordRecent(key: string) {
  recentKeys.value = [key, ...recentKeys.value.filter((k) => k !== key)].slice(0, RECENT_CAP);
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
function applyLive(fastMode: boolean, contextWindow = pending.value?.contextWindow) {
  const p = pending.value;
  if (!p || !modelReady(p.model)) return;
  if (p.model.providerId !== props.activeProvider) return;
  emit("apply", {
    provider: p.model.providerId,
    modelId: p.effort.modelId,
    tier: p.effort.tier,
    fastMode,
    contextWindow,
  });
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

// Context window — cycle the model's windows (Claude's 200k/1m auto-compact
// window). Two windows makes this a toggle; the label carries the state. Applies
// live exactly like cycleEffort/toggleFastMode.
function cycleContextWindow() {
  const p = pending.value;
  const windows = p?.model.contextWindows;
  if (!p || !windows || windows.length <= 1) return;
  const idx = windows.findIndex((w) => w.id === p.contextWindow);
  const next = windows[(idx + 1) % windows.length]!;
  p.contextWindow = next.id;
  applyLive(p.fastMode, next.id);
}

// The context-window label to show on a row: the pending choice if this row is
// the one being tuned, else its resting (session/default) window. Null when the
// model has no window choice — mirrors reasoningMeta/fastModeOn.
function contextWindowMeta(m: MModel): string | null {
  const windows = m.contextWindows;
  if (!windows?.length) return null;
  const id = pending.value?.model.key === m.key ? pending.value.contextWindow : matchContextWindow(m);
  return windows.find((w) => w.id === id)?.label ?? null;
}

// The label of the window currently staged for the tuned model — drives the
// settings-bar cycle button.
const pendingWindowLabel = computed(() => {
  const p = pending.value;
  if (!p?.model.contextWindows?.length) return null;
  return p.model.contextWindows.find((w) => w.id === p.contextWindow)?.label ?? null;
});

function brainStack(count?: number): number[] {
  return Array.from({ length: Math.max(1, count ?? 1) }, (_, i) => i);
}

// Is there anything to configure? Drives whether the gear button shows, so it
// never opens an empty bar. A model has settings when it offers more than one
// reasoning effort, a fast tier, or a context-window choice.
function hasSettings(m: MModel): boolean {
  return m.efforts.length > 1 || Boolean(m.fastTier) || (m.contextWindows?.length ?? 0) > 1;
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
// A leading tab (Favorites / Recent) can lose its last row — step off it onto a
// real provider if it's the one open, so the list never strands on a dead tab.
watch(
  () => [favorites.value.models.length, recent.value.models.length] as const,
  ([favN, recN]) => {
    const open = provider.value?.id;
    if (open === "favorites" && favN === 0) provider.value = realProviders.value[0] ?? null;
    else if (open === "recent" && recN === 0) provider.value = realProviders.value[0] ?? null;
  },
);

let opener: HTMLElement | null = null;
onMounted(() => {
  opener = document.activeElement as HTMLElement | null;
  seedPending();
  // Favourites hydrate from localStorage (see `favoritedKeys`); don't re-seed
  // here — doing so used to wipe the user's stars on every open.
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
      class="mp-card relative z-20 w-full max-w-sm overflow-hidden"
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
              <HugeiconsIcon
                v-else-if="p.id === 'recent'"
                :icon="Clock01Icon"
                :size="19"
                :stroke-width="1.6"
                class="mp-clock"
              />
              <ProviderLogo v-else :brand="p.brand" :size="20" />
            </button>
          </aside>

          <!-- The model list is the dark content well inside the lighter shell. -->
          <div class="mp-content relative">
            <!-- Search — filters every provider's models by name / id / vendor.
                 With a query up, the list becomes ranked results across all
                 providers (favorites first, then match quality). -->
            <div class="mp-search">
              <HugeiconsIcon
                :icon="Search01Icon"
                :size="14"
                :stroke-width="2"
                class="mp-search__icon"
                aria-hidden="true"
              />
              <input
                v-model="query"
                class="mp-search__input"
                type="text"
                placeholder="Search models…"
                aria-label="Search models"
                spellcheck="false"
                autocomplete="off"
                @keydown.esc.stop="onSearchEsc"
              />
              <button
                v-if="query"
                type="button"
                class="mp-search__clear"
                aria-label="Clear search"
                title="Clear search"
                @click.stop="query = ''"
              >
                <HugeiconsIcon :icon="Cancel01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
              </button>
            </div>
            <Transition name="mp-swap" mode="out-in">
              <div v-if="provider" :key="searching ? 'search' : provider.id" class="mp-scroll">
                <p v-if="!displayModels.length" class="mp-empty">
                  {{ searching
                    ? `No models match “${query.trim()}”.`
                    : provider.id === 'favorites'
                      ? 'No favorites yet — star a model to keep it here.'
                      : provider.id === 'recent'
                        ? 'No recent models yet — pick one to see it here.'
                        : 'No models available.' }}
                </p>
                <button
                  v-for="m in displayModels"
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
                      <span
                        v-if="contextWindowMeta(m)"
                        class="mp-meta-ctx"
                        :title="`Context window · ${contextWindowMeta(m)}`"
                      >
                        {{ contextWindowMeta(m) }}
                      </span>
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

          <!-- Context window: cycle the model's windows (Claude's 200k/1m
               auto-compact window). The label carries the state. -->
          <div
            v-if="pending.model.contextWindows && pending.model.contextWindows.length > 1"
            class="mp-footer-group"
          >
            <button
              type="button"
              class="mp-ctx-toggle"
              :aria-label="`Context window: ${pendingWindowLabel}. Click to change.`"
              :title="`Context window · ${pendingWindowLabel}`"
              @click.stop="cycleContextWindow"
            >
              <span class="mp-ctx-toggle-text">{{ pendingWindowLabel }}</span>
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
.mp-clock {
  color: var(--ink);
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
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px;
  scrollbar-width: none;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
}
.mp-scroll::-webkit-scrollbar { width: 0; height: 0; }

/* Search — a quiet field across the top of the content well. The list below
   it flexes to share the well, so a query never clips the rows. */
.mp-search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  margin: 10px 10px 0;
  padding: 7px 10px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 7%, transparent);
  color: var(--muted);
}
.mp-search__icon {
  flex: none;
  opacity: 0.7;
}
.mp-search__input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  font-size: 12.5px;
  color: var(--ink);
}
.mp-search__input::placeholder {
  color: var(--muted);
}
.mp-search__clear {
  display: inline-flex;
  flex: none;
  padding: 2px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.mp-search__clear:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}

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

/* The context-window indicator: a compact monospace token count (200K / 1M),
   dim by default and lifting on row hover like the reasoning brains. */
.mp-meta-ctx {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--muted);
  opacity: 0.72;
  font-variant-numeric: tabular-nums;
  transition: opacity 0.14s ease;
}
.mp-row:hover .mp-meta-ctx { opacity: 1; }

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

/* Context-window cycle — a plain label pill matching the composer's ctxwin. */
.mp-ctx-toggle {
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
  transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.mp-ctx-toggle:hover {
  opacity: 1;
  transform: translateY(-1px);
}
.mp-ctx-toggle:active {
  transform: translateY(0) scale(0.95);
}
.mp-ctx-toggle-text {
  font-variant-numeric: tabular-nums;
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
