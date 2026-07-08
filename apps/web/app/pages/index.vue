<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";
import RotatingText from "~/components/ui/rotating-text/RotatingText.vue";
import SplitText from "~/components/ui/split-text/SplitText.vue";
import ProviderModelPicker from "~/components/ProviderModelPicker.vue";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER,
  getModelLabel,
  getModelProviderId,
  getProviderLabel,
  isRoutedModel,
} from "~/lib/model-catalog";
import {
  getDefaultEffort,
  getEffortLabel,
  getEffortLevels,
  modelSupportsFastMode,
  modelSupportsThinkingToggle,
} from "~/lib/model-capabilities";

const prompt = ref("");
const isFocused = ref(false);
const isSubmitted = ref(false);
const responseText = ref("");
const thinkingText = ref("");
const selectedProvider = ref(DEFAULT_PROVIDER);
const selectedModel = ref(DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER]);
const selectedEffort = ref(getDefaultEffort(DEFAULT_PROVIDER, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER]));
const selectedFastMode = ref(false);
const selectedThinking = ref(true);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const BASE_FONT_SIZE = 20;
const MIN_FONT_SIZE = 14;
const promptFontSize = ref(BASE_FONT_SIZE);

const promptTypographyStyle = computed(() => ({
  fontSize: `${promptFontSize.value}px`,
  lineHeight: 1.625,
}));

const placeholderPrefix = "What should we";
const rotatingWords = ["build?", "ship?", "launch?", "design?"];

const longestRotatingWord = computed(() =>
  rotatingWords.reduce(
    (longest, word) => (word.length > longest.length ? word : longest),
    rotatingWords[0] ?? "",
  ),
);

const computePromptFontSize = (el: HTMLTextAreaElement) => {
  const length = prompt.value.length;
  const lineHeight = BASE_FONT_SIZE * 1.625;

  el.style.fontSize = `${BASE_FONT_SIZE}px`;
  el.style.height = "auto";

  const lineCount = Math.max(1, Math.round(el.scrollHeight / lineHeight));
  let nextSize = BASE_FONT_SIZE;

  if (length > 140 || lineCount > 5) nextSize = MIN_FONT_SIZE;
  else if (length > 90 || lineCount > 4) nextSize = 15;
  else if (length > 55 || lineCount > 3) nextSize = 16;
  else if (length > 30 || lineCount > 2) nextSize = 18;

  return nextSize;
};

const adjustHeight = () => {
  const el = textareaRef.value;
  if (!el) return;

  promptFontSize.value = computePromptFontSize(el);
  el.style.fontSize = `${promptFontSize.value}px`;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
};

const handleInput = () => {
  adjustHeight();
};

const simulateStreaming = () => {
  const providerLabel = getProviderLabel(selectedProvider.value);
  const modelLabel = getModelLabel(selectedProvider.value, selectedModel.value);
  const modelProviderLabel = getProviderLabel(
    getModelProviderId(selectedProvider.value, selectedModel.value),
  );
  const routeSummary = isRoutedModel(selectedProvider.value, selectedModel.value)
    ? `${providerLabel} → ${modelProviderLabel} · ${modelLabel}`
    : `${providerLabel} · ${modelLabel}`;
  const effortLabel = getEffortLabel(
    selectedProvider.value,
    selectedModel.value,
    selectedEffort.value,
  );
  const effortLevels = getEffortLevels(selectedProvider.value, selectedModel.value);
  const hasEffort = effortLevels.length > 0;
  const showsThinking =
    modelSupportsThinkingToggle(selectedProvider.value, selectedModel.value) &&
    selectedThinking.value;
  const showsReasoning = hasEffort || showsThinking;
  const traits = [
    hasEffort && effortLabel ? `${effortLabel} reasoning` : null,
    modelSupportsFastMode(selectedProvider.value, selectedModel.value) && selectedFastMode.value
      ? "Fast mode"
      : null,
    showsThinking ? "Thinking on" : null,
    modelSupportsThinkingToggle(selectedProvider.value, selectedModel.value) &&
    !selectedThinking.value
      ? "Thinking off"
      : null,
  ].filter(Boolean);
  const traitSummary = traits.length > 0 ? ` · ${traits.join(" · ")}` : "";
  const response = `Using ${routeSummary}${traitSummary}. Understood. Creating the new design system details. Setting up clean, responsive layouts, establishing dynamic color schemes, and configuring modern micro-animations for interactions...`;

  thinkingText.value = showsReasoning
    ? `Reasoning at ${effortLabel || "default"} depth before responding. Considering layout constraints, animation timing, and how the composer should surface model traits without breaking the minimal prompt flow...`
    : "";

  if (thinkingText.value) {
    setTimeout(() => {
      responseText.value = response;
    }, 900);
    return;
  }

  responseText.value = response;
};

const thinkingBlocks = computed(() => {
  if (!thinkingText.value) return [];
  return thinkingText.value
    .split(/(?<=[.!?])\s+/)
    .map((block) => block.trim())
    .filter(Boolean);
});

const responseBlocks = computed(() => {
  if (!responseText.value) return [];
  return responseText.value
    .split(/(?<=[.!?])\s+/)
    .map((block) => block.trim())
    .filter(Boolean);
});

const handleKeyDown = (event: KeyboardEvent) => {
  if (isSubmitted.value) return;

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (prompt.value.trim()) {
      isSubmitted.value = true;
      if (textareaRef.value) {
        textareaRef.value.blur();
      }
      setTimeout(() => {
        simulateStreaming();
      }, 700);
    }
    return;
  }

  if (
    textareaRef.value &&
    document.activeElement !== textareaRef.value &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    event.key.length === 1
  ) {
    textareaRef.value.focus();
  }
};

onMounted(() => {
  window.addEventListener("keydown", handleKeyDown);
  nextTick(() => {
    adjustHeight();
  });
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeyDown);
});
</script>

<template>
  <div class="h-screen w-screen flex flex-col items-center justify-center p-6 bg-[#fafafa] dark:bg-[#070708] transition-colors duration-700 relative overflow-hidden">
    <!-- Main content area container handling layout shifts smoothly -->
    <div 
      class="w-full max-w-3xl flex flex-col items-center justify-center transition-all duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)] relative h-full w-full"
    >
      <!-- Input Area centered initially, then shifts to stick at absolute top -->
      <div 
        class="w-full flex flex-col items-center justify-center transition-all duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)] absolute"
        :class="[isSubmitted ? 'top-12 translate-y-0 scale-95' : 'top-1/2 -translate-y-1/2 scale-100']"
      >
        <!-- Input wrapper where both the textarea and placeholder share dimensions -->
        <div class="relative w-full flex justify-center items-center">
          <textarea
            ref="textareaRef"
            v-model="prompt"
            aria-label="What should we build?"
            @input="handleInput"
            @focus="isFocused = true"
            @blur="isFocused = false"
            rows="1"
            :disabled="isSubmitted"
            class="w-full bg-transparent text-zinc-800 dark:text-zinc-100 resize-none outline-none border-none font-light text-center caret-zinc-500 dark:caret-zinc-400 tracking-tight z-10 transition-[font-size,height] duration-300 ease-out disabled:cursor-default"
            :style="{ overflow: 'hidden', height: 'auto', ...promptTypographyStyle }"
          />
          <div
            v-if="!prompt && !isFocused"
            class="absolute inset-0 flex items-center justify-center pointer-events-none z-0"
            aria-hidden="true"
          >
            <span
              class="inline-flex items-baseline justify-center font-light text-center tracking-tight text-zinc-400 dark:text-zinc-600"
              :style="promptTypographyStyle"
            >
              <span class="shrink-0">{{ placeholderPrefix }}&nbsp;</span>
              <span class="relative inline-block overflow-hidden text-left">
                <span class="invisible select-none" aria-hidden="true">
                  {{ longestRotatingWord }}
                </span>
                <span class="absolute inset-0">
                  <RotatingText
                    :texts="rotatingWords"
                    :rotation-interval="4000"
                    class="size-full"
                  />
                </span>
              </span>
            </span>
          </div>
        </div>
        
        <!-- Composer route + run hint -->
        <div
          v-if="!isSubmitted"
          class="relative mt-6 h-5 w-full max-w-xl shrink-0 px-2 transition-opacity duration-700 ease-out"
          :class="[prompt ? 'opacity-100' : 'opacity-70']"
        >
          <ProviderModelPicker
            v-model:provider="selectedProvider"
            v-model:model="selectedModel"
            v-model:effort="selectedEffort"
            v-model:fast-mode="selectedFastMode"
            v-model:thinking="selectedThinking"
          />
          <span
            class="pointer-events-none absolute right-2 top-0 text-[10px] font-mono uppercase tracking-[0.28em] text-zinc-400 transition-all duration-700 ease-out dark:text-zinc-600"
            :class="[prompt ? 'opacity-100' : 'opacity-0']"
          >
            enter ↵
          </span>
        </div>
      </div>

      <!-- Simulated Streaming Response Area -->
      <transition name="response-fade">
        <div 
          v-if="isSubmitted"
          class="absolute top-28 left-0 right-0 overflow-hidden px-4 py-2 leading-relaxed font-light text-base tracking-normal max-w-2xl mx-auto text-left transition-all duration-[800ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
        >
          <SplitText
            v-for="(block, index) in thinkingBlocks"
            :key="`thinking-${index}-${block}`"
            :text="block"
            by="words"
            :active="!!thinkingText"
            :start-delay="index * 280"
            :delay="55"
            :duration="0.4"
            :from="{ opacity: 0, y: 8 }"
            :to="{ opacity: 1, y: 0 }"
            class="mb-3 block text-zinc-400 dark:text-zinc-500 leading-relaxed font-light text-sm tracking-normal italic last:mb-0"
          />

          <SplitText
            v-for="(block, index) in responseBlocks"
            :key="`${index}-${block}`"
            :text="block"
            by="words"
            :active="!!responseText"
            :start-delay="thinkingBlocks.length * 280 + index * 420"
            :delay="70"
            :duration="0.45"
            :from="{ opacity: 0, y: 12 }"
            :to="{ opacity: 1, y: 0 }"
            class="mb-3 block text-zinc-700 dark:text-zinc-300 leading-relaxed font-light text-base tracking-normal last:mb-0"
          />
        </div>
      </transition>
    </div>
  </div>
</template>

<style scoped>
.response-fade-enter-active {
  transition: all 0.8s cubic-bezier(0.16, 1, 0.3, 1);
  transition-property: opacity, transform;
}
.response-fade-enter-from {
  opacity: 0;
  transform: translateY(20px);
}
</style>
