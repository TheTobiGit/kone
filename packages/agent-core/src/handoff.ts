import { randomUUID } from "node:crypto";

import { getConversationStore } from "./ConversationStore.js";
import type {
  CreateHandoffInput,
  CreateHandoffResult,
  ForkContext,
  ForkImportedBlock,
  HandoffCut,
  ProviderKind,
  StoredBlock,
  StoredThread,
  ThreadLineage,
} from "./types.js";
import { copyTurnStamp, isContinuationForkContext, nonBlank } from "./types.js";

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

export const BRANCH_INTRO = "This is the conversation up to the point you are continuing from.";
export const BRANCH_BOUNDARY_INSTRUCTION =
  "Continue this conversation from the transcript below. Treat it as settled history — what was actually said and done up to this point — and carry on from there. Answer the latest user message directly, building on that history. Nothing happened after the transcript ends; do not assume any later turns.";

/** The message an overlong first branch turn is rejected with. The branched
 *  history rides the first turn, so a message that leaves no room for it
 *  cannot run — the turn is rejected up front rather than silently dropping
 *  history. */
export const BRANCH_MESSAGE_TOO_LONG =
  "This message is too long to include the branched conversation's history. Shorten the message and retry.";

/** The model-visible narrative of a block: the prompt for user blocks, the
 *  joined assistant_text items for assistant blocks. */
function blockText(block: StoredBlock): string {
  if (block.role === "user") return block.text;
  return block.items
    .filter((item) => item.kind === "assistant_text")
    .map((item) => item.text)
    .join(" ");
}

/** How many tool calls a tool-only turn's transfer note names before rolling
 *  the rest into a count. */
const TRANSFER_NOTE_TOOLS = 6;
/** Total cap for the note. It rides the same budget as real prose, so a
 *  tool-heavy turn collapses to one line rather than a tool-by-tool log. */
const TRANSFER_NOTE_CHARS = 240;

function condenseTransferText(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap).trimEnd()}…` : flat;
}

/** The transferable text of one block: its narrative prose when it has any,
 *  else — for an assistant turn that ran tools and wrote nothing — a one-line
 *  note naming the tools it ran. That turn genuinely happened and changed the
 *  workspace, so it contributes the note rather than vanishing; a block with
 *  neither prose nor tool calls carried nothing worth importing and reads as
 *  null. The note is bracketed so it never reads as words anyone actually
 *  said — it is transfer metadata on an assistant row, never a user quote. */
export function transferText(block: StoredBlock): string | null {
  const prose = blockText(block).trim();
  if (prose) return prose;
  if (block.role !== "assistant") return null;
  const calls = block.items.filter((item) => item.kind === "tool_call");
  if (calls.length === 0) return null;
  const shown = calls
    .slice(0, TRANSFER_NOTE_TOOLS)
    .map((call) => {
      const target = condenseTransferText(call.text ?? "", 60);
      const name = (call.name ?? "").trim() || "tool";
      return target ? `${name}(${target})` : name;
    })
    .join(", ");
  const rest = calls.length - Math.min(calls.length, TRANSFER_NOTE_TOOLS);
  const tail = rest > 0 ? ` (+${rest} more)` : "";
  // The overflow count is the load-bearing half of a tool-heavy note, so it
  // is fitted first: the tool list gives way, never the count.
  const head = "[No written summary — tools ran: ";
  const room = Math.max(0, TRANSFER_NOTE_CHARS - head.length - tail.length - 1);
  const fitted = shown.length > room ? `${shown.slice(0, Math.max(0, room - 1)).trimEnd()}…` : shown;
  return `${head}${fitted}${tail}]`;
}

/** Every user + assistant block of the source, in arrival order — including
 *  earlier `fork-import` rows, so a handoff of a handoff keeps the whole
 *  chain. Assistant blocks contribute their narrative text, or — when a turn
 *  ran tools and wrote no prose — a one-line note naming those tools, so a
 *  silent work turn still leaves a trace; genuinely empty blocks are skipped.
 *  Tool items themselves are not imported. Ids are re-minted (randomUUID),
 *  `at` timestamps and attachments are kept.
 *
 *  With a cut the copy stops after that block, so the import ends on the
 *  reply the user chose rather than on the source's newest turn. */
function buildHandoffImportedBlocks(
  source: StoredThread,
  cut: HandoffCut,
): ForkImportedBlock[] {
  const throughBlockId = cut.kind === "branch" ? cut.throughBlockId : undefined;
  let scoped = source.blocks;
  if (throughBlockId !== undefined) {
    const idx = source.blocks.findIndex((b) => b.id === throughBlockId);
    if (idx >= 0) scoped = source.blocks.slice(0, idx + 1);
  }
  const rows: ForkImportedBlock[] = [];
  for (const b of scoped) {
    if (b.role !== "user" && b.role !== "assistant") continue;
    const text = transferText(b);
    if (!text) continue;
    const row: ForkImportedBlock = { id: randomUUID(), role: b.role, text, at: b.at };
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
  cut: HandoffCut,
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
  // The gate is about a copy with no new history being re-handed forever,
  // each one thinner than the last. A branch is not that: it names a
  // different, strictly earlier cut point every time, so the chain
  // terminates on its own and branching an un-run continuation is a real
  // request, not a duplicate.
  if (
    cut.kind === "handoff" &&
    isContinuationForkContext(source.forkContext) &&
    !store.hasNativeAssistantTurn(sourceThreadId)
  ) {
    return { ok: false, reason: "Run at least one turn before handing this thread off again" };
  }
  const throughBlockId = cut.kind === "branch" ? cut.throughBlockId : undefined;
  if (throughBlockId !== undefined && !source.blocks.some((b) => b.id === throughBlockId)) {
    return {
      ok: false,
      reason: `That message is not part of this conversation: ${throughBlockId}`,
    };
  }
  if (buildHandoffImportedBlocks(source, cut).length === 0) {
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
  const eligible = handoffEligibility(input.sourceThreadId, input);
  if (!eligible.ok) {
    throw new Error(eligible.reason);
  }

  // A handoff that names its own provider/model is just a duplicate — refuse
  // it rather than minting a twin the bootstrap would then re-narrate.
  const sourceModel = nonBlank(source.model);
  const targetModel =
    input.target.model ?? (input.target.provider === source.provider ? sourceModel : undefined);
  // Forking from a chosen reply is a different request: what changes is
  // where the conversation is taken from, so the same provider and model is
  // a legitimate target and only an untruncated handoff to identical hands
  // is the duplicate this refuses.
  if (
    input.kind === "handoff" &&
    input.target.provider === source.provider &&
    (targetModel ?? undefined) === sourceModel
  ) {
    throw new Error("Select a different provider or model to hand off to");
  }

  const throughBlockId = input.kind === "branch" ? input.throughBlockId : undefined;
  const createdAt = Date.now();
  const forkContext: ForkContext = {
    sourceThreadId: input.sourceThreadId,
    forkPointBlockId: throughBlockId ?? forkPointOf(source),
    importedAt: createdAt,
    bootstrapStatus: "pending",
    forkKind: input.kind,
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
    title: nonBlank(input.title) ?? nonBlank(source.title) ?? "Conversation",
    sourceThreadId: input.sourceThreadId,
    forkContext,
    lineage,
    requestId: input.requestId,
    importedBlocks: buildHandoffImportedBlocks(source, input),
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
