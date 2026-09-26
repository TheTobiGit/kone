<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { PencilEdit01Icon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import ModelPickerModal from "~/components/model/ModelPickerModal.vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import {
  buildModelCatalog,
  describeModelId,
  EFFORT_META,
  isEffortTier,
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
  setDefaultModel,
} from "~/utils/modelPicker";
import type { ModelPick } from "~/composables/useModelCommit";
import SettingsInlineChoice from "~/components/settings/SettingsInlineChoice.vue";

// The Composer page — what a new chat starts with: which model answers, and how
// much it may do without asking.
//
// Defaults, not live state: this never touches a running thread. It writes the
// keys a project reads at boot (utils/modelPicker), so anything that already
// carries its own choice keeps it and these seed the ones that don't.

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
    if (list) {
      // SAFETY: Keys of modelCache correspond to ProviderKind values
      out[prov as ProviderKind] = buildModelCatalog(list);
    }
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
  // SAFETY: Local storage value is checked at assignment or defaults to null
  currentProvider.value = (localStorage.getItem(DEFAULT_PROVIDER_KEY) as ProviderKind | null) ?? null;
  currentModel.value = localStorage.getItem(DEFAULT_MODEL_KEY);
  const tier = localStorage.getItem(DEFAULT_REASONING_KEY);
  currentReasoning.value = isEffortTier(tier) ? tier : null;
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
  setDefaultModel({
    provider: picked.provider,
    modelId: picked.modelId,
    tier: picked.tier,
  });
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
  if (saved && MODES.some((m) => m.id === saved)) {
    // SAFETY: Invariant verified by checking membership in MODES array
    currentMode.value = saved as InteractionMode;
  }
});

function chooseMode(id: string) {
  if (currentMode.value === id) return;
  // SAFETY: the ids handed to the choice come from MODES, so anything it can
  // emit is an InteractionMode.
  currentMode.value = id as InteractionMode;
  if (import.meta.client) localStorage.setItem(DEFAULT_MODE_KEY, id);
}
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Personalization / Composer"
    :breadcrumb-icon="PencilEdit01Icon"
    label="Composer settings"
    @back="$emit('back')"
  >
    <!-- Each setting is one line: its name on the left, what it's set to on the
         right, under the part of the studio it belongs to. The pane's note
         carries what these defaults mean, so a row never explains itself. -->
    <div class="srow__group">
      <h2 class="srow__heading">New chats</h2>
      <div class="srow__rows">
        <!-- Default model ─────────────────────────────────────────────────── -->
        <div class="srow__row">
          <h3 class="srow__title">Default model</h3>

          <div class="srow__value">
            <button
              type="button"
              class="srow__pick"
              :tabindex="open ? 0 : -1"
              aria-haspopup="dialog"
              aria-label="Change the default model"
              @click="togglePicker"
            >
              <span class="srow__pick-face">
                <ProviderLogo
                  v-if="modelDesc && modelDesc.brand !== 'generic'"
                  :brand="modelDesc.brand"
                  :size="17"
                />
                <span class="srow__pick-name">{{ modelDesc?.name ?? "Provider default" }}</span>
                <span v-if="effortLabel" class="srow__pick-effort">{{ effortLabel }}</span>
              </span>
              <HugeiconsIcon
                class="srow__pick-chev"
                :class="{ 'srow__pick-chev--on': pickerOpen }"
                :icon="ArrowRight01Icon"
                :size="15"
                :stroke-width="1.8"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        <!-- Default approval ───────────────────────────────────────────────── -->
        <div class="srow__row">
          <h3 class="srow__title">Default approval</h3>

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
      already open. Each seeds what the next one starts from.
    </template>
  </SettingsPageShell>
</template>

<style scoped src="./settingsRows.css"></style>
