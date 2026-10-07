<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import CreateRouteModal from "~/components/presets/CreateRouteModal.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import ToggleSwitch from "~/components/ui/ToggleSwitch.vue";
import { useAgentProviders } from "~/composables/useAgentProviders";
import { useModelPreferences } from "~/composables/useModelPreferences";
import { useSound } from "~/composables/useSound";
import { buildModelCatalog, describeModelId, effortMeta, isEffortTier, sessionBrand } from "~/utils/modelCatalog";
import { PROVIDER_BRAND } from "~/utils/modelPicker";
import { isBuiltInModelPreference } from "@kone/protocol/model-preferences";
import type { ModelPreference } from "~/types/desktop";

// The Rules half of the Teams page: each rule sends a kind of work to a model.
// The built-ins always stand and are only switched off; the user's own sit
// beside them and can be removed. A rule reaches an agent only when it is on
// and has a model, so the list says which are live. It owns its own editor,
// since nothing else on the page opens it.

const props = defineProps<{
  /** Whether the drawer is showing — closing it closes the editor too. */
  open: boolean;
  /** Whether the cards have already dealt in, so a return visit doesn't replay it. */
  dealt: boolean;
}>();

const { preferences: routes, canAdd, setEnabled, removeRoute } = useModelPreferences();
const { modelCache, prepare: prepareProviders } = useAgentProviders();
const { cue } = useSound();
onMounted(() => void prepareProviders());

// ── the editor ──────────────────────────────────────────────────────────────
// Closed, a rule open for rewriting (its kind), or a blank card (no kind).
const editing = ref<{ kind: string | null } | null>(null);

const editingRoute = computed(() => {
  const kind = editing.value?.kind;
  return kind ? (routes.value.find((r) => r.kind === kind) ?? null) : null;
});

watch(
  () => props.open,
  (open) => {
    if (!open) editing.value = null;
  },
);

function openRoute(kind: string) {
  editing.value = { kind };
  cue("show");
}

/** Open a blank card. False when the list is full, so the caller can tell
 *  nothing opened. */
function create(): boolean {
  if (!canAdd.value) return false;
  editing.value = { kind: null };
  cue("show");
  return true;
}
defineExpose({ create });

// ── the list ────────────────────────────────────────────────────────────────
const sections = computed(() => [
  { id: "builtin", title: "Built-in", rows: routes.value.filter((r) => isBuiltInModelPreference(r.kind)) },
  { id: "custom", title: "Custom", rows: routes.value.filter((r) => !isBuiltInModelPreference(r.kind)) },
]);

/** Flip a rule's switch. One with no model has nothing to run on, so switching
 *  it on opens the editor to pick one — saving that switches it on. */
function toggle(route: ModelPreference, on: boolean) {
  if (on && !route.model) {
    openRoute(route.kind);
    return;
  }
  void setEnabled(route.kind, on);
}

/** A route's model by name, or nothing when it has none — the row says "Not
 *  set" itself, since that is what keeps it from agents. */
function routeModel(route: ModelPreference): string | null {
  if (!route.model) return null;
  const catalog = buildModelCatalog(modelCache.value[route.model.provider] ?? [], route.model.provider);
  return describeModelId(route.model.model, catalog).name;
}

function routeEffort(route: ModelPreference): string | null {
  return isEffortTier(route.effort) ? effortMeta(route.effort).label : null;
}

function routeBrand(route: ModelPreference) {
  const { provider, model } = route.model!;
  return sessionBrand(provider, PROVIDER_BRAND[provider], model);
}

// Removing asks twice: the first press arms the row, the second removes it, and
// the arm lapses on its own, so a stray click never costs a rule.
const armed = ref<string | null>(null);
let armTimer: ReturnType<typeof setTimeout> | undefined;

function pressRemove(kind: string) {
  clearTimeout(armTimer);
  if (armed.value === kind) {
    armed.value = null;
    void removeRoute(kind);
    cue("discard");
    return;
  }
  armed.value = kind;
  armTimer = setTimeout(() => (armed.value = null), 3000);
  cue("press");
}
onBeforeUnmount(() => clearTimeout(armTimer));
</script>

<template>
  <div class="tm__stack" :class="{ 'is-dealt': dealt }">
    <CreateRouteModal v-if="editing && editing.kind === null" @close="editing = null" @saved="editing = null" />
    <CreateRouteModal
      v-else-if="editingRoute"
      :key="editingRoute.kind"
      :route="editingRoute"
      @close="editing = null"
      @saved="editing = null"
    />

    <section v-for="(sec, si) in sections" :key="sec.id" class="tm-kind" :aria-label="sec.title">
      <header class="tm-kind__head">
        <span class="tm-kind__title">{{ sec.title }}</span>
        <span class="tm-kind__meta">{{ sec.rows.length }}</span>
        <span class="tm-kind__rule" aria-hidden="true" />
      </header>

      <div v-if="sec.rows.length" class="tm-map" role="list" :aria-label="sec.title">
        <article
          v-for="(r, i) in sec.rows"
          :key="r.kind"
          role="listitem"
          class="tm-map__row"
          :class="{ 'is-unset': !r.model, 'is-off': !r.enabled }"
          :style="{ '--i': si * sections[0]!.rows.length + i }"
          :tabindex="open ? 0 : -1"
          :aria-label="`${r.label}, ${routeModel(r) ?? 'no model set'}${r.enabled ? '' : ', off'}`"
          @click="openRoute(r.kind)"
          @keydown.enter.prevent="openRoute(r.kind)"
          @keydown.space.prevent="openRoute(r.kind)"
        >
          <div class="tm-map__kind">
            <h4 class="tm-map__name">{{ r.label }}</h4>
            <p v-if="r.hint" class="tm-map__hint">{{ r.hint }}</p>
          </div>
          <span class="tm-map__model">
            <template v-if="r.model">
              <ProviderLogo :brand="routeBrand(r)" :size="14" />
              <span class="tm-map__modelname">{{ routeModel(r) }}</span>
              <span v-if="routeEffort(r)" class="tm-map__effort">{{ routeEffort(r) }}</span>
            </template>
            <span v-else class="tm-map__modelname">Not set</span>
          </span>
          <div class="tm-map__act" @click.stop @keydown.stop>
            <button
              v-if="sec.id === 'custom'"
              type="button"
              class="tm-route__remove"
              :class="{ 'is-armed': armed === r.kind }"
              :tabindex="open ? 0 : -1"
              :aria-label="armed === r.kind ? `Confirm removing ${r.label}` : `Remove ${r.label}`"
              @click="pressRemove(r.kind)"
              @blur="armed === r.kind && (armed = null)"
            >
              <HugeiconsIcon :icon="Delete02Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
              <span v-if="armed === r.kind">Remove?</span>
            </button>
            <ToggleSwitch
              :model-value="r.enabled"
              :aria-label="r.label"
              @update:model-value="toggle(r, $event)"
            />
          </div>
        </article>
      </div>
      <p v-else class="tm-route__empty">None yet. Add one for a kind of work the built-ins don't cover.</p>

      <button
        v-if="sec.id === 'custom' && canAdd"
        type="button"
        class="tm-add tm-add--sub"
        :style="{ '--i': routes.length }"
        :tabindex="open ? 0 : -1"
        @click="create"
      >
        <span class="tm-add__ring" aria-hidden="true">
          <HugeiconsIcon :icon="Add01Icon" :size="16" :stroke-width="1.6" />
        </span>
        <span class="tm-add__label">New rule</span>
      </button>
    </section>
  </div>
</template>

<style scoped src="./teamsRows.css"></style>

<style scoped>
.tm-route__empty {
  max-width: 52ch;
  margin: 0;
  padding-inline: 6px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--muted);
  text-wrap: pretty;
}
/* The remove control stays out of the way until the row is being looked at,
   then asks twice — the first press arms it and it says so. */
.tm-route__remove {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding-inline: 7px;
  border-radius: 8px;
  font-size: 11.5px;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 160ms ease,
    background-color 140ms ease,
    color 140ms ease;
}
.tm-map__row:is(:hover, :focus-within) .tm-route__remove,
.tm-route__remove.is-armed {
  opacity: 1;
}
.tm-route__remove:hover {
  color: var(--ink);
  background-color: var(--hover);
}
.tm-route__remove.is-armed {
  color: #e05252;
  background-color: color-mix(in srgb, #e05252 14%, transparent);
}
.tm-route__remove:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
@media (hover: none) {
  .tm-route__remove {
    opacity: 1;
  }
}
/* A rule is a setting, not a thing you define: one kind of work and the
   model it goes to, read across a line. So the list is a single column of
   rows on hairlines, the model set in a chip at the right edge — nothing like
   the worker cards, which carry a glyph and a brief because each is its own
   definition. */
.tm-map {
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  background: color-mix(in srgb, var(--ink) 3%, transparent);
  overflow: hidden;
}
.tm-map__row {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 52px;
  padding: 10px 10px 10px 16px;
  cursor: pointer;
  outline: none;
  animation: tm-deal 460ms var(--tm-ease) calc(var(--i, 0) * 28ms + 40ms) backwards;
  transition: background-color 160ms ease;
}
.tm__stack.is-dealt .tm-map__row {
  animation: none;
}
.tm-map__row + .tm-map__row {
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ink) 7%, transparent);
}
.tm-map__row:hover {
  background-color: color-mix(in srgb, var(--ink) 3%, transparent);
}
.tm-map__row:focus-visible {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.tm-map__kind {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.tm-map__name {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.25;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tm-map__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The chip is the answer the row gives. Unset, it turns to a dashed outline:
   a slot still waiting on a model, which is why no agent hears of it. */
.tm-map__model {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  max-width: 50%;
  height: 28px;
  padding-inline: 9px 11px;
  border-radius: 999px;
  background: var(--panel);
  font-size: 12.5px;
  color: var(--ink);
}
.tm-map__modelname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tm-map__effort {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}
.tm-map__row.is-unset .tm-map__model {
  padding-inline: 11px;
  background: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 16%, transparent);
  color: var(--muted);
}
.tm-map__row.is-unset .tm-map__name {
  color: var(--ink-soft);
}

.tm-map__act {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  cursor: default;
}
/* Off reads as benched, not broken: the words and the chip fade back, the
   switch stays at full strength so turning it on again is the obvious move. */
.tm-map__row.is-off :is(.tm-map__kind, .tm-map__model) {
  opacity: 0.5;
}

@media (prefers-reduced-motion: reduce) {
  .tm-map__row {
    animation: none;
    transition: none;
  }
}
</style>
