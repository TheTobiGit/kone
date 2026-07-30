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
import type { ThreadSession, useAgent } from "~/composables/useAgent";
import type { TerminalSession, useTerminal } from "~/composables/useTerminal";
import type { ScratchpadSession, useScratchpad } from "~/composables/useScratchpad";

type Agent = ReturnType<typeof useAgent>;
type Terminal = ReturnType<typeof useTerminal>;
type Scratchpad = ReturnType<typeof useScratchpad>;

export interface UseBoardOptions {
  agent: Agent;
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
  /** Threads only: reuse the focused blank thread instead of stacking a new one
   *  — mirrors useAgent.newThread()'s "don't stack blank slates" guard, for the
   *  ⌘N / composer-from-home paths. Ignored by the seam insert (always fresh). */
  reuseBlank?: boolean;
  /** Restore/continue a specific stored thread rather than spawning a blank one. */
  threadId?: string;
}

export interface UseBoardReturn {
  entries: Ref<PaneEntry[]>;
  panes: ComputedRef<Pane[]>;
  focusedId: Ref<PaneId | null>;
  focusedPane: ComputedRef<Pane | null>;
  open: (kind: PaneKind, o?: OpenOptions) => Promise<PaneId>;
  close: (id: PaneId) => Promise<void>;
  focus: (id: PaneId) => void;
  focusByOffset: (delta: number) => void;
  move: (id: PaneId, delta: number) => void;
  setWidth: (id: PaneId, width: number) => void;
  /** Bind a dormant pane to a live session on demand (the focus-attaches path).
   *  Idempotent and de-duped: concurrent calls for the same pane share one spawn. */
  attach: (id: PaneId) => Promise<void>;
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
  /** Apply a persisted layout before `agent.start()`. Returns true when it took
   *  over the board (caller must then SKIP `agent.start()`); false for an empty /
   *  absent / threadless layout, where the caller falls back to today's boot. */
  restore: (layout: BoardLayout | null) => Promise<boolean>;
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
      return "padId" in session;
  }
}
let warnedMismatch = false;

function anchorFor(kind: PaneKind): PaneAnchor {
  switch (kind) {
    case "thread":
      return { kind: "thread", threadId: null };
    case "terminal":
      return { kind: "terminal", terminalId: null };
    case "scratchpad":
      return { kind: "scratchpad", padId: null };
  }
}

export function useBoard(opts: UseBoardOptions): UseBoardReturn {
  const { agent, terminal, scratchpad } = opts;

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
      return { id: entry.id, kind: entry.kind, entry, session } as Pane;
    });
  });

  const focusedPane = computed<Pane | null>(
    () => panes.value.find((p) => p.id === focusedId.value) ?? null,
  );

  function sessionKeyOf(id: PaneId): string | undefined {
    return sessionKeyById.value[id];
  }
  function isBlankThreadPane(pane: Pane | null): boolean {
    if (!pane || pane.kind !== "thread" || !pane.session) return false;
    return pane.session.blocks.value.length === 0 && !pane.session.busy.value;
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
  //   · ADOPT — a live session no entry claims → append an entry for it. This is
  //     how the boot thread and pill-opened threads get on the board.
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

    // ADOPT — one appended entry per unclaimed live session.
    const adopt = (kind: PaneKind, key: string, anchor: PaneAnchor): void => {
      const id = mintPaneId();
      next.push({ id, kind, anchor, width: 0 });
      mapping[id] = key;
      changed = true;
    };
    for (const s of agent.sessions.value)
      if (!claimed.has(s.key)) adopt("thread", s.key, { kind: "thread", threadId: s.threadId.value });
    for (const s of terminal.sessions.value)
      if (!claimed.has(s.key)) adopt("terminal", s.key, { kind: "terminal", terminalId: s.terminalId });
    for (const s of scratchpad.sessions.value)
      if (!claimed.has(s.key)) adopt("scratchpad", s.key, { kind: "scratchpad", padId: s.padId });

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
  const inFlight = new Map<PaneId, Promise<void>>();
  function attach(id: PaneId): Promise<void> {
    if (sessionKeyOf(id)) return Promise.resolve(); // already attached
    const pending = inFlight.get(id);
    if (pending) return pending;
    const p = doAttach(id).finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
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
            await agent.openThread(threadId);
            // Re-check: a rival attach may have recorded while we awaited.
            if (sessionKeyOf(id)) return;
            const sk = agent.sessions.value.find((s) => s.threadId.value === threadId)?.key;
            // No activeKey fallback: if the open didn't surface a session with our
            // id, recording *some* key would bind the pane to the wrong thread.
            if (sk) record(id, sk);
          } else {
            // A fresh blank thread. newThreadAt always spawns (no empty-guard);
            // diff the session set to find exactly the one it added (activeKey is
            // a projection that a concurrent open could have already moved).
            const before = new Set(agent.sessions.value.map((s) => s.key));
            await agent.newThreadAt(agent.sessions.value.length);
            if (sessionKeyOf(id)) return;
            const sk = agent.sessions.value.find((s) => !before.has(s.key))?.key;
            if (sk) record(id, sk);
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

    // Singleton kinds (the scratchpad) — never a second; focus the existing one.
    if (meta.singleton) {
      const existing = entries.value.find((e) => e.kind === kind);
      if (existing) {
        if (doFocus) focus(existing.id);
        return existing.id;
      }
    }

    // ⌘N / composer-from-home: reuse the focused blank thread rather than stack.
    if (kind === "thread" && o.reuseBlank && !o.threadId && isBlankThreadPane(focusedPane.value)) {
      const id = focusedPane.value!.id;
      if (doFocus) focus(id);
      return id;
    }

    const id = mintPaneId();
    const anchor = anchorFor(kind);
    if (kind === "thread" && o.threadId && anchor.kind === "thread") anchor.threadId = o.threadId;
    const entry: PaneEntry = { id, kind, anchor, width: 0 };

    await mutate(async () => {
      const list = [...entries.value];
      const insertAt =
        typeof o.at === "number"
          ? Math.min(Math.max(0, o.at), list.length)
          : o.near
            ? indexOf(o.near) + 1
            : focusedIndex() + 1;
      list.splice(Math.min(Math.max(0, insertAt), list.length), 0, entry);
      entries.value = list;
      await attach(id);
    });

    if (doFocus) focus(id);
    return id;
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
      // Teardown. Closing the last thread makes useAgent spawn a fresh blank one
      // (its "strip is never empty" rule); reconcile then adopts that as a new
      // pane — matching today's behaviour exactly.
      if (entry.kind === "thread") {
        if (sk) await agent.closeThread(sk);
      } else if (entry.kind === "terminal") {
        if (sk) await terminal.close(sk);
      } else {
        if (sk) await scratchpad.close(sk);
      }
    });

    // If the board is somehow left with nothing, open a thread — the board is
    // never empty. (useAgent's respawn usually covers the last-thread case.)
    if (entries.value.length === 0) await open("thread");
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
          threadId: p.session?.threadId.value ?? (p.entry.anchor as { threadId: string | null }).threadId ?? null,
        };
      case "terminal":
        return {
          kind: "terminal",
          terminalId: p.session?.terminalId ?? (p.entry.anchor as { terminalId: string | null }).terminalId ?? null,
        };
      case "scratchpad":
        return {
          kind: "scratchpad",
          padId: p.session?.padId ?? (p.entry.anchor as { padId: string | null }).padId ?? null,
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
        return a.padId ?? "";
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
   *  thread must remember its id; one singleton max; leftmost MAX_RESTORED_PANES.
   *  Pane ids are *carried through* (validated + de-duped) rather than re-minted,
   *  so focus and any id-keyed UI state survive a relaunch (G1) — an invalid or
   *  duplicate id falls back to a fresh mint. */
  function sanitizeLayout(layout: BoardLayout | null): PaneEntry[] {
    if (!layout || layout.version !== 1 || !Array.isArray(layout.panes)) return [];
    const seenSingleton = new Set<PaneKind>();
    const seenIds = new Set<string>();
    const kept: PaneEntry[] = [];
    for (const raw of layout.panes) {
      if (!raw || typeof raw !== "object") continue;
      const kind = (raw as PaneEntry).kind;
      if (kind !== "thread" && kind !== "terminal" && kind !== "scratchpad") continue;
      const anchor = (raw as PaneEntry).anchor;
      if (!anchor || anchor.kind !== kind) continue;
      // A thread with no remembered id has nothing to restore.
      if (anchor.kind === "thread" && !anchor.threadId) continue;
      const meta = paneKindMeta(kind);
      if (meta.singleton) {
        if (seenSingleton.has(kind)) continue;
        seenSingleton.add(kind);
      }
      const rawId = (raw as PaneEntry).id;
      const id = typeof rawId === "string" && rawId && !seenIds.has(rawId) ? rawId : mintPaneId();
      seenIds.add(id);
      const width = typeof (raw as PaneEntry).width === "number" ? (raw as PaneEntry).width : 0;
      kept.push({ id, kind, anchor, width });
      if (kept.length >= MAX_RESTORED_PANES) break;
    }
    return kept;
  }

  // Returns whether the restored board ADOPTED the boot thread — i.e. whether a
  // thread pane is now resident. The caller uses that to decide about
  // agent.start():
  //   · true  → a stored thread is attached and consumed the boot session; skip
  //             start(), the board is whole.
  //   · false → either nothing to restore, or a threadless board (only terminals
  //             / a scratchpad were stored). The entries are still applied; the
  //             caller runs start(), and reconcile appends the boot thread at the
  //             END as a fresh pane.
  async function restore(layout: BoardLayout | null): Promise<boolean> {
    const sanitized = sanitizeLayout(layout);
    if (!sanitized.length) return false;
    const firstThread = sanitized.find((e) => e.kind === "thread");

    await mutate(async () => {
      entries.value = sanitized;
      sessionKeyById.value = {};
      const wantFocus = sanitized.some((e) => e.id === layout?.focusedId)
        ? (layout!.focusedId as PaneId)
        : sanitized[0]!.id;
      focusedId.value = wantFocus;

      // Attach eagerly only what's cheap or needed to land on content:
      //   · every eagerAttach kind (the scratchpad — text, no process),
      //   · the focused pane, whatever its kind (you should see content, not a
      //     dormant placeholder, on the pane you left focused),
      //   · exactly ONE thread when the focused pane isn't itself a thread, so
      //     the boot session useAgent already spawned gets consumed (openThread
      //     evicts the idle boot) instead of lingering as an extra pane.
      // Everything else — other terminals, background threads — stays dormant and
      // attaches on focus. Attaching a second stored thread here would trip
      // useAgent's open-evicts-idle-previous rule and drop the first, so we
      // deliberately keep threads to one.
      const toAttach = new Set<PaneId>();
      for (const e of sanitized) if (paneKindMeta(e.kind).eagerAttach) toAttach.add(e.id);
      const focusedEntry = sanitized.find((e) => e.id === focusedId.value);
      if (focusedEntry) toAttach.add(focusedEntry.id);
      if (firstThread && focusedEntry?.kind !== "thread") toAttach.add(firstThread.id);
      for (const id of toAttach) await attach(id);

      // G6 — claim the boot session explicitly. If we attached a stored thread,
      // openThread should have evicted the idle boot; but no primitive lets us
      // *reuse* boot (openThread always spawns, and rewriting useAgent is out of
      // scope), so dispose any leftover idle blank thread it left behind rather
      // than let reconcile adopt it as a surprise pane. Only ever a blank, idle,
      // unclaimed session — never one we just bound or that carries a turn.
      if (firstThread) {
        const claimed = new Set(Object.values(sessionKeyById.value));
        for (const s of agent.sessions.value) {
          if (claimed.has(s.key)) continue;
          if (s.blocks.value.length === 0 && !s.busy.value) await agent.closeThread(s.key);
        }
      }
    });
    // Adopted a thread only when the layout actually had one.
    return !!firstThread;
  }

  function indexOf(id: PaneId): number {
    return entries.value.findIndex((e) => e.id === id);
  }
  function focusedIndex(): number {
    // A stale focusedId (points at a pane that's since gone) resolves to the
    // right edge, same as no focus — so an insert lands at the end, never at 0.
    const i = focusedId.value ? indexOf(focusedId.value) : -1;
    return i === -1 ? entries.value.length - 1 : i;
  }

  return {
    entries,
    panes,
    focusedId,
    focusedPane,
    open,
    close,
    focus,
    focusByOffset,
    move,
    setWidth,
    attach,
    focusThreadById,
    dispatch,
    serialize,
    saveSignature,
    restore,
  };
}
