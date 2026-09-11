<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  AiChipIcon,
  Copy01Icon,
  Delete02Icon,
  IdIcon,
  NoteIcon,
  PencilEdit02Icon,
  RoboticIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import CreateSubagentModal from "~/components/presets/CreateSubagentModal.vue";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import DetailTable from "~/components/ui/DetailTable.vue";
import DetailTabs from "~/components/ui/DetailTabs.vue";
import ToggleSwitch from "~/components/ui/ToggleSwitch.vue";
import {
  BUILTIN_SUBAGENT_PRESET_IDS,
  BUILTIN_SUBAGENT_PRESETS,
} from "@kone/protocol/subagent-presets";
import { useSettingsSurface } from "~/composables/useSettingsSurface";
import { useSound } from "~/composables/useSound";
import type { DetailTab } from "~/composables/useDetailTabs";
import { useSubagentPresets } from "~/composables/useSubagentPresets";
import { formatModelChain, toDirectives, type DetailTableRow } from "~/utils/detailFormat";
import { PROVIDER_BRAND } from "~/utils/modelPicker";
import { nativeSubagentIcon } from "~/utils/subagentIcons";
import { PROVIDER_LABEL } from "~/utils/usageProviders";
import type { SubagentPresetRecord } from "~/types/desktop";

const props = defineProps<{ open: boolean; presetId: string }>();
const emit = defineEmits<{
  back: [];
  switched: [presetId: string];
}>();

const {
  presets,
  nativeConfigs,
  configureNative,
  createPreset,
  deletePreset,
} = useSubagentPresets();

const { compact } = useSettingsSurface();
const { cue } = useSound();

const isDeleting = ref(false);
const isEditing = ref(false);

onMounted(() => {
  compact.value = true;
});
onBeforeUnmount(() => {
  compact.value = false;
});

const isNative = computed(() => BUILTIN_SUBAGENT_PRESET_IDS.includes(props.presetId));

const nativeDef = computed(() =>
  BUILTIN_SUBAGENT_PRESETS.find((p) => p.presetId === props.presetId),
);

const nativeConfig = computed(() =>
  nativeConfigs.value.find((c) => c.presetId === props.presetId),
);

const customPreset = computed(() =>
  presets.value.find((p) => p.presetId === props.presetId),
);

// If the preset ceases to exist (e.g. deleted), step back.
watch(
  [isNative, nativeDef, customPreset],
  ([native, def, custom]) => {
    if (props.open && !native && !custom) emit("back");
    if (props.open && native && !def) emit("back");
  },
  { immediate: true },
);

const name = computed(() =>
  isNative.value ? (nativeDef.value?.name ?? "") : (customPreset.value?.name ?? ""),
);

const rawInstructions = computed(() =>
  isNative.value
    ? (nativeDef.value?.instructions ?? "")
    : (customPreset.value?.instructions ?? ""),
);

const model = computed(() =>
  isNative.value
    ? (nativeConfig.value?.model ?? null)
    : (customPreset.value?.model ?? null),
);

const modelFallbacks = computed(() =>
  isNative.value
    ? (nativeConfig.value?.modelFallbacks ?? [])
    : (customPreset.value?.modelFallbacks ?? []),
);

const isEnabled = computed(() =>
  isNative.value ? (nativeConfig.value?.enabled ?? true) : true,
);

// One row per truth about the preset, resolved once here so the table stays
// a list of rows rather than a list of conditions.
const detailRows = computed<DetailTableRow[]>(() => [
  {
    id: "model",
    label: "Model",
    icon: AiChipIcon,
    brands: model.value ? [PROVIDER_BRAND[model.value.provider]] : [],
    text: formatModelChain(model.value, modelFallbacks.value) ?? undefined,
    aside: model.value ? PROVIDER_LABEL[model.value.provider] : undefined,
    emptyText: "Inherits the caller",
  },
  {
    id: "identifier",
    label: "Identifier",
    icon: IdIcon,
    mono: true,
    text: props.presetId,
  },
  {
    id: "scope",
    label: "Scope",
    icon: RoboticIcon,
    text: "Global · available to all agents",
  },
]);

function toggleNative(enabled: boolean) {
  cue("toggle");
  void configureNative(props.presetId, { enabled });
}

async function handleDuplicate() {
  // The native and custom cases differ only in where the name and brief come
  // from; the model chain is already resolved above for either. One source and
  // one create: the bridge boundary owns making the payload sendable, so there
  // is nothing to clone here.
  const source = isNative.value ? nativeDef.value : customPreset.value;
  if (!source) return;
  const copy: SubagentPresetRecord | null = await createPreset({
    name: `${source.name} Copy`,
    instructions: source.instructions,
    model: model.value,
    modelFallbacks: modelFallbacks.value,
  });
  if (copy) {
    cue("press");
    emit("switched", copy.presetId);
    await nextTick();
    isEditing.value = true;
  }
}

async function handleDelete() {
  if (isNative.value || !customPreset.value) return;
  const ok = await deletePreset(customPreset.value.presetId);
  if (ok) {
    cue("press");
    emit("back");
  }
}

function openEdit() {
  if (isNative.value) {
    void handleDuplicate();
    return;
  }
  isEditing.value = true;
  cue("open");
}

const instructions = computed(() => toDirectives(rawInstructions.value));

// ── Tabs ────────────────────────────────────────────────────────────────────
type TabKey = "details" | "instructions";

const TABS = [
  { key: "details", label: "Details", icon: IdIcon },
  { key: "instructions", label: "Instructions", icon: NoteIcon },
] as const satisfies readonly DetailTab<TabKey>[];

watch(
  () => props.presetId,
  () => {
    isDeleting.value = false;
    isEditing.value = false;
  },
);
</script>

<template>
  <CreateSubagentModal
    v-if="isEditing && customPreset"
    :preset="customPreset"
    @close="isEditing = false"
    @saved="isEditing = false"
  />

  <SettingsPageShell
    :open="open"
    :breadcrumb="`Ecosystem / Sub-agents / ${name}`"
    :breadcrumb-icon="RoboticIcon"
    :label="name"
    @back="$emit('back')"
  >
    <template #actions>
      <div class="det__actions">
        <button
          type="button"
          class="det__action-btn"
          :title="isNative ? 'Duplicate and edit this sub-agent' : 'Edit this sub-agent'"
          :tabindex="open ? 0 : -1"
          @click="openEdit"
        >
          <HugeiconsIcon :icon="PencilEdit02Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          <span>Edit</span>
        </button>

        <button
          type="button"
          class="det__action-btn"
          title="Duplicate this sub-agent preset"
          :tabindex="open ? 0 : -1"
          @click="handleDuplicate"
        >
          <HugeiconsIcon :icon="Copy01Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          <span>Duplicate</span>
        </button>

        <button
          v-if="!isNative"
          type="button"
          class="det__action-btn det__action-btn--danger"
          title="Delete this sub-agent preset"
          :tabindex="open ? 0 : -1"
          @click="isDeleting ? handleDelete() : (isDeleting = true)"
        >
          <HugeiconsIcon :icon="Delete02Icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          <span>{{ isDeleting ? "Confirm delete" : "Delete" }}</span>
        </button>
      </div>
    </template>

    <article class="det">
      <!-- Hero -->
      <header class="det__hero">
        <span class="det__portrait">
          <span class="det__glyph">
            <HugeiconsIcon
              :icon="isNative ? nativeSubagentIcon(presetId) : RoboticIcon"
              :size="26"
              :stroke-width="1.7"
              aria-hidden="true"
            />
          </span>
        </span>

        <span class="det__id">
          <span class="det__nameline">
            <h2 class="det__name">{{ name }}</h2>
            <span class="det__chip">{{ isNative ? "Built-in" : "Custom" }}</span>
          </span>
        </span>

        <div v-if="isNative" class="det__hero-action">
          <label class="det__toggle-label">
            <span class="det__toggle-text">{{ isEnabled ? "Active" : "Off" }}</span>
            <ToggleSwitch
              :model-value="isEnabled"
              :aria-label="`Enable ${name}`"
              @update:model-value="toggleNative"
            />
          </label>
        </div>
      </header>

      <!-- Body tabs -->
      <DetailTabs
        :tabs="TABS"
        :reset-key="presetId"
        ariaLabel="Sub-agent"
        :can-focus="open"
        v-slot="{ tab }"
      >
          <!-- Details tab: Metadata & indicator table -->
          <DetailTable v-if="tab === 'details'" :rows="detailRows" />

          <!-- Instructions tab -->
          <template v-else>
            <div v-if="instructions.length" class="det__prose">
              <p v-for="(d, i) in instructions" :key="i" class="det__para">
                <span v-if="d.lead" class="det__lead">{{ d.lead }}</span>{{ d.body }}
              </p>
            </div>
            <p v-else class="det__bare">
              No standing instructions for this preset yet.
            </p>
          </template>
      </DetailTabs>
    </article>

    <template #foot>
      A preset is a reusable sub-agent definition an agent invokes when it needs one. It has no
      thread history of its own; each spawn copies the standing brief and resolves its model chain
      afresh.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.det {
  display: flex;
  flex-direction: column;
  gap: 26px;
  max-width: 36rem;
  padding-bottom: 3rem;
  container-type: inline-size;
}

/* ── actions in shell masthead ────────────────────────────────────────────── */
.det__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.det__action-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 27px;
  padding-inline: 10px;
  border-radius: 8px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 140ms ease,
    color 140ms ease,
    opacity 140ms ease;
}
.det__action-btn:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.det__action-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.det__action-btn--danger:hover {
  background-color: color-mix(in srgb, #e05252 14%, transparent);
  color: #e05252;
}

/* ── hero header ──────────────────────────────────────────────────────────── */
.det__hero {
  display: flex;
  align-items: center;
  gap: 16px;
  padding-top: 4px;
}

.det__portrait {
  position: relative;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 58px;
  height: 58px;
  border-radius: 16px;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
}

.det__glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-soft);
}

.det__id {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1 1 auto;
}

.det__nameline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.det__name {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1.25;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.det__chip {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding-inline: 7px;
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--muted);
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
}

.det__hero-action {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.det__toggle-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.det__toggle-text {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--muted);
}

/* ── prose instructions ───────────────────────────────────────────────────── */
.det__prose {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-soft);
}

.det__para {
  margin: 0;
  text-wrap: pretty;
}

.det__lead {
  display: block;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 2px;
}

.det__bare {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
  font-style: italic;
}
</style>
