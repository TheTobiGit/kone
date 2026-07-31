import type { Pane } from "~/types/board";
import type { ThreadSession } from "~/composables/useAgent";

/** A thread session with no transcript yet and no turn in flight — the blank
 *  slate the composer shows before the first send. Shared by the pane-level and
 *  session-level predicates so "empty" never diverges across useBoard, the strip
 *  and useAgent's resident cap. */
export function isThreadSessionBlank(s: ThreadSession): boolean {
  return s.blocks.value.length === 0 && !s.busy.value;
}

/** A thread's *identity* is its conversation — not its column, and not the
 *  client-side id it was minted with. `threadId` is populated at construction
 *  (useAgent mints a placeholder uid so the session has something to key by),
 *  so it is NOT a usable identity test: a never-run thread has a threadId that
 *  means nothing to the provider and nothing to history. What proves identity is
 *  that a turn actually happened here — a transcript block, or a turn in flight.
 *  A dormant pane whose anchor remembers a real id also counts: that's a stored
 *  conversation waiting to re-attach, not an empty slot. */
export function threadHasIdentity(pane: Pane | null): boolean {
  if (!pane || pane.kind !== "thread") return false;
  if (pane.session) return !isThreadSessionBlank(pane.session);
  const anchor = pane.entry.anchor;
  return anchor.kind === "thread" && anchor.threadId !== null;
}

/** The inverse, restricted to thread panes: a thread column that is a slot, not
 *  a conversation. A dormant (session === null) thread pane is NOT blank — it's
 *  a real stored conversation that hasn't been attached yet. That distinction is
 *  the one people get wrong. */
export function isBlankThread(pane: Pane | null): boolean {
  if (!pane || pane.kind !== "thread" || !pane.session) return false;
  return isThreadSessionBlank(pane.session);
}

/** Kind-agnostic: does removing this artifact destroy something unrecoverable?
 *  Terminals: yes — the PTY and its scrollback are gone forever. Threads with
 *  identity and the scratchpad: no — the conversation / pad content survives
 *  removal and can be reopened. */
export function isEphemeral(pane: Pane): boolean {
  return pane.kind === "terminal";
}
