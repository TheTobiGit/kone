<script setup lang="ts">
// One thread column's own composer, resting bottom-centre of that column.
//
// Every thread column on the board carries one of these, so each conversation
// has a voice of its own rather than borrowing one that follows focus around.
// That only holds if nothing here reads the registry's active-thread
// projection: every slot is read off this column's session, and every commit
// points the registry at that session before it changes anything (see
// useInboxComposer). Without that ordering a pick made here while another
// column took focus would land on the other column's thread.
//
// The row keeps what is about the row: focus, the corner docks, the ask
// overlay, default seeding for a blank thread, and the handoff picker. What it
// needs from here — waking this composer, pre-filling it, how much floor its
// column must leave — it asks for or is told.

import { computed, onBeforeUnmount, ref, watch } from "vue";
import AgentComposer from "~/components/agent/AgentComposer.vue";
import HandOffChainBar from "~/components/thread/HandOffChainBar.vue";
import { useAgentProviders } from "~/composables/useAgentProviders";
import { useInboxComposer } from "~/composables/useInboxComposer";
import { useKeyedWorkspaceChoice } from "~/composables/useWorkspaceChoice";
import {
  useDockClearance,
  STRIP_DOCK_AIR,
  STRIP_DOCK_FLOAT,
  STRIP_DOCK_RESTING,
} from "~/composables/useDockClearance";
import { getSideChatSource } from "~/composables/sideChats";
import {
  mergeComposerAttachments,
  normalizeComposerDraft,
  type ComposerDraft,
  type QueuedTurnEntry,
  type ThreadSession,
  type useAgent,
} from "~/composables/useAgent";
import { agentForThread } from "~/utils/agents";
import { columnComposerDockState, type ColumnComposerDock } from "~/utils/columnComposerDock";
import { compactPropsForSession } from "~/utils/compactAvailability";
import type { ModelPick } from "~/composables/useModelCommit";
import type { WorkspaceChoice } from "~/utils/threadWorkspace";
import type { ChatAttachment, SkillReference, TextReference, ThreadEnvMode } from "~/types/desktop";

/** What the column's floor has to clear, and whether the card is open — the
 *  row lifts the focused column's corner docks onto a rail above an open card. */
export type { ColumnComposerDock };

const props = defineProps<{
  /** The column this composer belongs to — the key its unsent draft and its
   *  blank-thread workspace choice are kept under. */
  paneId: string;
  session: ThreadSession;
  agent: ReturnType<typeof useAgent>;
  projectPath: string;
  projectName: string;
  /** The branch the project's checkout is on. */
  branch: string | null;
  /** This column has focus. A background column's composer still opens on a
   *  click, but leaves stray keystrokes and Escape to the focused one. */
  focused: boolean;
  /** Whether `/new` is offered — false while a blank thread already stands on
   *  the row, which is the new thread. */
  creatable: boolean;
  /** Where each blank column will work, kept by the row so a pick survives this
   *  composer stepping off screen and back. */
  workspaceChoices: Record<string, WorkspaceChoice>;
}>();

const emit = defineEmits<{
  /** The composer's `/new` row. */
  "new-thread": [];
  /** The floor this column needs and the card's state, or null on the way out. */
  dock: [state: ColumnComposerDock | null];
  "update:workspaceChoices": [choices: Record<string, WorkspaceChoice>];
}>();

const { cue } = useSound();
const providers = useAgentProviders();

const composer = useInboxComposer({
  agent: props.agent,
  session: () => props.session,
  projectPath: () => props.projectPath,
});

const composerRef = ref<InstanceType<typeof AgentComposer> | null>(null);
const composerOpen = ref(false);

/** Nothing has been asked of this thread yet, so the choices that fix its shape
 *  for good — which branch it works on, which agent works it — are still open.
 *  The first block is the point of no return for both. */
const blank = computed(() => props.session.blocks.value.length === 0);

const isSideChat = computed(() => {
  const id = props.session.threadId.value;
  return Boolean(props.session.isSideChat.value || (id && getSideChatSource(id)));
});

// A side chat inherits its source's owner, so the router never gets a say
// there — the question of who works it was answered by the thread it came from.
const agentId = computed(() => {
  const id = props.session.threadId.value;
  if (id && isSideChat.value) return agentForThread(id)?.id ?? null;
  return composer.agentId.value;
});

// While an ask is parked on this thread the composer steps aside — but only
// visually. Unmounting it used to lose whatever the user was holding (and made
// Add to Composer a silent no-op); hiding it keeps the draft, chips, references
// and uploaded files alive until the ask resolves.
const asking = computed(
  () => Boolean(props.session.pendingUserInput.value) || Boolean(props.session.pendingApproval.value),
);

// ── where a blank thread works ───────────────────────────────────────────────
// Draft state until this column's first send hands it to the session. Nothing
// is built while it waits, so a column closed after picking leaves no
// directory behind.
const workspacePickerOpen = ref(false);
const workspaceHeld = computed({
  get: () => props.workspaceChoices,
  set: (next) => emit("update:workspaceChoices", next),
});
const workspace = useKeyedWorkspaceChoice({
  key: () => props.paneId,
  drafting: () => blank.value,
  fallbackBranch: () => props.branch,
  held: workspaceHeld,
});

// A blank thread shows what it will do; a started one shows what it did.
const envMode = computed<ThreadEnvMode | null>(() =>
  blank.value ? workspace.choice.value.mode : (props.session.envMode.value ?? null),
);

// The `/compact` row follows the column header's own rule, so the two agree.
// A blank thread has no user turn worth compacting.
const compact = computed(() => compactPropsForSession(props.session, providers.statuses.value));
const compactable = computed(
  () => !blank.value && Boolean(compact.value.onCompact) && compact.value.compactState === "available",
);
function onCompact(_focus: string): void {
  if (!compact.value.onCompact || compact.value.compactState !== "available") return;
  compact.value.onCompact();
}

/** Warm the router off the draft while it is still being typed. Blank threads
 *  only: a settled thread never routes again, and a side chat inherits its
 *  source's owner — warming for either would spend a call whose answer can
 *  never land. */
function onDraft(text: string): void {
  if (!blank.value || isSideChat.value || !composer.routing.value) return;
  composer.prefetchRoute(text);
}

function onPick(picked: ModelPick): void {
  composer.onPick(picked);
  cue("select");
}

// Pickers belong to the column that opened them; one left standing after focus
// moves on would answer for a column the user is no longer looking at.
watch(
  () => props.focused,
  (focused) => {
    if (focused) return;
    composer.closePicker();
    workspacePickerOpen.value = false;
  },
);

async function onSend(draft: ComposerDraft): Promise<void>;
async function onSend(text: string, files?: File[], skills?: SkillReference[]): Promise<void>;
async function onSend(
  textOrDraft: string | ComposerDraft,
  files?: File[],
  skills?: SkillReference[],
): Promise<void> {
  const draft = normalizeComposerDraft(textOrDraft, files, skills);
  const s = props.session;
  await composer.syncTarget();
  // Where the work lands is staged on the session before the turn: the session
  // consumes it on its one start. Only a blank thread has a choice to stage.
  const request = workspace.request();
  if (request) s.stageWorkspace(request);
  // Who works the thread is written once, on its first send, and the session
  // reads the persona off that binding as it spawns — so it is settled before
  // the turn goes out, and whoever it names starts on their own model.
  const threadId = s.threadId.value;
  if (isSideChat.value && threadId) {
    const sourceId = s.sideChatSource.value ?? getSideChatSource(threadId);
    composer.settleThreadAgent(threadId, (sourceId ? agentForThread(sourceId)?.id : undefined) ?? null);
  } else {
    await composer.settleAndPin(draft.text, threadId);
  }
  // Uploaded through the session itself, so they are scoped to this thread
  // whatever the registry is pointing at by the time the router answers.
  let attachments: ChatAttachment[] | undefined;
  if (draft.files?.length) {
    const results = await Promise.allSettled(draft.files.map((f) => s.uploadAttachment(f)));
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (ok.length) attachments = ok;
  }
  attachments = mergeComposerAttachments(attachments, draft.references);
  void s.send({ text: draft.text, attachments, skills: draft.skills, steer: draft.steer });
}

async function onSendNow(entry: QueuedTurnEntry): Promise<void> {
  await props.session.sendQueuedEntryNow(entry);
}

// ── the floor this column leaves ─────────────────────────────────────────────
// The card floats over the transcript, so the column's scroll floor has to
// clear whatever it currently stacks: the resting orb, or the open card plus
// the pills above it. Measured here and reported up, since the column body
// that pads by it is this host's sibling and no variable set here reaches it.
const dockEl = ref<HTMLElement>();
const { clear, height } = useDockClearance(dockEl, {
  resting: STRIP_DOCK_RESTING,
  float: STRIP_DOCK_FLOAT,
  air: STRIP_DOCK_AIR,
});
watch(
  [asking, composerOpen, height, clear],
  ([parked, open, h, c]) =>
    emit(
      "dock",
      columnComposerDockState({ asking: parked, open, height: h, clear: c }),
    ),
  { immediate: true },
);
onBeforeUnmount(() => emit("dock", null));

// The card is always mounted while this wrapper is (see the template); a null
// inner ref means the column is being torn down. Refuse rather than resolve
// successfully with nothing delivered — the row turns that into a notice.
function composerHandle(): InstanceType<typeof AgentComposer> {
  const handle = composerRef.value;
  if (!handle) throw new Error("This column's composer is not mounted.");
  return handle;
}

// The caret hand-off lives in the row, which owns focus across every column
// (see utils/caretHandoff). A column only offers these two ends of it: which
// column is losing or gaining focus is not something a composer can see.
defineExpose({
  wake: async (): Promise<void> => {
    await composerRef.value?.wake();
  },
  /** Seed the field with ordinary, literal text for New Thread. */
  setDraft: async (text: string): Promise<void> => {
    await composerHandle().seedDraft(text);
  },
  /** Add a selection to this column's composer without changing its prose. */
  addReference: async (reference: TextReference): Promise<void> => {
    await composerHandle().addReference(reference);
  },
  /** Append text after the existing draft, keeping its chips and references. */
  appendDraft: async (text: string): Promise<void> => {
    await composerHandle().appendDraft(text);
  },
  /** Blur the caret if it is in this column, answering whether it was. */
  releaseCaret: (): boolean => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !dockEl.value?.contains(active)) return false;
    active.blur();
    return true;
  },
  /** Take the caret, but only into an already-open card — a resting orb stays
   *  resting and wakes on the next keystroke by itself. */
  takeCaret: (): void => {
    if (composerOpen.value) composerRef.value?.focus();
  },
});
</script>

<template>
  <!-- Always mounted: a parked ask only hides the dock (visibility keeps the
       measured layout intact) so the composer's draft, chips and references
       survive the wait and Add to Composer can land. `inert` plus visibility
       keeps the hidden card out of focus and the accessibility tree. -->
  <div
    ref="dockEl"
    class="col-composer"
    :class="{ 'col-composer--open': composerOpen, 'col-composer--parked': asking }"
    :inert="asking"
  >
    <HandOffChainBar :thread-id="session.threadId.value" :spawned="session.spawnedChildren.value" />
    <AgentComposer
      ref="composerRef"
      :background="!focused"
      :inactive="asking"
      :draft-scope="paneId"
      :project-path="projectPath"
      :provider="composer.provider.value"
      :send-rejection="session.sendRejection.value"
      :queue-return="session.queueReturn.value"
      :steer-wait="session.steerWait.value"
      :project-name="projectName"
      :branch="workspace.branch.value"
      :branch-switchable="blank && !isSideChat"
      :env-mode="envMode"
      :worktree-path="blank ? null : session.worktreePath.value"
      :thread-name="session.title.value"
      :thread-id="session.threadId.value"
      :busy="session.busy.value"
      :queued="session.queuedTurns.value"
      :picking="composer.pickerOpen.value || workspacePickerOpen"
      :agents="composer.agents.value"
      :agent-id="agentId"
      :routing-note="composer.routingNote.value"
      :agent-switchable="blank && !isSideChat"
      :models="composer.modelOptions.value"
      :model-switchable="composer.modelSwitchable.value"
      :model-id="composer.modelId.value"
      :reasoning="composer.reasoning.value"
      :mode="composer.mode.value"
      :fast-mode="composer.fastMode.value"
      :context-window="composer.contextWindow.value"
      :blocked-reason="composer.sendBlockedReason.value"
      :health-status="composer.sendBlockedStatus.value"
      :health-checking="composer.recheckingProviders.value"
      :workspace-steps="session.workspaceSteps.value"
      :compactable="compactable"
      :creatable="creatable"
      @send="onSend"
      @remove-queued="session.cancelQueuedTurn($event)"
      @reorder-queued="session.reorderQueuedTurns($event)"
      @send-now="onSendNow"
      @interrupt-now="void session.interruptStepWaitNow()"
      @interrupt="void session.stop()"
      @update:agent-id="composer.onAgentPick"
      @update:model-id="composer.onModelId"
      @update:reasoning="composer.onReasoning"
      @update:mode="composer.onMode"
      @update:fast-mode="composer.onFastMode"
      @update:context-window="composer.onContextWindow"
      @open-models="composer.openPicker"
      @open-branch="workspacePickerOpen = true"
      @compact="onCompact"
      @new-thread="emit('new-thread')"
      @update:open="composerOpen = $event"
      @update:draft="onDraft"
      @recheck="composer.recheckProviders"
      @cancel-workspace="session.cancelWorkspace()"
      @dismiss-workspace="session.dismissWorkspaceSteps()"
    />
  </div>

  <!-- The pickers leave the column for the page: a background column is
       scaled and filtered, either of which would pin a fixed scrim to the
       column's own box and clip it to the rail. -->
  <Teleport to="body">
    <ModelPickerModal
      v-if="composer.pickerOpen.value"
      :providers="composer.pickerProviders.value"
      :active-provider="composer.provider.value"
      :model-id="composer.modelId.value"
      :reasoning="composer.reasoning.value"
      :fast-mode="composer.fastMode.value"
      :context-window="composer.contextWindow.value"
      @select="onPick"
      @apply="composer.onApply"
      @cancel="composer.closePicker"
    />

    <!-- Where a blank thread works: its project's checkout or its own
         worktree. Nothing is built by picking; the first send does that. -->
    <ConversationBranchPickerModal
      v-if="workspacePickerOpen"
      :project-path="projectPath"
      mode="select"
      :chosen="workspace.choice.value"
      @picked="(choice) => { workspacePickerOpen = false; workspace.pick(choice); }"
      @cancel="workspacePickerOpen = false"
    />
  </Teleport>
</template>

<style scoped>
/* Bottom-centre of its own column, floating over the transcript, which keeps
   scrolling behind it. At rest it sits under the focused column's corner docks
   (40 < 45): the orb is small and out of their way, and the docks are what is
   being read. Open, the card is what is being typed into, so it takes the
   higher layer and the docks pass underneath. */
.col-composer {
  position: absolute;
  inset-inline: 0;
  /* STRIP_DOCK_FLOAT in composables/useDockClearance.ts — the clearance this
     host reports is built from it, so change them together. */
  bottom: 32px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* The host is only a rail for centring; the card takes its own clicks and
     everything either side of it belongs to the transcript. */
  pointer-events: none;
}
.col-composer > * {
  pointer-events: auto;
}
.col-composer--open {
  z-index: 46;
}
/* A parked ask owns this spot. The dock stays in the tree (and keeps its
   measured box) so the composer's state survives, but it takes no input, no
   focus and no accessibility-tree presence. */
.col-composer--parked {
  visibility: hidden;
  pointer-events: none;
}
</style>
