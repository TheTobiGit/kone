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
import ThreadSubagentDock from "~/components/thread/ThreadSubagentDock.vue";
import AgentComposer from "~/components/agent/AgentComposer.vue";
import ProviderHealthBanner from "~/components/provider/ProviderHealthBanner.vue";
import InboxThreadHeader from "~/components/inbox/InboxThreadHeader.vue";
import ThreadDockStack from "~/components/thread/ThreadDockStack.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import { useAgentProviders } from "~/composables/useAgentProviders";
import { useDockSnapshot } from "~/composables/useDockSnapshot";
import { compactPropsForSession } from "~/utils/compactAvailability";
import type { ApprovalDecision, ChatAttachment, UserInputAnswers } from "~/types/desktop";
import type { SessionSummary } from "~/types/session";
import type { QueuedTurnEntry } from "~/composables/useAgent";

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

const emit = defineEmits<{
  /** Reveal a spawned child thread's own conversation — the shell's open-thread
   *  action. The pane shows one thread, so reaching another one is the portal's
   *  call, not this pane's. */
  "open-thread": [threadId: string];
}>();

const { cue } = useSound();

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
// `handleKey` is computed so a handed session key that arrives after mount
// (the inbox composer's handover) still wins over the fallback lookup — a plain
// const would capture the initial undefined and leave the pane bound to a
// duplicate empty session with no transcript, which is what left the thread
// blank until the next reload.
const handleKey = computed(
  () => props.sessionKey ?? agent.openThreadHandle(props.row.threadId).key,
);
const session = computed(
  () => agent.sessions.value.find((s) => s.key === handleKey.value) ?? null,
);

// Who may work here, what they may run, and where a pick has to land.
const composer = useInboxComposer({
  agent,
  session: () => session.value,
  projectPath: props.projectPath,
});

// Whether the composer is expanded into its input. When open, the docks leave
// the bottom-right corner and show directly above the composer card.
const composerOpen = ref(false);

// The thread's live asks — the same two gates the studio answers in place, so
// the inbox answers them in place too rather than leaving a parked turn with
// nowhere to go.
const pendingUserInput = computed(() => session.value?.pendingUserInput.value ?? null);
const pendingApproval = computed(() => session.value?.pendingApproval.value ?? null);

// Answer the agent's live question — hands the picked answers back so the
// parked tool call resolves and the turn continues.
function onAnswerUserInput(requestId: string, answers: UserInputAnswers): void {
  void session.value?.respondUserInput(requestId, answers);
}
// Dismiss the question — an empty answer, which the adapter treats as declined.
function onCancelUserInput(requestId: string): void {
  void session.value?.respondUserInput(requestId, {});
}
// Decide a parked tool approval — resolves the parked request and lets the
// turn continue.
function onRespondApproval(requestId: string, decision: ApprovalDecision): void {
  void session.value?.respondApproval(requestId, decision);
}
// Stop a live provider-native nested run, leaving the parent turn running.
function onStopSubagent(toolUseId: string): void {
  void agent.stopSubagent(toolUseId);
}

// The idle sweep evicts sessions it believes nobody is looking at. A pane
// holding one is exactly the case it must not evict, and saying so is the
// pane's job — the registry cannot see who is on screen.
onMounted(() => agent.pinToPane(handleKey.value));
onBeforeUnmount(() => agent.unpinFromPane(handleKey.value));
watch(handleKey, (next, prev) => {
  if (prev) agent.unpinFromPane(prev);
  if (next) agent.pinToPane(next);
});

const blocks = computed(() => session.value?.timelineBlocks.value ?? []);
const busy = computed(() => session.value?.busy.value ?? false);
const queued = computed(() => session.value?.queuedTurns.value ?? []);
const starting = computed(() => session.value?.sessionState.value === "starting");
const threadTitle = computed(() => session.value?.title.value || props.row.title);

// Derives and snapshot for active plan, touched files, and subagent delegates.
const {
  subagentsRaw,
  activePlan,
  activeChanges,
  activeDelegates,
} = useDockSnapshot(
  blocks,
  computed(() => session.value?.spawnedChildren.value ?? []),
);

// Which delegate's expanded transcript is on screen. Approvals still go
// through this pane's one approval path, and revealing a spawned thread is the
// portal's call — the shell only asks.
const focusedKey = computed(() => session.value?.key ?? null);
const {
  activeShell,
  activeShellRun,
  activeShellThread,
  shellApprovals,
  shellSuppressesApproval,
  onCloseShell,
  onDecideShellApproval,
  onShellOpenThread,
  onOpenDelegate,
} = useSubagentShell({
  subagents: subagentsRaw,
  focusedThread: session,
  focusedPendingApproval: pendingApproval,
  focusedKey,
  respondApproval: (requestId, decision) => onRespondApproval(requestId, decision),
  revealThread: (threadId) => emit("open-thread", threadId),
  cue,
});

// While an ask owns the centre-bottom the composer steps aside for it — the
// modal sits in the composer's spot, the way it does on the studio.
const modalOpen = computed(
  () => Boolean(pendingUserInput.value) || (Boolean(pendingApproval.value) && !shellSuppressesApproval.value),
);

// The header meter's Compact control — the same shared rule as the strip, so
// both surfaces agree. Null session (or an unsupported provider) hides the
// actions card.
const agentProviders = useAgentProviders();
const compact = computed(() => compactPropsForSession(session.value, agentProviders.statuses.value));

// No visible scrollbar — the thread content smokes its top/bottom edges over whatever
// content runs past the cutoff, easing in over the first ~28px of scroll.
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

watch(blocks, () => void nextTick(measure));

// Opening a thread should land at the latest message, not the top.
// The child ConversationThread also attempts this, but the live session's
// blocks arrive async after the thread is adopted — so pin the portal's own
// scroller once the first window is in, and hold it per thread.
function scrollLiveToBottom(): void {
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

const liveInitialDoneFor = ref<string | null>(null);
function tryLiveInitialScroll(): void {
  if (!import.meta.client) return;
  const key = props.row.threadId ?? "";
  if (!key || liveInitialDoneFor.value === key) return;
  if (blocks.value.length === 0) return;
  liveInitialDoneFor.value = key;
  void nextTick(() => {
    void nextTick(() => {
      if (!import.meta.client) return;
      requestAnimationFrame(() => scrollLiveToBottom());
    });
  });
}

watch(() => props.row.threadId, () => void nextTick(() => tryLiveInitialScroll()));
watch(blocks, () => tryLiveInitialScroll());
onMounted(() => void nextTick(() => tryLiveInitialScroll()));

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

async function onSendNow(entry: QueuedTurnEntry): Promise<void> {
  const s = session.value;
  if (!s) return;
  await s.sendQueuedEntryNow(entry);
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
      :seed="row.threadId"
      :provider="session?.provider.value || agent.provider.value || row.provider"
      :brand="row.brand"
      :token-usage="session?.tokenUsage.value ?? undefined"
      :compact="compact"
    />

    <div
      ref="scroller"
      class="live__body"
      :style="maskStyle"
      @scroll.passive="measure"
    >
      <ConversationThread
        :blocks="blocks"
        :compactions="session?.compactions.value ?? []"
        :now="agent.now.value"
        :thread-id="row.threadId"
        :agent-seed="row.threadId"
        mode="reply"
        :session-error="session?.error.value"
        :load-failed="session?.transcriptLoadFailed.value"
        :loading="starting"
        :busy="busy"
        :has-older="session?.hasOlder.value"
        :loading-older="session?.loadingOlder.value"
        :older-error="session?.olderError.value"
        hide-empty-art
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
         opens or a queued strip appears. While an ask owns the centre-bottom
         the composer steps aside for it. -->
    <div v-if="!modalOpen" class="live__dock">
      <ProviderHealthBanner
        class="live__banner"
        :status="composer.sendBlockedStatus.value"
        :reason="composer.sendBlockedReason.value"
        :checking="composer.recheckingProviders.value"
        @recheck="composer.recheckProviders"
      />

      <ThreadDockStack
        :composer-open="composerOpen"
        :changes="activeChanges"
        :plan="activePlan"
        :project-path="projectPath"
        :thread-key="row.threadId"
        position-mode="absolute-dock"
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
        :picking="composer.pickerOpen.value"
        :blocked-reason="composer.sendBlockedReason.value"
        @send="onSend"
        @remove-queued="session?.cancelQueuedTurn($event)"
        @reorder-queued="session?.reorderQueuedTurns($event)"
        @send-now="onSendNow"
        @interrupt="session?.interrupt()"
        @update:agent-id="composer.onAgentPick"
        @update:model-id="composer.onModelId"
        @update:reasoning="composer.onReasoning"
        @update:mode="composer.onMode"
        @update:fast-mode="composer.onFastMode"
        @update:context-window="composer.onContextWindow"
        @open-models="composer.openPicker"
        @update:open="composerOpen = $event"
      />
    </div>

    <!-- Mid-turn question: raises over the composer in the picker-family
         shell, the way it does on the studio. Answering resolves the parked
         tool call and the turn continues. -->
    <UiUserInputModal
      v-if="pendingUserInput"
      :request-id="pendingUserInput.requestId"
      :questions="pendingUserInput.questions"
      @answer="onAnswerUserInput"
      @cancel="onCancelUserInput"
      />

    <!-- Tool approval: the turn is parked on the agent wanting to run
         something. The subagent shell, when it is already showing this same
         ask inline, is the answer spot instead — and then this modal stays
         down. -->
    <AgentApprovalModal
      v-if="pendingApproval && !shellSuppressesApproval"
      :request-id="pendingApproval.requestId"
      :approval="pendingApproval.approval"
      :queue="session?.pendingApprovals.value"
      @decide="onRespondApproval"
    />

    <!-- The subagent corner — delegated runs bottom-left with their expanded
         shell. Steps aside while the shell is open. -->
    <ThreadSubagentDock
      :rows="activeDelegates.rows"
      :streaming="activeDelegates.streaming"
      :shell="activeShell"
      :shell-run="activeShellRun"
      :shell-thread="activeShellThread"
      :shell-approvals="shellApprovals"
      @open="onOpenDelegate"
      @stop-subagent="onStopSubagent"
      @close="onCloseShell"
      @open-thread="onShellOpenThread"
      @decide-approval="onDecideShellApproval"
    />

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
