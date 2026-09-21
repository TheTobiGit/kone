import { randomUUID } from "node:crypto";

import { getConversationStore } from "./ConversationStore.js";
import type {
  ChatAttachment,
  CreateHandoffInput,
  CreateHandoffResult,
  ForkContext,
  ProviderKind,
  StoredBlock,
  StoredThread,
  ThreadLineage,
  TurnStamp,
} from "./types.js";
import { copyTurnStamp } from "./types.js";

// Thread handoff — handing a conversation to another provider/model.
//
// A handoff is an ownership transfer, not reference context: the new thread
// continues the same task on the target provider/model from the imported
// transcript. The mechanics ride the fork machinery (imported `fork-import`
// rows, a stored ForkContext with a one-shot `pending` bootstrap, first-turn
// injection in sidechat.ts), but the framing is continuation — the import is
// the conversation's real history, shown in the timeline like an edit fork's
// prefix, never hidden like a side chat's reference context.
//
// Two deliberate differences from a side chat:
//   1. The import covers the FULL transcript, including earlier `fork-import`
//      rows — a handoff of a handoff keeps the whole chain, newest-first
//      budgeting drops the oldest, never the newest.
//   2. No one-per-source rule — many handoffs may leave one source, each its
//      own continuation. The re-handoff gate below (a handoff must run a
//      native turn before it can itself be handed off) is what stops an
//      import with no new history from being re-handed forever.

export const HANDOFF_INTRO = "This conversation was handed off from another provider.";
export const HANDOFF_BOUNDARY_INSTRUCTION =
  "Continue this conversation from the transcript below. Treat it as settled history — what was actually said and done — and carry on the same task as its new owner. Answer the latest user message directly, building on that history.";

/** The message an overlong first handoff turn is rejected with. The handed
 *  history rides the first turn, so a message that leaves no room for it
 *  cannot run — the turn is rejected up front rather than silently dropping
 *  history. */
export const HANDOFF_MESSAGE_TOO_LONG =
  "This message is too long to include the handed-off conversation's history. Shorten the message and retry.";

/** The model-visible narrative of a block: the prompt for user blocks, the
 *  joined assistant_text items for assistant blocks. */
function blockText(block: StoredBlock): string {
  if (block.role === "user") return block.text;
  return block.items
    .filter((item) => item.kind === "assistant_text")
    .map((item) => item.text)
    .join(" ");
}

/** One imported transcript row, in the shape `writeForkThread` takes. */
type HandoffImportedBlock = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  attachments?: ChatAttachment[];
} & TurnStamp;

/** Every user + assistant block of the source, in arrival order — including
 *  earlier `fork-import` rows, so a handoff of a handoff keeps the whole
 *  chain. Assistant blocks are reduced to their narrative text; tool items
 *  are not imported. Ids are re-minted (randomUUID), `at` timestamps and
 *  attachments are kept. */
function buildHandoffImportedBlocks(source: StoredThread): HandoffImportedBlock[] {
  const rows: HandoffImportedBlock[] = [];
  for (const b of source.blocks) {
    if (b.role !== "user" && b.role !== "assistant") continue;
    const text = blockText(b).trim();
    if (!text) continue;
    const row: HandoffImportedBlock = { id: randomUUID(), role: b.role, text, at: b.at };
    if (b.role === "user") {
      if (b.attachments?.length) row.attachments = b.attachments;
      copyTurnStamp(b, row);
    }
    rows.push(row);
  }
  return rows;
}

/** The id of the source's last block at import time — provenance for the
 *  fork point; the import itself is never truncated. */
function forkPointOf(source: StoredThread): string | null {
  for (let i = source.blocks.length - 1; i >= 0; i -= 1) {
    const block = source.blocks[i];
    if (block) return block.id;
  }
  return null;
}

/** Whether the source thread is eligible to be handed off, and if not, why.
 *  The renderer disables the handoff control on these; the creator below
 *  enforces them. */
export function handoffEligibility(
  sourceThreadId: string,
): { ok: true } | { ok: false; reason: string } {
  const store = getConversationStore();
  const source = store.loadThread(sourceThreadId);
  if (!source) return { ok: false, reason: `Handoff source thread not found: ${sourceThreadId}` };
  if (source.forkContext?.forkKind === "side_chat") {
    return { ok: false, reason: "A side chat cannot be handed off — hand off its source thread instead" };
  }
  // Re-handoff gate: a handoff must contain at least one native turn after
  // its import before it can be handed off again — otherwise an import with
  // no new history could be re-handed forever, each copy thinner than the
  // last.
  if (source.forkContext?.forkKind === "handoff" && !store.hasNativeAssistantTurn(sourceThreadId)) {
    return { ok: false, reason: "Run at least one turn before handing this thread off again" };
  }
  if (buildHandoffImportedBlocks(source).length === 0) {
    return { ok: false, reason: "There is no conversation to hand off yet" };
  }
  return { ok: true };
}

/**
 * Hand a thread to another provider/model: a new root thread carrying the
 * source's full transcript as `fork-import` rows plus a `ForkContext` naming
 * the source and its provider. The renderer mints `threadId` and `requestId`
 * (kone owns thread ids); this resolves to `status: "created"`, or
 * `"exists"` when the same threadId was already created. Throws on
 * validation failures: unknown source, ineligible source (see
 * handoffEligibility), a target identical to the source's provider/model, or
 * the same requestId bound to a different thread (idempotency conflict).
 *
 * Does not start a session or dispatch a turn — the renderer runs the normal
 * open + first-send flow afterwards, and the bootstrap rides the first send.
 * The `thread.handoff-created` event is emitted by the IPC layer.
 */
export function createHandoffThread(input: CreateHandoffInput): CreateHandoffResult {
  const store = getConversationStore();

  if (!input.sourceThreadId || !input.threadId || !input.requestId || !input.target?.provider) {
    throw new Error("create-handoff requires requestId, threadId, sourceThreadId and target.provider");
  }

  // Natural idempotency on the minted thread id: a replay of the same
  // creation resolves as "exists" without touching anything.
  if (store.threadExists(input.threadId)) {
    return {
      requestId: input.requestId,
      threadId: input.threadId,
      sourceThreadId: input.sourceThreadId,
      provider: store.threadMeta(input.threadId)?.provider ?? input.target.provider,
      status: "exists",
    };
  }

  // Exactly-once on the request key: one requestId is bound to exactly one
  // thread. Replayed with the same threadId → the branch above; replayed
  // with a different threadId → a genuine conflict, not a retry.
  const bound = store.threadIdForRequestId(input.requestId);
  if (bound) {
    throw new Error(
      `Idempotency conflict: requestId "${input.requestId}" is already bound to thread "${bound}"`,
    );
  }

  const source = store.loadThread(input.sourceThreadId);
  if (!source) {
    throw new Error(`Handoff source thread not found: ${input.sourceThreadId}`);
  }
  const eligible = handoffEligibility(input.sourceThreadId);
  if (!eligible.ok) {
    throw new Error(eligible.reason);
  }

  // A handoff that names its own provider/model is just a duplicate — refuse
  // it rather than minting a twin the bootstrap would then re-narrate.
  const sourceModel = source.model?.trim() ? source.model : undefined;
  const targetModel =
    input.target.model ?? (input.target.provider === source.provider ? sourceModel : undefined);
  if (input.target.provider === source.provider && (targetModel ?? undefined) === sourceModel) {
    throw new Error("Select a different provider or model to hand off to");
  }

  const createdAt = Date.now();
  const forkContext: ForkContext = {
    sourceThreadId: input.sourceThreadId,
    forkPointBlockId: forkPointOf(source),
    importedAt: createdAt,
    bootstrapStatus: "pending",
    forkKind: "handoff",
    sourceProvider: source.provider,
  };
  // The source model rides the context the same way its provider does — the
  // timeline names it long after the source row may be gone. Blank means the
  // source never ran named, so nothing is written rather than an empty label.
  if (sourceModel) forkContext.sourceModel = sourceModel;
  // A handoff is a new root — no parent edge, so archive/retention subtree
  // walks treat it as independent. The back-pointer is `sourceThreadId` plus
  // the fork context, never `parentThreadId` (reserved for agent-spawned
  // children).
  const lineage: ThreadLineage = {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: input.threadId,
  };

  const forkInput: Parameters<typeof store.writeForkThread>[0] = {
    threadId: input.threadId,
    projectPath: source.projectPath,
    provider: input.target.provider,
    createdAt,
    title: input.title?.trim() || source.title?.trim() || "Conversation",
    sourceThreadId: input.sourceThreadId,
    forkContext,
    lineage,
    requestId: input.requestId,
    importedBlocks: buildHandoffImportedBlocks(source),
    // The handoff continues the same task where the source worked — branch,
    // worktree and all. The per-thread picker snapshot (effort/tier/window)
    // is deliberately NOT carried: it names the source provider's knobs in
    // the source provider's vocabulary, and the target starts on its own
    // defaults plus the chosen model.
    branch: source.branch ?? null,
    envMode: source.envMode ?? null,
    worktreePath: source.worktreePath ?? null,
    requestedBranch: source.requestedBranch ?? null,
  };
  // SAFETY: writeForkThread's model field is optional; only set it when a
  // target model resolved, so a cross-provider handoff without one falls
  // back to the provider default instead of a foreign id.
  const provider: ProviderKind = input.target.provider;
  if (targetModel) forkInput.model = targetModel;
  const written = store.writeForkThread(forkInput);
  if (!written) {
    // A concurrent duplicate (the threadExists check raced) reads as a
    // replay rather than a failure.
    if (store.threadExists(input.threadId)) {
      return {
        requestId: input.requestId,
        threadId: input.threadId,
        sourceThreadId: input.sourceThreadId,
        provider: store.threadMeta(input.threadId)?.provider ?? provider,
        status: "exists",
      };
    }
    throw new Error(`Could not persist handoff thread: ${input.threadId}`);
  }

  // A handoff carries whoever worked the source thread — a named agent or
  // guest binding alike follows the fork, write-once.
  const carried = store.carryThreadAgent(input.sourceThreadId, input.threadId);
  if (!carried) {
    store.bindThreadAgent(input.threadId, null);
  }

  const result: CreateHandoffResult = {
    requestId: input.requestId,
    threadId: input.threadId,
    sourceThreadId: input.sourceThreadId,
    provider,
    status: "created",
  };
  if (targetModel) result.model = targetModel;
  return result;
}
