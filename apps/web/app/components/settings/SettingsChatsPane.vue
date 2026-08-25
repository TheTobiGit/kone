<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { BubbleChatIcon } from "@hugeicons/core-free-icons";
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

// The Chats pane — the two things a new chat should inherit before you've told it
// anything: which model answers, and how much it may do without asking. Both are
// app-wide *defaults*, not a live session: this pane never touches a running
// thread, it only writes the same keys a project reads at boot
// (utils/modelPicker). A project that already carries its own choice keeps it;
// these seed the ones that don't.

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
function openPicker() {
  pickerOpen.value = true;
  cue("press");
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
// The same three-rung ladder the composer cycles, laid out as choosable rows.
// Each maps to a real approval/sandbox pairing downstream; the hue climbs calm →
// warm with the autonomy.
type ModeMeta = { id: InteractionMode; label: string; desc: string; hue: string };
const MODES: ModeMeta[] = [
  { id: "ask", label: "Ask user", desc: "Reads freely, asks before any change.", hue: "#6E8BEF" },
  {
    id: "accept-edits",
    label: "Edits only",
    desc: "Auto-approves file edits, asks before commands.",
    hue: "#5EAF8C",
  },
  {
    id: "full-access",
    label: "Full access",
    desc: "Runs everything without prompting.",
    hue: "#D08466",
  },
];

// No stored default reads as the app's own fallback (accept-edits) so the pane
// shows the rung a fresh project would actually open on.
const currentMode = ref<InteractionMode>("accept-edits");
onMounted(() => {
  if (!import.meta.client) return;
  const saved = localStorage.getItem(DEFAULT_MODE_KEY);
  if (saved && MODES.some((m) => m.id === saved)) currentMode.value = saved as InteractionMode;
});

function chooseMode(id: InteractionMode) {
  if (currentMode.value === id) return;
  currentMode.value = id;
  if (import.meta.client) localStorage.setItem(DEFAULT_MODE_KEY, id);
  cue("toggle");
}
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Ecosystem / Chats"
    :breadcrumb-icon="BubbleChatIcon"
    label="Chat defaults"
    @back="$emit('back')"
  >
    <!-- Default model ─────────────────────────────────────────────────────── -->
    <section class="chats__group">
      <h2 class="chats__title">Default model</h2>
      <p class="chats__lede">The model every new chat opens with, until you switch it in-thread.</p>

      <button
        type="button"
        class="chats__pick"
        :tabindex="open ? 0 : -1"
        aria-label="Change the default model"
        @click="openPicker"
      >
        <span class="chats__pick-face">
          <ProviderLogo
            v-if="modelDesc && modelDesc.brand !== 'generic'"
            :brand="modelDesc.brand"
            :size="17"
          />
          <span class="chats__pick-name">{{ modelDesc?.name ?? "Provider default" }}</span>
          <span v-if="effortLabel" class="chats__pick-effort">{{ effortLabel }}</span>
        </span>
        <HugeiconsIcon
          class="chats__pick-chev"
          :icon="ArrowRight01Icon"
          :size="15"
          :stroke-width="1.8"
          aria-hidden="true"
        />
      </button>
    </section>

    <!-- Default approval ──────────────────────────────────────────────────── -->
    <section class="chats__group">
      <h2 class="chats__title">Default approval</h2>
      <p class="chats__lede">
        How much a new chat may do before asking. A project keeps its own choice once you set one;
        this seeds the ones that haven't.
      </p>

      <div class="chats__modes" role="radiogroup" aria-label="Default approval mode">
        <button
          v-for="m in MODES"
          :key="m.id"
          type="button"
          role="radio"
          class="chats__mode"
          :class="{ 'chats__mode--on': currentMode === m.id }"
          :aria-checked="currentMode === m.id"
          :tabindex="open ? 0 : -1"
          @click="chooseMode(m.id)"
        >
          <span class="chats__dot" :style="{ backgroundColor: m.hue }" aria-hidden="true" />
          <span class="chats__mode-text">
            <span class="chats__mode-label">{{ m.label }}</span>
            <span class="chats__mode-desc">{{ m.desc }}</span>
          </span>
        </button>
      </div>
    </section>

    <!-- Teleported to the body: the settings drawer sits behind the stage (z-0
         under the stage's z-10), so a modal nested here would render behind it.
         At body level the modal's own fixed z-50 stands above everything. -->
    <Teleport to="body">
      <ModelPickerModal
        v-if="pickerOpen"
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
      already open. Each seeds what a fresh chat starts from.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.chats__group {
  padding-block: 0.5rem 1.75rem;
}
.chats__group + .chats__group {
  margin-top: 0.75rem;
}

.chats__title {
  font-size: 14px;
  line-height: 1.2;
  color: var(--ink);
}
.chats__lede {
  margin-top: 5px;
  max-width: 48ch;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--muted);
  text-wrap: pretty;
}

/* ── model row ─────────────────────────────────────────────────────────────── */
.chats__pick {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--panel);
  cursor: pointer;
  transition:
    background-color 140ms ease,
    box-shadow 140ms ease;
}
.chats__pick:hover {
  background: var(--hover);
}
.chats__pick:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.chats__pick-face {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.chats__pick-name {
  font-size: 14px;
  line-height: 1.2;
  color: var(--ink);
}
.chats__pick-effort {
  padding: 2px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  font-size: 11px;
  line-height: 1.3;
  color: var(--muted);
}
.chats__pick-chev {
  flex-shrink: 0;
  color: var(--muted);
}

/* ── approval rows ─────────────────────────────────────────────────────────── */
.chats__modes {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 14px;
}
.chats__mode {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  width: 100%;
  padding: 11px 14px;
  border-radius: 12px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 140ms ease,
    box-shadow 140ms ease;
}
.chats__mode:hover {
  background: var(--hover);
}
.chats__mode--on {
  background: var(--panel);
}
.chats__mode:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.chats__dot {
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  margin-top: 4px;
  border-radius: 999px;
  /* Off rungs read as a faint ring; the chosen one lights to its full hue. */
  opacity: 0.32;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 12%, transparent);
  transition:
    opacity 140ms ease,
    box-shadow 140ms ease;
}
.chats__mode--on .chats__dot {
  opacity: 1;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 0%, transparent);
}
.chats__mode-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.chats__mode-label {
  font-size: 13.5px;
  line-height: 1.25;
  color: var(--ink);
}
.chats__mode-desc {
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted);
}
</style>
