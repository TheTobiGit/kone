<script setup lang="ts">
// The global assistant: an inbox thread, in a modal.
//
// Everything below the header band is the inbox's reading pane verbatim — the
// same ConversationThread over the same edge-faded scroller, the same composer
// dock laid over it, the same full model picker hosted outside the dock. What
// differs is where it lives and what it is pointed at: a modal card in the
// app's shared scrim + card shell, over one reserved project path that is not
// a project at all, so the assistant follows you across whatever you had open
// instead of belonging to any of it.
//
// The composer opens on arrival and stays open. This surface exists to be
// typed in — there is nothing else on the card to look back to — so the
// resting orb would only charge a click for a decision already made, and
// `always-open` keeps it covered for the modal's whole life.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion } from "motion-v";
import { onClickOutside } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  PencilEdit02Icon,
  Cancel01Icon,
  Clock01Icon,
  Delete02Icon,
  ArrowDown01Icon,
} from "@hugeicons/core-free-icons";
import ConversationThread from "~/components/conversation/ConversationThread.vue";
import AgentComposer from "~/components/agent/AgentComposer.vue";
import ProviderHealthBanner from "~/components/provider/ProviderHealthBanner.vue";
import ModelPickerModal from "~/components/model/ModelPickerModal.vue";
import {
  useGlobalAssistant,
  GLOBAL_ASSISTANT_PROJECT_PATH,
} from "~/composables/useGlobalAssistant";
import { useInboxComposer } from "~/composables/useInboxComposer";
import { useEdgeFade } from "~/composables/useEdgeFade";
import { useModalExit } from "~/composables/useModalExit";
import { useSound } from "~/composables/useSound";
import { formatDayDivider } from "~/utils/threadDates";
import type { ChatAttachment } from "~/types/desktop";

const {
  close,
  registerExit,
  newChat,
  selectChat,
  deleteChat,
  threads,
  isHistoryLoading,
  showHistoryDropdown,
  agent,
  refreshThreads,
} = useGlobalAssistant();

const { cue } = useSound();

const session = computed(
  () =>
    agent.sessions.value.find((s) => s.key === agent.activeKey.value) ??
    agent.sessions.value[0] ??
    null,
);

const composer = useInboxComposer({
  agent,
  session: () => session.value,
  projectPath: GLOBAL_ASSISTANT_PROJECT_PATH,
});

// The idle sweep evicts sessions it believes nobody is looking at, and the
// registry cannot see who is on screen — so the card says so for as long as it
// holds one. The active session can change under it (a history pick, a new
// chat), which is why this follows the key rather than pinning once.
watch(
  () => session.value?.key,
  (nextKey, prevKey) => {
    if (prevKey) agent.unpinFromPane(prevKey);
    if (nextKey) agent.pinToPane(nextKey);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  const key = session.value?.key;
  if (key) agent.unpinFromPane(key);
});

const blocks = computed(() => session.value?.timelineBlocks.value ?? []);
const busy = computed(() => session.value?.busy.value ?? false);
const queued = computed(() => session.value?.queuedTurns.value ?? []);
const starting = computed(() => session.value?.sessionState.value === "starting");

// No visible scrollbar — the transcript smokes its own top/bottom edges over
// whatever runs past the cutoff.
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

watch(blocks, () => void nextTick(measure));

// ── modal surface & transitions ─────────────────────────────────────────────
const { shown, close: playExit } = useModalExit();

const cardSpring = {
  type: "spring",
  stiffness: 300,
  damping: 22,
  mass: 0.9,
} as const;

/** Every dismissal — the button, the scrim, Escape, the hotkey, the tray icon —
 *  runs the same exit. The composable owns the open flag and is toggled from
 *  outside the card too, so it is handed the exit rather than asked to guess:
 *  while this card is mounted, its `close` plays the animation first. */
function requestClose(): void {
  close();
}

onMounted(() => {
  registerExit(playExit);
  shown.value = true;
});
onBeforeUnmount(() => registerExit(null));

const historyWrap = ref<HTMLElement | null>(null);
onClickOutside(historyWrap, () => {
  showHistoryDropdown.value = false;
});

function toggleHistory(): void {
  cue("press");
  showHistoryDropdown.value = !showHistoryDropdown.value;
  if (showHistoryDropdown.value) void refreshThreads();
}

function onNewChat(): void {
  cue("press");
  void newChat();
}

function onSelectChat(threadId: string): void {
  cue("select");
  void selectChat(threadId);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    // The model picker is a modal of its own on top of this one; the first
    // Escape belongs to whichever surface is highest.
    if (composer.pickerOpen.value) {
      composer.closePicker();
      return;
    }
    if (showHistoryDropdown.value) {
      showHistoryDropdown.value = false;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    requestClose();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    onNewChat();
  }
}

let opener: HTMLElement | null = null;

onMounted(() => {
  // SAFETY: activeElement is the element focused just before open; null is allowed by the type.
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  opener?.focus();
});

/** Attachments go up one at a time and a failed one is dropped rather than
 *  sinking the whole message — a picture that would not upload is not a reason
 *  to lose what you typed. */
async function upload(files?: File[]): Promise<ChatAttachment[]> {
  if (!files || files.length === 0) return [];
  const results = await Promise.allSettled(files.map((f) => agent.uploadAttachment(f)));
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

async function onSend(text: string, files?: File[]): Promise<void> {
  const s = session.value;
  if (!s) return;
  // Nothing to settle about who is on this thread: the assistant is kone, on
  // every one of them. The inbox binds a thread to whoever was picked for the
  // project because a project has a team; this one has no project and no
  // roster, so a binding here would only pin a name that is never shown.
  await composer.syncTarget();
  await s.send(text, await upload(files));
  // The list is titled from the conversation, so a send is when a row's name
  // (and its place in the order) can change.
  void refreshThreads();
}

async function onSteer(text: string, files?: File[]): Promise<void> {
  const s = session.value;
  if (!s) return;
  await s.steerTurn(text, await upload(files));
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-end justify-center overflow-hidden p-4 sm:p-6">
    <motion.div
      class="modal-scrim absolute inset-0"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: shown ? 1 : 0 }"
      :transition="{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }"
      @click="requestClose"
    />

    <motion.div
      class="modal-card relative z-20 w-full max-w-xl overflow-hidden"
      :initial="{ opacity: 0, y: 12, scale: 0.96 }"
      :animate="{
        opacity: shown ? 1 : 0,
        y: shown ? 0 : 12,
        scale: shown ? 1 : 0.96,
      }"
      :transition="cardSpring"
      role="dialog"
      aria-modal="true"
      aria-label="Assistant"
    >
      <div class="assistant">
        <!-- Recessed header band, the same one the pickers wear: what you can
             do to the conversation on the left, the way out on the right, and
             nothing in between. The conversation names itself in what it says;
             a title strip over the top of it would only be a second, worse
             copy. Nothing here names who is answering either — the assistant
             is the app's own, not a hire. -->
        <div class="picker-header">
          <div class="assistant__lead">
            <button
              type="button"
              class="assistant__icon"
              title="New chat (⌘N)"
              aria-label="New chat"
              @click="onNewChat"
            >
              <HugeiconsIcon :icon="PencilEdit02Icon" :size="15" :stroke-width="1.8" />
            </button>

            <div ref="historyWrap" class="assistant__history">
              <button
                type="button"
                class="assistant__chip"
                :class="{ 'is-open': showHistoryDropdown }"
                :aria-expanded="showHistoryDropdown"
                aria-label="Chat history"
                @click="toggleHistory"
              >
                <HugeiconsIcon :icon="Clock01Icon" :size="13" :stroke-width="1.8" />
                <span>History</span>
                <HugeiconsIcon
                  class="assistant__chev"
                  :class="{ 'assistant__chev--open': showHistoryDropdown }"
                  :icon="ArrowDown01Icon"
                  :size="12"
                  :stroke-width="2"
                />
              </button>

              <Transition name="drop">
                <div v-if="showHistoryDropdown" class="drop picker-scroll" role="menu">
                  <p v-if="isHistoryLoading" class="drop__note">Loading history…</p>
                  <p v-else-if="threads.length === 0" class="drop__note">
                    No previous chats yet
                  </p>
                  <template v-else>
                    <div
                      v-for="th in threads"
                      :key="th.threadId"
                      class="drop__row"
                      :class="{ 'is-current': session?.threadId.value === th.threadId }"
                      role="menuitem"
                      tabindex="0"
                      @click="onSelectChat(th.threadId)"
                      @keydown.enter="onSelectChat(th.threadId)"
                    >
                      <span class="drop__body">
                        <span class="drop__title">{{ th.title || "Untitled chat" }}</span>
                        <span class="drop__when">{{ formatDayDivider(th.updatedAt) }}</span>
                      </span>
                      <button
                        type="button"
                        class="drop__remove"
                        title="Delete chat"
                        aria-label="Delete chat"
                        @click.stop="deleteChat(th.threadId)"
                      >
                        <HugeiconsIcon :icon="Delete02Icon" :size="13" :stroke-width="1.8" />
                      </button>
                    </div>
                  </template>
                </div>
              </Transition>
            </div>
          </div>

          <div class="assistant__tail">
            <button
              type="button"
              class="assistant__icon"
              title="Close (Esc)"
              aria-label="Close assistant"
              @click="requestClose"
            >
              <HugeiconsIcon :icon="Cancel01Icon" :size="15" :stroke-width="1.8" />
            </button>
          </div>
        </div>

        <!-- The inbox thread, unchanged: transcript under a composer laid over
             it, so the conversation does not resize every time a queued chip
             appears or the card grows a line. -->
        <div class="live">
          <div
            ref="scroller"
            class="live__body"
            :style="maskStyle"
            @scroll.passive="measure"
          >
            <ConversationThread
              house
              :blocks="blocks"
              :now="agent.now.value"
              :thread-id="session?.threadId.value"
              mode="reply"
              :session-error="session?.error.value"
              :load-failed="session?.transcriptLoadFailed.value"
              :loading="starting"
              :busy="busy"
              :queued="queued"
              :picking="composer.pickerOpen.value"
              :has-older="session?.hasOlder.value"
              :loading-older="session?.loadingOlder.value"
              :older-error="session?.olderError.value"
              @retry="onSend"
              @resend="onSend"
              @retry-load="session ? session.openStored(session.threadId.value) : undefined"
              @retry-session="session?.start()"
              @load-older="session?.loadOlder()"
            />
          </div>

          <div class="live__dock">
            <ProviderHealthBanner
              class="live__banner"
              :status="composer.sendBlockedStatus.value"
              :reason="composer.sendBlockedReason.value"
              :checking="composer.recheckingProviders.value"
              @recheck="composer.recheckProviders"
            />
            <AgentComposer
              always-open
              hide-context-tray
              :project-path="GLOBAL_ASSISTANT_PROJECT_PATH"
              :branch-switchable="false"
              :thread-id="session?.threadId.value"
              :busy="busy"
              :queued="queued"
              :agent-switchable="false"
              :models="composer.modelOptions.value"
              :model-switchable="composer.modelSwitchable.value"
              :model-id="composer.modelId.value"
              :reasoning="composer.reasoning.value"
              :mode="composer.mode.value"
              :fast-mode="composer.fastMode.value"
              :context-window="composer.contextWindow.value"
              :picking="composer.pickerOpen.value"
              :blocked-reason="composer.sendBlockedReason.value"
              @send="onSend"
              @steer="onSteer"
              @remove-queued="session?.cancelQueuedTurn($event)"
              @interrupt="session?.interrupt()"
              @update:model-id="composer.onModelId"
              @update:reasoning="composer.onReasoning"
              @update:mode="composer.onMode"
              @update:fast-mode="composer.onFastMode"
              @update:context-window="composer.onContextWindow"
              @open-models="composer.openPicker"
            />
          </div>
        </div>
      </div>
    </motion.div>

    <!-- The full providers → models → effort picker. It is the surface's to
         host, not the composer's: it lands outside the composer's dock, which
         is exactly why the composer has to be told it is up. -->
    <ModelPickerModal
      v-if="composer.pickerOpen.value"
      :providers="composer.pickerProviders.value"
      :active-provider="composer.provider.value"
      :model-id="composer.modelId.value"
      :reasoning="composer.reasoning.value"
      :fast-mode="composer.fastMode.value"
      :context-window="composer.contextWindow.value"
      @select="composer.onPick"
      @apply="composer.onApply"
      @cancel="composer.closePicker"
    />
  </div>
</template>

<style scoped>
.modal-scrim {
  background: color-mix(in srgb, var(--ground) 50%, transparent);
}
.modal-card {
  background: var(--panel);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  display: flex;
  flex-direction: column;
}

.assistant {
  --band-bg: var(--band);
  --band-arc: 14px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* Tall enough that the transcript is a document rather than a peephole, and
     short enough that the card still reads as sitting on the app. */
  height: min(720px, 82vh);
}

/* ── header band, with the shell's arc scoops ────────────────────────────── */
.picker-header {
  position: relative;
  z-index: 30;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.5rem 0.75rem;
  background-color: var(--band-bg);
}
.picker-header::before,
.picker-header::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}
.picker-header::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.picker-header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.assistant__lead,
.assistant__tail {
  display: flex;
  align-items: center;
  gap: 4px;
}

.assistant__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    color 0.14s ease;
}
.assistant__icon:hover {
  background-color: var(--hover);
  color: var(--ink);
}

.assistant__history {
  position: relative;
}

.assistant__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 0.5rem;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    color 0.14s ease;
}
.assistant__chip:hover,
.assistant__chip.is-open {
  background-color: var(--hover);
  color: var(--ink);
}
.assistant__chev {
  transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.assistant__chev--open {
  transform: rotate(180deg);
}

/* ── history dropdown ───────────────────────────────────────────────────── */
.drop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 40;
  width: 260px;
  max-height: 300px;
  overflow-y: auto;
  padding: 4px;
  border-radius: 14px;
  background: var(--panel);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 14px 34px -16px color-mix(in srgb, var(--ink) 45%, transparent);
}

.drop__note {
  margin: 0;
  padding: 0.75rem 0.65rem;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
}

.drop__row {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 10px;
  padding: 0.4rem 0.55rem;
  cursor: pointer;
  transition: background-color 0.14s ease;
}
.drop__row:hover,
.drop__row:focus-visible,
.drop__row.is-current {
  background-color: var(--hover);
  outline: none;
}

.drop__body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.drop__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.drop__when {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--muted);
}
.drop__row.is-current .drop__title {
  color: var(--accent);
}

.drop__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.14s ease,
    background-color 0.14s ease,
    color 0.14s ease;
}
.drop__row:hover .drop__remove,
.drop__row:focus-within .drop__remove {
  opacity: 1;
}
.drop__remove:hover {
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  color: var(--ink);
}

.drop-enter-active,
.drop-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
}
.drop-enter-from,
.drop-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}

/* ── the thread ─────────────────────────────────────────────────────────── */
.live {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* The scroll host. The transcript renders as a plain column and finds its
   scroller by walking up from itself, so this element has to be the one that
   overflows. The floor clears the composer's resting height — the last thing
   said must be readable without moving anything. */
.live__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px 18px 132px;
  scrollbar-width: none;
}
.live__body::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.live__dock {
  position: absolute;
  inset-inline: 0;
  bottom: 18px;
  display: flex;
  /* A column so the health banner stacks ABOVE the card rather than beside it;
     the card still centres itself, which is all `justify-content` was for. */
  flex-direction: column;
  align-items: center;
  /* The dock is only a rail for centring; the card inside it takes its own
     clicks, and everything either side of it belongs to the transcript. */
  pointer-events: none;
  z-index: 20;
}
.live__dock > * {
  pointer-events: auto;
}
/* Matches the composer card's own width so the two read as one dock. */
.live__banner {
  width: min(100% - 32px, 680px);
  margin-bottom: 8px;
}

.picker-scroll {
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 16%, transparent) transparent;
}
.picker-scroll::-webkit-scrollbar {
  width: 6px;
}
.picker-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.picker-scroll::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
  border: 1px solid transparent;
  background-clip: content-box;
}
.picker-scroll:hover::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .assistant__chev,
  .drop-enter-active,
  .drop-leave-active {
    transition: none;
  }
}
</style>
