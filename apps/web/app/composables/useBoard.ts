// useBoard — the project board's runtime.
//
// The board owns the layout: an ordered list of `PaneEntry` (plain, serialisable
// JSON) plus the focused pane id. Sessions are a *runtime attachment* to an
// entry, minted by the three existing composables (useAgent / useTerminal /
// useScratchpad) and reached through thin adapters here. The board never
// reimplements what those composables already do — it wraps them.
//
// The single source of truth for strip order is `entries`. useAgent keeps its
// own internal session order for its own bookkeeping, but nothing here reads it:
// the strip renders `panes` (entries joined to their live sessions), so the
// board decides where a pane sits and the composables just supply the session.
//
// Entry ↔ session matching. A session carries its own stable `key`; we record
// that on `sessionKeyById` (a runtime-only map, PaneId → session key) at attach
// time. `panes` looks the key up, then the session by key. The map is NOT part
// of `PaneEntry` — the entry must stay serialisable.
//
// Phase 3 scope: every pane attaches immediately on open, exactly as the old
// four-watch reconciliation did. Persistence (phase 6) and dormancy (phase 7)
// layer on top without changing this contract.

import { computed, nextTick, ref, watch } from "vue";
import type { ComputedRef, Ref } from "vue";
import type {
  BoardIntent,
  BoardLayout,
  Pane,
  PaneAnchor,
  PaneEntry,
  PaneId,
  PaneKind,
} from "~/types/board";
import { paneKindMeta } from "~/utils/paneKinds";
import { isBlankThread } from "~/utils/panes";
import type { ThreadSession, useAgent } from "~/composables/useAgent";
import type { TerminalSession, useTerminal } from "~/composables/useTerminal";
import type { ScratchpadSession, useScratchpad } from "~/composables/useScratchpad";

// The registry of live provider sessions, not one of them — and deliberately not
// called `Agent`: that name belongs to the person a thread was handed to, and a
// local alias would quietly shadow it for the whole file.
type SessionRegistry = ReturnType<typeof useAgent>;
type Terminal = ReturnType<typeof useTerminal>;
type Scratchpad = ReturnType<typeof useScratchpad>;

export interface UseBoardOptions {
  agent: SessionRegistry;
  terminal: Terminal;
  scratchpad: Scratchpad;
  /** UI-only side effects the dispatcher fires but doesn't own. The board runs
   *  the layout half of a cross-pane action (open/append); these finish it in
   *  ProjectView's world (the composer, the index-dash pulse). */
  hooks?: {
    /** Flash the target pad's index dash after a capture — today's pulsePadColumn. */
    pulsePad?: (padPaneId: PaneId) => void;
    /** Pre-fill the composer under the freshly-opened draft thread. The text is
     *  already quoted by the caller (the `> ` prefix lives at the call site). */
    setDraft?: (text: string) => void | Promise<void>;
  };
}

export type { BoardIntent } from "~/types/board";

export interface OpenOptions {
  /** Insert to the right of this pane. Defaults to the right of the focused pane. */
  near?: PaneId;
  /** Absolute insert index (0 = left edge). Overrides `near`. */
  at?: number;
  /** Focus the pane once it's open. Default true. */
  focus?: boolean;
  /** Restore/continue a specific stored thread rather than spawning a blank one. */
  threadId?: string;
}

export interface RestoreOptions {
  /** Skip eager attach of the focused thread/terminal (and the boot-thread
   *  consumer) on restore. The project home opens on the working-tree overview,
   *  so spawning a stored conversation here would block git/history IPC behind a
   *  heavy openThread + agent start. Heavy panes attach when the board surface
   *  is shown or the pane is focused. */
  deferHeavyAttach?: boolean;
}

export interface UseBoardReturn {
  entries: Ref<PaneEntry[]>;
  panes: ComputedRef<Pane[]>;
  focusedId: Ref<PaneId | null>;
  focusedPane: ComputedRef<Pane | null>;
  /** The board's single blank thread column, if any — a runtime singleton like the
   *  scratchpad, but keyed off session state rather than kind. */
  blankThreadPane: ComputedRef<Pane | null>;
  open: (kind: PaneKind, o?: OpenOptions) => Promise<PaneId>;
  close: (id: PaneId) => Promise<void>;
  focus: (id: PaneId) => void;
  focusByOffset: (delta: number) => void;
  move: (id: PaneId, delta: number) => void;
  setWidth: (id: PaneId, width: number) => void;
  /** Bind a dormant pane to a live session on demand (the focus-attaches path).
   *  Idempotent and de-duped: concurrent calls for the same pane share one spawn. */
  attach: (id: PaneId) => Promise<void>;
  /** Attach every dormant thread pane. Used when the board surface is revealed
   *  after a deferred restore, so off-screen columns load their transcripts
   *  instead of sitting on the Opening placeholder until they're focused. */
  wakeThreadPanes: () => Promise<void>;
  /** Bring the pane hosting `threadId` to focus (the away-from-thread pill open).
   *  Every agent thread is adopted as a pane, so it always resolves to one. */
  focusThreadById: (threadId: string) => void;
  /** The one path for cross-pane actions — selection→pad, selection→new thread,
   *  copy. See BoardIntent. */
  dispatch: (intent: BoardIntent) => Promise<void>;
  /** Rebuild the persisted layout from the live board — pane order, kinds, the
   *  current backend ids (read from live sessions when attached) and widths. */
  serialize: () => BoardLayout;
  /** A cheap string that changes whenever the *persisted* shape does (order,
   *  kind, backend id, width, focus) — never on a streamed token. Feed the save
   *  debounce off this, not a deep watch of `entries`. */
  saveSignature: ComputedRef<string>;
  /** Apply a persisted layout on mount. Returns true when a layout was applied
   *  (including an intentionally empty desktop); false when every stored pane
   *  failed sanitising and nothing could be restored. */
  restore: (
    layout: BoardLayout | null,
    knownThreadIds?: ReadonlySet<string>,
    opts?: RestoreOptions,
  ) => Promise<boolean>;
}

/** The strip's practical column limit — also the cap on how many panes a
 *  restored layout may bring back, which bounds restore cost (each pane past the
 *  focused one attaches on demand, but they still cost DOM + a join entry). */
const MAX_RESTORED_PANES = 8;

let paneSeq = 0;
function mintPaneId(): PaneId {
  paneSeq += 1;
  return `pane-${Date.now().toString(36)}-${paneSeq.toString(36)}`;
}

/** Does a live session's runtime shape agree with the entry's declared kind?
 *  The join assumes "the adapter that made the entry made the session", which
 *  holds today — but a restore path with dormant panes and re-attach is exactly
 *  where a mismatched pairing could slip in, and a mistyped pane is a crash
 *  (a dormant one is a state we handle). Cheap insurance: the three session
 *  types carry disjoint id fields. */
function sessionMatchesKind(
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
 *  reconcile/sanitizeLayout never fired. Return null for a blank thread (no
 *  transcript, not running) so those guards drop it; a real one keeps its id. */
function persistableThreadId(s: ThreadSession): string | null {
  return s.blocks.value.length === 0 && !s.busy.value ? null : s.threadId.value;
}

  function anchorFor(kind: PaneKind): PaneAnchor {
    switch (kind) {
      case "thread":
        return { kind: "thread", threadId: null };
      case "terminal":
        return { kind: "terminal", terminalId: null };
      case "scratchpad":
        return { kind: "scratchpad", scratchpadId: null };
    }
  }

export function useBoard(opts: UseBoardOptions): UseBoardReturn {
  const { agent, terminal, scratchpad } = opts;
  let warnedMismatch = false;

  const entries = ref<PaneEntry[]>([]);
  const focusedId = ref<PaneId | null>(null);
  // Runtime-only: PaneId → the live session's stable key. Reassigned (not
  // mutated in place) so `panes` recomputes. Never persisted.
  const sessionKeyById = ref<Record<PaneId, string>>({});

  // Suspend the reconcile watcher while the board mutates its own state, so a
  // session the board just created (which fires the watcher as it lands in a
  // composable's list) isn't double-adopted before its mapping is recorded. A
  // counter, because open()/close() can nest through attach(). Only the
  // outermost mutation reconciles on the way out — an inner one returning at
  // depth 1 must not reconcile mid-outer-mutation (that's the double-adopt
  // window the guard exists to close).
  let reconcileDepth = 0;
  async function mutate<T>(fn: () => Promise<T>): Promise<T> {
    reconcileDepth += 1;
    try {
      return await fn();
    } finally {
      reconcileDepth -= 1;
      if (reconcileDepth === 0) reconcile();
    }
  }

  function record(id: PaneId, sessionKey: string): void {
    sessionKeyById.value = { ...sessionKeyById.value, [id]: sessionKey };
  }
  function drop(id: PaneId): void {
    if (!(id in sessionKeyById.value)) return;
    const { [id]: _removed, ...rest } = sessionKeyById.value;
    sessionKeyById.value = rest;
  }

  // ── the join: entries × live sessions ──────────────────────────────────────
  const panes = computed<Pane[]>(() => {
    const byKey = new Map<string, ThreadSession | TerminalSession | ScratchpadSession>();
    for (const s of agent.sessions.value) byKey.set(s.key, s);
    for (const s of terminal.sessions.value) byKey.set(s.key, s);
    for (const s of scratchpad.sessions.value) byKey.set(s.key, s);
    const mapping = sessionKeyById.value;
    return entries.value.map((entry) => {
      const sk = mapping[entry.id];
      let session = sk ? byKey.get(sk) ?? null : null;
      // The cast below assumes entry.kind and the session type agree. They do
      // when the adapter that made the entry made the session — but guard it, so
      // a bad pairing renders dormant (handled) instead of crashing on a wrong
      // .blocks/.terminalId read downstream.
      if (session && !sessionMatchesKind(entry.kind, session)) {
        if (!warnedMismatch) {
          warnedMismatch = true;
          console.warn(`[board] session/kind mismatch on pane ${entry.id} (${entry.kind}); treating as dormant`);
        }
        session = null;
      }
      // SAFETY: sessionMatchesKind above pins session's variant to entry.kind,
      // so the literal matches its Pane union arm.
      return { id: entry.id, kind: entry.kind, entry, session } as Pane;
    });
  });

  const focusedPane = computed<Pane | null>(
    () => panes.value.find((p) => p.id === focusedId.value) ?? null,
  );

  // The blank thread is a board-level singleton, like the scratchpad — it just isn't
  // declared in the kind registry because "blank" is a runtime state, not a kind.
  // Anywhere on the strip, focused or not, one empty slot is enough: a second would
  // be indistinguishable from the first and would tempt us into minting a second
  // throwaway identity. Opening a *stored* thread (o.threadId) is never suppressed
  // — that's a real conversation and gets its own column.
  const blankThreadPane = computed<Pane | null>(
    () => panes.value.find((p) => isBlankThread(p)) ?? null,
  );

  function sessionKeyOf(id: PaneId): string | undefined {
    return sessionKeyById.value[id];
  }

  /** The thread id an *entry* currently resolves to: its live session's id
   *  (via the runtime mapping) when attached, else its anchor's remembered id
   *  while dormant. Works on raw entries, so reconcile and open()'s in-lock
   *  dedup can read it where the panes join may not be computed yet. */
  function entryThreadId(e: PaneEntry): string | null {
    if (e.kind !== "thread") return null;
    const sk = sessionKeyById.value[e.id];
    if (sk) {
      const s = agent.sessions.value.find((x) => x.key === sk);
      if (s) return s.threadId.value;
    }
    return e.anchor.kind === "thread" ? e.anchor.threadId : null;
  }

  // ── anchor sync ───────────────────────────────────────────────────────────
  // A pane's anchor is what lets a dormant pane re-attach to the right backend,
  // and what serialize() persists. A thread adopted blank carries `threadId:
  // null` until its first turn mints a real id — a change that never touches the
  // session key set, so the reconcile watcher below won't see it. This watch
  // does: whenever any attached pane's live backend id changes, write it back
  // onto the entry, so the anchor is always current *before* an eviction (B)
  // strands the pane dormant.
  function syncAnchors(): void {
    let changed = false;
    const next = entries.value.map((e) => {
      if (!sessionKeyById.value[e.id]) return e;
      const p = panes.value.find((x) => x.id === e.id);
      if (!p || !p.session) return e;
      const fresh = liveAnchor(p);
      if (fresh.kind === e.anchor.kind && anchorId(fresh) === anchorId(e.anchor)) return e;
      changed = true;
      return { ...e, anchor: fresh };
    });
    if (changed) entries.value = next;
  }
  watch(
    () => panes.value.map((p) => `${p.id}=${p.session ? anchorId(liveAnchor(p)) : ""}`).join("|"),
    () => syncAnchors(),
  );

  // ── reconcile ───────────────────────────────────────────────────────────────
  // The board owns entries, but sessions also come and go outside board.open():
  // useAgent spawns its first thread at construction, opens a stored thread when
  // a pill is clicked, and evicts idle background threads past MAX_RESIDENT. This
  // keeps the two in sync.
  //
  //   · ADOPT — a live session no entry claims: if a thread entry already
  //     anchors its thread id (a dormant pane whose session was evicted, or a
  //     restored pane for a thread opened outside the board), re-attach that
  //     pane in place — one pane per conversation, however the session arrives.
  //     Otherwise append an entry for it. This is how the boot thread and
  //     pill-opened threads get on the board.
  //   · DORMANT — an entry whose mapped session vanished. A session disappears
  //     for two reasons and only one is a close: a board close() already removed
  //     the entry (so this never sees it), while a useAgent eviction leaves the
  //     conversation alive in SQLite. So drop the *mapping* only and keep the
  //     entry — the pane goes dormant and re-attaches on focus. The one entry we
  //     do remove is a blank thread (anchor with no threadId): it never sent, so
  //     there is nothing to re-attach to.
  function reconcile(): void {
    const allLive = new Set<string>([
      ...agent.sessions.value.map((s) => s.key),
      ...terminal.sessions.value.map((s) => s.key),
      ...scratchpad.sessions.value.map((s) => s.key),
    ]);

    const next = [...entries.value];
    const mapping = { ...sessionKeyById.value };
    const claimed = new Set(Object.values(mapping));
    let changed = false;

    // ADOPT — unclaimed live sessions land to the right of the focused column,
    // same rule as open(). Several may arrive in one reconcile pass (pill opens,
    // resume); insert them in order after the focus point so they don't stack at
    // the same index and reverse.
    const toAdopt: Array<{ kind: PaneKind; key: string; anchor: PaneAnchor }> = [];
    const queueAdopt = (kind: PaneKind, key: string, anchor: PaneAnchor): void => {
      toAdopt.push({ kind, key, anchor });
    };
    for (const s of agent.sessions.value) {
      if (claimed.has(s.key)) continue;
      const tid = persistableThreadId(s);
      if (tid) {
        // A thread pane is the one host of its conversation. If an entry
        // already anchors this id — a dormant pane whose session was evicted,
        // or a restored pane for a thread opened outside the board (launcher
        // resume, recent click, shell reveal) — re-attach it in place instead
        // of minting a second column for the same thread. Blank threads (no
        // persistable id) still mint, exactly as before.
        const host = entries.value.find((e) => entryThreadId(e) === tid);
        if (host) {
          if (!mapping[host.id]) {
            mapping[host.id] = s.key;
            changed = true;
          }
          // A live host (or one claimed earlier in this pass) means a duplicate
          // session for an id the board already hosts — never a second pane;
          // the stray session just stays unclaimed.
          continue;
        }
      }
      queueAdopt("thread", s.key, { kind: "thread", threadId: tid });
    }
    for (const s of terminal.sessions.value)
      if (!claimed.has(s.key))
        queueAdopt("terminal", s.key, { kind: "terminal", terminalId: s.terminalId });
    for (const s of scratchpad.sessions.value)
      if (!claimed.has(s.key))
        queueAdopt("scratchpad", s.key, { kind: "scratchpad", scratchpadId: s.scratchpadId });
    if (toAdopt.length) {
      let insertAt = insertIndexFor({}, next);
      for (const item of toAdopt) {
        const id = mintPaneId();
        next.splice(insertAt, 0, { id, kind: item.kind, anchor: item.anchor, width: 0 });
        mapping[id] = item.key;
        insertAt += 1;
        changed = true;
      }
    }

    // DORMANT / DROP — entries whose mapped session no longer exists.
    for (let i = next.length - 1; i >= 0; i--) {
      const entry = next[i]!;
      const sk = mapping[entry.id];
      if (!sk || allLive.has(sk)) continue;
      // The session is gone. Un-claim it either way.
      delete mapping[entry.id];
      changed = true;
      // A blank thread has nothing to re-attach to → remove it. Everything else
      // survives dormant (its anchor was kept fresh by syncAnchors).
      if (entry.anchor.kind === "thread" && !entry.anchor.threadId) {
        next.splice(i, 1);
      }
    }

    if (changed) {
      entries.value = next;
      sessionKeyById.value = mapping;
    }

    // Focus never points at a gone pane; and the first pane to appear takes it.
    if (!entries.value.some((e) => e.id === focusedId.value)) {
      focusedId.value = entries.value[0]?.id ?? null;
    }
  }

  // Adopt the boot thread immediately, then track every subsequent session
  // arrival/departure across the three composables.
  watch(
    () => [
      agent.sessions.value.map((s) => s.key).join("|"),
      terminal.sessions.value.map((s) => s.key).join("|"),
      scratchpad.sessions.value.map((s) => s.key).join("|"),
    ].join("§"),
    () => {
      if (reconcileDepth > 0) return;
      reconcile();
    },
    { immediate: true },
  );

  // ── attach — bind an entry to a live session ────────────────────────────────
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
    if (sessionKeyOf(id)) return Promise.resolve(); // already attached
    const pending = inFlight.get(id);
    if (pending) return pending;
    const p = mutate(() => doAttach(id)).finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  }

  async function wakeThreadPanes(): Promise<void> {
    const focused = focusedId.value;
    const ids = entries.value
      .filter((e) => e.kind === "thread" && !sessionKeyOf(e.id))
      .map((e) => e.id);
    const ordered =
      focused && ids.includes(focused) ? [focused, ...ids.filter((id) => id !== focused)] : ids;
    for (const id of ordered) await attach(id);
  }

  async function doAttach(id: PaneId): Promise<void> {
    const entry = entries.value.find((e) => e.id === id);
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
            if (!sessionKeyOf(id)) record(id, key);
            await ready;
          } else {
            // A fresh blank thread. newThreadAt always spawns (no empty-guard)
            // and hands back the column it made, so there's no set-diff to get
            // wrong when a concurrent open moves activeKey out from under us.
            const sk = await agent.newThreadAt(agent.sessions.value.length);
            if (sessionKeyOf(id)) return;
            record(id, sk);
          }
        } catch (err) {
          // The thread wouldn't open (deleted underneath us, adapter error). Don't
          // strand a dormant pane that can never attach — close it.
          console.warn(`[board] failed to attach thread pane ${id}; closing`, err);
          void close(id);
          return;
        }
        break;
      }
      case "terminal": {
        const sk = await terminal.spawn();
        if (sessionKeyOf(id)) return;
        record(id, sk);
        break;
      }
      case "scratchpad": {
        const sk = await scratchpad.open();
        if (sessionKeyOf(id)) return;
        record(id, sk);
        break;
      }
    }
    // A dormant thread that just attached under focus: push the projection down
    // now that its key exists (focus() couldn't, there was no session yet).
    if (entry.kind === "thread" && focusedId.value === id) {
      const sk = sessionKeyOf(id);
      if (sk) agent.focusThread(sk);
    }
  }

  // ── open ─────────────────────────────────────────────────────────────────────
  async function open(kind: PaneKind, o: OpenOptions = {}): Promise<PaneId> {
    const meta = paneKindMeta(kind);
    const doFocus = o.focus !== false;

    // A thread is hosted by exactly one pane: opening a thread that is already
    // on the board (live, or dormant with its anchor remembering the id)
    // focuses its pane instead of minting a second column. The side-chat join
    // path leans on this — one side chat per source thread means one pane for
    // it, however the button is reached (in-flight join, or a reopen of an
    // existing fork). This fast path reads pre-mutation state; the same check
    // runs again inside the mutate lock below, which is the race-free one.
    if (kind === "thread" && o.threadId) {
      const hosted = entries.value.find((e) => entryThreadId(e) === o.threadId);
      if (hosted) {
        if (doFocus) focus(hosted.id);
        return hosted.id;
      }
    }

    // Singleton kinds (the scratchpad) — never a second; focus the existing one.
    if (meta.singleton) {
      const existing = entries.value.find((e) => e.kind === kind);
      if (existing) {
        if (doFocus) focus(existing.id);
        return existing.id;
      }
    }

    // Blank-thread suppression is a board invariant (L3), not a caller opt-in.
    // Reuse the one blank column instead of stacking a second — including a
    // restored dormant blank slot, which we attach here so the reused pane is
    // live on return (matching the mint path's `await attach` below).
    if (kind === "thread" && !o.threadId && blankThreadPane.value) {
      const existing = blankThreadPane.value;
      if (!existing.session) await attach(existing.id);
      if (doFocus) focus(existing.id);
      return existing.id;
    }

    const id = mintPaneId();
    const anchor = anchorFor(kind);
    if (kind === "thread" && o.threadId && anchor.kind === "thread") anchor.threadId = o.threadId;
    const entry: PaneEntry = { id, kind, anchor, width: 0 };

    // The dedup checks above all read pre-mutation state — two concurrent opens
    // in the same tick can both pass them (a double click on a recent row, a
    // side-chat join racing a resume). Re-run the dedup inside the mutate lock,
    // where no other open can interleave between the read and the insert; a
    // loser folds into the winner's pane instead of minting a duplicate.
    let paneId: PaneId = id;
    await mutate(async () => {
      if (kind === "thread" && o.threadId) {
        const hosted = entries.value.find((e) => entryThreadId(e) === o.threadId);
        if (hosted) {
          paneId = hosted.id;
          return;
        }
      }
      if (meta.singleton) {
        const existing = entries.value.find((e) => e.kind === kind);
        if (existing) {
          paneId = existing.id;
          return;
        }
      }
      if (kind === "thread" && !o.threadId && blankThreadPane.value) {
        const existing = blankThreadPane.value;
        paneId = existing.id;
        if (!sessionKeyOf(existing.id)) await attach(existing.id);
        return;
      }
      const list = [...entries.value];
      const insertAt = insertIndexFor(o, list);
      list.splice(insertAt, 0, entry);
      entries.value = list;
      await attach(id);
    });

    if (doFocus) focus(paneId);
    return paneId;
  }

  // ── close ──────────────────────────────────────────────────────────────────
  async function close(id: PaneId): Promise<void> {
    const i = indexOf(id);
    if (i === -1) return;
    const entry = entries.value[i]!;
    const sk = sessionKeyOf(id);

    // Move focus to a neighbour before the entry leaves (right, else left).
    if (focusedId.value === id) {
      const neighbour = entries.value[i + 1] ?? entries.value[i - 1];
      if (neighbour) focus(neighbour.id);
    }

    await mutate(async () => {
      entries.value = entries.value.filter((e) => e.id !== id);
      drop(id);
      // Teardown. Closing the last window leaves an empty desktop — nothing is
      // respawned to fill it. ProjectView shows the chooser over a zero-pane
      // board, which is the way back.
      if (entry.kind === "thread") {
        if (sk) await agent.closeThread(sk);
      } else if (entry.kind === "terminal") {
        if (sk) await terminal.close(sk);
      } else {
        if (sk) await scratchpad.close(sk);
      }
    });
  }

  // ── focus + order ────────────────────────────────────────────────────────────
  function focus(id: PaneId): void {
    if (!entries.value.some((e) => e.id === id)) return;
    focusedId.value = id;
    const sk = sessionKeyOf(id);
    // A dormant pane (no session) attaches the moment it's focused — this is the
    // whole point of dormancy: nothing spawns until you look at it. attach() is
    // de-duped and re-projects the thread once its key lands, so we're done here.
    if (!sk) {
      void attach(id);
      return;
    }
    // Push focus down to useAgent so its active-thread projection (the composer's
    // model/mode/blocks) tracks the focused thread pane.
    const entry = entries.value.find((e) => e.id === id);
    if (entry?.kind === "thread") agent.focusThread(sk);
  }

  function focusByOffset(delta: number): void {
    if (!entries.value.length) return;
    const i = focusedIndex();
    if (i === -1) {
      focus(entries.value[0]!.id);
      return;
    }
    const j = Math.min(entries.value.length - 1, Math.max(0, i + delta));
    const next = entries.value[j];
    if (next) focus(next.id);
  }

  function move(id: PaneId, delta: number): void {
    const list = [...entries.value];
    const i = list.findIndex((e) => e.id === id);
    if (i === -1) return;
    const j = Math.min(list.length - 1, Math.max(0, i + delta));
    if (i === j) return;
    const [e] = list.splice(i, 1);
    if (!e) return;
    list.splice(j, 0, e);
    entries.value = list;
  }

  function setWidth(id: PaneId, width: number): void {
    const list = entries.value.map((e) => (e.id === id ? { ...e, width } : e));
    entries.value = list;
  }

  function focusThreadById(threadId: string): void {
    // Attached first — an open thread pane wins outright.
    const live = panes.value.find(
      (p) => p.kind === "thread" && p.session?.threadId.value === threadId,
    );
    if (live) {
      focus(live.id);
      return;
    }
    // Otherwise a dormant thread pane whose anchor remembers this id (restore
    // brings threads back dormant, so the pill target is often not yet attached).
    // focus() does the attach; we just point it there.
    const dormant = entries.value.find(
      (e) => e.kind === "thread" && e.anchor.kind === "thread" && e.anchor.threadId === threadId,
    );
    if (dormant) focus(dormant.id);
  }

  // ── dispatch — the one cross-pane action path ────────────────────────────────
  async function dispatch(intent: BoardIntent): Promise<void> {
    switch (intent.type) {
      case "copy": {
        if (!import.meta.client) return;
        try {
          await navigator.clipboard.writeText(intent.text);
        } catch {
          // clipboard blocked — swallow, same as the old onSelectionCopy.
        }
        return;
      }
      case "capture-text": {
        const trimmed = intent.text.trim();
        if (!trimmed) return;
        // The pad is a singleton: open() finds-or-creates it, without stealing
        // focus, beside the source thread. Its live session is useScratchpad's
        // only one.
        const padPaneId = await open("scratchpad", { near: intent.from, focus: false });
        // open() finds-or-creates the singleton pad but a *found* one may be
        // dormant (restored, never focused) — attach before appending, and read
        // the key off this pane's mapping, not scratchpad.sessions[0] (which is
        // empty while dormant and wrong once dormancy allows more than one).
        await attach(padPaneId);
        const padKey = sessionKeyOf(padPaneId);
        if (!padKey) return;
        await scratchpad.append(padKey, { text: trimmed });
        opts.hooks?.pulsePad?.(padPaneId);
        return;
      }
      case "draft-thread": {
        if (!intent.draft.trim()) return;
        // A fresh thread beside the source, then pre-fill its composer once the
        // pane (and thus the composer) has landed. Quoting is the caller's job.
        const id = await open("thread", { near: intent.from });
        await nextTick();
        await opts.hooks?.setDraft?.(intent.draft);
        focus(id);
        return;
      }
    }
  }

  // ── persistence: serialize + restore ─────────────────────────────────────────
  // The entry's anchor is stamped at adopt/open time; a thread adopted blank
  // carries `threadId: null` even after its first turn mints a real id. So the
  // persisted anchor is read from the *live session* when the pane is attached,
  // falling back to the entry's stored anchor when it's dormant.
  function liveAnchor(p: Pane): PaneAnchor {
    switch (p.kind) {
      case "thread":
        return {
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

  function anchorId(a: PaneAnchor): string {
    switch (a.kind) {
      case "thread":
        return a.threadId ?? "";
      case "terminal":
        return a.terminalId ?? "";
      case "scratchpad":
        return a.scratchpadId ?? "";
    }
  }

  function serialize(): BoardLayout {
    return {
      version: 1,
      panes: panes.value.map((p) => ({
        id: p.id,
        kind: p.kind,
        anchor: liveAnchor(p),
        width: p.entry.width,
      })),
      focusedId: focusedId.value,
    };
  }

  const saveSignature = computed(() =>
    panes.value
      .map((p) => `${p.kind}:${anchorId(liveAnchor(p))}:${p.entry.width}`)
      .join("|") + `#${focusedId.value ?? ""}`,
  );

  /** Trim a persisted layout to what can be safely restored: known kinds only; a
   *  thread must remember its id (or be the one preserved blank slot); one
   *  singleton max; leftmost MAX_RESTORED_PANES. Pane ids are *carried through*
   *  (validated + de-duped) rather than re-minted, so focus and any id-keyed UI
   *  state survive a relaunch (G1) — an invalid or duplicate id falls back to a
   *  fresh mint. */
  function sanitizeLayout(
    layout: BoardLayout | null,
    knownThreadIds?: ReadonlySet<string>,
  ): PaneEntry[] {
    if (!layout || layout.version !== 1 || !Array.isArray(layout.panes)) return [];
    const seenSingleton = new Set<PaneKind>();
    const seenIds = new Set<string>();
    const seenThreadIds = new Set<string>();
    let keptBlankThread = false;
    const kept: PaneEntry[] = [];
    for (const raw of layout.panes) {
      if (!raw || typeof raw !== "object") continue;
      const kind = raw.kind;
      if (kind !== "thread" && kind !== "terminal" && kind !== "scratchpad") continue;
      const anchor = raw.anchor;
      if (!anchor || anchor.kind !== kind) continue;
      // A blank thread slot (no remembered id) is preserved at most once — it
      // restores as an empty column with a composer, not a phantom conversation.
      // Positioned after the phantom filter so an unknown id is dropped, not
      // laundered into a blank slot.
      if (anchor.kind === "thread" && !anchor.threadId) {
        if (keptBlankThread) continue;
        keptBlankThread = true;
      }
      // …and a remembered id that no longer maps to a stored conversation is a
      // phantom (a blank thread persisted before this guard existed, or a thread
      // since deleted). Drop it so it can't come back as an empty column. Only
      // filter when we actually have the stored set — no bridge (nuxt dev) means
      // no list, so fall back to keeping the id rather than wiping the board.
      if (
        anchor.kind === "thread" &&
        knownThreadIds &&
        anchor.threadId &&
        !knownThreadIds.has(anchor.threadId)
      ) {
        continue;
      }
      // One conversation is hosted by exactly one pane; a layout written before
      // that law held (the duplicate-pane bug) can carry two panes for the same
      // thread id. Keep the leftmost, drop the rest — they would otherwise
      // resurrect as twin columns on every relaunch. Runs after the phantom
      // filter so a dropped phantom never consumes the slot of the real pane.
      if (anchor.kind === "thread" && anchor.threadId) {
        if (seenThreadIds.has(anchor.threadId)) continue;
        seenThreadIds.add(anchor.threadId);
      }
      const meta = paneKindMeta(kind);
      if (meta.singleton) {
        if (seenSingleton.has(kind)) continue;
        seenSingleton.add(kind);
      }
      const rawId = raw.id;
      const id = typeof rawId === "string" && rawId && !seenIds.has(rawId) ? rawId : mintPaneId();
      seenIds.add(id);
      const width = typeof raw.width === "number" ? raw.width : 0;
      kept.push({ id, kind, anchor, width });
      if (kept.length >= MAX_RESTORED_PANES) break;
    }
    return kept;
  }

  // Returns whether a persisted layout was applied. An intentionally EMPTY desktop
  // counts as true: closing every window is a layout the user chose. A layout
  // whose panes all failed sanitising (every stored thread a phantom) returns
  // false — the board keeps whatever reconcile already adopted.
  async function restore(
    layout: BoardLayout | null,
    knownThreadIds?: ReadonlySet<string>,
    opts?: RestoreOptions,
  ): Promise<boolean> {
    if (!layout || layout.version !== 1 || !Array.isArray(layout.panes)) return false;
    const sanitized = sanitizeLayout(layout, knownThreadIds);
    if (!sanitized.length && layout.panes.length > 0) return false;
    const deferHeavy = opts?.deferHeavyAttach ?? false;

    await mutate(async () => {
      entries.value = sanitized;
      sessionKeyById.value = {};
      focusedId.value = sanitized.some((e) => e.id === layout.focusedId)
        ? layout.focusedId
        : sanitized[0]?.id ?? null;

      // Attach eagerly only what's cheap or needed to land on content:
      //   · every eagerAttach kind (the scratchpad — text, no process),
      //   · the focused pane, whatever its kind (you should see content, not a
      //     dormant placeholder, on the pane you left focused) — unless
      //     `deferHeavyAttach` (project-home open: thread/terminal spawn later),
      //   · every stored thread when we're not deferring. Opening one used to
      //     evict the previous restored session (it looked like a throwaway
      //     because it hadn't sent a turn *this* session), so restore kept
      //     threads to one; that's fixed, and a saved strip should come back
      //     with every conversation already readable.
      // Other terminals stay dormant until focused — a PTY is a process, and
      // the column already invites the click that starts it.
      const toAttach = new Set<PaneId>();
      for (const e of sanitized) if (paneKindMeta(e.kind).eagerAttach) toAttach.add(e.id);
      const focusedEntry = sanitized.find((e) => e.id === focusedId.value);
      if (focusedEntry && !deferHeavy) toAttach.add(focusedEntry.id);
      if (!deferHeavy) {
        for (const e of sanitized) if (e.kind === "thread") toAttach.add(e.id);
      }
      for (const id of toAttach) await attach(id);

      // G6 — dispose stray idle blank threads. useAgent still spawns one session at
      // construction; if restore attached a stored thread, openThread should have
      // evicted that idle boot, but no primitive lets us *reuse* it. Also catches
      // sessions that appear from outside the board (launcher resume, away-pill open)
      // when they weren't claimed by a pane. Only ever a blank, idle, unclaimed
      // session — never one we just bound or that carries a turn.
      const claimed = new Set(Object.values(sessionKeyById.value));
      for (const s of agent.sessions.value) {
        if (claimed.has(s.key)) continue;
        if (s.blocks.value.length === 0 && !s.busy.value) await agent.closeThread(s.key);
      }
    });
    // A layout was applied — the caller must not run start() on top of it.
    return true;
  }

  function indexOf(id: PaneId): number {
    return entries.value.findIndex((e) => e.id === id);
  }
  function focusedIndexIn(list: PaneEntry[] = entries.value): number {
    // A stale focusedId (points at a pane that's since gone) resolves to the
    // right edge, same as no focus — so an insert lands at the end, never at 0.
    const i = focusedId.value ? list.findIndex((e) => e.id === focusedId.value) : -1;
    return i === -1 ? list.length - 1 : i;
  }
  function focusedIndex(): number {
    return focusedIndexIn();
  }
  /** Where a new pane lands: explicit `at`, else right of `near`, else right of
   *  the focused column (append when the board is bare or focus is stale). */
  function insertIndexFor(
    o: { at?: number; near?: PaneId },
    list: PaneEntry[],
  ): number {
    if (typeof o.at === "number") return Math.min(Math.max(0, o.at), list.length);
    if (o.near) {
      const i = list.findIndex((e) => e.id === o.near);
      return i === -1 ? list.length : i + 1;
    }
    return focusedIndexIn(list) + 1;
  }

  return {
    entries,
    panes,
    focusedId,
    focusedPane,
    blankThreadPane,
    open,
    close,
    focus,
    focusByOffset,
    move,
    setWidth,
    attach,
    wakeThreadPanes,
    focusThreadById,
    dispatch,
    serialize,
    saveSignature,
    restore,
  };
}
