import type { Ref, ShallowRef } from "vue";

import type { ThreadSession } from "~/composables/useAgent";
import type { Pane } from "~/types/studio";
import { useSound } from "./useSound";

// Pane event forwarding: almost everything here relays a column's intent to
// its session or re-emits it to the row. The emitters arrive as one callbacks
// object so this never names the component's events; the overview ref and the
// info session arrive as refs, read live at call time.
export function useStripPaneActions(deps: {
  focusedId: () => string;
  overview: Ref<boolean>;
  exitOverview: (targetKey?: string) => Promise<void>;
  infoSession: ShallowRef<ThreadSession | null>;
  emits: {
    focus: (key: string) => void;
    selectColumn: (key: string) => void;
    close: (key: string) => void;
    archive: (threadId: string, key: string) => void;
    terminalWrite: (sessionKey: string, data: string) => void;
    terminalResize: (sessionKey: string, cols: number, rows: number) => void;
    terminalRestart: (sessionKey: string) => void;
  };
}) {
  const { focusedId, overview, exitOverview, infoSession, emits } = deps;
  const { cue } = useSound();

  function onColumnClick(key: string): void {
    // In overview a card is a button, not a document: clicking one always exits — even
    // the already-focused card — flying the plane back in onto it. Focus it first
    // so exitOverview lands on the right column.
    if (overview.value) {
      cue("select");
      emits.focus(key);
      emits.selectColumn(key);
      void exitOverview(key);
      return;
    }
    if (key === focusedId()) return;
    cue("select");
    emits.focus(key);
  }

  // Enter/Space select a card in overview — it's a `role="button"` there, so the
  // keyboard must activate it like any button.
  function onCardKeydown(key: string, e: KeyboardEvent): void {
    if (!overview.value) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onColumnClick(key);
    }
  }

  /** Terminal I/O is the one pair of emits that speaks in session keys rather than pane
   *  ids (useTerminal keys its registry by session), so it goes through these instead of
   *  an inline arrow: the template's `c.session` check doesn't narrow inside a closure,
   *  and re-widening it with `!` is exactly how a pane id ends up on the wire again —
   *  which silently swallows every keystroke, because useTerminal's lookup just misses. */
  function onTerminalWrite(pane: Pane, data: string): void {
    if (pane.kind !== "terminal" || !pane.session) return;
    emits.terminalWrite(pane.session.key, data);
  }
  function onTerminalResize(pane: Pane, cols: number, rows: number): void {
    if (pane.kind !== "terminal" || !pane.session) return;
    emits.terminalResize(pane.session.key, cols, rows);
  }
  function onTerminalRestart(pane: Pane): void {
    if (pane.kind !== "terminal" || !pane.session) return;
    emits.terminalRestart(pane.session.key);
  }

  function onClose(key: string): void {
    cue("collapse");
    emits.close(key);
  }

  function onArchive(c: Pane): void {
    if (c.kind !== "thread" || !c.session) return;
    cue("press");
    emits.archive(c.session.threadId.value, c.id);
  }

  // ── turn retry / resend / reload — the session's own send & open paths ───────
  // ConversationThread never touches the send path; these forward its intents to
  // the column's session, which owns send/openStored/start. `send` is the same
  // function the composer uses, so a retry lands exactly like a fresh prompt.
  function onRetryTurn(c: Pane, text: string): void {
    if (c.kind !== "thread") return;
    const s = c.session;
    if (!s || !text.trim() || s.busy.value) return;
    void s.send(text);
  }
  function onResendTurn(c: Pane, text: string): void {
    if (c.kind !== "thread") return;
    const s = c.session;
    if (!s || !text.trim() || s.busy.value) return;
    void s.send(text);
  }
  function onRetryLoad(c: Pane): void {
    if (c.kind !== "thread") return;
    const s = c.session;
    const id = anchoredThreadId(c);
    if (!s || !id) return;
    void s.openStored(id);
  }
  /** Windowed stored threads page their older history on demand — forward the
   *  thread's request to the session's loadOlder (the store read + prepend). */
  function onLoadOlder(c: Pane): void {
    if (c.kind !== "thread") return;
    const s = c.session;
    if (!s || !s.hasOlder.value) return;
    void s.loadOlder();
  }

  /** The stored conversation this pane is anchored to — null for a fresh blank
   *  column. This is the discriminator ConversationThread needs: a thread whose
   *  transcript failed to load still carries its real stored id on the anchor,
   *  while a never-sent blank column's anchor remembers none. */
  function anchoredThreadId(c: Pane): string | null {
    if (c.kind !== "thread") return null;
    const anchor = c.entry.anchor;
    return anchor.kind === "thread" ? anchor.threadId : null;
  }

  // ── thread rename ───────────────────────────────────────────────────────────
  // A thread is renamed from its info panel's Name row; the strip owns the write
  // because the column title is a live ref on the session. The new name lands
  // optimistically and reverts if the store's renameThread says no.
  async function onRename(title: string): Promise<void> {
    const s = infoSession.value;
    if (!s) return;
    const previous = s.title.value;
    s.title.value = title; // optimistic — the strip shows it immediately
    if (!import.meta.client) return;
    const api = window.koneDesktop?.agent;
    if (!api) return; // browser dev — no store to tell; the optimistic title stands
    try {
      const ok = await api.renameThread(s.threadId.value, title);
      if (ok === false) s.title.value = previous;
    } catch {
      s.title.value = previous; // bridge hiccup — never keep a title the store lost
    }
  }

  return {
    onColumnClick,
    onCardKeydown,
    onTerminalWrite,
    onTerminalResize,
    onTerminalRestart,
    onClose,
    onArchive,
    onRetryTurn,
    onResendTurn,
    onRetryLoad,
    onLoadOlder,
    anchoredThreadId,
    onRename,
  };
}
