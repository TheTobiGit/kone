import { getConversationStore } from "./ConversationStore.js";
import { createHandoffThread } from "./handoff.js";
import type {
  ForkContext,
  ForkThreadAtTurnInput,
  ForkThreadAtTurnResult,
  NativeForkTarget,
  StoredBlock,
  StoredThread,
  ThreadLineage,
} from "./types.js";
import { nonBlank } from "./types.js";

// Fork a thread from any finished run at a chosen turn.
//
// This is the portable, conversation-only counterpart to a file revert: where
// a revert restores the working tree to before turn N (and would touch every
// later turn's work), a fork-at-turn leaves the source untouched and continues
// the conversation from the end of turn N in a new thread. It accepts the same
// target shape a rewind names — { sourceThreadId, turnId, userBlockId } — so a
// refusal that cannot safely restore files can hand its target straight here.
//
// The mechanics are the branch continuation (handoff.ts): the source's history
// through the chosen turn's last block is imported as `fork-import` rows and
// the new session continues from it. No provider session is started here — the
// renderer's first send chooses provider/model, with the source's own stored
// provider/model as the placeholder until then.

/** The block a fork-at-turn cuts through: the chosen turn's LAST assistant
 *  block (the run's end), or the prompt block when the turn never produced an
 *  answer block (a failed or cancelled run). Null when neither is part of the
 *  source. */
export function resolveTurnCutBlock(
  blocks: readonly StoredBlock[],
  turnId: string,
  userBlockId: string | null,
): string | null {
  let cut: string | null = null;
  for (const block of blocks) {
    if (block.role === "assistant" && block.turnId === turnId) cut = block.id;
  }
  if (cut) return cut;
  if (userBlockId && blocks.some((block) => block.id === userBlockId)) return userBlockId;
  return null;
}

/** Whether the source still has a turn running — a fork must not take a
 *  snapshot of work in flight. */
export function sourceThreadRunning(blocks: readonly StoredBlock[]): boolean {
  return blocks.some((block) => block.role === "assistant" && block.state === "running");
}

/**
 * Fork a thread from a finished turn. Throws on an unknown source, a running
 * source, a turn stamped rolled back, or a turn that is not part of the
 * source. The new thread is written but not started; its provider/model are a
 * placeholder the first send may replace.
 */
export function forkThreadAtTurn(input: ForkThreadAtTurnInput): ForkThreadAtTurnResult {
  const store = getConversationStore();
  const source = store.loadThread(input.sourceThreadId);
  if (!source) throw new Error(`Fork source thread not found: ${input.sourceThreadId}`);
  if (sourceThreadRunning(source.blocks)) {
    throw new Error("This thread is still running. Wait for it to finish before forking from it.");
  }
  if (store.isTurnRolledBack(input.sourceThreadId, input.turnId)) {
    throw new Error("That turn was rolled back. Fork from a turn that still stands.");
  }
  const throughBlockId = resolveTurnCutBlock(source.blocks, input.turnId, input.userBlockId);
  if (!throughBlockId) {
    throw new Error(`That turn is not part of this conversation: ${input.turnId}`);
  }
  // A native fork when the provider supports it and the source has a native
  // conversation: the first session asks the provider to fork instead of
  // replaying imported history. Otherwise the portable branch import.
  const nativeFork = nativeForkTarget(store, source, input);
  if (nativeFork) return writeNativeForkThread(store, source, input, throughBlockId, nativeFork);
  // The placeholder target: the source's own provider/model, so the fork opens
  // where the work was. It is not a commitment — the first send may choose a
  // different provider/model while the fork has no session or conversation.
  const target = input.target ? { ...input.target } : { provider: source.provider };
  if (!input.target && source.model) target.model = source.model;
  const handoff: Parameters<typeof createHandoffThread>[0] = {
    requestId: input.requestId,
    threadId: input.threadId,
    sourceThreadId: input.sourceThreadId,
    kind: "branch",
    throughBlockId,
    target,
  };
  if (input.title) handoff.title = input.title;
  return createHandoffThread(handoff);
}

/** The native fork target for this source and turn, or null when the provider
 *  cannot fork natively, the source has no native conversation, or (Claude) the
 *  turn recorded no assistant uuid. */
function nativeForkTarget(
  store: ReturnType<typeof getConversationStore>,
  source: StoredThread,
  input: ForkThreadAtTurnInput,
): NativeForkTarget | null {
  if (!input.supportsFork) return null;
  const conversationId = store.threadMeta(input.sourceThreadId)?.conversationId;
  if (!conversationId) return null;
  if (source.provider === "claudeAgent") {
    const assistantUuid = store.turnAssistantUuid(input.sourceThreadId, input.turnId);
    return assistantUuid ? { conversationId, assistantUuid } : null;
  }
  // Codex's turn id IS its native turn id, so fork at the chosen turn by
  // lastTurnId. Other providers do not advertise supportsFork.
  return { conversationId, beforeTurnId: input.turnId };
}

/** Write a native fork's thread row: no imported blocks, a fork context
 *  carrying the native fork target, bootstrap already complete (there is
 *  nothing to replay). The first session start performs the fork. */
function writeNativeForkThread(
  store: ReturnType<typeof getConversationStore>,
  source: StoredThread,
  input: ForkThreadAtTurnInput,
  throughBlockId: string,
  nativeFork: NativeForkTarget,
): ForkThreadAtTurnResult {
  const existing = store.threadMeta(input.threadId);
  if (existing) {
    const existsResult: ForkThreadAtTurnResult = {
      requestId: input.requestId,
      threadId: input.threadId,
      sourceThreadId: input.sourceThreadId,
      provider: existing.provider,
      status: "exists",
    };
    if (existing.model) existsResult.model = existing.model;
    return existsResult;
  }
  const bound = store.threadIdForRequestId(input.requestId);
  if (bound) {
    throw new Error(
      `Idempotency conflict: requestId "${input.requestId}" is already bound to thread "${bound}"`,
    );
  }
  const target = input.target ? { ...input.target } : { provider: source.provider };
  if (!input.target && source.model) target.model = source.model;
  const createdAt = Date.now();
  const forkContext: ForkContext = {
    sourceThreadId: input.sourceThreadId,
    forkPointBlockId: throughBlockId,
    importedAt: createdAt,
    bootstrapStatus: "completed",
    forkKind: "branch",
    sourceProvider: source.provider,
    nativeFork,
  };
  if (source.model) forkContext.sourceModel = source.model;
  const lineage: ThreadLineage = {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: input.threadId,
  };
  const write: Parameters<typeof store.writeForkThread>[0] = {
    threadId: input.threadId,
    projectPath: source.projectPath,
    provider: target.provider,
    createdAt,
    sourceThreadId: input.sourceThreadId,
    forkContext,
    lineage,
    requestId: input.requestId,
    importedBlocks: [],
    branch: source.branch ?? null,
    envMode: source.envMode ?? null,
    worktreePath: source.worktreePath ?? null,
    requestedBranch: source.requestedBranch ?? null,
  };
  if (target.model) write.model = target.model;
  const title = nonBlank(input.title) ?? nonBlank(source.title);
  if (title) write.title = title;
  const written = store.writeForkThread(write);
  if (!written) {
    const raced = store.threadMeta(input.threadId);
    if (raced) {
      const racedResult: ForkThreadAtTurnResult = {
        requestId: input.requestId,
        threadId: input.threadId,
        sourceThreadId: input.sourceThreadId,
        provider: raced.provider,
        status: "exists",
      };
      if (raced.model) racedResult.model = raced.model;
      return racedResult;
    }
    throw new Error(`Could not persist native fork thread: ${input.threadId}`);
  }
  if (!store.carryThreadAgent(input.sourceThreadId, input.threadId)) {
    store.bindThreadAgent(input.threadId, null);
  }
  const createdResult: ForkThreadAtTurnResult = {
    requestId: input.requestId,
    threadId: input.threadId,
    sourceThreadId: input.sourceThreadId,
    provider: target.provider,
    status: "created",
  };
  if (target.model) createdResult.model = target.model;
  return createdResult;
}
