<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { useDebounceFn } from "@vueuse/core";
import RotatingText from "~/components/ui/rotating-text/RotatingText.vue";
import ShinyText from "~/components/ui/shiny-text/ShinyText.vue";
import ResponseContent from "~/components/ResponseContent.vue";
import ThinkingBlock from "~/components/ThinkingBlock.vue";
import WorkTimeline from "~/components/WorkTimeline.vue";
import PermissionRequestInline from "~/components/PermissionRequestInline.vue";
import ArtifactPreview from "~/components/ArtifactPreview.vue";
import ArtifactPreviewLane from "~/components/ArtifactPreviewLane.vue";
import ThreadHistoryRail from "~/components/ThreadHistoryRail.vue";
import ProviderModelPicker from "~/components/ProviderModelPicker.vue";
import { useDroidBridge } from "~/composables/useDroidBridge";
import { useConversationTurns } from "~/composables/useConversationTurns";
import { useThreadStore } from "~/composables/useThreadStore";
import { useMotionPreference } from "~/composables/useMotionPreference";
import type { ArtifactReference, ConversationTurn } from "~/types/conversation";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER,
} from "~/lib/model-catalog";
import {
  getDefaultEffort,
} from "~/lib/model-capabilities";

const {
  turns,
  hasThread,
  activeTurn,
  createTurn,
  replaceTurns,
  updateThinkingExpanded,
  markToolAwaitingPermission,
  applyMessage,
  failActiveTurn,
} = useConversationTurns();
const {
  threads,
  activeThread,
  activeThreadId,
  createThread,
  updateThread,
  renameThread,
  deleteThread,
  activateThread,
} = useThreadStore();
const { scrollBehavior } = useMotionPreference();
const draftPrompt = ref("");
const isLandingFocused = ref(false);
const selectedProvider = ref(DEFAULT_PROVIDER);
const selectedModel = ref(DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER]);
const selectedEffort = ref(getDefaultEffort(DEFAULT_PROVIDER, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER]));
const selectedThinking = ref(true);
const isSubmitting = ref(false);
const landingTextareaRef = ref<HTMLTextAreaElement | null>(null);
const followUpTextareaRef = ref<HTMLTextAreaElement | null>(null);
const followUpPickerOpen = ref(false);
const transcriptEndRef = ref<HTMLDivElement | null>(null);
const notebookPageRef = ref<HTMLElement | null>(null);
const followsLiveOutput = ref(true);
const historyOpen = ref(false);
const selectedArtifact = ref<ArtifactReference | null>(null);
const copiedTurnId = ref<string | null>(null);
const hasHydratedThread = ref(false);
let skipHydrationForThreadId: string | null = null;
let initialHydration = true;

const {
  isConnected,
  connectionStatus,
  bridgeError,
  permissionRequests,
  submitPrompt: submitPromptToBridge,
  cancelTurn,
  respondToPermission,
  onMessage,
  onDisconnect,
  onModelsReady,
  connect,
} = useDroidBridge();

const BASE_FONT_SIZE = 17;
const FOLLOW_UP_FONT_SIZE = 15;
const MIN_FONT_SIZE = 14;
const LINE_HEIGHT_RATIO = 1.35;
const landingFontSize = ref(BASE_FONT_SIZE);
const followUpFontSize = ref(FOLLOW_UP_FONT_SIZE);

const isLanding = computed(() => !hasThread.value);
const canSubmit = computed(
  () =>
    isConnected.value &&
    Boolean(selectedModel.value) &&
    !isSubmitting.value,
);

const connectionStatusMessage = computed(() => {
  switch (connectionStatus.value) {
    case "reconnecting":
      return "Reconnecting to Droid…";
    case "failed":
      return "Lost connection to Droid.";
    default:
      return "Connecting to Droid…";
  }
});

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

const typographyForTurn = (turnIndex: number) =>
  turnIndex === 0 ? landingTypographyStyle.value : threadPromptStyle.value;

const colorMode = useColorMode();

const awaitingShinyColors = computed(() =>
  colorMode.value === "dark"
    ? { color: "#a1a1aa", shineColor: "#f4f4f5" }
    : { color: "#71717a", shineColor: "#ffffff" },
);

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

const isTurnDimmed = (turn: ConversationTurn) =>
  turn.status === "completed" || turn.status === "error";

const isTurnAwaitingResponse = (turn: ConversationTurn) =>
  turn.status === "pending" ||
  (turn.status === "streaming" &&
    !turn.thinkingText &&
    !turn.responseText &&
    turn.tools.length === 0);

const scrollTranscriptToEnd = (force = false) => {
  if (!force && !followsLiveOutput.value) return;
  nextTick(() => {
    transcriptEndRef.value?.scrollIntoView({
      behavior: force ? scrollBehavior.value : "auto",
      block: "end",
    });
  });
};

const handleTranscriptScroll = () => {
  const page = notebookPageRef.value;
  if (!page) return;
  const distanceFromEnd = page.scrollHeight - page.scrollTop - page.clientHeight;
  followsLiveOutput.value = distanceFromEnd < 96;
};

const resumeLiveOutput = () => {
  followsLiveOutput.value = true;
  scrollTranscriptToEnd(true);
};

const submitPrompt = () => {
  const trimmedPrompt = draftPrompt.value.trim();
  if (!trimmedPrompt || !canSubmit.value) return;

  if (!activeThreadId.value) {
    const thread = createThread({
      provider: selectedProvider.value,
      modelId: selectedModel.value,
      reasoningEffort: selectedEffort.value,
      thinking: selectedThinking.value,
      prompt: trimmedPrompt,
    });
    skipHydrationForThreadId = thread.id;
    hasHydratedThread.value = true;
  }

  const turn = createTurn({
    prompt: trimmedPrompt,
    modelId: selectedModel.value,
    reasoningEffort: selectedEffort.value,
  });
  draftPrompt.value = "";
  isSubmitting.value = true;
  followsLiveOutput.value = true;

  nextTick(() => {
    if (hasThread.value) {
      adjustTextareaHeight(followUpTextareaRef.value, "follow-up");
      followUpTextareaRef.value?.focus();
    } else {
      adjustTextareaHeight(landingTextareaRef.value, "landing");
    }
    scrollTranscriptToEnd(true);
  });

  const sent = submitPromptToBridge({
    turnId: turn.id,
    prompt: trimmedPrompt,
    modelId: selectedModel.value,
    reasoningEffort: selectedEffort.value,
    thinking: selectedThinking.value,
  });

  if (!sent) {
    turn.status = "error";
    turn.errorMessage = bridgeError.value ?? "Could not reach the Droid bridge.";
    isSubmitting.value = false;
  }
};

const stopActiveTurn = () => {
  if (!activeTurn.value) return;
  cancelTurn(activeTurn.value.id);
};

const handlePermissionDecision = (approved: boolean) => {
  const request = permissionRequests.value[0];
  if (!request) return;
  markToolAwaitingPermission(request.turnId, request.toolCallId, false);
  respondToPermission(approved, request.requestId);
};

const copyTurnResponse = async (turn: ConversationTurn) => {
  if (!turn.responseText || !navigator.clipboard) return;
  await navigator.clipboard.writeText(turn.responseText);
  copiedTurnId.value = turn.id;
  window.setTimeout(() => {
    if (copiedTurnId.value === turn.id) copiedTurnId.value = null;
  }, 1400);
};

const prepareTurnRetry = (turn: ConversationTurn) => {
  if (isSubmitting.value) return;
  draftPrompt.value = turn.prompt;
  nextTick(() => {
    adjustTextareaHeight(followUpTextareaRef.value, "follow-up");
    followUpTextareaRef.value?.focus();
  });
};

const hydrateThread = () => {
  const thread = activeThread.value;
  hasHydratedThread.value = false;
  if (!thread) {
    replaceTurns([]);
    draftPrompt.value = "";
    isSubmitting.value = false;
    nextTick(() => {
      hasHydratedThread.value = true;
    });
    initialHydration = false;
    return;
  }

  const restoredTurns = structuredClone(thread.turns).map((turn) =>
    initialHydration &&
    (turn.status === "queued" ||
      turn.status === "pending" ||
      turn.status === "streaming")
      ? {
          ...turn,
          status: "error" as const,
          errorMessage:
            "This turn was interrupted when the previous session ended.",
          completedAt: new Date().toISOString(),
        }
      : turn,
  );
  replaceTurns(restoredTurns);
  draftPrompt.value = thread.draft;
  selectedProvider.value = thread.provider;
  selectedModel.value = thread.modelId;
  selectedEffort.value = thread.reasoningEffort;
  selectedThinking.value = thread.thinking;
  isSubmitting.value = Boolean(activeTurn.value);
  initialHydration = false;
  nextTick(() => {
    hasHydratedThread.value = true;
    scrollTranscriptToEnd(true);
  });
};

const createBlankThread = () => {
  const thread = createThread({
    provider: selectedProvider.value,
    modelId: selectedModel.value,
    reasoningEffort: selectedEffort.value,
    thinking: selectedThinking.value,
  });
  skipHydrationForThreadId = thread.id;
  replaceTurns([]);
  draftPrompt.value = "";
  hasHydratedThread.value = true;
  historyOpen.value = false;
};

const selectThread = (threadId: string) => {
  activateThread(threadId);
  historyOpen.value = false;
};

const removeThread = (threadId: string) => {
  const thread = threads.value.find((entry) => entry.id === threadId);
  if (!thread) return;
  if (!window.confirm(`Delete “${thread.title}”?`)) return;
  deleteThread(threadId);
};

const handleLandingKeyDown = (event: KeyboardEvent) => {
  if (!isLanding.value) return;

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (draftPrompt.value.trim() && canSubmit.value) {
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
    if (draftPrompt.value.trim() && canSubmit.value) {
      followUpTextareaRef.value?.blur();
      submitPrompt();
    }
  }
};

let unsubscribeMessages: (() => void) | undefined;
let unsubscribeModels: (() => void) | undefined;
let unsubscribeDisconnect: (() => void) | undefined;
const pendingStreamText = new Map<
  string,
  { response: string; thinking: string }
>();
let streamFrame: number | null = null;

const flushStreamText = () => {
  if (streamFrame !== null) {
    cancelAnimationFrame(streamFrame);
    streamFrame = null;
  }
  for (const [turnId, pending] of pendingStreamText) {
    if (pending.thinking) {
      applyMessage({
        type: "turn.thinking",
        turnId,
        text: pending.thinking,
      } as Parameters<typeof applyMessage>[0]);
    }
    if (pending.response) {
      applyMessage({
        type: "turn.delta",
        turnId,
        text: pending.response,
      } as Parameters<typeof applyMessage>[0]);
    }
  }
  pendingStreamText.clear();
  scrollTranscriptToEnd();
};

const queueStreamText = (
  message: Extract<
    Parameters<typeof applyMessage>[0],
    { type: "turn.delta" | "turn.thinking" }
  >,
) => {
  const pending = pendingStreamText.get(message.turnId) ?? {
    response: "",
    thinking: "",
  };
  if (message.type === "turn.delta") pending.response += message.text;
  else pending.thinking += message.text;
  pendingStreamText.set(message.turnId, pending);
  if (streamFrame === null) {
    streamFrame = requestAnimationFrame(flushStreamText);
  }
};

onMounted(() => {
  window.addEventListener("keydown", handleGlobalKeyDown);
  hydrateThread();
  nextTick(() => {
    adjustTextareaHeight(landingTextareaRef.value, "landing");
  });

  unsubscribeDisconnect = onDisconnect(() => {
    if (activeTurn.value) {
      failActiveTurn("Connection to Droid was lost during this turn.");
      isSubmitting.value = false;
    }
  });

  unsubscribeModels = onModelsReady(({ defaultModelId, defaultReasoningEffort }) => {
    if (defaultModelId && !selectedModel.value) {
      selectedModel.value = defaultModelId;
      selectedEffort.value = defaultReasoningEffort;
    }
  });

  unsubscribeMessages = onMessage((message) => {
    if (message.type === "turn.delta" || message.type === "turn.thinking") {
      queueStreamText(message);
      return;
    }
    flushStreamText();
    const turn = applyMessage(message);
    if (!turn) return;
    if (
      turn.status === "completed" ||
      turn.status === "error" ||
      turn.status === "cancelled"
    ) {
      isSubmitting.value = false;
    }
    scrollTranscriptToEnd();
  });
});

watch(hasThread, (inThread) => {
  if (!inThread) return;
  nextTick(() => {
    adjustTextareaHeight(followUpTextareaRef.value, "follow-up");
    followUpTextareaRef.value?.focus();
  });
});

watch(activeThreadId, () => {
  if (!import.meta.client) return;
  if (
    activeThreadId.value &&
    activeThreadId.value === skipHydrationForThreadId
  ) {
    skipHydrationForThreadId = null;
    return;
  }
  hydrateThread();
});

watch(
  permissionRequests,
  (current, previous) => {
    for (const request of current) {
      markToolAwaitingPermission(request.turnId, request.toolCallId, true);
    }
    for (const request of previous ?? []) {
      if (
        !current.some((entry) => entry.requestId === request.requestId)
      ) {
        markToolAwaitingPermission(request.turnId, request.toolCallId, false);
      }
    }
  },
  { deep: true },
);

const persistActiveThread = useDebounceFn(() => {
  if (!hasHydratedThread.value || !activeThreadId.value) return;
  updateThread(activeThreadId.value, {
    turns: structuredClone(turns.value),
    draft: draftPrompt.value,
    provider: selectedProvider.value,
    modelId: selectedModel.value,
    reasoningEffort: selectedEffort.value,
    thinking: selectedThinking.value,
  });
}, 180);

watch(
  [
    turns,
    draftPrompt,
    selectedProvider,
    selectedModel,
    selectedEffort,
    selectedThinking,
  ],
  persistActiveThread,
  { deep: true },
);

onUnmounted(() => {
  window.removeEventListener("keydown", handleGlobalKeyDown);
  unsubscribeMessages?.();
  unsubscribeModels?.();
  unsubscribeDisconnect?.();
  if (streamFrame !== null) cancelAnimationFrame(streamFrame);
});
</script>

<template>
  <div
    ref="notebookPageRef"
    class="notebook-page notebook-fade kone-scroll h-dvh min-h-dvh w-full overflow-x-hidden overflow-y-auto bg-transparent px-5 pt-28 pb-10 transition-colors duration-700 sm:px-8 md:px-14 md:pt-36 md:pb-12"
    :class="[hasThread ? 'pt-12 md:pt-14' : '']"
    @scroll.passive="handleTranscriptScroll"
  >
    <ThreadHistoryRail
      :open="historyOpen"
      :threads="threads"
      :active-thread-id="activeThreadId"
      @toggle="historyOpen = !historyOpen"
      @close="historyOpen = false"
      @create="createBlankThread"
      @activate="selectThread"
      @remove="removeThread"
      @rename="renameThread"
    />

    <div class="mx-auto flex w-full max-w-2xl flex-col items-start">
      <p
        v-if="bridgeError"
        class="mb-4 w-full text-sm font-light text-accent-warning"
        role="status"
      >
        {{ bridgeError }}
      </p>

      <p
        v-else-if="connectionStatus !== 'ready'"
        class="mb-4 flex w-full items-center gap-2 text-xs font-light text-ink-muted"
        role="status"
      >
        <span>{{ connectionStatusMessage }}</span>
        <button
          v-if="connectionStatus === 'failed'"
          type="button"
          class="text-[10px] font-mono uppercase tracking-[0.12em] text-ink-muted underline decoration-zinc-300 underline-offset-2 transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-tool/40 dark:decoration-zinc-700"
          @click="connect"
        >
          Reconnect
        </button>
      </p>

      <PermissionRequestInline
        v-if="permissionRequests[0]"
        class="mb-6"
        :request="permissionRequests[0]"
        :position="1"
        :total="permissionRequests.length"
        @allow="handlePermissionDecision(true)"
        @deny="handlePermissionDecision(false)"
      />

      <template v-for="(turn, turnIndex) in turns" :key="turn.id">
        <div
          class="w-full shrink-0"
          :class="[turnIndex > 0 ? 'mt-12' : '']"
        >
          <div
            class="transition-opacity duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]"
            :class="[isTurnDimmed(turn) ? 'opacity-40' : 'opacity-100']"
            :style="typographyForTurn(turnIndex)"
          >
            <ShinyText
              v-if="isTurnAwaitingResponse(turn)"
              :text="turn.prompt"
              class="whitespace-pre-wrap font-light tracking-tight"
              :speed="2.5"
              v-bind="awaitingShinyColors"
            />
            <p
              v-else
              class="m-0 whitespace-pre-wrap text-left font-light text-ink-primary tracking-tight"
            >
              {{ turn.prompt }}
            </p>
          </div>

          <ThinkingBlock
            v-if="turn.thinkingText"
            :text="turn.thinkingText"
            :active="turn.status === 'pending' || turn.status === 'streaming'"
            :expanded="turn.thinkingExpanded"
            @update:expanded="updateThinkingExpanded(turn.id, $event)"
          />

          <WorkTimeline :tools="turn.tools" />

          <div
            v-if="turn.responseText"
            class="response-scroll mt-4 w-full"
            aria-live="polite"
          >
            <ResponseContent
              :text="turn.responseText"
              :typography-style="typographyForTurn(turnIndex)"
              :streaming="turn.status === 'streaming' || turn.status === 'pending'"
            />
          </div>

          <p
            v-else-if="turn.status === 'completed'"
            class="mt-4 text-sm font-light text-ink-muted"
          >
            The turn completed without a text response.
          </p>

          <div v-if="turn.artifacts.length" class="mt-5 w-full">
            <ArtifactPreview
              v-for="artifact in turn.artifacts"
              :key="artifact.id"
              :artifact="artifact"
              @inspect="selectedArtifact = $event"
            />
          </div>

          <p
            v-if="
              (turn.status === 'error' || turn.status === 'cancelled') &&
              turn.errorMessage
            "
            class="mt-4 border-l border-accent-error/30 pl-3 text-sm font-light text-accent-error"
            role="alert"
          >
            {{ turn.errorMessage }}
          </p>

          <div
            v-if="
              turn.status === 'completed' ||
              turn.status === 'error' ||
              turn.status === 'cancelled'
            "
            class="mt-3 flex items-center gap-3 text-ink-muted opacity-0 transition-opacity focus-within:opacity-100 hover:opacity-100"
          >
            <button
              v-if="turn.responseText"
              type="button"
              class="text-[10px] font-mono uppercase tracking-[0.12em] transition-colors hover:text-ink-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-tool/40"
              @click="copyTurnResponse(turn)"
            >
              {{ copiedTurnId === turn.id ? "Copied" : "Copy" }}
            </button>
            <button
              type="button"
              class="text-[10px] font-mono uppercase tracking-[0.12em] transition-colors hover:text-ink-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-tool/40"
              @click="prepareTurnRetry(turn)"
            >
              Retry
            </button>
          </div>
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
            class="prompt-input block w-full m-0 p-0 bg-transparent text-left font-light text-ink-primary caret-zinc-500 resize-none border-none outline-none tracking-tight transition-[font-size,height] duration-300 ease-out dark:caret-zinc-400"
            :style="{ overflow: 'hidden', ...landingTypographyStyle }"
          />
          <div
            v-if="!draftPrompt && !isLandingFocused"
            class="pointer-events-none absolute inset-x-0 top-0 z-0 text-left"
            aria-hidden="true"
          >
            <span
              class="inline-flex max-w-full items-baseline justify-start text-left font-light tracking-tight text-ink-muted"
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
            v-model:thinking="selectedThinking"
          />
          <span
            class="pointer-events-none absolute right-0 top-0 text-[10px] font-mono uppercase tracking-[0.28em] text-ink-muted transition-all duration-700 ease-out"
            :class="[draftPrompt || !isConnected ? 'opacity-100' : 'opacity-0']"
          >
            {{ isConnected ? "enter ↵" : "connecting" }}
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
            class="prompt-input block w-full m-0 p-0 bg-transparent text-left font-light text-ink-primary caret-zinc-500 resize-none border-none outline-none tracking-tight transition-[font-size,height] duration-300 ease-out dark:caret-zinc-400"
            :style="{ overflow: 'hidden', ...followUpTypographyStyle }"
          />
        </div>

        <div
          class="group relative mt-5 h-5 w-full overflow-hidden transition-opacity duration-300"
          :class="followUpPickerOpen ? 'opacity-100' : 'opacity-25 hover:opacity-100'"
        >
          <ProviderModelPicker
            v-model:open="followUpPickerOpen"
            v-model:provider="selectedProvider"
            v-model:model="selectedModel"
            v-model:effort="selectedEffort"
            v-model:thinking="selectedThinking"
          />
          <button
            v-if="activeTurn"
            type="button"
            class="absolute right-0 top-0 inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-[0.2em] text-ink-muted transition-colors hover:text-accent-error focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-error/40"
            @click="stopActiveTurn"
          >
            <UIcon name="i-lucide-square" class="size-2.5" aria-hidden="true" />
            stop
          </button>
          <span
            v-else
            class="pointer-events-none absolute right-0 top-0 text-[10px] font-mono uppercase tracking-[0.28em] text-ink-muted transition-all duration-300 ease-out"
            :class="[draftPrompt || !isConnected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100']"
          >
            {{ isConnected ? "enter ↵" : "connecting" }}
          </span>
        </div>
      </div>

      <div ref="transcriptEndRef" class="h-px w-full shrink-0" aria-hidden="true" />
    </div>

    <button
      v-if="hasThread && !followsLiveOutput"
      type="button"
      class="fixed bottom-6 left-1/2 z-20 -translate-x-1/2 rounded-full border border-zinc-200/80 bg-surface-raised px-3 py-1.5 text-xs font-light text-ink-secondary shadow-sm backdrop-blur-md transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-tool/40 dark:border-zinc-800"
      @click="resumeLiveOutput"
    >
      Latest response
    </button>

    <ArtifactPreviewLane
      :artifact="selectedArtifact"
      @close="selectedArtifact = null"
    />
  </div>
</template>

<style scoped>
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
