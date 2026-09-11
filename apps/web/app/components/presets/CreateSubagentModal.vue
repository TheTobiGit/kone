<script setup lang="ts">
import { computed, ref } from "vue";
import { RoboticIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import DrawerModalShell, { type DrawerModalHandle } from "~/components/ui/DrawerModalShell.vue";
import PresetModelList, { type PresetModelChain } from "~/components/presets/PresetModelList.vue";
import { useSubagentPresets } from "~/composables/useSubagentPresets";
import { useSound } from "~/composables/useSound";
import { formatModelChain } from "~/utils/detailFormat";
import { normalizeChain } from "@kone/protocol/subagent-presets";
import type { AgentModelRef, SubagentPresetRecord } from "~/types/desktop";

// Creating or editing a preset sub-agent: the shell carries the scrim, card,
// rows and keyboard, so this is the row definitions plus the one submit path.
// One row is open at a time to keep the card compact within the settings
// drawer. When creating, identity opens first; when editing, rows start
// closed so the summaries display the active values.

const props = defineProps<{
  /** The preset being rewritten. Absent, the card is making a new one. */
  preset?: SubagentPresetRecord;
}>();

const emit = defineEmits<{
  close: [];
  created: [preset: SubagentPresetRecord];
  saved: [preset: SubagentPresetRecord];
}>();

const { createPreset, updatePreset } = useSubagentPresets();
const isEditing = computed(() => Boolean(props.preset));
const { cue } = useSound();
const shellRef = ref<DrawerModalHandle | null>(null);

// ── sections ──────────────────────────────────────────────────────────────────
type Section = "identity" | "instructions" | "capabilities";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "identity", label: "Identity" },
  { id: "instructions", label: "Instructions" },
  { id: "capabilities", label: "Model" },
];

const HINTS = {
  identity: "What it is called.",
  instructions: "Habits and standing brief for every spawn.",
  capabilities: "The model chain it thinks with.",
} satisfies Record<Section, string>;

// ── form state ────────────────────────────────────────────────────────────────
const name = ref("");
const instructions = ref("");
const model = ref<AgentModelRef | null>(null);
const modelFallbacks = ref<AgentModelRef[]>([]);
const isSubmitting = ref(false);
const errorMsg = ref<string | null>(null);

const canSubmit = computed(() => name.value.trim().length > 0 && !isSubmitting.value);

function seedFrom(preset: SubagentPresetRecord) {
  name.value = preset.name;
  instructions.value = preset.instructions ?? "";
  model.value = preset.model;
  modelFallbacks.value = preset.modelFallbacks ? [...preset.modelFallbacks] : [];
}

if (props.preset) seedFrom(props.preset);

function onChainUpdate(chain: PresetModelChain) {
  model.value = chain.model;
  modelFallbacks.value = chain.fallbacks;
}

/** What a closed row says about itself: the value it holds, or a word for the
 *  quiet default it will fall back to. A summary never says "empty" — an
 *  untouched row is a working answer, not an omission. */
const summaries = computed<Record<Section, string>>(() => {
  const named = name.value.trim();
  const words = instructions.value.trim().split(/\s+/).filter(Boolean).length;
  return {
    identity: named || "Not named yet",
    instructions: words ? `${words} ${words === 1 ? "word" : "words"}` : "None",
    capabilities: formatModelChain(model.value, modelFallbacks.value) ?? "Inherits the caller",
  };
});

const actionLabel = computed(() => {
  if (isSubmitting.value) return isEditing.value ? "Saving…" : "Creating…";
  return isEditing.value ? "Save changes" : "Create sub-agent";
});

// ── submit ────────────────────────────────────────────────────────────────────
// Create and save walk one path: the payload is identical either way, and only
// the store call and the failure line differ. The operation picks both, so a
// fix to the payload can't land on one and miss the other.
type Operation = "create" | "save";

async function persist(operation: Operation) {
  const current = props.preset;
  const trimmed = name.value.trim();
  if (!trimmed || isSubmitting.value) return;
  if (operation === "save" && !current) return;

  isSubmitting.value = true;
  errorMsg.value = null;
  try {
    const chain = normalizeChain(model.value, modelFallbacks.value);
    const payload = {
      name: trimmed,
      instructions: instructions.value.trim() || null,
      model: chain.primary,
      modelFallbacks: chain.fallbacks,
    };
    const result =
      operation === "save" && current
        ? await updatePreset(current.presetId, payload)
        : await createPreset(payload);
    if (!result) {
      errorMsg.value =
        operation === "save"
          ? "Could not save the sub-agent — check the fields and try again."
          : "Could not create the sub-agent — check the fields and try again.";
      cue("error");
      isSubmitting.value = false;
      return;
    }
    cue("success");
    if (operation === "save") shellRef.value?.finish(() => emit("saved", result));
    else shellRef.value?.finish(() => emit("created", result));
  } catch (err) {
    errorMsg.value =
      err instanceof Error ? err.message : operation === "save" ? "Save failed." : "Creation failed.";
    cue("error");
    isSubmitting.value = false;
  }
}

function submit() {
  void persist(isEditing.value ? "save" : "create");
}
</script>

<template>
  <DrawerModalShell
    ref="shellRef"
    :sections="SECTIONS"
    :hints="HINTS"
    :summaries="summaries"
    :initial-open="props.preset ? null : 'identity'"
    :eyebrow="isEditing ? 'Edit sub-agent' : 'New sub-agent'"
    :dialog-label="isEditing ? 'Edit sub-agent' : 'Create a sub-agent'"
    :error="errorMsg"
    :action-label="actionLabel"
    :can-submit="canSubmit"
    :is-submitting="isSubmitting"
    @close="emit('close')"
    @submit="submit"
  >
    <!-- Identity: what the sub-agent is called. -->
    <template #row-identity>
      <label class="dm-field">
        <span class="dm-glyph">
          <HugeiconsIcon
            :icon="RoboticIcon"
            :size="17"
            :stroke-width="1.7"
            aria-hidden="true"
          />
        </span>
        <input
          v-model="name"
          data-autofocus
          type="text"
          class="dm-input"
          placeholder="Name — Scout, Critic, Architect"
          maxlength="64"
          spellcheck="false"
          autocomplete="off"
          aria-label="Sub-agent name"
        />
      </label>
    </template>

    <!-- Instructions -->
    <template #row-instructions>
      <textarea
        v-model="instructions"
        data-autofocus
        class="dm-input dm-textarea"
        rows="5"
        placeholder="Standing brief laid ahead of the specific task on each spawn. e.g. Investigate the codebase without making changes..."
        aria-label="Standing instructions"
      />
    </template>

    <!-- Model -->
    <template #row-capabilities>
      <PresetModelList
        :model="model"
        :fallbacks="modelFallbacks"
        @update:chain="onChainUpdate"
      />
    </template>
  </DrawerModalShell>
</template>
