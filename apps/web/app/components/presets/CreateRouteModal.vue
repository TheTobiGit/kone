<script setup lang="ts">
import { computed, ref } from "vue";
import { Route01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
import DrawerModalShell, { type DrawerModalHandle } from "~/components/ui/DrawerModalShell.vue";
import ModelPinPicker from "~/components/model/ModelPinPicker.vue";
import { useAgentProviders } from "~/composables/useAgentProviders";
import { useModelPreferences } from "~/composables/useModelPreferences";
import { useSound } from "~/composables/useSound";
import {
  buildModelCatalog,
  describeModelId,
  effortForTier,
  effortMeta,
  familyForIdStrict,
  hasEffortChoice,
  isEffortTier,
  type Effort,
  type ModelOption,
} from "~/utils/modelCatalog";
import type { AgentModelRef, ModelPreference } from "~/types/desktop";

// Making or rewriting a category of work: a name, when it applies, and the
// model it runs on. The shell carries the scrim, card, rows and keyboard, so
// this is the row definitions plus the one submit path — the same shape as the
// sub-agent card beside it.
//
// The model is the one part an agent never reads as words: a category with no
// model is saved but dormant, and stays out of sight until it has one.

const props = defineProps<{
  /** The category being rewritten. Absent, the card is making a new one. */
  route?: ModelPreference;
}>();

const emit = defineEmits<{
  close: [];
  saved: [kind: string];
}>();

const { saveRoute } = useModelPreferences();
const { modelCache } = useAgentProviders();
const isEditing = computed(() => Boolean(props.route));
const { cue } = useSound();
const shellRef = ref<DrawerModalHandle | null>(null);

// ── sections ──────────────────────────────────────────────────────────────────
type Section = "name" | "applies" | "model";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "name", label: "Category" },
  { id: "applies", label: "When" },
  { id: "model", label: "Model" },
];

const HINTS = {
  name: "The kind of work, in your words.",
  applies: "When an agent should reach for it. Agents read this to choose.",
  model: "What that work runs on. Without one, agents never see the category.",
} satisfies Record<Section, string>;

// ── form state ────────────────────────────────────────────────────────────────
const label = ref(props.route?.label ?? "");
const hint = ref(props.route?.hint ?? "");
const model = ref<AgentModelRef | null>(props.route?.model ?? null);
const effort = ref<string | null>(props.route?.effort ?? null);
const isSubmitting = ref(false);
const errorMsg = ref<string | null>(null);

const canSubmit = computed(() => label.value.trim().length > 0 && !isSubmitting.value);

// ── model and effort ──────────────────────────────────────────────────────────
// The picker speaks in families; what the store keeps is the model id the
// effort resolves to (a provider that bakes effort into the id has a different
// one per rung) and the tier beside it — the same pair the composer commits.
const catalog = computed<ModelOption[]>(() =>
  model.value ? buildModelCatalog(modelCache.value[model.value.provider] ?? [], model.value.provider) : [],
);
const family = computed(() => familyForIdStrict(catalog.value, model.value?.model));

/** The pin as the picker knows it: the family key, not the effort's model id. */
const pinned = computed<AgentModelRef | null>(() =>
  model.value ? { provider: model.value.provider, model: family.value?.key ?? model.value.model } : null,
);

const efforts = computed<Effort[]>(() => (hasEffortChoice(family.value) ? (family.value?.efforts ?? []) : []));
const activeEffort = computed(() =>
  effortForTier(family.value, isEffortTier(effort.value) ? effort.value : undefined),
);

/** "base" is the catalog's word for a model with no effort dial — nothing to
 *  store; every other tier is the provider's own effort vocabulary. */
function place(provider: AgentModelRef["provider"], rung: Effort) {
  model.value = { provider, model: rung.modelId };
  effort.value = rung.tier === "base" ? null : rung.tier;
}

function onPick(next: AgentModelRef | null) {
  if (!next) {
    model.value = null;
    effort.value = null;
    return;
  }
  const opt = buildModelCatalog(modelCache.value[next.provider] ?? [], next.provider).find(
    (o) => o.key === next.model,
  );
  const rung = opt?.efforts[opt.defaultEffortIndex];
  if (rung) place(next.provider, rung);
  else {
    model.value = { provider: next.provider, model: next.model };
    effort.value = null;
  }
}

function onEffort(rung: Effort) {
  if (!model.value) return;
  cue("toggle");
  place(model.value.provider, rung);
}

/** What the closed row says: the model's name and effort, or what a category
 *  without one means. */
const modelSummary = computed(() => {
  if (!model.value) return "Not set — agents won't see it";
  const name = describeModelId(model.value.model, catalog.value).name;
  const tier = isEffortTier(effort.value) ? effortMeta(effort.value).label : null;
  return tier ? `${name} · ${tier}` : name;
});

const summaries = computed<Record<Section, string>>(() => ({
  name: label.value.trim() || "Not named yet",
  applies: hint.value.trim() || "Nothing yet — agents choose by name alone",
  model: modelSummary.value,
}));

const actionLabel = computed(() => {
  if (isSubmitting.value) return "Saving…";
  return isEditing.value ? "Save changes" : "Add category";
});

// ── submit ────────────────────────────────────────────────────────────────────
async function submit() {
  if (!canSubmit.value) return;
  isSubmitting.value = true;
  errorMsg.value = null;
  try {
    const kind = await saveRoute(props.route?.kind ?? null, {
      label: label.value,
      hint: hint.value,
      model: model.value,
      effort: effort.value,
    });
    if (!kind) {
      errorMsg.value = "Could not save the category — the list may be full.";
      cue("error");
      isSubmitting.value = false;
      return;
    }
    cue("success");
    shellRef.value?.finish(() => emit("saved", kind));
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : "Save failed.";
    cue("error");
    isSubmitting.value = false;
  }
}
</script>

<template>
  <DrawerModalShell
    ref="shellRef"
    :sections="SECTIONS"
    :hints="HINTS"
    :summaries="summaries"
    :initial-open="props.route ? null : 'name'"
    :eyebrow="isEditing ? 'Edit category' : 'New category'"
    :dialog-label="isEditing ? 'Edit a category' : 'Add a category'"
    :error="errorMsg"
    :action-label="actionLabel"
    :can-submit="canSubmit"
    :is-submitting="isSubmitting"
    @close="emit('close')"
    @submit="submit"
  >
    <!-- Category: what the work is called. -->
    <template #row-name>
      <label class="dm-field">
        <span class="dm-glyph">
          <HugeiconsIcon :icon="Route01Icon" :size="17" :stroke-width="1.7" aria-hidden="true" />
        </span>
        <input
          v-model="label"
          data-autofocus
          type="text"
          class="dm-input"
          placeholder="Name — Quick fixes, Reviews, Big refactors"
          maxlength="60"
          spellcheck="false"
          autocomplete="off"
          aria-label="Category name"
        />
      </label>
    </template>

    <!-- When: the line an agent reads to decide. -->
    <template #row-applies>
      <textarea
        v-model="hint"
        data-autofocus
        class="dm-input dm-textarea"
        rows="3"
        maxlength="300"
        placeholder="e.g. A small, well-understood change: a typo, a rename, a one-line bug."
        aria-label="When this category applies"
      />
    </template>

    <!-- Model: one model, and the effort it thinks at. -->
    <template #row-model>
      <ModelPinPicker :model="pinned" @update:model="onPick" />
      <div v-if="efforts.length" class="rm-effort" role="radiogroup" aria-label="Effort">
        <span class="rm-effort__label">Effort</span>
        <button
          v-for="rung in efforts"
          :key="rung.id"
          type="button"
          role="radio"
          class="rm-effort__chip"
          :class="{ 'is-on': activeEffort?.id === rung.id }"
          :aria-checked="activeEffort?.id === rung.id"
          :title="rung.hint"
          @click="onEffort(rung)"
        >
          {{ rung.label }}
        </button>
      </div>
    </template>
  </DrawerModalShell>
</template>

<style scoped>
.rm-effort {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 0.7rem;
}
.rm-effort__label {
  margin-right: 4px;
  font-size: 11.5px;
  color: var(--muted);
}
.rm-effort__chip {
  height: 24px;
  padding-inline: 9px;
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--ink-soft);
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
  cursor: pointer;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.rm-effort__chip:hover {
  background-color: color-mix(in srgb, var(--ink) 9%, transparent);
  color: var(--ink);
}
.rm-effort__chip.is-on {
  color: var(--ink);
  background-color: color-mix(in srgb, var(--ink) 13%, transparent);
}
.rm-effort__chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
</style>
