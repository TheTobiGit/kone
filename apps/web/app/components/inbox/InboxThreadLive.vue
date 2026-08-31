<script setup lang="ts">
// A thread in the inbox with a voice: the stored transcript, plus the composer
// you answer it in.
//
// Reading a thread costs one query, but replying to one needs a live session
// against the project the thread belongs to — and the whole point of the inbox
// is that you never went to that project. Nothing here sends you there. The
// session registry is keyed by project path, so asking for this thread's
// project hands back its registry without the app changing which project it is
// showing; the studio, if it has that project open, keeps its own panes and
// its own columns exactly as they were.
//
// No process starts on arrival. Adopting a stored thread stages its resume and
// stops — the CLI comes up on the first thing you actually say, so opening a
// thread to read it stays as cheap as it was before there was a composer.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ConversationThread from "~/components/conversation/ConversationThread.vue";
import AgentComposer from "~/components/agent/AgentComposer.vue";
import ProviderHealthBanner from "~/components/provider/ProviderHealthBanner.vue";
import InboxThreadHeader from "~/components/inbox/InboxThreadHeader.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import type { ChatAttachment } from "~/types/desktop";
import type { SessionSummary } from "~/types/session";

const props = defineProps<{
  /** The row this pane is showing. Carries the project the thread lives in,
   *  which is what lets a session exist at all. */
  row: SessionSummary;
  /** The row's project root. Passed separately because it is optional on the
   *  row and required here — the caller does the narrowing. */
  projectPath: string;
  /** The session this thread is already running in, when the caller knows it.
   *  Adopting by id would find the same one, but only if the lookup wins its
   *  race with everything else the registry is doing; a key is the session. */
  sessionKey?: string;
}>();

// Resolved once, at setup: the registry is picked from this value eagerly, so
// this component is keyed on the project and thread by its host rather than
// trying to follow either of them reactively.
// `rehydrate: false`: this pane is opening one named thread. The boot session's
// habit of reloading the project's latest conversation belongs to a board that
// is resuming a project, and here it would only pull an unrelated thread into
// the registry behind the one being read.
const agent = useAgent({
  provider: props.row.provider,
  cwd: props.projectPath,
  rehydrate: false,
});

// Adopting the thread is synchronous in the part that matters — the key comes
// back immediately, and the transcript settles behind it.
const handleKey = props.sessionKey ?? agent.openThreadHandle(props.row.threadId).key;
const session = computed(() => agent.sessions.value.find((s) => s.key === handleKey) ?? null);

// Who may work here, what they may run, and where a pick has to land.
const composer = useInboxComposer({
  agent,
  session: () => session.value,
  projectPath: props.projectPath,
});

// The idle sweep evicts sessions it believes nobody is looking at. A pane
// holding one is exactly the case it must not evict, and saying so is the
// pane's job — the registry cannot see who is on screen.
onMounted(() => agent.pinToPane(handleKey));
onBeforeUnmount(() => agent.unpinFromPane(handleKey));

const blocks = computed(() => session.value?.timelineBlocks.value ?? []);
const busy = computed(() => session.value?.busy.value ?? false);
const queued = computed(() => session.value?.queuedTurns.value ?? []);
const starting = computed(() => session.value?.sessionState.value === "starting");
const threadTitle = computed(() => session.value?.title.value || props.row.title);

// No visible scrollbar — the thread content smokes its top/bottom edges over whatever
// content runs past the cutoff, easing in over the first ~28px of scroll.
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

watch(blocks, () => void nextTick(measure));

async function onSend(text: string, files?: File[]): Promise<void> {
  const s = session.value;
  if (!s) return;
  // Settle who is on the thread before the turn goes out: the binding is
  // write-once, so the first send is the only moment it can be decided.
  await composer.syncTarget();
  const threadId = s.threadId.value;
  if (threadId) composer.settleThreadAgent(threadId, composer.agentId.value);
  await s.send(text, await upload(files));
}

async function onSteer(text: string, files?: File[]): Promise<void> {
  const s = session.value;
  if (!s) return;
  await s.steerTurn(text, await upload(files));
}

/** Attachments go up one at a time and a failed one is dropped rather than
 *  sinking the whole message — a picture that would not upload is not a reason
 *  to lose what you typed. */
async function upload(files?: File[]): Promise<ChatAttachment[]> {
  if (!files || files.length === 0) return [];
  const results = await Promise.allSettled(files.map((f) => agent.uploadAttachment(f)));
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}
</script>

<template>
  <div class="live">
    <InboxThreadHeader
      :title="threadTitle"
      :seed="session?.threadId.value ?? row.threadId"
      :provider="session?.provider.value || agent.provider.value || row.provider"
      :brand="row.brand"
      :token-usage="session?.tokenUsage.value ?? undefined"
    />

    <div
      ref="scroller"
      class="live__body"
      :style="maskStyle"
      @scroll.passive="measure"
    >
      <ConversationThread
        :blocks="blocks"
        :now="agent.now.value"
        :thread-id="row.threadId"
        :agent-seed="session?.threadId.value ?? row.threadId"
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
        :empty-art="false"
        @retry="onSend"
        @resend="onSend"
        @retry-load="session?.openStored(row.threadId)"
        @retry-session="session?.start()"
        @load-older="session?.loadOlder()"
      />
    </div>

    <!-- Laid over the transcript rather than under it, the way it is on the
         board: the composer keeps its own footprint and the conversation
         scrolls behind it, so the thread does not resize every time the card
         opens or a queued chip appears. -->
    <div class="live__dock">
      <ProviderHealthBanner
        class="live__banner"
        :status="composer.sendBlockedStatus.value"
        :reason="composer.sendBlockedReason.value"
        :checking="composer.recheckingProviders.value"
        @recheck="composer.recheckProviders"
      />
      <AgentComposer
        :project-path="projectPath"
        :project-name="row.projectName"
        :branch="composer.branch.value ?? undefined"
        :branch-switchable="false"
        :thread-name="threadTitle"
        :thread-id="row.threadId"
        :busy="busy"
        :queued="queued"
        :agents="composer.agents.value"
        :agent-id="composer.agentId.value"
        :agent-switchable="false"
        :models="composer.modelOptions.value"
        :model-switchable="composer.modelSwitchable.value"
        :model-id="composer.modelId.value"
        :reasoning="composer.reasoning.value"
        :mode="composer.mode.value"
        :fast-mode="composer.fastMode.value"
        :context-window="composer.contextWindow.value"
        :blocked-reason="composer.sendBlockedReason.value"
        @send="onSend"
        @steer="onSteer"
        @remove-queued="session?.cancelQueuedTurn($event)"
        @interrupt="session?.interrupt()"
        @update:agent-id="composer.onAgentPick"
        @update:model-id="composer.onModelId"
        @update:reasoning="composer.onReasoning"
        @update:mode="composer.onMode"
        @update:fast-mode="composer.onFastMode"
        @update:context-window="composer.onContextWindow"
        @open-models="composer.openPicker"
      />
    </div>

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
.live {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
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
}
.live__dock > * {
  pointer-events: auto;
}
/* Matches the composer card's own width so the two read as one dock. */
.live__banner {
  width: min(100% - 32px, 680px);
  margin-bottom: 8px;
}
</style>
