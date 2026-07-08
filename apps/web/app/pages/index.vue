<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
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
const MIN_FONT_SIZE = 16;
const LINE_HEIGHT_RATIO = 1.35;
const promptFontSize = ref(BASE_FONT_SIZE);

const isPromptDimmed = computed(
  () => isSubmitted.value && Boolean(thinkingText.value || responseText.value),
);

const promptTypographyStyle = computed(() => ({
  fontSize: `${promptFontSize.value}px`,
  lineHeight: LINE_HEIGHT_RATIO,
}));

const placeholderPrefix = "What should we";
const rotatingWords = ["build?", "ship?", "launch?", "design?"];

const longestRotatingWord = computed(() =>
  rotatingWords.reduce(
    (longest, word) => (word.length > longest.length ? word : longest),
    rotatingWords[0] ?? "",
  ),
);

const measurePromptLineCount = (el: HTMLTextAreaElement, fontSize: number) => {
  const previousFontSize = el.style.fontSize;
  const previousHeight = el.style.height;

  el.style.fontSize = `${fontSize}px`;
  el.style.height = "0px";

  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const lineCount = Math.max(1, Math.round(el.scrollHeight / lineHeight));

  el.style.fontSize = previousFontSize;
  el.style.height = previousHeight;

  return lineCount;
};

const computePromptFontSize = (el: HTMLTextAreaElement) => {
  const length = prompt.value.length;
  const lineCount = measurePromptLineCount(el, BASE_FONT_SIZE);
  let nextSize = BASE_FONT_SIZE;

  if (length > 200 || lineCount > 8) nextSize = MIN_FONT_SIZE;
  else if (length > 140 || lineCount > 6) nextSize = 17;
  else if (length > 90 || lineCount > 5) nextSize = 18;
  else if (length > 50 || lineCount > 4) nextSize = 19;

  return nextSize;
};

const supportsFieldSizing =
  typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

const adjustHeight = () => {
  const el = textareaRef.value;
  if (!el) return;

  promptFontSize.value = computePromptFontSize(el);
  el.style.fontSize = `${promptFontSize.value}px`;
  el.style.lineHeight = String(LINE_HEIGHT_RATIO);

  if (supportsFieldSizing) {
    el.style.removeProperty("height");
    return;
  }

  const minHeight = promptFontSize.value * LINE_HEIGHT_RATIO;
  el.style.height = "0px";
  el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
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
      nextTick(() => {
        adjustHeight();
      });
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

watch(isSubmitted, (submitted) => {
  if (!submitted) return;
  nextTick(() => {
    adjustHeight();
  });
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeyDown);
});
</script>

<template>
  <div class="notebook-page h-screen w-screen overflow-x-hidden overflow-y-auto bg-[#fafafa] px-10 pt-28 pb-10 transition-colors duration-700 dark:bg-[#070708] md:px-14 md:pt-36 md:pb-12">
    <div class="mx-auto flex w-full max-w-2xl flex-col items-start">
      <div class="w-full shrink-0">
        <div
          class="transition-opacity duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]"
          :class="[isPromptDimmed ? 'opacity-40' : 'opacity-100']"
        >
          <div class="relative w-full text-left">
            <p
              v-if="isSubmitted"
              class="m-0 whitespace-pre-wrap text-left font-light text-zinc-800 tracking-tight dark:text-zinc-100"
              :style="promptTypographyStyle"
            >
              {{ prompt }}
            </p>
            <textarea
              v-else
              ref="textareaRef"
              v-model="prompt"
              aria-label="What should we build?"
              @input="handleInput"
              @focus="isFocused = true"
              @blur="isFocused = false"
              rows="1"
              class="prompt-input block w-full m-0 p-0 bg-transparent text-left font-light text-zinc-800 caret-zinc-500 resize-none border-none outline-none tracking-tight transition-[font-size,height] duration-300 ease-out dark:text-zinc-100 dark:caret-zinc-400"
              :style="{ overflow: 'hidden', ...promptTypographyStyle }"
            />
            <div
              v-if="!isSubmitted && !prompt && !isFocused"
              class="pointer-events-none absolute inset-x-0 top-0 z-0 text-left"
              aria-hidden="true"
            >
              <span
                class="inline-flex max-w-full items-baseline justify-start text-left font-light tracking-tight text-zinc-400 dark:text-zinc-600"
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
        </div>

        <div
          class="relative overflow-hidden transition-all duration-500 ease-out"
          :class="[
            isSubmitted
              ? 'pointer-events-none mt-0 max-h-0 opacity-0'
              : 'mt-8 h-5 opacity-70',
            prompt && !isSubmitted ? 'opacity-100' : '',
          ]"
        >
          <ProviderModelPicker
            v-model:provider="selectedProvider"
            v-model:model="selectedModel"
            v-model:effort="selectedEffort"
            v-model:fast-mode="selectedFastMode"
            v-model:thinking="selectedThinking"
          />
          <span
            class="pointer-events-none absolute right-0 top-0 text-[10px] font-mono uppercase tracking-[0.28em] text-zinc-400 transition-all duration-700 ease-out dark:text-zinc-600"
            :class="[prompt ? 'opacity-100' : 'opacity-0']"
          >
            enter ↵
          </span>
        </div>
      </div>

      <div
        v-if="isSubmitted"
        class="response-scroll mt-3 w-full"
      >
        <div class="text-left text-base font-light leading-relaxed tracking-normal">
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
            class="mb-3 block text-sm font-light italic leading-relaxed tracking-normal text-zinc-400 last:mb-0 dark:text-zinc-500"
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
            class="mb-3 block text-base font-light leading-relaxed tracking-normal text-zinc-700 last:mb-0 dark:text-zinc-300"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notebook-page {
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.notebook-page::-webkit-scrollbar {
  display: none;
}

.prompt-input {
  field-sizing: content;
  min-height: 1lh;
  vertical-align: top;
}

@supports not (field-sizing: content) {
  .prompt-input {
    overflow: hidden;
  }
}
</style>
