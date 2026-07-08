<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import RotatingText from "~/components/ui/rotating-text/RotatingText.vue";
import SplitText from "~/components/ui/split-text/SplitText.vue";
import ProviderModelPicker from "~/components/ProviderModelPicker.vue";
import { useDroidBridge } from "~/composables/useDroidBridge";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER,
} from "~/lib/model-catalog";
import {
  getDefaultEffort,
} from "~/lib/model-capabilities";

type TurnStatus = "pending" | "streaming" | "completed" | "error";

type ConversationTurn = {
  id: string;
  prompt: string;
  responseText: string;
  thinkingText: string;
  status: TurnStatus;
  errorMessage?: string;
};

const turns = ref<ConversationTurn[]>([]);
const draftPrompt = ref("");
const isLandingFocused = ref(false);
const selectedProvider = ref(DEFAULT_PROVIDER);
const selectedModel = ref(DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER]);
const selectedEffort = ref(getDefaultEffort(DEFAULT_PROVIDER, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER]));
const selectedFastMode = ref(false);
const selectedThinking = ref(true);
const isSubmitting = ref(false);
const landingTextareaRef = ref<HTMLTextAreaElement | null>(null);
const followUpTextareaRef = ref<HTMLTextAreaElement | null>(null);
const transcriptEndRef = ref<HTMLDivElement | null>(null);

const {
  bridgeError,
  pendingPermission,
  submitPrompt: submitPromptToBridge,
  respondToPermission,
  onMessage,
  onModelsReady,
} = useDroidBridge();

const BASE_FONT_SIZE = 17;
const FOLLOW_UP_FONT_SIZE = 15;
const MIN_FONT_SIZE = 14;
const RESPONSE_FONT_SIZE = 14;
const LINE_HEIGHT_RATIO = 1.35;
const landingFontSize = ref(BASE_FONT_SIZE);
const followUpFontSize = ref(FOLLOW_UP_FONT_SIZE);

const hasThread = computed(() => turns.value.length > 0);
const isLanding = computed(() => !hasThread.value);

const landingTypographyStyle = computed(() => ({
  fontSize: `${landingFontSize.value}px`,
  lineHeight: LINE_HEIGHT_RATIO,
}));

const followUpTypographyStyle = computed(() => ({
  fontSize: `${followUpFontSize.value}px`,
  lineHeight: LINE_HEIGHT_RATIO,
}));

const threadPromptStyle = computed(() => ({
  fontSize: `${FOLLOW_UP_FONT_SIZE}px`,
  lineHeight: LINE_HEIGHT_RATIO,
}));

const responseTypographyStyle = computed(() => ({
  fontSize: `${RESPONSE_FONT_SIZE}px`,
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

const computeLandingFontSize = (el: HTMLTextAreaElement) => {
  const length = draftPrompt.value.length;
  const lineCount = measurePromptLineCount(el, BASE_FONT_SIZE);
  let nextSize = BASE_FONT_SIZE;

  if (length > 200 || lineCount > 8) nextSize = MIN_FONT_SIZE;
  else if (length > 140 || lineCount > 6) nextSize = 15;
  else if (length > 90 || lineCount > 5) nextSize = 16;
  else if (length > 50 || lineCount > 4) nextSize = 16;

  return nextSize;
};

const computeFollowUpFontSize = (el: HTMLTextAreaElement) => {
  const length = draftPrompt.value.length;
  const lineCount = measurePromptLineCount(el, FOLLOW_UP_FONT_SIZE);
  let nextSize = FOLLOW_UP_FONT_SIZE;

  if (length > 180 || lineCount > 7) nextSize = MIN_FONT_SIZE;
  else if (length > 120 || lineCount > 5) nextSize = 14;

  return nextSize;
};

const supportsFieldSizing =
  typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

const adjustTextareaHeight = (
  el: HTMLTextAreaElement | null,
  mode: "landing" | "follow-up",
) => {
  if (!el) return;

  if (mode === "landing") {
    landingFontSize.value = computeLandingFontSize(el);
    el.style.fontSize = `${landingFontSize.value}px`;
  } else {
    followUpFontSize.value = computeFollowUpFontSize(el);
    el.style.fontSize = `${followUpFontSize.value}px`;
  }

  el.style.lineHeight = String(LINE_HEIGHT_RATIO);

  if (supportsFieldSizing) {
    el.style.removeProperty("height");
    return;
  }

  const fontSize = mode === "landing" ? landingFontSize.value : followUpFontSize.value;
  const minHeight = fontSize * LINE_HEIGHT_RATIO;
  el.style.height = "0px";
  el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
};

const handleLandingInput = () => {
  adjustTextareaHeight(landingTextareaRef.value, "landing");
};

const handleFollowUpInput = () => {
  adjustTextareaHeight(followUpTextareaRef.value, "follow-up");
};

const splitIntoBlocks = (text: string) =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((block) => block.trim())
    .filter(Boolean);

const isTurnDimmed = (turn: ConversationTurn) =>
  turn.status === "completed" || turn.status === "error" || Boolean(turn.responseText);

const findTurn = (turnId: string) => turns.value.find((turn) => turn.id === turnId);

const scrollTranscriptToEnd = () => {
  nextTick(() => {
    transcriptEndRef.value?.scrollIntoView({ behavior: "smooth", block: "end" });
  });
};

const submitPrompt = () => {
  const trimmedPrompt = draftPrompt.value.trim();
  if (!trimmedPrompt || isSubmitting.value) return;

  const turn: ConversationTurn = {
    id: crypto.randomUUID(),
    prompt: trimmedPrompt,
    responseText: "",
    thinkingText: "",
    status: "pending",
  };

  turns.value.push(turn);
  draftPrompt.value = "";
  isSubmitting.value = true;

  nextTick(() => {
    if (hasThread.value) {
      adjustTextareaHeight(followUpTextareaRef.value, "follow-up");
      followUpTextareaRef.value?.focus();
    } else {
      adjustTextareaHeight(landingTextareaRef.value, "landing");
    }
    scrollTranscriptToEnd();
  });

  const sent = submitPromptToBridge({
    turnId: turn.id,
    prompt: trimmedPrompt,
    modelId: selectedModel.value,
    reasoningEffort: selectedEffort.value,
  });

  if (!sent) {
    turn.status = "error";
    turn.errorMessage = bridgeError.value ?? "Could not reach the Droid bridge.";
    isSubmitting.value = false;
  }
};

const handleLandingKeyDown = (event: KeyboardEvent) => {
  if (!isLanding.value) return;

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (draftPrompt.value.trim()) {
      landingTextareaRef.value?.blur();
      submitPrompt();
    }
    return;
  }

  if (
    landingTextareaRef.value &&
    document.activeElement !== landingTextareaRef.value &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    event.key.length === 1
  ) {
    landingTextareaRef.value.focus();
  }
};

const handleGlobalKeyDown = (event: KeyboardEvent) => {
  if (isLanding.value) {
    handleLandingKeyDown(event);
    return;
  }

  if (
    followUpTextareaRef.value &&
    document.activeElement !== followUpTextareaRef.value &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    event.key.length === 1
  ) {
    followUpTextareaRef.value.focus();
  }
};

const handleFollowUpKeyDown = (event: KeyboardEvent) => {
  if (isLanding.value) return;

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (draftPrompt.value.trim()) {
      followUpTextareaRef.value?.blur();
      submitPrompt();
    }
  }
};

onMounted(() => {
  window.addEventListener("keydown", handleGlobalKeyDown);
  nextTick(() => {
    adjustTextareaHeight(landingTextareaRef.value, "landing");
  });

  onModelsReady(({ defaultModelId, defaultReasoningEffort }) => {
    if (defaultModelId) {
      selectedModel.value = defaultModelId;
      selectedEffort.value = defaultReasoningEffort;
    }
  });

  onMessage((message) => {
    if (message.type === "turn.delta") {
      const turn = findTurn(message.turnId);
      if (!turn) return;
      turn.status = "streaming";
      turn.responseText += message.text;
      scrollTranscriptToEnd();
      return;
    }

    if (message.type === "turn.thinking") {
      const turn = findTurn(message.turnId);
      if (!turn) return;
      turn.thinkingText += message.text;
      scrollTranscriptToEnd();
      return;
    }

    if (message.type === "turn.completed") {
      const turn = findTurn(message.turnId);
      if (!turn) return;
      turn.status = "completed";
      isSubmitting.value = false;
      scrollTranscriptToEnd();
      return;
    }

    if (message.type === "turn.error") {
      const turn = findTurn(message.turnId);
      if (!turn) return;
      turn.status = "error";
      turn.errorMessage = message.message;
      isSubmitting.value = false;
      scrollTranscriptToEnd();
    }
  });
});

watch(hasThread, (inThread) => {
  if (!inThread) return;
  nextTick(() => {
    adjustTextareaHeight(followUpTextareaRef.value, "follow-up");
    followUpTextareaRef.value?.focus();
  });
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleGlobalKeyDown);
});
</script>

<template>
  <div
    class="notebook-page h-screen w-screen overflow-x-hidden overflow-y-auto bg-[#fafafa] px-10 pt-28 pb-10 transition-colors duration-700 dark:bg-[#070708] md:px-14 md:pt-36 md:pb-12"
    :class="[hasThread ? 'pt-12 md:pt-14' : '']"
  >
    <div class="mx-auto flex w-full max-w-2xl flex-col items-start">
      <p
        v-if="bridgeError"
        class="mb-6 w-full text-sm font-light text-amber-700 dark:text-amber-300"
      >
        {{ bridgeError }}
      </p>

      <div
        v-if="pendingPermission"
        class="mb-6 w-full rounded-xl border border-zinc-200 bg-white/80 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900/80"
      >
        <p class="m-0 font-light text-zinc-700 dark:text-zinc-300">
          {{ pendingPermission.detail }}
        </p>
        <div class="mt-3 flex gap-2">
          <button
            type="button"
            class="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            @click="respondToPermission(true)"
          >
            Allow
          </button>
          <button
            type="button"
            class="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
            @click="respondToPermission(false)"
          >
            Deny
          </button>
        </div>
      </div>

      <template v-for="(turn, turnIndex) in turns" :key="turn.id">
        <div
          class="w-full shrink-0"
          :class="[turnIndex > 0 ? 'mt-12' : '']"
        >
          <div
            class="transition-opacity duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]"
            :class="[isTurnDimmed(turn) ? 'opacity-40' : 'opacity-100']"
          >
            <p
              class="m-0 whitespace-pre-wrap text-left font-light text-zinc-800 tracking-tight dark:text-zinc-100"
              :style="turnIndex === 0 ? landingTypographyStyle : threadPromptStyle"
            >
              {{ turn.prompt }}
            </p>
          </div>

          <div
            v-if="turn.thinkingText"
            class="mt-3 w-full text-xs font-light leading-relaxed text-zinc-500 dark:text-zinc-500"
          >
            {{ turn.thinkingText }}
          </div>

          <div
            v-if="turn.status === 'streaming' && turn.responseText"
            class="response-scroll mt-3 w-full whitespace-pre-wrap text-left font-light leading-relaxed tracking-normal text-zinc-700 dark:text-zinc-300"
            :style="responseTypographyStyle"
          >
            {{ turn.responseText }}
          </div>

          <div
            v-else-if="turn.responseText"
            class="response-scroll mt-3 w-full"
          >
            <div class="text-left font-light leading-relaxed tracking-normal" :style="responseTypographyStyle">
              <SplitText
                v-for="(block, index) in splitIntoBlocks(turn.responseText)"
                :key="`${turn.id}-response-${index}-${block}`"
                :text="block"
                by="words"
                :active="turn.status === 'completed'"
                :start-delay="index * 420"
                :delay="70"
                :duration="0.45"
                :from="{ opacity: 0, y: 12 }"
                :to="{ opacity: 1, y: 0 }"
                class="mb-3 block font-light leading-relaxed tracking-normal text-zinc-700 last:mb-0 dark:text-zinc-300"
              />
            </div>
          </div>

          <p
            v-else-if="turn.status === 'pending'"
            class="mt-3 text-sm font-light text-zinc-400 dark:text-zinc-600"
          >
            Thinking...
          </p>

          <p
            v-if="turn.status === 'error' && turn.errorMessage"
            class="mt-3 text-sm font-light text-red-600 dark:text-red-400"
          >
            {{ turn.errorMessage }}
          </p>
        </div>
      </template>

      <div v-if="isLanding" class="w-full shrink-0">
        <div class="relative w-full text-left">
          <textarea
            ref="landingTextareaRef"
            v-model="draftPrompt"
            aria-label="What should we build?"
            @input="handleLandingInput"
            @focus="isLandingFocused = true"
            @blur="isLandingFocused = false"
            rows="1"
            class="prompt-input block w-full m-0 p-0 bg-transparent text-left font-light text-zinc-800 caret-zinc-500 resize-none border-none outline-none tracking-tight transition-[font-size,height] duration-300 ease-out dark:text-zinc-100 dark:caret-zinc-400"
            :style="{ overflow: 'hidden', ...landingTypographyStyle }"
          />
          <div
            v-if="!draftPrompt && !isLandingFocused"
            class="pointer-events-none absolute inset-x-0 top-0 z-0 text-left"
            aria-hidden="true"
          >
            <span
              class="inline-flex max-w-full items-baseline justify-start text-left font-light tracking-tight text-zinc-400 dark:text-zinc-600"
              :style="landingTypographyStyle"
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

        <div
          class="relative mt-8 h-5 overflow-hidden opacity-70 transition-all duration-500 ease-out"
          :class="[draftPrompt ? 'opacity-100' : '']"
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
            :class="[draftPrompt ? 'opacity-100' : 'opacity-0']"
          >
            enter ↵
          </span>
        </div>
      </div>

      <div
        v-if="hasThread"
        class="mt-12 w-full shrink-0"
      >
        <div class="relative w-full text-left">
          <textarea
            ref="followUpTextareaRef"
            v-model="draftPrompt"
            aria-label="Send another message in this thread"
            @input="handleFollowUpInput"
            @keydown="handleFollowUpKeyDown"
            rows="1"
            class="prompt-input block w-full m-0 p-0 bg-transparent text-left font-light text-zinc-800 caret-zinc-500 resize-none border-none outline-none tracking-tight transition-[font-size,height] duration-300 ease-out dark:text-zinc-100 dark:caret-zinc-400"
            :style="{ overflow: 'hidden', ...followUpTypographyStyle }"
          />
        </div>

        <div
          class="relative mt-5 h-5 overflow-hidden opacity-70 transition-all duration-500 ease-out"
          :class="[draftPrompt ? 'opacity-100' : '']"
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
            :class="[draftPrompt ? 'opacity-100' : 'opacity-0']"
          >
            enter ↵
          </span>
        </div>
      </div>

      <div ref="transcriptEndRef" class="h-px w-full shrink-0" aria-hidden="true" />
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
