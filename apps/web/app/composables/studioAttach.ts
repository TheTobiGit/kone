// studioAttach — binding an entry to a live session on demand.
//
// A dormant pane (restored but never focused, or evicted) has an entry and an
// anchor but no session. Attaching spawns (or re-opens) the backend session
// and records the PaneId → session-key join. The in-flight map de-dupes: two
// focuses landing on the same dormant pane in the same tick (restore's eager
// pass + a user click, say) share ONE spawn, or the pane ends up with two
// backend sessions and the loser leaks.
//
// The controller is a factory over explicit deps so the spawn/record/close
// effects stay with the orchestrator's refs. It runs *inside* `mutate` (see
// below), which is not decoration.

import type { PaneEntry, PaneId } from "~/types/studio";
import type { UseStudioOptions } from "./useStudio";

export interface StudioAttachDeps {
  agent: UseStudioOptions["agent"];
  terminal: UseStudioOptions["terminal"];
  scratchpad: UseStudioOptions["scratchpad"];
  getEntries: () => PaneEntry[];
  getFocusedId: () => PaneId | null;
  sessionKeyOf: (id: PaneId) => string | undefined;
  record: (id: PaneId, sessionKey: string) => void;
  /** The orchestrator's close — used when the backend won't open. */
  closePane: (id: PaneId) => Promise<void>;
  /** The orchestrator's re-entrant mutation guard (see useStudio). */
  mutate: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface StudioAttach {
  /** Bind a dormant pane to a live session on demand (the focus-attaches path).
   *  Idempotent and de-duped: concurrent calls for the same pane share one spawn. */
  attach: (id: PaneId) => Promise<void>;
  /** Attach every dormant thread pane. Used when the studio surface is revealed
   *  after a deferred restore, so off-screen columns load their transcripts
   *  instead of sitting on the Opening placeholder until they're focused. */
  wakeThreadPanes: () => Promise<void>;
}

export function createStudioAttach(deps: StudioAttachDeps): StudioAttach {
  const { agent, terminal, scratchpad } = deps;

  // De-duped: two focuses landing on the same dormant pane in the same tick
  // (restore's eager pass + a user click, say) must share ONE spawn, or the pane
  // ends up with two backend sessions and the loser leaks. The in-flight promise
  // is the lock; every caller awaits the same one.
  //
  // It also has to run *inside* `mutate`, and that is not decoration. Every backend
  // spawn pushes its session into the registry before its own await resolves, so the
  // reconcile watcher fires while doAttach is still mid-flight and `record()` hasn't
  // happened yet. To reconcile, that live session belongs to no pane — so it adopts
  // it, and you get a second column for the session the first column was in the
  // middle of claiming. `open()` never showed this because it already wrapped attach;
  // `focus()` on a dormant pane (click a restored terminal, or the neighbour focus
  // that `close()` hands out) did not, which is why closing one terminal and clicking
  // another conjured a third. mutate's depth counter is re-entrant, so wrapping here
  // is safe under open() too, and the trailing reconcile still runs once the mapping
  // exists.
  const inFlight = new Map<PaneId, Promise<void>>();
  function attach(id: PaneId): Promise<void> {
    if (deps.sessionKeyOf(id)) return Promise.resolve(); // already attached
    const pending = inFlight.get(id);
    if (pending) return pending;
    const p = deps.mutate(() => doAttach(id)).finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  }

  async function wakeThreadPanes(): Promise<void> {
    const focused = deps.getFocusedId();
    const ids = deps
      .getEntries()
      .filter((e) => e.kind === "thread" && !deps.sessionKeyOf(e.id))
      .map((e) => e.id);
    const ordered =
      focused && ids.includes(focused) ? [focused, ...ids.filter((id) => id !== focused)] : ids;
    for (const id of ordered) await attach(id);
  }

  async function doAttach(id: PaneId): Promise<void> {
    const entry = deps.getEntries().find((e) => e.id === id);
    if (!entry) return;
    switch (entry.kind) {
      case "thread": {
        // Hoist the id before the await: `entry.anchor` is a live object and a
        // concurrent syncAnchors could rewrite it mid-flight; the local is stable.
        const threadId = entry.anchor.kind === "thread" ? entry.anchor.threadId : null;
        try {
          if (threadId) {
            // Bind the pane to its column *before* the transcript loads. The
            // handle hands back the session key synchronously; awaiting the open
            // first is what kept a reopened conversation dormant — and so showing
            // ThreadStrip's "Opening…" — for the whole history round-trip.
            const { key, ready } = agent.openThreadHandle(threadId);
            // A rival attach may already have recorded for this pane; leave its
            // binding alone, but still see the open through.
            if (!deps.sessionKeyOf(id)) {
              deps.record(id, key);
              // The join now exists — report it up so the sweep never reaps a
              // session sitting in a visible column.
              agent.pinToPane(key);
            }
            await ready;
          } else {
            // A fresh blank thread. newThreadAt always spawns (no empty-guard)
            // and hands back the column it made, so there's no set-diff to get
            // wrong when a concurrent open moves activeKey out from under us.
            const sk = await agent.newThreadAt(agent.sessions.value.length);
            if (deps.sessionKeyOf(id)) return;
            deps.record(id, sk);
            agent.pinToPane(sk);
          }
        } catch (err) {
          // The thread wouldn't open (deleted underneath us, adapter error). Don't
          // strand a dormant pane that can never attach — close it.
          console.warn(`[studio] failed to attach thread pane ${id}; closing`, err);
          void deps.closePane(id);
          return;
        }
        break;
      }
      case "terminal": {
        const sk = await terminal.spawn();
        if (deps.sessionKeyOf(id)) return;
        deps.record(id, sk);
        break;
      }
      case "scratchpad": {
        const sk = await scratchpad.open();
        if (deps.sessionKeyOf(id)) return;
        deps.record(id, sk);
        break;
      }
    }
    // A dormant thread that just attached under focus: push the projection down
    // now that its key exists (focus() couldn't, there was no session yet).
    if (entry.kind === "thread" && deps.getFocusedId() === id) {
      const sk = deps.sessionKeyOf(id);
      if (sk) agent.focusThread(sk);
    }
  }

  return { attach, wakeThreadPanes };
}
