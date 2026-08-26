<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ListViewIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import ModelPickerModal from "~/components/model/ModelPickerModal.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import {
  buildModelCatalog,
  describeModelId,
  EFFORT_META,
  type EffortTier,
  type ModelOption,
  type PickerProvider,
} from "~/utils/modelCatalog";
import type { InteractionMode, ProviderKind } from "~/types/desktop";
import {
  DEFAULT_MODE_KEY,
  DEFAULT_MODEL_KEY,
  DEFAULT_PROVIDER_KEY,
  DEFAULT_REASONING_KEY,
  PROVIDER_BRAND,
  PROVIDER_VENDOR,
} from "~/utils/modelPicker";
import type { ModelPick } from "~/composables/useModelCommit";
import SettingsInlineChoice from "~/components/settings/SettingsInlineChoice.vue";
import { usePaneWidthPrefs } from "~/composables/usePaneWidthPrefs";
import type { PaneKind } from "~/types/studio";
import { LADDER_PX } from "~/utils/stripScroll";

// The Studio pane — what the studio hands the next thing you open, in two
// groups: what the *composer* starts a chat with (which model answers, how much
// it may do without asking), and how wide each kind of *pane* opens.
//
// All app-wide *defaults*, not live state: this never touches a running thread
// or a pane already on the board. It writes the keys a project reads at boot
// (utils/modelPicker) and the rungs useStudio hands a pane it's about to mint.
// Anything that already carries its own choice keeps it; these seed the ones
// that don't.

defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

const { cue } = useSound();
const providers = useAgentProviders();
const providerSettings = useProviderSettings();

// The picker reads live catalogs; prime them once so opening it isn't a cold CLI
// handshake. Shared singleton — cheap if another surface already warmed it.
onMounted(() => void providers.prepare());

// Raw provider lists → the picker's family catalogs. Same transform StudioRow
// runs for the composer's picker, so both offer the same models.
const catalogs = computed<Partial<Record<ProviderKind, ModelOption[]>>>(() => {
  const out: Partial<Record<ProviderKind, ModelOption[]>> = {};
  for (const [prov, list] of Object.entries(providers.modelCache.value)) {
    if (list) out[prov as ProviderKind] = buildModelCatalog(list);
  }
  return out;
});

// One rail entry per ready, enabled provider, each filtered through the same
// per-model visibility the providers pane writes. No agent pin narrows it here —
// a default belongs to the app, not to whichever agent the composer points at.
const enabledReady = computed(() =>
  providers.ready.value.filter((s) => providerSettings.isEnabled(s.provider)),
);
const pickerProviders = computed<PickerProvider[]>(() => {
  const visible = providerSettings.modelVisiblePredicate.value;
  return enabledReady.value.map((s) => {
    const models = (catalogs.value[s.provider] ?? []).filter((m) => visible(s.provider, m.key));
    return {
      id: s.provider,
      label: s.label,
      sub: `${PROVIDER_VENDOR[s.provider]} · ${models.length} model${models.length === 1 ? "" : "s"}`,
      brand: PROVIDER_BRAND[s.provider],
      ready: s.readiness === "ready",
      models,
    };
  });
});

// ── the current default (read back from the same keys boot restores) ──────────
const currentProvider = ref<ProviderKind | null>(null);
const currentModel = ref<string | null>(null);
const currentReasoning = ref<EffortTier | null>(null);

onMounted(() => {
  if (!import.meta.client) return;
  currentProvider.value = (localStorage.getItem(DEFAULT_PROVIDER_KEY) as ProviderKind | null) ?? null;
  currentModel.value = localStorage.getItem(DEFAULT_MODEL_KEY);
  const tier = localStorage.getItem(DEFAULT_REASONING_KEY);
  currentReasoning.value = tier && tier in EFFORT_META ? (tier as EffortTier) : null;
});

// The active provider the modal opens on: the stored default, else the first
// provider that actually has models to offer.
const activeProvider = computed<ProviderKind>(
  () => currentProvider.value ?? pickerProviders.value[0]?.id ?? "claudeAgent",
);

// Name + logomark for the row. describeModelId resolves both from a bare id, and
// reads a richer label when the provider's catalog is loaded.
const modelDesc = computed(() =>
  currentModel.value
    ? describeModelId(currentModel.value, catalogs.value[activeProvider.value])
    : null,
);
const effortLabel = computed(() =>
  currentReasoning.value ? EFFORT_META[currentReasoning.value].label : "",
);

// ── model picker ──────────────────────────────────────────────────────────────
const pickerOpen = ref(false);
function togglePicker() {
  pickerOpen.value = !pickerOpen.value;
  cue(pickerOpen.value ? "expand" : "collapse");
}

// A pick here is a default, not a live commit — there is no session to restart.
// Persist exactly the three keys the boot restore reads (provider/model/effort);
// fast mode and context window ride a session, not the app-wide default.
function persistDefault(picked: ModelPick) {
  currentProvider.value = picked.provider;
  currentModel.value = picked.modelId;
  currentReasoning.value = picked.tier;
  if (import.meta.client) {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, picked.provider);
    localStorage.setItem(DEFAULT_MODEL_KEY, picked.modelId);
    localStorage.setItem(DEFAULT_REASONING_KEY, picked.tier);
  }
}

// `select` commits and dismisses; `apply` is an in-place tweak (effort/fast) the
// modal fires while still open, so it saves without closing.
function onModelSelect(picked: ModelPick) {
  persistDefault(picked);
  pickerOpen.value = false;
  cue("toggle");
}
function onModelApply(picked: ModelPick) {
  persistDefault(picked);
}

// ── default approval ──────────────────────────────────────────────────────────
// The same three-rung ladder the composer cycles. The row shows the rung that's
// set and opens the other two on click, so the pane reads as one value per line
// rather than three choices always on screen.
type ModeMeta = { id: InteractionMode; label: string };
const MODES: ModeMeta[] = [
  { id: "ask", label: "Ask user" },
  { id: "accept-edits", label: "Edits only" },
  { id: "full-access", label: "Full access" },
];

// No stored default reads as the app's own fallback (accept-edits) so the pane
// shows the rung a fresh project would actually open on.
const currentMode = ref<InteractionMode>("accept-edits");
onMounted(() => {
  if (!import.meta.client) return;
  const saved = localStorage.getItem(DEFAULT_MODE_KEY);
  if (saved && MODES.some((m) => m.id === saved)) currentMode.value = saved as InteractionMode;
});

function chooseMode(id: string) {
  if (currentMode.value === id) return;
  // SAFETY: the ids handed to the choice come from MODES, so anything it can
  // emit is an InteractionMode.
  currentMode.value = id as InteractionMode;
  if (import.meta.client) localStorage.setItem(DEFAULT_MODE_KEY, id);
}

// ── default pane widths ───────────────────────────────────────────────────────
// What width a newly opened pane takes, per kind. A pane already on the board
// keeps the width it was given — these only seed the next one, and they're the
// strip's own rungs, so a choice here is the width the strip will actually use.
const { paneWidths, defaultWidth, setDefaultWidth } = usePaneWidthPrefs();

const WIDTH_OPTIONS = LADDER_PX.map((px, i) => ({ id: String(i), label: `${px}px` }));

/** One row per kind, named for the thing it opens rather than its internal kind.
 *  `paneName` is the same thing in a sentence, for the control's aria label. */
const WIDTH_ROWS: { kind: PaneKind; title: string; paneName: string }[] = [
  { kind: "thread", title: "Chat width", paneName: "chat pane" },
  { kind: "terminal", title: "Terminal width", paneName: "terminal" },
  { kind: "scratchpad", title: "Scratchpad width", paneName: "scratchpad" },
];

/** Read through the stored record so a change re-renders the row. */
function widthValue(kind: PaneKind): string {
  void paneWidths.value;
  return String(defaultWidth(kind));
}

function chooseWidth(kind: PaneKind, id: string) {
  setDefaultWidth(kind, Number(id));
}
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Ecosystem / Studio"
    :breadcrumb-icon="ListViewIcon"
    label="Studio defaults"
    @back="$emit('back')"
  >
    <!-- Each setting is one line: its name on the left, what it's set to on the
         right, under the part of the studio it belongs to. The pane's note
         carries what these defaults mean, so a row never explains itself. -->
    <div class="studio__group">
      <h2 class="studio__heading">Composer</h2>
      <div class="studio__rows">
        <!-- Default model ─────────────────────────────────────────────────── -->
        <div class="studio__row">
          <h3 class="studio__title">Default model</h3>

          <div class="studio__value">
            <button
              type="button"
              class="studio__pick"
              :tabindex="open ? 0 : -1"
              aria-haspopup="dialog"
              aria-label="Change the default model"
              @click="togglePicker"
            >
              <span class="studio__pick-face">
                <ProviderLogo
                  v-if="modelDesc && modelDesc.brand !== 'generic'"
                  :brand="modelDesc.brand"
                  :size="17"
                />
                <span class="studio__pick-name">{{ modelDesc?.name ?? "Provider default" }}</span>
                <span v-if="effortLabel" class="studio__pick-effort">{{ effortLabel }}</span>
              </span>
              <HugeiconsIcon
                class="studio__pick-chev"
                :class="{ 'studio__pick-chev--on': pickerOpen }"
                :icon="ArrowRight01Icon"
                :size="15"
                :stroke-width="1.8"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        <!-- Default approval ───────────────────────────────────────────────── -->
        <div class="studio__row">
          <h3 class="studio__title">Default approval</h3>

          <SettingsInlineChoice
            :options="MODES"
            :value="currentMode"
            :tabbable="open"
            setting="the default approval mode"
            @pick="chooseMode"
          />
        </div>
      </div>
    </div>

    <!-- Panes — how wide each kind opens. The rungs are the strip's own, so a
         choice here is the width the board will actually use. -->
    <div class="studio__group">
      <h2 class="studio__heading">Panes</h2>
      <div class="studio__rows">
        <div v-for="row in WIDTH_ROWS" :key="row.kind" class="studio__row">
          <h3 class="studio__title">{{ row.title }}</h3>

          <SettingsInlineChoice
            :options="WIDTH_OPTIONS"
            :value="widthValue(row.kind)"
            :tabbable="open"
            :setting="`the width a new ${row.paneName} opens at`"
            @pick="(id) => chooseWidth(row.kind, id)"
          />
        </div>
      </div>
    </div>

    <!-- Teleported to the body because the drawer's aside is overflow-hidden and
         rides a transformed stage, which would clip a fixed child. The picker is
         pane-anchored, so the shell it opens still lands in the pane's own
         bottom-right corner rather than over the whole app. -->
    <Teleport to="body">
      <ModelPickerModal
        v-if="pickerOpen"
        pane-anchored
        :providers="pickerProviders"
        :active-provider="activeProvider"
        :model-id="currentModel ?? undefined"
        :reasoning="currentReasoning ?? undefined"
        :fast-mode="false"
        @select="onModelSelect"
        @apply="onModelApply"
        @cancel="pickerOpen = false"
      />
    </Teleport>

    <template #foot>
      These are defaults, not a live session — changing them here never disturbs a chat that's
      already open, or a pane already on the board. Each seeds what the next one starts from.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
/* ── groups ────────────────────────────────────────────────────────────────── */
.studio__group {
  padding-block: 0.5rem 1.5rem;
}
.studio__group + .studio__group {
  margin-top: 0.5rem;
}
/* The part of the studio a group's rows belong to, in the pane's eyebrow voice
   so it names the group without competing with the settings under it. */
.studio__heading {
  font-size: 10px;
  letter-spacing: 0.08em;
  line-height: 1;
  text-transform: uppercase;
  color: var(--muted);
}

/* ── setting / value rows ──────────────────────────────────────────────────── */
.studio__rows {
  display: flex;
  flex-direction: column;
  gap: 22px;
  margin-top: 18px;
}
.studio__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px 40px;
}
/* Below the two-column measure the value drops under its label rather than
   squeezing the copy into a ribbon. */
@media (max-width: 620px) {
  .studio__row {
    grid-template-columns: minmax(0, 1fr);
  }
}
.studio__value {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 7px;
  min-width: 0;
}

.studio__title {
  font-size: 14px;
  line-height: 1.4;
  color: var(--ink);
}
/* ── model value ───────────────────────────────────────────────────────────── */
.studio__pick {
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: box-shadow 140ms ease;
}
/* No pill: the value is text with a chevron, and the hover lands on the text
   rather than lighting a tile. */
.studio__pick:hover .studio__pick-name,
.studio__pick:hover .studio__pick-chev {
  color: var(--ink);
}
.studio__pick:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.studio__pick-face {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
/* The value reads as the answer to the label: muted until you go for it. */
.studio__pick-name {
  font-size: 14px;
  line-height: 1.2;
  color: var(--muted);
  transition: color 140ms ease;
}
.studio__pick-effort {
  font-size: 11.5px;
  line-height: 1.3;
  color: var(--muted);
  opacity: 0.75;
}
.studio__pick-chev {
  flex-shrink: 0;
  color: var(--muted);
  transition:
    color 140ms ease,
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
/* Open, the chevron points down at the picker it opened. */
.studio__pick-chev--on {
  transform: rotate(90deg);
}

</style>
