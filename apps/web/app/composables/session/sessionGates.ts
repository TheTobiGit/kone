import { computed, ref, type Ref } from "vue";
import type {
  ApprovalDecision,
  KoneAgentApi,
  SpawnedThread,
  UserInputAnswers,
} from "~/types/desktop";
import { seedFromBridge } from "../useCompaction";
import type {
  PendingApproval,
  PendingUserInput,
  ThreadAttention,
} from "../agentTypes";

/** Live questions, tool approvals, and spawned children. Answers resolve
 *  the waiting provider/tool request through IPC; this path never sends a turn. */
export type SessionGatesDeps = {
  threadId: Ref<string>;
  bridge: () => KoneAgentApi | null;
  mockHasPendingApproval: (requestId: string) => boolean;
  mockRespondApproval: (requestId: string, decision: ApprovalDecision) => void;
};

/** The live "parked on a human" state: questions, tool approvals, and the
 *  spawned children whose dock reads live here. Refs are written by the event
 *  reducer and the orphan stashes through the session — this unit owns them,
 *  callers only wire them through. */
export function useSessionGates(deps: SessionGatesDeps) {
  const { threadId, bridge, mockHasPendingApproval, mockRespondApproval } = deps;

  // The question the thread is parked on — a Kone question or a provider's
  // own request — as the backend's events last left it. Only the event
  // reducer writes it: the backend shows a thread one question at a time and
  // says when each is resolved, aborted or replaced.
  const parkedUserInput = ref<PendingUserInput | null>(null);
  // The question whose answer is on its way. Hidden meanwhile, and back only
  // if the answer never reached the backend and the question still waits.
  const answeringUserInput = ref<string | null>(null);
  const pendingUserInput = computed<PendingUserInput | null>(() => {
    const parked = parkedUserInput.value;
    return parked && parked.requestId !== answeringUserInput.value ? parked : null;
  });
  // Live tool approvals the agent is parked on (Codex requestApproval / Claude
  // canUseTool / ACP request_permission / OpenCode permission). A queue, not a
  // single slot: providers can ask for several tools in parallel (Claude's
  // parallel tool calls), and each must be answerable or its parked request
  // hangs the turn. The modal shows the head.
  const pendingApprovals = ref<PendingApproval[]>([]);
  /** The child threads THIS thread spawned via agent_spawn — what the
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

  /** Answer the parked request directly; stale answers never send a message
   *  or start a turn. The prompt hides while the answer travels and nothing
   *  restores a copy of it: a failed send only stops hiding it, so whatever
   *  the backend said meanwhile — resolved, aborted, the next question — is
   *  what shows, and a question still waiting stays retryable. */
  async function respondUserInput(requestId: string, answers: UserInputAnswers): Promise<void> {
    const api = bridge();
    if (!api) return;
    answeringUserInput.value = requestId;
    try {
      await api.respondUserInput(threadId.value, requestId, answers);
      // Taken, or waiting nowhere any more (a stale answer): done either way.
      if (parkedUserInput.value?.requestId === requestId) parkedUserInput.value = null;
    } catch {
      // The backend never took the answers.
    } finally {
      if (answeringUserInput.value === requestId) answeringUserInput.value = null;
    }
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
    parkedUserInput,
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
