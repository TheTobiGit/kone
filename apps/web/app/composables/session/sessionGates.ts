import { computed, ref, type Ref } from "vue";
import type {
  ApprovalDecision,
  ChatAttachment,
  KoneAgentApi,
  SpawnedThread,
  UserInputAnswers,
  UserInputRespondResult,
} from "~/types/desktop";
import { seedFromBridge } from "../useCompaction";
import type {
  PendingApproval,
  PendingUserInput,
  ThreadAttention,
} from "../agentTypes";

/** Live parked asks — questions, tool approvals, spawned children. The
 *  follow-up turn an answered aftermath ask carries goes out as an ordinary
 *  send, and the browser-dev mock owns its own pending approvals, so both
 *  arrive as the callbacks below. */
export type SessionGatesDeps = {
  threadId: Ref<string>;
  bridge: () => KoneAgentApi | null;
  send: (text: string, attachments?: ChatAttachment[]) => Promise<void>;
  mockHasPendingApproval: (requestId: string) => boolean;
  mockRespondApproval: (requestId: string, decision: ApprovalDecision) => void;
};

/** The live "parked on a human" state: questions, tool approvals, and the
 *  spawned children whose dock reads live here. Refs are written by the event
 *  reducer and the orphan stashes through the session — this unit owns them,
 *  callers only wire them through. */
export function useSessionGates(deps: SessionGatesDeps) {
  const { threadId, bridge, send, mockHasPendingApproval, mockRespondApproval } = deps;

  // A live question the agent is asking (AskUserQuestion / Codex requestUserInput).
  // Non-null while the modal is up; cleared once answered or resolved/aborted.
  const pendingUserInput = ref<PendingUserInput | null>(null);
  // Live tool approvals the agent is parked on (Codex requestApproval / Claude
  // canUseTool / ACP request_permission / OpenCode permission). A queue, not a
  // single slot: providers can ask for several tools in parallel (Claude's
  // parallel tool calls), and each must be answerable or its parked request
  // hangs the turn. The modal shows the head.
  const pendingApprovals = ref<PendingApproval[]>([]);
  /** The child threads THIS thread spawned via kone_spawn_worker — what the
   *  corner Subagents dock reads. Live-only state: the spawn events are
   *  deliberately not journaled (reduce isn't a replay), so a session that
   *  adopts a stored identity re-seeds it by an explicit query instead (see
   *  seedSpawnedChildren). */
  const spawnedChildren = ref<SpawnedThread[]>([]);
  const pendingApproval = computed<PendingApproval | null>(() => pendingApprovals.value[0] ?? null);

  /** The one "needs a human" signal for this thread, derived straight from the
   *  live parked requests. A permission gate outranks a question — the turn is
   *  blocked behind the gate, so that's the ask to answer first. Null the moment
   *  both clear; nothing here is stored, so a resume can't strand it. */
  const attention = computed<ThreadAttention | null>(() => {
    const gate = pendingApprovals.value[0];
    if (gate) return { kind: "permission", detail: gate.approval.title };
    const q = pendingUserInput.value;
    if (q) return { kind: "question", detail: q.questions[0]?.header };
    return null;
  });

  /** Re-seed this session's spawned children from the bridge, for a thread that
   *  just adopted a stored identity (rehydrate / openStored) — the spawn events
   *  are deliberately not journaled, so the dock's live-only state must be
   *  rebuilt by an explicit query to survive a reload. Best-effort via
   *  seedFromBridge. */
  function seedSpawnedChildren(): void {
    // Declared on the bridge, but still checked at runtime: browser dev runs
    // against a partial mock, and a dock that can't seed is a missing
    // convenience, not a broken thread.
    seedFromBridge(bridge()?.spawnChildren, threadId, (kids) => {
      spawnedChildren.value = [...kids].sort((a, b) => a.createdAt - b.createdAt);
    });
  }

  /** Stop one nested subagent run, leaving the parent turn running. */
  async function stopSubagent(toolUseId: string): Promise<void> {
    const api = bridge();
    if (!api) return;
    try {
      await api.stopSubagent(threadId.value, toolUseId);
    } catch {
      // The run's `subagent.completed` event (or its absence) is the truth.
    }
  }

  /** Send a mid-task message to a running nested subagent. It's delivered on the
   *  child's next tool call, so a child about to finish may never see it. */
  async function steerSubagent(toolUseId: string, message: string): Promise<void> {
    const api = bridge();
    if (!api) return;
    try {
      await api.steerSubagent(threadId.value, toolUseId, message);
    } catch {
      // Best-effort — the run may have settled between render and click.
    }
  }

  /** Answer the agent's live question. Clears the modal optimistically, then
   *  hands the answers to the backend in one call — which reports whether it
   *  still owned the request and, for a print-mode aftermath ask, the
   *  follow-up turn text carrying the answers. A stale answer (a superseded
   *  aftermath, a double submit, a stop race) resolves unowned and sends
   *  nothing, so it can never start a phantom follow-up turn. A print-mode
   *  aftermath ask has no live call to resolve, so an owned answer goes out
   *  as an ordinary follow-up turn instead — journaling, queueing and history
   *  then behave like a typed message. A dismissal (nothing answered) carries
   *  no follow-up and sends nothing. A failed backend call restores the modal
   *  so the answers are not lost; a failed follow-up never does — the backend
   *  cleared its park before answering, so there is nothing left to retry
   *  against, and resurrecting the modal would answer into a dead request.
   *  The send error itself still surfaces through the send path. */
  async function respondUserInput(requestId: string, answers: UserInputAnswers): Promise<void> {
    const pending =
      pendingUserInput.value?.requestId === requestId ? pendingUserInput.value : undefined;
    if (pending) {
      pendingUserInput.value = null;
    }
    const api = bridge();
    if (!api) {
      if (pending) pendingUserInput.value = pending;
      return;
    }
    let result: UserInputRespondResult;
    try {
      result = await api.respondUserInput(threadId.value, requestId, answers);
    } catch {
      // The backend never took the answers — put the modal back so the user
      // can retry instead of losing them to a cleared prompt. No follow-up:
      // nothing was owned, so there is nothing to deliver.
      if (pending) pendingUserInput.value = pending;
      return;
    }
    if (!result.owned) return;
    if (result.followUp) await send(result.followUp);
  }

  /** Decide a parked tool approval. Drops it from the queue optimistically,
   *  then hands the decision to the adapter — which resolves the parked
   *  provider request and emits `approval.resolved` (a belt-and-braces
   *  re-clear). */
  async function respondApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    pendingApprovals.value = pendingApprovals.value.filter((a) => a.requestId !== requestId);
    if (mockHasPendingApproval(requestId)) {
      mockRespondApproval(requestId, decision);
      return;
    }
    const api = bridge();
    if (!api) return;
    try {
      await api.respond(threadId.value, requestId, decision);
    } catch {
      // If the send fails the turn will abort and clear state via turn.aborted.
    }
  }

  return {
    pendingUserInput,
    pendingApprovals,
    spawnedChildren,
    pendingApproval,
    attention,
    seedSpawnedChildren,
    stopSubagent,
    steerSubagent,
    respondUserInput,
    respondApproval,
  };
}
