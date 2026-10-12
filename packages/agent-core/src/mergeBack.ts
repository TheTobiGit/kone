import { getConversationStore } from "./ConversationStore.js";
import type { MergeBackInput, MergeBackResult } from "./types.js";

// Merge a fork's or side chat's outcome back into its source thread.
//
// A fork is a separate conversation, so its work is invisible to the thread it
// came from until it is delivered. Merge-back writes the outcome into the
// source as an attributed summary block — a kone "system" notice naming the
// fork — so the source's timeline shows what the fork concluded without the
// fork's whole transcript. Data only: the caller (the gateway/IPC layer) emits
// the `thread.message-journaled` event that puts it on screen.

/**
 * Write a fork's/side chat's outcome into its source as a system-attributed
 * summary. Throws on an unknown source or fork, or when the fork was not forked
 * from the named source. Returns the written block so the caller can announce
 * it.
 */
export function mergeBackFork(input: MergeBackInput): MergeBackResult {
  const store = getConversationStore();
  if (!store.threadMeta(input.sourceThreadId)) {
    throw new Error(`Merge-back source thread not found: ${input.sourceThreadId}`);
  }
  const forkContext = store.threadForkContext(input.forkThreadId);
  if (!forkContext) {
    throw new Error(`Merge-back fork thread not found: ${input.forkThreadId}`);
  }
  if (forkContext.sourceThreadId !== input.sourceThreadId) {
    throw new Error(
      `Thread ${input.forkThreadId} was not forked from ${input.sourceThreadId}`,
    );
  }
  const summary =
    input.summaryText?.trim() ||
    store.latestAssistantText(input.forkThreadId) ||
    "(the fork produced no summary)";
  const text = `Merge-back from fork ${input.forkThreadId}:\n\n${summary}`;
  store.recordUserBlock({
    threadId: input.sourceThreadId,
    text,
    at: input.at ?? Date.now(),
    // A notice about the fork, not words an agent spoke: the system sender.
    sender: { kind: "system" },
  });
  const updated = store.loadThread(input.sourceThreadId);
  const block = updated?.blocks.at(-1);
  if (!block || block.role !== "user") {
    throw new Error(`Could not record merge-back for thread: ${input.sourceThreadId}`);
  }
  return { sourceThreadId: input.sourceThreadId, forkThreadId: input.forkThreadId, block };
}
