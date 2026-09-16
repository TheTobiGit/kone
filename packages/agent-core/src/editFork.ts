import { getConversationStore } from "./ConversationStore.js";
import type { ForkThreadAtBlockInput, ForkThreadAtBlockResult } from "./types.js";

// Edit-and-resend of an earlier user message (docs/conversation-features-plan.md
// item 5). Editing rewrites history, so instead of mutating the source thread
// the edit forks it: blocks before the edited message are copied verbatim
// into a new thread, the edited text is journaled as that thread's newest
// user block, and the fork's first turn is dispatched from it. The source
// thread is only ever read.
//
// Forks are roots, not children: no `parent_thread_id`, no spawned-child
// relationship — archive/retention subtree walks ignore them, and the dock
// never lists them as children. What ties a fork to its source is the
// `source_thread_id` pointer plus the `fork_context_json`, which names the
// replaced block and carries the edit fork kind (so timeline and bootstrap
// reads can tell continued history apart from side-chat reference context).

/**
 * Fork `input.sourceThreadId` at `input.blockId`, replacing that message
 * with `input.editedText`, and return the fork. The renderer mints `threadId`
 * and `requestId`: replaying the same creation resolves "exists" without
 * writing twice or dispatching twice, while the same requestId bound to a
 * different thread is an idempotency conflict.
 *
 * Dispatching the fork's first turn is the caller's job (the dispatcher sends
 * it silent — the edited block is already journaled — and the one-shot
 * bootstrap hands the copied prefix to the model exactly once).
 */
export function forkThreadForEdit(input: ForkThreadAtBlockInput): ForkThreadAtBlockResult {
  const store = getConversationStore();

  if (!input.sourceThreadId || !input.threadId || !input.requestId || !input.blockId) {
    throw new Error("fork-thread-at-block requires requestId, threadId, sourceThreadId and blockId");
  }
  if (!input.editedText.trim()) {
    throw new Error("fork-thread-at-block requires a non-empty editedText");
  }

  // Natural idempotency on the minted fork id: a replay of the same creation
  // resolves as "exists" without touching anything.
  if (store.threadExists(input.threadId)) {
    return {
      requestId: input.requestId,
      threadId: input.threadId,
      sourceThreadId: input.sourceThreadId,
      status: "exists",
    };
  }

  // One requestId is bound to exactly one thread: replayed with the same
  // threadId this resolves above; replayed with a different one is a genuine
  // conflict, not a retry.
  const bound = store.threadIdForRequestId(input.requestId);
  if (bound) {
    throw new Error(
      `Idempotency conflict: requestId "${input.requestId}" is already bound to thread "${bound}"`,
    );
  }

  const forked = store.forkThreadAtBlock({
    threadId: input.threadId,
    sourceThreadId: input.sourceThreadId,
    blockId: input.blockId,
    editedText: input.editedText,
    requestId: input.requestId,
  });
  if (!forked.ok) {
    // The exists-check raced a concurrent creation: read it as a replay.
    if (forked.reason === "thread-exists" && store.threadExists(input.threadId)) {
      return {
        requestId: input.requestId,
        threadId: input.threadId,
        sourceThreadId: input.sourceThreadId,
        status: "exists",
      };
    }
    throw new Error(`Could not fork thread at block: ${forked.reason}`);
  }

  // A fork keeps whoever worked the source thread — a named agent or guest
  // binding alike follows it, write-once.
  const carried = store.carryThreadAgent(input.sourceThreadId, input.threadId);
  if (!carried) {
    store.bindThreadAgent(input.threadId, null);
  }

  return {
    requestId: input.requestId,
    threadId: input.threadId,
    sourceThreadId: input.sourceThreadId,
    status: "created",
  };
}
