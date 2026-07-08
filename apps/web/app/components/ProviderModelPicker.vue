<script setup lang="ts">
import { onClickOutside } from "@vueuse/core";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_CATALOG,
  type ProviderId,
  getModelLabel,
  getModelsForProvider,
  getProviderLabel,
} from "~/lib/model-catalog";
import ProviderIcon from "~/components/ProviderIcon.vue";
import {
  composerControlButtonClass,
  composerControlIconClass,
  composerControlLabelClass,
  composerControlValueClass,
} from "~/lib/composer-controls";

const provider = defineModel<ProviderId>("provider", { required: true });
const model = defineModel<string>("model", { required: true });

const rootRef = ref<HTMLElement | null>(null);
const isOpen = ref(false);
const panelProvider = ref<ProviderId>(provider.value);

const panelModels = computed(() => getModelsForProvider(panelProvider.value));
const modelLabel = computed(() => getModelLabel(provider.value, model.value));

function openPanel() {
  panelProvider.value = provider.value;
  isOpen.value = true;
}

function closePanel() {
  isOpen.value = false;
}

function selectProvider(nextProvider: ProviderId) {
  panelProvider.value = nextProvider;
  const models = getModelsForProvider(nextProvider);
  if (!models.some((entry) => entry.id === model.value)) {
    model.value = DEFAULT_MODEL_BY_PROVIDER[nextProvider];
  }
  provider.value = nextProvider;
}

function selectModel(nextModel: string) {
  provider.value = panelProvider.value;
  model.value = nextModel;
  closePanel();
}

watch(provider, (nextProvider) => {
  const models = getModelsForProvider(nextProvider);
  if (!models.some((entry) => entry.id === model.value)) {
    model.value = DEFAULT_MODEL_BY_PROVIDER[nextProvider];
  }
});

onClickOutside(rootRef, closePanel);
</script>

<template>
  <div ref="rootRef" class="relative">
    <button
      type="button"
      :class="[
        composerControlButtonClass,
        isOpen ? 'text-zinc-600 dark:text-zinc-300' : '',
      ]"
      @click="isOpen ? closePanel() : openPanel()"
    >
      <span :class="composerControlLabelClass">via</span>
      <ProviderIcon :provider="provider" :class="composerControlIconClass" />
      <span :class="[composerControlValueClass, 'max-w-[11rem] truncate']">
        {{ modelLabel }}
      </span>
    </button>

    <transition name="route-panel">
      <div
        v-if="isOpen"
        class="absolute left-1/2 top-[calc(100%+0.75rem)] z-20 w-[min(20rem,calc(100vw-3rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-zinc-200/50 bg-[#fafafa]/90 shadow-[0_20px_60px_-24px_rgba(0,0,0,0.28)] backdrop-blur-xl dark:border-zinc-800/80 dark:bg-[#0b0b0c]/92"
      >
        <div class="border-b border-zinc-200/60 px-3 py-3 dark:border-zinc-800/80">
          <div class="flex items-center justify-between gap-3">
            <span class="text-[10px] font-mono uppercase tracking-[0.24em] text-zinc-400">
              route
            </span>
            <span class="truncate text-xs font-light text-zinc-500 dark:text-zinc-500">
              {{ getProviderLabel(panelProvider) }} → {{ getModelLabel(panelProvider, model) }}
            </span>
          </div>

          <div class="mt-3 flex items-center justify-between gap-1">
            <button
              v-for="entry in MODEL_CATALOG"
              :key="entry.id"
              type="button"
              class="flex flex-1 flex-col items-center gap-1 rounded-xl px-1 py-2 transition-all duration-300"
              :class="
                entry.id === panelProvider
                  ? 'bg-zinc-200/70 text-zinc-800 dark:bg-zinc-800/90 dark:text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-100/80 hover:text-zinc-600 dark:hover:bg-zinc-900/70 dark:hover:text-zinc-300'
              "
              :title="entry.label"
              @click="selectProvider(entry.id)"
            >
              <ProviderIcon :provider="entry.id" class="size-4 shrink-0" />
              <span class="max-w-full truncate text-[9px] font-mono uppercase tracking-[0.14em]">
                {{ entry.label }}
              </span>
            </button>
          </div>
        </div>

        <div class="px-2 py-2">
          <transition name="model-list" mode="out-in">
            <div :key="panelProvider" class="flex flex-col">
              <button
                v-for="entry in panelModels"
                :key="entry.id"
                type="button"
                class="rounded-xl px-3 py-2.5 text-left transition-all duration-200"
                :class="
                  entry.id === model
                    ? 'bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-600 hover:bg-zinc-100/90 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900/80 dark:hover:text-zinc-100'
                "
                @click="selectModel(entry.id)"
              >
                <span class="block text-sm font-light tracking-tight">{{ entry.name }}</span>
                <span class="mt-0.5 block text-[10px] font-mono uppercase tracking-[0.18em] opacity-55">
                  {{ entry.id }}
                </span>
              </button>
            </div>
          </transition>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.route-panel-enter-active,
.route-panel-leave-active {
  transition:
    opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

.route-panel-enter-from,
.route-panel-leave-to {
  opacity: 0;
  transform: translate(-50%, -6px) scale(0.98);
}

.model-list-enter-active,
.model-list-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.model-list-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.model-list-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
