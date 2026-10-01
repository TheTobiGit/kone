<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Add01Icon, Delete02Icon, Route01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import CreateRouteModal from "~/components/presets/CreateRouteModal.vue";
import { useAgentProviders } from "~/composables/useAgentProviders";
import { useModelPreferences } from "~/composables/useModelPreferences";
import { useSound } from "~/composables/useSound";
import { buildModelCatalog, describeModelId, effortMeta, isEffortTier } from "~/utils/modelCatalog";
import type { ModelPreference } from "~/types/desktop";

// The routing half of the Teams page: the user's own categories of work, each
// sent to a model. A category with no model is kept but dormant — no agent is
// told of it — so the list says which are live and which are still waiting on
// one. It owns its own editor, since nothing else on the page opens it.

const props = defineProps<{
  /** Whether the drawer is showing — closing it closes the editor too. */
  open: boolean;
  /** Whether the cards have already dealt in, so a return visit doesn't replay it. */
  dealt: boolean;
}>();

const { preferences: routes, routedCount, canAdd, removeRoute, restoreSuggested } = useModelPreferences();
const { modelCache, prepare: prepareProviders } = useAgentProviders();
const { cue } = useSound();
onMounted(() => void prepareProviders());

// ── the editor ──────────────────────────────────────────────────────────────
// Closed, a category open for rewriting (its kind), or a blank card (no kind).
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
  cue("press");
}

/** Open a blank card. False when the list is full, so the caller can tell
 *  nothing opened. */
function create(): boolean {
  if (!canAdd.value) return false;
  editing.value = { kind: null };
  cue("open");
  return true;
}
defineExpose({ create });

// ── the list ────────────────────────────────────────────────────────────────
/** A route's model as a line of text: its name, and the effort when it has one.
 *  A category with none says so, since that is what keeps it from agents. */
function routeModel(route: ModelPreference): string {
  if (!route.model) return "Not set";
  const catalog = buildModelCatalog(modelCache.value[route.model.provider] ?? [], route.model.provider);
  const name = describeModelId(route.model.model, catalog).name;
  return isEffortTier(route.effort) ? `${name} · ${effortMeta(route.effort).label}` : name;
}

// Removing asks twice: the first press arms the row, the second removes it, and
// the arm lapses on its own, so a stray click never costs a category.
const armed = ref<string | null>(null);
let armTimer: ReturnType<typeof setTimeout> | undefined;

function pressRemove(kind: string) {
  clearTimeout(armTimer);
  if (armed.value === kind) {
    armed.value = null;
    void removeRoute(kind);
    cue("press");
    return;
  }
  armed.value = kind;
  armTimer = setTimeout(() => (armed.value = null), 3000);
  cue("toggle");
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

    <section class="tm-kind" aria-label="Categories">
      <header class="tm-kind__head">
        <span class="tm-kind__title">Categories</span>
        <span class="tm-kind__meta">{{ routes.length }}</span>
        <span class="tm-kind__rule" aria-hidden="true" />
      </header>

      <p v-if="!routes.length" class="tm-route__empty">
        No categories. Name a kind of work and pick the model it runs on, and agents
        hand that work to it instead of keeping it on their own.
        <button
          type="button"
          class="tm-route__restore"
          :tabindex="open ? 0 : -1"
          @click="restoreSuggested"
        >
          Bring back the suggested ones
        </button>
      </p>
      <p v-else-if="!routedCount" class="tm-route__empty">
        These are suggestions. Give one a model and agents start sending that kind of
        work there; until then none of them is told about it.
      </p>

      <div class="tm__rows" role="list" aria-label="Categories">
        <article
          v-for="(r, i) in routes"
          :key="r.kind"
          role="listitem"
          class="tm-sub tm-sub--custom"
          :class="{ 'is-off': !r.model }"
          :style="{ '--i': i }"
          :tabindex="open ? 0 : -1"
          :aria-label="`${r.label}${r.model ? '' : ', no model set'}`"
          @click="openRoute(r.kind)"
          @keydown.enter.prevent="openRoute(r.kind)"
          @keydown.space.prevent="openRoute(r.kind)"
        >
          <span class="tm-sub__glyph" aria-hidden="true">
            <HugeiconsIcon :icon="Route01Icon" :size="18" :stroke-width="1.7" />
          </span>
          <div class="tm-sub__body">
            <div class="tm-sub__line">
              <h4 class="tm-sub__name">{{ r.label }}</h4>
              <span class="tm-sub__model">{{ routeModel(r) }}</span>
            </div>
            <p class="tm-sub__brief">
              {{ r.hint || "No description — agents would choose this by name alone." }}
            </p>
          </div>
          <div class="tm-sub__act" @click.stop @keydown.stop>
            <button
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
          </div>
        </article>

        <button
          v-if="canAdd"
          type="button"
          class="tm-add tm-add--sub"
          :style="{ '--i': routes.length }"
          :tabindex="open ? 0 : -1"
          @click="create"
        >
          <span class="tm-add__ring" aria-hidden="true">
            <HugeiconsIcon :icon="Add01Icon" :size="16" :stroke-width="1.6" />
          </span>
          <span class="tm-add__label">New category</span>
        </button>
      </div>
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
.tm-route__restore {
  display: block;
  margin-top: 6px;
  font-size: 12.5px;
  color: var(--ink-soft);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--ink) 25%, transparent);
  text-underline-offset: 3px;
  transition: color 140ms ease;
}
.tm-route__restore:hover {
  color: var(--ink);
}
/* The remove control stays out of the way until the card is being looked at,
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
.tm-sub:is(:hover, :focus-within) .tm-route__remove,
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
</style>
