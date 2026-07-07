<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";
import RotatingText from "~/components/ui/rotating-text/RotatingText.vue";

const prompt = ref("");
const isFocused = ref(false);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const placeholderPrefix = "What should we";
const rotatingWords = ["build?", "ship?", "launch?", "design?"];

const longestRotatingWord = computed(() =>
  rotatingWords.reduce(
    (longest, word) => (word.length > longest.length ? word : longest),
    rotatingWords[0] ?? "",
  ),
);

const adjustHeight = () => {
  const el = textareaRef.value;
  if (el) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }
};

const handleInput = () => {
  adjustHeight();
};

const handleKeyDown = (event: KeyboardEvent) => {
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
  <div class="h-screen w-screen flex items-center justify-center p-6 bg-[#fafafa] dark:bg-[#070708] transition-colors duration-700">
    <div class="w-full max-w-3xl flex flex-col items-center justify-center">
      <!-- Centered Input Area -->
      <div class="w-full flex flex-col items-center justify-center relative">
        <!-- Input Overlay wrapper where both the textarea and characters share exact dimensions and layout rules -->
        <div class="relative w-full flex justify-center items-center">
          <textarea
            ref="textareaRef"
            v-model="prompt"
            aria-label="What should we build?"
            @input="handleInput"
            @focus="isFocused = true"
            @blur="isFocused = false"
            rows="1"
            class="w-full bg-transparent text-zinc-800 dark:text-zinc-100 resize-none outline-none border-none text-4xl font-light text-center leading-relaxed caret-zinc-500 dark:caret-zinc-400 tracking-tight z-10 transition-all duration-300"
            style="overflow: hidden; height: auto;"
          />
          <div
            v-if="!prompt && !isFocused"
            class="absolute inset-0 flex items-center justify-center pointer-events-none z-0"
            aria-hidden="true"
          >
            <span
              class="inline-flex items-baseline justify-center text-4xl font-light text-center leading-relaxed tracking-tight text-zinc-400 dark:text-zinc-600"
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
        
        <!-- Subtle dynamic details below input -->
        <div 
          class="mt-6 flex gap-4 text-xs font-mono text-zinc-400 dark:text-zinc-600 transition-all duration-700 ease-out"
          :class="[prompt ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none']"
        >
          <span class="tracking-widest">press enter to run</span>
        </div>
      </div>
    </div>
  </div>
</template>






