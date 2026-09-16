// Where a conversation-search hit wants the thread view to land.
//
// Selecting a result opens its thread (possibly in another project) and asks
// the transcript to reveal one old row. The opener and the transcript never
// meet — the open crosses a project switch and an async history read — so the
// target waits here, keyed by thread, until the thread view showing that
// thread claims it. Anything else (a different thread opening first) leaves it
// in place; claiming is by exact thread id, so a stale target can never flash
// a stranger's transcript.

export type SearchJumpTarget = {
  threadId: string;
  blockId: string;
};

export function useSearchJumpState() {
  return useState<SearchJumpTarget | null>("kone:search-jump", () => null);
}

/** Park a reveal target for the thread about to open. */
export function requestSearchJump(threadId: string, blockId: string): void {
  useSearchJumpState().value = { threadId, blockId };
}

/** Claim the parked target when it names this thread. Consumes it, so the
 *  flash fires once — a later revisit of the same thread reads as a revisit,
 *  not a second arrival. Null unless the target names `threadId`. */
export function takeSearchJumpFor(threadId: string): SearchJumpTarget | null {
  const state = useSearchJumpState();
  const pending = state.value;
  if (!pending || pending.threadId !== threadId) return null;
  state.value = null;
  return pending;
}
