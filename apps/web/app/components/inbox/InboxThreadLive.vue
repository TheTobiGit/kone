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
import ThreadBranchDrift from "~/components/inbox/ThreadBranchDrift.vue";
import ThreadWorkspacePrep from "~/components/inbox/ThreadWorkspacePrep.vue";
import InboxThreadHeader from "~/components/inbox/InboxThreadHeader.vue";
import ThreadDockStack from "~/components/thread/ThreadDockStack.vue";
import ThreadInfoPanel from "~/components/thread/ThreadInfoPanel.vue";
import { useEdgeFade } from "~/composables/useEdgeFade";
import { useAgentProviders } from "~/composables/useAgentProviders";
import { useDockSnapshot } from "~/composables/useDockSnapshot";
import { useDockClearance } from "~/composables/useDockClearance";
import { useStudioIntake } from "~/composables/useStudioIntake";
import { getSideChatSource } from "~/composables/sideChats";
import { compactPropsForSession } from "~/utils/compactAvailability";
import { resolveBranchDrift } from "~/utils/branchDrift";
import type { ApprovalDecision, ChatAttachment, GitRemote, UserInputAnswers } from "~/types/desktop";
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
  /** Start a conversation — the composer's `/new` row. The pane shows one
   *  thread, so showing the composer instead is the portal's call, not this
   *  pane's. */
  "new-thread": [];
  /** An earlier message was edited into a fork: the portal selects the fork
   *  the ordinary way, so the pane remounts onto it. */
  "open-thread": [threadId: string];
}>();

const { cue } = useSound();
const intake = useStudioIntake();
// The live list's shared pipeline — the same instance the inbox rows read —
// so a header archive drops optimistically with the same refusal-restore as a
// row archive, instead of a second bridge path with its own semantics.
const sessions = useAllRecentSessions();

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

/** Whether this thread's history was written on a different branch than the one
 *  its next turn would land on. The row carries what the thread's last settled
 *  turn stamped on it; the composer has already read what the checkout says now
 *  — so the comparison costs nothing beyond what both ends already hold. */
/** Backing out of a worktree still being built. The stepper goes away at once —
 *  the decision is made and there is nothing further to watch — while the
 *  teardown happens behind it, once the creation it is undoing finishes. */
async function onCancelWorkspace(): Promise<void> {
  const s = session.value;
  if (!s) return;
  s.dismissWorkspaceSteps();
  await s.cancelWorkspace();
}

const branchDrift = computed(() =>
  resolveBranchDrift({
    recorded: props.row.branch,
    live: composer.branch.value,
    envMode: props.row.envMode,
    worktreePath: props.row.worktreePath,
    requestedBranch: props.row.requestedBranch ?? null,
  }),
);
const busy = computed(() => session.value?.busy.value ?? false);
const queued = computed(() => session.value?.queuedTurns.value ?? []);
const starting = computed(() => session.value?.sessionState.value === "starting");
const threadTitle = computed(() => session.value?.title.value || props.row.title);

// A forked throwaway conversation reads as provisional — the same temporary
// mark the studio column wears, so the thread never reads as a main one.
const isSideChat = computed(
  () =>
    Boolean(session.value?.isSideChat.value) ||
    Boolean(getSideChatSource(props.row.threadId)) ||
    Boolean(props.row.sideChat),
);

// The thread-info drop-down — the studio column header's own read-out, anchored
// beneath the title that opened it. The strip owns this same state per column;
// this pane shows one thread, so it owns it once.
const infoAnchor = ref<DOMRect | null>(null);
const infoOpen = computed(() => infoAnchor.value !== null);
function toggleInfo(ev: Event): void {
  if (infoAnchor.value) {
    infoAnchor.value = null;
    return;
  }
  // SAFETY: toggleInfo is bound to the header title element, so currentTarget
  // is that HTMLElement during dispatch (nulled after — hence | null).
  const el = ev.currentTarget as HTMLElement | null;
  if (!el || !session.value) return;
  infoAnchor.value = el.getBoundingClientRect();
}
function closeInfo(): void {
  infoAnchor.value = null;
}

// Where the thread's work lives — the info panel's Project section. The branch
// rides the composer's git read with the row's stored branch as fallback; the
// remote is read once per pane, the way a project page reads it once per open.
const git = useGit();
const origin = ref<GitRemote | null>(null);
onMounted(async () => {
  try {
    const remotes = await git.remotes(props.projectPath);
    origin.value = remotes.find((r) => r.name === "origin") ?? remotes[0] ?? null;
  } catch {
    origin.value = null;
  }
});

// A thread is renamed from its info panel's Name row — the same write the strip
// owns, so the title lands optimistically and reverts on a store refusal.
async function onRename(title: string): Promise<void> {
  const s = session.value;
  if (!s) return;
  const previous = s.title.value;
  s.title.value = title;
  if (!import.meta.client) return;
  const api = window.koneDesktop?.agent;
  if (!api) return;
  try {
    const ok = await api.renameThread(s.threadId.value, title);
    if (ok === false) s.title.value = previous;
  } catch {
    s.title.value = previous;
  }
}

// Archiving from the header walks the same path as the list row's own
// archive — optimistic drop with refusal-restore — and the reading pane clears
// off the store fan-out the portal already trusts. The store can refuse (a
// spawned descendant mid-turn), which leaves the thread exactly where it is.
async function onArchive(): Promise<void> {
  const threadId = props.row.threadId;
  if (!threadId) return;
  cue("press");
  infoAnchor.value = null;
  const ok = await sessions.archive(threadId, true).catch(() => false);
  if (!ok) return;
  void intake.dismissThread(props.projectPath, threadId);
}

// Derives and snapshot for active plan, touched files, and subagent delegates.
const {
  activePlan,
  activeChanges,
  activeDelegates,
} = useDockSnapshot(
  blocks,
  computed(() => session.value?.spawnedChildren.value ?? []),
);

// While an ask owns the centre-bottom the composer steps aside for it — the
// modal sits in the composer's spot, the way it does on the studio.
const modalOpen = computed(
  () => Boolean(pendingUserInput.value) || Boolean(pendingApproval.value),
);

// The header meter's Compact control — the same shared rule as the strip, so
// both surfaces agree. Null session (or an unsupported provider) hides the
// actions card.
const agentProviders = useAgentProviders();
const compact = computed(() => compactPropsForSession(session.value, agentProviders.statuses.value));

// The composer's `/compact` row follows the same availability as the header
// button — offered only when the button could run.
const compactable = computed(
  () => Boolean(compact.value.onCompact) && compact.value.compactState === "available",
);

// The composer's `/compact` emit — the header button's call, so the two can
// never disagree. Guards mirror the button: a busy or already-compacting
// thread consumes silently, never calls.
function onComposerCompact(_focus: string): void {
  if (!compact.value.onCompact || compact.value.compactState !== "available") return;
  compact.value.onCompact();
}

// The composer's `/new` row — the portal's own compose action, so the row
// lands where the list's new-chat button lands. A turn in flight consumes
// silently: nothing is started over it, and nothing says so.
function onComposerNewThread(): void {
  if (busy.value) return;
  emit("new-thread");
}

// No visible scrollbar — the thread content smokes its top/bottom edges over whatever
// content runs past the cutoff, easing in over the first ~28px of scroll.
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

// The composer dock is laid over the transcript, so the scroll floor has to
// clear whatever it currently stacks: the resting bar, or the open card plus
// the pills row above it. It floats 18px above the pane bottom, and 26px of
// air keeps the last line from kissing the card.
const dockEl = ref<HTMLElement>();
const { clear: bodyPadBottom } = useDockClearance(dockEl, { resting: 132, float: 18, air: 26 });
// Growing the floor changes what there is to scroll, but resizes no box the
// edge-fade observes — so tell it by hand, once the new padding is laid out.
watch(bodyPadBottom, () => void nextTick(measure));

// Subagents get exactly one host: the row above the composer while it is open,
// the bottom-left corner the rest of the time. Both placements read this one
// value, so they can't both render — or both vanish.
const subagentsAbove = computed(() => composerOpen.value);

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
  // write-once, so the first send is the only moment it can be decided — and
  // the session reads the persona off it as it spawns, so a decision made
  // after the send would arrive too late to reach the provider.
  await composer.syncTarget();
  const threadId = s.threadId.value;
  // Only the thread's first turn asks: every later one finds it already
  // decided and leaves both the binding and the router alone.
  if (threadId) await composer.settleAgentFor(text, threadId);
  await s.send(text, await upload(files));
}

async function onSendNow(entry: QueuedTurnEntry): Promise<void> {
  const s = session.value;
  if (!s) return;
  await s.sendQueuedEntryNow(entry);
}

/** Edit-and-resend of an earlier message: fork the thread at that block and
 *  hand the fork to the portal, which selects it the ordinary way. The
 *  source thread is never mutated. Refused while busy, like every send. */
async function onEditFork(blockId: string, text: string): Promise<void> {
  const s = session.value;
  if (!s || busy.value) return;
  const forkId = await s.forkAtBlock(blockId, text);
  if (forkId) emit("open-thread", forkId);
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
      :side-chat="isSideChat"
      archivable
      :worktree-path="row.worktreePath"
      :env-mode="row.envMode"
      :info-clickable="!!session"
      :info-open="infoOpen"
      @archive="onArchive"
      @open-info="toggleInfo"
    />

    <!-- Building this conversation's worktree, while it happens. Renders only
         for the seconds it takes, and only for a thread that asked for one. -->
    <ThreadWorkspacePrep
      v-if="session && session.workspaceSteps.value.length > 0"
      :steps="session.workspaceSteps.value"
      @cancel="onCancelWorkspace"
      @dismiss="session?.dismissWorkspaceSteps()"
    />

    <ThreadInfoPanel
      v-if="session && infoAnchor"
      :session="session"
      :anchor="infoAnchor"
      :repo="row.projectName"
      :branch="composer.branch.value ?? row.branch ?? undefined"
      :origin="origin"
      :worktree-path="row.worktreePath"
      :env-mode="row.envMode"
      @close="closeInfo"
      @rename="onRename"
    />

    <div
      ref="scroller"
      class="live__body"
      :style="[maskStyle, { paddingBottom: `${bodyPadBottom}px` }]"
      @scroll.passive="measure"
    >
      <ConversationThread
        :blocks="blocks"
        :compactions="session?.compactions.value ?? []"
        :checkpoints="session?.checkpoints.value ?? []"
        :now="agent.now.value"
        :thread-id="row.threadId"
        :agent-seed="row.threadId"
        mode="reply"
        :load-failed="session?.transcriptLoadFailed.value"
        :loading="starting"
        :busy="busy"
        :has-older="session?.hasOlder.value"
        :loading-older="session?.loadingOlder.value"
        :older-error="session?.olderError.value"
        hide-empty-art
        @retry="onSend"
        @resend="onSend"
        @edit-fork="onEditFork"
        @retry-load="session?.openStored(row.threadId)"
        @load-older="session?.loadOlder()"
      />
    </div>

    <!-- Laid over the transcript rather than under it, the way it is on the
         board: the composer keeps its own footprint and the conversation
         scrolls behind it, so the thread does not resize every time the card
         opens or a queued strip appears. While an ask owns the centre-bottom
         the composer steps aside for it. -->
    <div v-if="!modalOpen" ref="dockEl" class="live__dock">
      <!-- Above the provider's banner: a provider that cannot take the turn is
           about whether the turn happens at all, and this is about where it
           would land — so the nearer-term obstacle sits nearer the composer. -->
      <ThreadBranchDrift class="live__banner" :drift="branchDrift" />

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
        :delegates="subagentsAbove ? activeDelegates : null"
        :project-path="projectPath"
        :thread-key="row.threadId"
        position-mode="absolute-dock"
        @stop-subagent="onStopSubagent"
      />

      <AgentComposer
        :project-path="projectPath"
        :project-name="row.projectName"
        :branch="composer.branch.value ?? undefined"
        :branch-switchable="false"
        :worktree-path="row.worktreePath"
        :env-mode="row.envMode"
        :thread-name="threadTitle"
        :thread-id="row.threadId"
        :busy="busy"
        :queued="queued"
        :agents="composer.agents.value"
        :agent-id="composer.agentId.value"
        :routing-note="composer.routingNote.value"
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
        :compactable="compactable"
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
        @compact="onComposerCompact"
        @new-thread="onComposerNewThread"
        @update:open="composerOpen = $event"
      />
    </div>

    <!-- Mid-turn question + tool approval, over the composer in the
         picker-family shells, the way they sit on the studio. Contained to
         this thread pane so the scrim dims only the thread. -->
    <ThreadInteractionOverlay
      :user-input="pendingUserInput"
      :approval="pendingApproval"
      :approval-queue="session?.pendingApprovals.value"
      @answer="onAnswerUserInput"
      @cancel="onCancelUserInput"
      @decide="onRespondApproval"
    />

    <!-- The subagent corner — delegated runs bottom-left. While the composer
         is open the dock joins the Changes/Tasks row above the composer
         instead, so this corner copy steps aside to avoid a duplicate. -->
    <ThreadSubagentDock
      v-if="!subagentsAbove"
      :rows="activeDelegates.rows"
      :streaming="activeDelegates.streaming"
      @stop-subagent="onStopSubagent"
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
   overflows. The CSS floor is the resting minimum — the bound inline
   paddingBottom grows it past the open card and pills (see bodyPadBottom), so
   the last thing said stays readable without moving anything. */
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
