// studioAnchors — what a pane remembers about its backend, and how to read it.
//
// A pane's anchor is what lets a dormant pane re-attach to the right backend,
// and what serialize() persists. The helpers here are pure reads over the
// entry/session join: given a pane, what backend id would we persist for it,
// and does a live session's shape agree with the entry's declared kind.

import type { ThreadSession } from "~/composables/useAgent";
import type { TerminalSession } from "~/composables/useTerminal";
import type { ScratchpadSession } from "~/composables/useScratchpad";
import type { Pane, PaneAnchor, PaneKind } from "~/types/studio";

/** Does a live session's runtime shape agree with the entry's declared kind?
 *  The join assumes "the adapter that made the entry made the session", which
 *  holds today — but a restore path with dormant panes and re-attach is exactly
 *  where a mismatched pairing could slip in, and a mistyped pane is a crash
 *  (a dormant one is a state we handle). Cheap insurance: the three session
 *  types carry disjoint id fields. */
export function sessionMatchesKind(
  kind: PaneKind,
  session: ThreadSession | TerminalSession | ScratchpadSession,
): boolean {
  switch (kind) {
    case "thread":
      return "blocks" in session;
    case "terminal":
      return "terminalId" in session;
    case "scratchpad":
      return "scratchpadId" in session;
  }
}

/** The threadId worth *persisting* for a thread session. Every ThreadSession
 *  mints a client id at construction (useAgent), so even a blank slate that was
 *  never sent carries a truthy `threadId.value` — but there's no conversation in
 *  storage behind it. Persisting that phantom id is what let empty columns pile
 *  up on every relaunch: the "no threadId → nothing to restore" guards in
 *  reconcile/sanitizeRow never fired. Return null for a blank thread (no
 *  transcript, not running) so those guards drop it; a real one keeps its id. */
export function persistableThreadId(s: ThreadSession): string | null {
  return s.blocks.value.length === 0 && !s.busy.value ? null : s.threadId.value;
}

export function anchorFor(kind: PaneKind): PaneAnchor {
  switch (kind) {
    case "thread":
      return { kind: "thread", threadId: null };
    case "terminal":
      return { kind: "terminal", terminalId: null };
    case "scratchpad":
      return { kind: "scratchpad", scratchpadId: null };
  }
}

// The entry's anchor is stamped at adopt/open time; a thread adopted blank
// carries `threadId: null` even after its first turn mints a real id. So the
// persisted anchor is read from the *live session* when the pane is attached,
// falling back to the entry's stored anchor when it's dormant.
export function liveAnchor(p: Pane): PaneAnchor {
  switch (p.kind) {
    case "thread": {
      const sideSrc =
        p.session?.sideChatSource?.value ??
        (p.entry.anchor.kind === "thread" ? p.entry.anchor.sideChatSource ?? null : null);
      const anchor: PaneAnchor = {
        kind: "thread",
        // Attached → the live emptiness check (blank slates persist as null so
        // they don't resurrect); dormant → fall back to the stored anchor id.
        // A stored anchor whose kind disagrees with the pane reads as blank —
        // the same null a missing field would produce below.
        threadId:
          p.session
            ? persistableThreadId(p.session)
            : p.entry.anchor.kind === "thread"
              ? p.entry.anchor.threadId
              : null,
      };
      if (sideSrc) anchor.sideChatSource = sideSrc;
      return anchor;
    }
    case "terminal":
      // A terminal anchor is a slot marker only — the live terminalId lets a
      // dormant pane re-attach within this session, but persisting it would
      // point at a PTY that no longer exists after relaunch (L6/W6).
      return {
        kind: "terminal",
        terminalId: null,
      };
    case "scratchpad":
      return {
        kind: "scratchpad",
        scratchpadId:
          p.session?.scratchpadId ??
          (p.entry.anchor.kind === "scratchpad" ? p.entry.anchor.scratchpadId : null),
      };
  }
}

export function anchorId(a: PaneAnchor): string {
  switch (a.kind) {
    case "thread":
      return `${a.threadId ?? ""}${a.sideChatSource ? `:${a.sideChatSource}` : ""}`;
    case "terminal":
      return a.terminalId ?? "";
    case "scratchpad":
      return a.scratchpadId ?? "";
  }
}
