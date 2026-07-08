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
import {
  getDefaultEffort,
  getEffortLabel,
  getEffortLevels,
  modelSupportsFastMode,
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
  fastModeToggleActiveClass,
  fastModeToggleClass,
  pickerBackButtonClass,
  pickerModelActiveClass,
  pickerModelClass,
  pickerModelIconClass,
  thinkingToggleActiveClass,
} from "~/lib/composer-controls";

const provider = defineModel<ProviderId>("provider", { required: true });
const model = defineModel<string>("model", { required: true });
const effort = defineModel<string>("effort", { required: true });
const fastMode = defineModel<boolean>("fastMode", { required: true });
const thinking = defineModel<boolean>("thinking", { required: true });

type PickerStep = "providers" | "models" | "effort";

const rootRef = ref<HTMLElement | null>(null);
const secondaryRowRef = ref<HTMLElement | null>(null);
const isOpen = ref(false);
const step = ref<PickerStep>("providers");
const browseProvider = ref<ProviderId>(provider.value);

const triggerBounds = useElementBounding(rootRef);
const { recents, recordSelection } = useRecentModels();

const modelLabel = computed(() => getModelLabel(provider.value, model.value));
const activeModelProviderId = computed(() =>
  getModelProviderId(provider.value, model.value),
);
const browseModels = computed(() => getModelsForProvider(browseProvider.value));
const supportsFastForSelection = computed(() =>
  modelSupportsFastMode(provider.value, model.value),
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

const secondaryRowStyle = computed(() => ({
  top: `${triggerBounds.bottom.value + 8}px`,
  left: `${triggerBounds.left.value + triggerBounds.width.value / 2}px`,
}));

function syncSecondaryRowPosition() {
  triggerBounds.update();
}

function syncTraitsForSelection(nextProvider: ProviderId, nextModel: string) {
  effort.value = getDefaultEffort(nextProvider, nextModel);
  thinking.value = true;
}

function rememberSelection(
  nextProvider: ProviderId,
  nextModel: string,
  nextFastMode: boolean,
) {
  recordSelection({
    provider: nextProvider,
    model: nextModel,
    fastMode: nextFastMode,
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

function applySelection(
  nextProvider: ProviderId,
  nextModel: string,
  options?: { fast?: boolean },
) {
  const useFast = options?.fast ?? false;
  provider.value = nextProvider;
  model.value = nextModel;
  syncTraitsForSelection(nextProvider, nextModel);
  fastMode.value = useFast && modelSupportsFastMode(nextProvider, nextModel);
  rememberSelection(nextProvider, nextModel, fastMode.value);
  closePanel();
}

function pickModel(nextModel: string, options?: { fast?: boolean }) {
  applySelection(browseProvider.value, nextModel, options);
}

function pickModelFast(nextModel: string) {
  pickModel(nextModel, { fast: true });
}

function pickRecent(entry: RecentModelSelection) {
  applySelection(entry.provider, entry.model, { fast: entry.fastMode });
}

function toggleFastMode() {
  fastMode.value = !fastMode.value;
  rememberSelection(provider.value, model.value, fastMode.value);
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
  return (
    entry.provider === provider.value &&
    entry.model === model.value &&
    entry.fastMode === fastMode.value
  );
}

function supportsFastForBrowseModel(modelId: string) {
  return modelSupportsFastMode(browseProvider.value, modelId);
}

watch(provider, (nextProvider) => {
  const models = getModelsForProvider(nextProvider);
  if (!models.some((entry) => entry.id === model.value)) {
    model.value = DEFAULT_MODEL_BY_PROVIDER[nextProvider];
  }
  effort.value = normalizeEffort(nextProvider, model.value, effort.value);
  if (!modelSupportsFastMode(nextProvider, model.value)) {
    fastMode.value = false;
  }
  if (!modelSupportsThinkingToggle(nextProvider, model.value)) {
    thinking.value = true;
  }
});

watch(model, (nextModel) => {
  effort.value = normalizeEffort(provider.value, nextModel, effort.value);
  if (!modelSupportsFastMode(provider.value, nextModel)) {
    fastMode.value = false;
  }
  if (!modelSupportsThinkingToggle(provider.value, nextModel)) {
    thinking.value = true;
  }
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

onClickOutside([rootRef, secondaryRowRef], closePanel);

onMounted(() => {
  window.addEventListener("keydown", onKeyDown);
  rememberSelection(provider.value, model.value, fastMode.value);
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
      class="absolute left-1/2 top-1/2 inline-flex h-5 -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap"
    >
      <div class="inline-flex items-center gap-0.5">
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
          v-if="supportsFastForSelection"
          type="button"
          :class="[
            fastModeToggleClass,
            fastMode ? fastModeToggleActiveClass : '',
          ]"
          :aria-pressed="fastMode"
          aria-label="Toggle fast mode"
          title="Fast mode"
          @click="toggleFastMode"
        >
          <UIcon name="i-lucide-zap" class="size-3" aria-hidden="true" />
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
            fastModeToggleClass,
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
      class="absolute left-1/2 top-1/2 flex h-5 -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap"
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
          v-for="entry in MODEL_CATALOG"
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
            class="size-3.5 shrink-0 text-zinc-500 dark:text-zinc-400"
          />
        </button>
      </div>
    </div>

    <div
      v-else
      class="absolute left-1/2 top-1/2 flex h-5 max-w-[min(56rem,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 items-center gap-2 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
        class="pointer-events-auto fixed z-50 flex w-max max-w-[min(56rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-nowrap items-center justify-center gap-x-3 overflow-hidden whitespace-nowrap"
        :style="secondaryRowStyle"
      >
        <button
          v-for="entry in recents"
          :key="`${entry.provider}:${entry.model}:${entry.fastMode}`"
          type="button"
          :class="[
            pickerModelClass,
            'inline-flex shrink-0 items-center gap-1 whitespace-nowrap',
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
          <span class="max-w-[7rem] truncate">{{ getModelLabel(entry.provider, entry.model) }}</span>
          <UIcon
            v-if="entry.fastMode"
            name="i-lucide-zap"
            class="size-2.5 shrink-0 text-amber-500/80 dark:text-amber-400/80"
            aria-hidden="true"
          />
        </button>
      </div>

      <div
        v-else-if="isOpen && step === 'models'"
        key="models"
        ref="secondaryRowRef"
        class="pointer-events-auto fixed z-50 flex w-max max-w-[min(56rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-nowrap items-center justify-center gap-x-2 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        :style="secondaryRowStyle"
      >
        <div
          v-for="entry in browseModels"
          :key="entry.id"
          class="inline-flex shrink-0 items-center gap-0.5"
        >
          <button
            type="button"
            :class="[
              pickerModelClass,
              'inline-flex items-center gap-1 whitespace-nowrap',
              isModelActive(entry.id) ? pickerModelActiveClass : '',
            ]"
            @click="pickModel(entry.id)"
          >
            <ProviderIcon :provider="entry.modelProviderId" :class="pickerModelIconClass" />
            <span>{{ entry.name }}</span>
          </button>

          <button
            v-if="supportsFastForBrowseModel(entry.id)"
            type="button"
            :class="[fastModeToggleClass, 'hover:text-amber-500/80 dark:hover:text-amber-400/80']"
            aria-label="Select with fast mode"
            title="Fast mode"
            @click="pickModelFast(entry.id)"
          >
            <UIcon name="i-lucide-zap" class="size-2.5" aria-hidden="true" />
          </button>
        </div>
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
