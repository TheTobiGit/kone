// useStudio — one row of the studio plane, at runtime.
//
// The studio's rows are projects and its columns are panes. This owns one row:
// an ordered list of `PaneEntry` (plain, serialisable JSON) plus the focused
// pane id, for one project. Sessions are a *runtime attachment* to an entry,
// minted by the three existing composables (useAgent / useTerminal /
// useScratchpad) and reached through thin adapters here. It never reimplements
// what those composables already do — it wraps them.
//
// The single source of truth for order within the row is `entries`. useAgent
// keeps its own internal session order for its own bookkeeping, but nothing here
// reads it: the strip renders `panes` (entries joined to their live sessions),
// so this decides where a pane sits and the composables just supply the session.
//
// Entry ↔ session matching. A session carries its own stable `key`; we record
// that on `sessionKeyById` (a runtime-only map, PaneId → session key) at attach
// time. `panes` looks the key up, then the session by key. The map is NOT part
// of `PaneEntry` — the entry must stay serialisable.
//
// Every pane attaches immediately on open, exactly as the old four-watch
// reconciliation did; dormancy layers on top without changing this contract.
//
// This file is the orchestrator: options, refs, watchers and the public API.
// The row mechanics live beside it — studioAnchors + studioCluster (pure reads),
// studioReconcile (the adopt/dormant/fold pass), studioAttach (spawn + bind),
// studioPersistenceRow (serialize/sanitize/restore) — wired here over these refs.

import { computed, nextTick, ref, watch } from "vue";
import type { ComputedRef, Ref } from "vue";
import type {
  Pane,
  PaneEntry,
  PaneId,
  PaneKind,
  StudioIntent,
  StudioRow,
} from "~/types/studio";
import { paneKindMeta } from "~/utils/paneKinds";
import { isBlankThread } from "~/utils/panes";
import { anchorFor, anchorId, liveAnchor, sessionMatchesKind } from "~/utils/studioAnchors";
import { clusterRangeFor as clusterRangeForResolved } from "~/utils/studioCluster";
import type { ClusterRange } from "~/utils/studioCluster";
import { createStudioAttach } from "~/composables/studioAttach";
import {
  entrySideChatSource as entrySideChatSourceResolved,
  entryThreadId as entryThreadIdResolved,
  reconcileRow,
} from "~/composables/studioReconcile";
import {
  restoreRow,
  serializeRow,
  studioSaveSignature,
} from "~/composables/studioPersistenceRow";
import { rememberSideChatSource } from "~/composables/sideChats";
import { usePaneWidthPrefs } from "~/composables/usePaneWidthPrefs";
import type { ThreadSession, useAgent } from "~/composables/useAgent";
import type { TerminalSession, useTerminal } from "~/composables/useTerminal";
import type { ScratchpadSession, useScratchpad } from "~/composables/useScratchpad";

// The registry of live provider sessions, not one of them — and deliberately not
// called `Agent`: that name belongs to the person a thread was handed to, and a
// local alias would quietly shadow it for the whole file.
//
// Picked down to what the studio actually touches rather than taken whole. The
// studio arranges columns; it has no business reaching into a session's
// transcript, its approvals or its model, and naming the members it does use
// says so in the type instead of in a comment. It also makes the dependency
// substitutable — a test stands in the seven functions below rather than
// asserting its way past fifty it will never call.
type SessionRegistry = Pick<
  ReturnType<typeof useAgent>,
  | "sessions"
  | "pinToPane"
  | "unpinFromPane"
  | "newThreadAt"
  | "openThreadHandle"
  | "closeThread"
  | "focusThread"
>;
type Terminal = Pick<ReturnType<typeof useTerminal>, "sessions" | "spawn" | "close">;
type Scratchpad = Pick<
  ReturnType<typeof useScratchpad>,
  "sessions" | "open" | "close" | "append"
>;

export interface UseStudioOptions {
  agent: SessionRegistry;
  terminal: Terminal;
  scratchpad: Scratchpad;
  /** The project this row belongs to. A row's identity on the plane, so a
   *  serialized row can say which project it is without the caller restating
   *  what it already told the three session composables. */
  projectPath: string | (() => string);
  /** UI-only side effects the dispatcher fires but doesn't own. This runs the
   *  layout half of a cross-pane action (open/append); these finish it in the
   *  caller's world (the composer, the index-dash pulse). */
  hooks?: {
    /** Flash the target pad's index dash after a capture — today's pulsePadColumn. */
    pulsePad?: (padPaneId: PaneId) => void;
    /** Pre-fill the composer under the freshly-opened draft thread. The text is
     *  already quoted by the caller (the `> ` prefix lives at the call site). */
    setDraft?: (text: string) => void | Promise<void>;
  };
}

export type { StudioIntent } from "~/types/studio";

export interface OpenOptions {
  /** Insert to the right of this pane. Defaults to the right of the focused pane. */
  near?: PaneId;
  /** Absolute insert index (0 = left edge). Overrides `near`. */
  at?: number;
  /** Focus the pane once it's open. Default true. */
  focus?: boolean;
  /** Restore/continue a specific stored thread rather than spawning a blank one. */
  threadId?: string;
  /** The source thread id if this is a side chat. */
  sideChatSource?: string;
}

export interface RestoreOptions {
  /** Skip eager attach of the focused thread/terminal (and the boot-thread
   *  consumer) on restore. The project home opens on the working-tree overview,
   *  so spawning a stored conversation here would block git/history IPC behind a
   *  heavy openThread + agent start. Heavy panes attach when the studio surface
   *  is shown or the pane is focused. */
  deferHeavyAttach?: boolean;
}

export interface UseStudioReturn {
  entries: Ref<PaneEntry[]>;
  panes: ComputedRef<Pane[]>;
  focusedId: Ref<PaneId | null>;
  focusedPane: ComputedRef<Pane | null>;
  /** The row's single blank thread column, if any — a runtime singleton like the
   *  scratchpad, but keyed off session state rather than kind. */
  blankThreadPane: ComputedRef<Pane | null>;
  open: (kind: PaneKind, o?: OpenOptions) => Promise<PaneId>;
  close: (id: PaneId) => Promise<void>;
  focus: (id: PaneId) => void;
  focusByOffset: (delta: number) => void;
  move: (id: PaneId, delta: number) => void;
  setWidth: (id: PaneId, width: number) => void;
  setZen: (id: PaneId, zen: boolean) => void;
  /** Bind a dormant pane to a live session on demand (the focus-attaches path).
   *  Idempotent and de-duped: concurrent calls for the same pane share one spawn. */
  attach: (id: PaneId) => Promise<void>;
  /** Attach every dormant thread pane. Used when the studio surface is revealed
   *  after a deferred restore, so off-screen columns load their transcripts
   *  instead of sitting on the Opening placeholder until they're focused. */
  wakeThreadPanes: () => Promise<void>;
  /** Bring the pane hosting `threadId` to focus (the away-from-thread pill open).
   *  Every agent thread is adopted as a pane, so it always resolves to one. */
  focusThreadById: (threadId: string) => void;
  /** The one path for cross-pane actions — selection→pad, selection→new thread,
   *  copy. See StudioIntent. */
  dispatch: (intent: StudioIntent) => Promise<void>;
  /** Rebuild this project's persisted row from the live panes — order, kinds,
   *  the current backend ids (read from live sessions when attached) and widths. */
  serialize: () => StudioRow;
  /** A cheap string that changes whenever the *persisted* shape does (order,
   *  kind, backend id, width, focus) — never on a streamed token. Feed the save
   *  debounce off this, not a deep watch of `entries`. */
  saveSignature: ComputedRef<string>;
  /** Apply a persisted row on mount. Returns true when one was applied
   *  (including an intentionally empty row); false when every stored pane
   *  failed sanitising and nothing could be restored. */
  restore: (
    row: StudioRow | null,
    knownThreadIds?: ReadonlySet<string>,
    opts?: RestoreOptions,
  ) => Promise<boolean>;
}

let paneSeq = 0;
function mintPaneId(): PaneId {
  paneSeq += 1;
  return `pane-${Date.now().toString(36)}-${paneSeq.toString(36)}`;
}

export function useStudio(opts: UseStudioOptions): UseStudioReturn {
  const { agent, terminal, scratchpad } = opts;
  // What rung a pane of each kind opens at (a per-install preference, not board
  // state — an existing pane's width stays on its entry).
  const { defaultWidth } = usePaneWidthPrefs();
  const resolveProjectPath = () =>
    opts.projectPath instanceof Function ? opts.projectPath() : opts.projectPath;
  let warnedMismatch = false;

  const entries = ref<PaneEntry[]>([]);
  const focusedId = ref<PaneId | null>(null);
  // Runtime-only: PaneId → the live session's stable key. Reassigned (not
  // mutated in place) so `panes` recomputes. Never persisted.
  const sessionKeyById = ref<Record<PaneId, string>>({});

  // ── close-detaches contract ──────────────────────────────────────────────
  // close() DETACHES a thread pane: the entry and its mapping go, the session
  // stays resident for the inbox. forget (archive/delete, sweep eviction)
  // DESTROYS: the session leaves the registry, and the entry — if one still
  // claims it — goes dormant and re-attaches on demand. Adopt NEVER resurrects
  // a detached key on its own; only an explicit open() re-binds it (clearing
  // the mark through record()).
  //
  // closedThreadKeys is the tombstone set backing that contract. It is
  // deliberately a plain (non-reactive) Set: every write funnels through
  // mutate()'s trailing reconcile (close() adds, record() clears on bind) or
  // runs inside reconcile itself (prune below), and every read happens inside
  // reconcile's adopt pass — which the session watchers and mutate's trailing
  // call already re-trigger. No template or computed reads it, so making it
  // reactive would schedule nothing extra.
  const closedThreadKeys = new Set<string>();

  // Suspend the reconcile watcher while the row mutates its own state, so a
  // session it just created (which fires the watcher as it lands in a
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
    // A bind is a deliberate hosting — it cancels any earlier close of the
    // same session, so the adopt pass can't treat it as put-away.
    closedThreadKeys.delete(sessionKey);
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
          console.warn(`[studio] session/kind mismatch on pane ${entry.id} (${entry.kind}); treating as dormant`);
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

  // The blank thread is a row-level singleton, like the scratchpad — it just isn't
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

  // Live-state bindings over the pure entry/cluster cores: the default mapping
  // is the current join and sessions come from the registry, so open()'s dedup,
  // move() and insertIndexFor() read what the strip shows. Reconcile passes its
  // staged mapping to the core directly instead (see studioReconcile).
  function entryThreadId(
    e: PaneEntry,
    mapping: Record<PaneId, string> = sessionKeyById.value,
  ): string | null {
    return entryThreadIdResolved(e, agent.sessions.value, mapping);
  }

  function entrySideChatSource(e: PaneEntry): string | null {
    return entrySideChatSourceResolved(e, agent.sessions.value, sessionKeyById.value);
  }

  function clusterRangeFor(index: number, list: PaneEntry[]): ClusterRange {
    return clusterRangeForResolved(
      index,
      list,
      (e) => entryThreadId(e),
      (e) => entrySideChatSource(e),
    );
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
  // (What it syncs and why lives with the pure core in studioReconcile.) The
  // session watcher below and mutate()'s trailing call funnel through here:
  // snapshot the live registries, run the adopt/dormant/fold pass, commit only
  // when it changed. Focus fixup always applies — assigning the same id back
  // is a ref no-op.
  function reconcile(): void {
    const result = reconcileRow(
      {
        entries: entries.value,
        mapping: sessionKeyById.value,
        focusedId: focusedId.value,
        agentSessions: agent.sessions.value,
        terminalSessions: terminal.sessions.value,
        scratchpadSessions: scratchpad.sessions.value,
        closedThreadKeys,
      },
      {
        mintPaneId,
        defaultWidth,
        insertIndexFor,
        pinToPane: (key) => agent.pinToPane(key),
        unpinFromPane: (key) => agent.unpinFromPane(key),
      },
    );
    if (result.changed) {
      entries.value = result.entries;
      sessionKeyById.value = result.mapping;
    }
    focusedId.value = result.focusedId;
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
  // (Why it runs inside `mutate` lives with the controller in studioAttach.)
  // The in-flight map there de-dupes concurrent callers for one pane into a
  // single spawn; the trailing reconcile still runs once the mapping exists.
  const { attach, wakeThreadPanes } = createStudioAttach({
    agent,
    terminal,
    scratchpad,
    getEntries: () => entries.value,
    getFocusedId: () => focusedId.value,
    sessionKeyOf,
    record,
    closePane: (id) => close(id),
    mutate,
  });

  // ── open ─────────────────────────────────────────────────────────────────────
  async function open(kind: PaneKind, o: OpenOptions = {}): Promise<PaneId> {
    const meta = paneKindMeta(kind);
    const doFocus = o.focus !== false;

    // A thread is hosted by exactly one pane: opening a thread that is already
    // in the row (live, or dormant with its anchor remembering the id)
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

    // Blank-thread suppression is a studio invariant (L3), not a caller opt-in.
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
    if (kind === "thread" && anchor.kind === "thread") {
      if (o.threadId) anchor.threadId = o.threadId;
      if (o.sideChatSource) {
        anchor.sideChatSource = o.sideChatSource;
        if (o.threadId) rememberSideChatSource(o.threadId, o.sideChatSource);
      }
    }
    const entry: PaneEntry = { id, kind, anchor, width: defaultWidth(kind) };

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
      if (entry.kind === "thread") {
        // Detach, don't destroy. The session stays resident: the same thread
        // may still be read in the inbox (both surfaces share the registry),
        // and tearing it down here is what killed the surviving twin — whose
        // re-attach then read as a spawned "new" pane. Teardown is forget's
        // job (archive/delete), which evicts explicitly. The tombstone keeps
        // the adopt pass from resurrecting the column; an explicit open()
        // re-binds it. Unpin only when no surviving pane is still bound to the
        // key, so a twin that stays on screen keeps its sweep protection.
        // Closing the last pane leaves the row empty — nothing is respawned to
        // fill it, and an empty row is not a row: the studio shows the chooser
        // over it, which is the way back.
        if (sk) {
          closedThreadKeys.add(sk);
          if (!entries.value.some((e) => sessionKeyOf(e.id) === sk)) {
            agent.unpinFromPane(sk);
          }
        }
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
    if (delta === 0) return;
    const list = [...entries.value];
    const i = list.findIndex((e) => e.id === id);
    if (i === -1) return;

    const range = clusterRangeFor(i, list);
    const clusterLen = range.end - range.start + 1;

    if (clusterLen === 1) {
      if (delta > 0 && i < list.length - 1) {
        const nextRange = clusterRangeFor(i + 1, list);
        const [e] = list.splice(i, 1);
        if (e) list.splice(nextRange.end, 0, e);
      } else if (delta < 0 && i > 0) {
        const prevRange = clusterRangeFor(i - 1, list);
        const [e] = list.splice(i, 1);
        if (e) list.splice(prevRange.start, 0, e);
      }
      entries.value = list;
      return;
    }

    const currentEntry = list[i]!;
    const isMain = !entrySideChatSource(currentEntry);

    // Moving a side chat within sibling side chats of the same cluster
    if (!isMain && delta < 0 && i > range.start + 1) {
      const [e] = list.splice(i, 1);
      if (e) list.splice(i - 1, 0, e);
      entries.value = list;
      return;
    }
    if (!isMain && delta > 0 && i < range.end) {
      const [e] = list.splice(i, 1);
      if (e) list.splice(i + 1, 0, e);
      entries.value = list;
      return;
    }

    // Moving the whole cluster across outside panes
    if (delta > 0 && range.end < list.length - 1) {
      const nextRange = clusterRangeFor(range.end + 1, list);
      const cluster = list.splice(range.start, clusterLen);
      const insertAt = nextRange.end - clusterLen + 1;
      list.splice(insertAt, 0, ...cluster);
    } else if (delta < 0 && range.start > 0) {
      const prevRange = clusterRangeFor(range.start - 1, list);
      const cluster = list.splice(range.start, clusterLen);
      list.splice(prevRange.start, 0, ...cluster);
    }
    entries.value = list;
  }

  function setWidth(id: PaneId, width: number): void {
    const list = entries.value.map((e) => (e.id === id ? { ...e, width } : e));
    entries.value = list;
  }

  function setZen(id: PaneId, zen: boolean): void {
    const list = entries.value.map((e) =>
      e.id === id ? { ...e, zen: zen ? true : undefined } : e,
    );
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
  async function dispatch(intent: StudioIntent): Promise<void> {
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
  // (The anchor reads and row sanitising live in studioPersistenceRow; this
  // keeps the refs they run against.)
  function serialize(): StudioRow {
    return serializeRow(panes.value, focusedId.value, resolveProjectPath());
  }

  const saveSignature = computed(() => studioSaveSignature(panes.value, focusedId.value));

  async function restore(
    row: StudioRow | null,
    knownThreadIds?: ReadonlySet<string>,
    opts?: RestoreOptions,
  ): Promise<boolean> {
    return restoreRow(row, knownThreadIds, opts, {
      entries,
      mapping: sessionKeyById,
      focusedId,
      agent,
      attach,
      defaultWidth,
      mintPaneId,
      mutate,
    });
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
  /** Where a new pane lands: explicit `at`, else right of `near` (after any
   *  attached side chats), else right of the focused column (after its side
   *  chats; append when the row is bare or focus is stale). */
  function insertIndexFor(
    o: { at?: number; near?: PaneId },
    list: PaneEntry[],
  ): number {
    if (o.at !== undefined && o.at !== null && Number.isFinite(o.at)) return Math.min(Math.max(0, o.at), list.length);
    let anchorIndex: number;
    if (o.near) {
      anchorIndex = list.findIndex((e) => e.id === o.near);
      if (anchorIndex === -1) return list.length;
    } else {
      anchorIndex = focusedIndexIn(list);
      if (anchorIndex === -1) return list.length;
    }
    const range = clusterRangeFor(anchorIndex, list);
    return range.end + 1;
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
    setZen,
    attach,
    wakeThreadPanes,
    focusThreadById,
    dispatch,
    serialize,
    saveSignature,
    restore,
  };
}
