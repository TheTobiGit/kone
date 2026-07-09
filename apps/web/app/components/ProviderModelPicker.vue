<script setup lang="ts">
import { onClickOutside, useElementBounding, useEventListener } from "@vueuse/core";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_CATALOG,
  type ProviderId,
  getModelLabel,
  getModelProviderId,
  getModelsForProvider,
} from "~/lib/model-catalog";
import { useDroidModelStore } from "~/lib/droid-model-store";
import {
  getDefaultEffort,
  getEffortLabel,
  getEffortLevels,
  modelSupportsThinkingToggle,
  normalizeEffort,
} from "~/lib/model-capabilities";
import { useRecentModels, type RecentModelSelection } from "~/lib/recent-models";
import { getEffortLevelIndex } from "~/lib/thinking-level-icon";
import ProviderIcon from "~/components/ProviderIcon.vue";
import ThinkingLevelIcon from "~/components/ThinkingLevelIcon.vue";
import {
  composerControlButtonClass,
  composerControlIconClass,
  composerControlLabelClass,
  composerControlValueClass,
  effortToggleClass,
  iconToggleClass,
  pickerBackButtonClass,
  pickerModelActiveClass,
  pickerModelClass,
  pickerModelIconClass,
  thinkingToggleActiveClass,
} from "~/lib/composer-controls";

const props = withDefaults(
  defineProps<{
    align?: "left" | "right";
  }>(),
  {
    align: "left",
  },
);

const provider = defineModel<ProviderId>("provider", { required: true });
const model = defineModel<string>("model", { required: true });
const effort = defineModel<string>("effort", { required: true });
const thinking = defineModel<boolean>("thinking", { required: true });

type PickerStep = "providers" | "models" | "effort";

const rootRef = ref<HTMLElement | null>(null);
const secondaryRowRef = ref<HTMLElement | null>(null);
const isOpen = defineModel<boolean>("open", { default: false });
const step = ref<PickerStep>("providers");
const browseProvider = ref<ProviderId>(provider.value);

const triggerBounds = useElementBounding(rootRef);
const { recents, recordSelection } = useRecentModels();
const { droidModels, droidModelsLoaded } = useDroidModelStore();

const modelLabel = computed(() => getModelLabel(provider.value, model.value));
const activeModelProviderId = computed(() =>
  getModelProviderId(provider.value, model.value),
);
const browseModels = computed(() => {
  if (browseProvider.value === "droid") {
    return [...droidModels.value]
      .sort((a, b) => {
        if (a.isCustom !== b.isCustom) return a.isCustom ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((entry) => ({
        id: entry.id,
        name: entry.isCustom ? entry.name : entry.shortName,
        modelProviderId: "droid" as ProviderId,
        isCustom: entry.isCustom,
      }));
  }

  return getModelsForProvider(browseProvider.value);
});
const visibleProviders = computed(() => MODEL_CATALOG.filter((entry) => entry.id === "droid"));
const isRightAligned = computed(() => props.align === "right");
const controlPositionClass = computed(() =>
  isRightAligned.value
    ? "absolute right-0 top-1/2 -translate-y-1/2"
    : "absolute left-0 top-1/2 -translate-y-1/2",
);
const effortLevels = computed(() => getEffortLevels(provider.value, model.value));
const hasEffortControls = computed(() => effortLevels.value.length > 0);
const supportsThinkingForSelection = computed(() =>
  modelSupportsThinkingToggle(provider.value, model.value),
);
const effortLabel = computed(() =>
  getEffortLabel(provider.value, model.value, effort.value),
);
const currentEffortIndex = computed(() =>
  getEffortLevelIndex(effortLevels.value, effort.value),
);

const secondaryRowStyle = computed(() => {
  const base = {
    top: `${triggerBounds.bottom.value + 8}px`,
  };

  if (isRightAligned.value) {
    return {
      ...base,
      right: `${window.innerWidth - triggerBounds.right.value}px`,
      left: "auto",
    };
  }

  return {
    ...base,
    left: `${triggerBounds.left.value}px`,
  };
});

function syncSecondaryRowPosition() {
  triggerBounds.update();
}

function syncTraitsForSelection(nextProvider: ProviderId, nextModel: string) {
  effort.value = getDefaultEffort(nextProvider, nextModel);
  thinking.value = true;
}

function rememberSelection(nextProvider: ProviderId, nextModel: string) {
  recordSelection({
    provider: nextProvider,
    model: nextModel,
    fastMode: false,
  });
}

function openPanel() {
  browseProvider.value = provider.value;
  step.value = "providers";
  isOpen.value = true;
  nextTick(() => syncSecondaryRowPosition());
}

function openEffortPanel() {
  step.value = "effort";
  isOpen.value = true;
  nextTick(() => syncSecondaryRowPosition());
}

function closePanel() {
  isOpen.value = false;
  step.value = "providers";
}

function handleBack() {
  closePanel();
}

function pickProvider(nextProvider: ProviderId) {
  browseProvider.value = nextProvider;
  step.value = "models";
}

function applySelection(nextProvider: ProviderId, nextModel: string) {
  provider.value = nextProvider;
  model.value = nextModel;
  syncTraitsForSelection(nextProvider, nextModel);
  rememberSelection(nextProvider, nextModel);
  closePanel();
}

function pickModel(nextModel: string) {
  applySelection(browseProvider.value, nextModel);
}

function pickRecent(entry: RecentModelSelection) {
  applySelection(entry.provider, entry.model);
}

function pickEffort(nextEffort: string) {
  effort.value = nextEffort;
  closePanel();
}

function toggleThinking() {
  thinking.value = !thinking.value;
}

function isEffortActive(effortId: string) {
  return effort.value === effortId;
}

function isModelActive(modelId: string) {
  return browseProvider.value === provider.value && modelId === model.value;
}

function isRecentActive(entry: RecentModelSelection) {
  return entry.provider === provider.value && entry.model === model.value;
}

watch(provider, (nextProvider) => {
  const models = getModelsForProvider(nextProvider);
  if (!models.some((entry) => entry.id === model.value)) {
    model.value = DEFAULT_MODEL_BY_PROVIDER[nextProvider];
  }
  effort.value = normalizeEffort(nextProvider, model.value, effort.value);
  if (!modelSupportsThinkingToggle(nextProvider, model.value)) {
    thinking.value = true;
  }
});

watch(model, (nextModel) => {
  effort.value = normalizeEffort(provider.value, nextModel, effort.value);
  if (!modelSupportsThinkingToggle(provider.value, nextModel)) {
    thinking.value = true;
  }
  rememberSelection(provider.value, nextModel);
});

watch(droidModelsLoaded, (loaded) => {
  if (!loaded) return;
  rememberSelection(provider.value, model.value);
});

watch(isOpen, (open) => {
  if (open) {
    nextTick(() => syncSecondaryRowPosition());
  }
});

watch(step, () => {
  if (isOpen.value) {
    nextTick(() => syncSecondaryRowPosition());
  }
});

useEventListener(window, "resize", () => {
  if (isOpen.value) syncSecondaryRowPosition();
});

useEventListener(
  window,
  "scroll",
  () => {
    if (isOpen.value) syncSecondaryRowPosition();
  },
  { capture: true },
);

onClickOutside(rootRef, closePanel, { ignore: [secondaryRowRef] });

onMounted(() => {
  window.addEventListener("keydown", onKeyDown);
  rememberSelection(provider.value, model.value);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeyDown);
});

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !isOpen.value) return;
  closePanel();
}
</script>

<template>
  <div ref="rootRef" class="relative h-5 w-full">
    <div
      v-if="!isOpen"
      :class="[controlPositionClass, 'inline-flex h-5 items-center gap-2 whitespace-nowrap']"
    >
      <div class="inline-flex items-center gap-1">
        <button
          type="button"
          :class="composerControlButtonClass"
          @click="openPanel"
        >
          <span :class="composerControlLabelClass">via</span>
          <span class="inline-flex items-center gap-0.5">
            <ProviderIcon :provider="provider" :class="composerControlIconClass" />
            <ProviderIcon
              v-if="activeModelProviderId !== provider"
              :provider="activeModelProviderId"
              :class="[composerControlIconClass, 'opacity-70']"
            />
          </span>
          <span :class="[composerControlValueClass, 'max-w-[12rem] truncate']">
            {{ modelLabel }}
          </span>
        </button>

        <button
          v-if="hasEffortControls"
          type="button"
          :class="effortToggleClass"
          :aria-label="`Reasoning effort: ${effortLabel}`"
          :title="effortLevels.find((level) => level.id === effort)?.hint ?? 'Reasoning effort'"
          @click="openEffortPanel"
        >
          <ThinkingLevelIcon
            :level-index="currentEffortIndex"
            :level-total="effortLevels.length"
            :effort-id="effort"
          />
        </button>

        <button
          v-if="supportsThinkingForSelection"
          type="button"
          :class="[
            iconToggleClass,
            thinking ? thinkingToggleActiveClass : '',
          ]"
          :aria-pressed="thinking"
          aria-label="Toggle thinking"
          :title="thinking ? 'Thinking on' : 'Thinking off'"
          @click="toggleThinking"
        >
          <UIcon name="i-lucide-brain" class="size-3" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div
      v-else-if="step === 'providers' || step === 'models'"
      :class="[controlPositionClass, 'flex h-5 items-center gap-2 whitespace-nowrap']"
    >
      <button
        type="button"
        :class="pickerBackButtonClass"
        aria-label="Back"
        title="Back"
        @click="handleBack"
      >
        <UIcon name="i-lucide-chevron-left" class="size-3.5" aria-hidden="true" />
      </button>

      <div class="flex items-center gap-3">
        <button
          v-for="entry in visibleProviders"
          :key="entry.id"
          type="button"
          class="transition-opacity duration-300"
          :class="entry.id === browseProvider ? 'opacity-100' : 'opacity-30 hover:opacity-60'"
          :title="entry.label"
          :aria-label="entry.label"
          :aria-pressed="entry.id === browseProvider"
          @click="pickProvider(entry.id)"
        >
          <ProviderIcon
            :provider="entry.id"
            class="size-3.5 shrink-0 text-ink-secondary"
          />
        </button>
      </div>
    </div>

    <div
      v-else
      :class="[
        controlPositionClass,
        'flex h-5 max-w-[min(56rem,calc(100vw-3rem))] items-center gap-2 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
      ]"
    >
      <button
        type="button"
        :class="pickerBackButtonClass"
        aria-label="Back"
        title="Back"
        @click="handleBack"
      >
        <UIcon name="i-lucide-chevron-left" class="size-3.5" aria-hidden="true" />
      </button>

      <button
        v-for="(level, index) in effortLevels"
        :key="level.id"
        type="button"
        class="inline-flex shrink-0 items-center px-0.5 transition-transform duration-200 hover:scale-105"
        :aria-label="level.label"
        :title="level.hint"
        @click="pickEffort(level.id)"
      >
        <ThinkingLevelIcon
          :level-index="index"
          :level-total="effortLevels.length"
          :effort-id="level.id"
          :active="isEffortActive(level.id)"
        />
      </button>
    </div>
  </div>

  <Teleport to="body">
    <transition name="hint-fade" mode="out-in">
      <div
        v-if="isOpen && step === 'providers' && recents.length > 0"
        key="recents"
        ref="secondaryRowRef"
        class="pointer-events-auto fixed z-50 flex w-[min(56rem,calc(100vw-1.5rem))] flex-wrap items-center gap-x-3 gap-y-1.5"
        :class="[isRightAligned ? 'justify-end' : 'justify-start']"
        :style="secondaryRowStyle"
      >
        <button
          v-for="entry in recents"
          :key="`${entry.provider}:${entry.model}`"
          type="button"
          :class="[
            pickerModelClass,
            'inline-flex max-w-full items-center gap-1 text-left whitespace-normal',
            isRecentActive(entry) ? pickerModelActiveClass : '',
          ]"
          @click="pickRecent(entry)"
        >
          <ProviderIcon :provider="entry.provider" :class="pickerModelIconClass" />
          <ProviderIcon
            v-if="getModelProviderId(entry.provider, entry.model) !== entry.provider"
            :provider="getModelProviderId(entry.provider, entry.model)"
            :class="[pickerModelIconClass, 'opacity-70']"
          />
          <span>{{ getModelLabel(entry.provider, entry.model) }}</span>
        </button>
      </div>

      <div
        v-else-if="isOpen && step === 'models'"
        key="models"
        ref="secondaryRowRef"
        class="pointer-events-auto fixed z-50 flex w-[min(56rem,calc(100vw-1.5rem))] flex-wrap items-center gap-x-2 gap-y-1.5"
        :class="[isRightAligned ? 'justify-end' : 'justify-start']"
        :style="secondaryRowStyle"
      >
        <template v-for="entry in browseModels" :key="entry.id">
          <button
            type="button"
            :class="[
              pickerModelClass,
              'inline-flex max-w-full items-center gap-1 text-left whitespace-normal',
              isModelActive(entry.id) ? pickerModelActiveClass : '',
            ]"
            @click="pickModel(entry.id)"
          >
            <ProviderIcon :provider="entry.modelProviderId" :class="pickerModelIconClass" />
            <span>{{ entry.name }}</span>
          </button>
        </template>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.hint-fade-enter-active {
  transition: opacity 0.7s ease-out;
}

.hint-fade-leave-active {
  transition: opacity 0.2s ease-out;
}

.hint-fade-enter-from,
.hint-fade-leave-to {
  opacity: 0;
}
</style>
