// studioReconcile — keeping the row's entries in sync with sessions that come
// and go outside studio.open().
//
// The row owns entries, but sessions also arrive on their own: useAgent spawns
// its first thread at construction, opens a stored thread when a pill is
// clicked, and evicts idle background threads past its resident cap. This
// module is the pure core of that sync — no refs, no watchers. The caller
// hands in plain snapshots plus the small set of effects (id minting, width
// defaults, insert position, sweep pinning) and gets the next row back:
//
//   · ADOPT — a live session no entry claims: if a thread entry already
//     anchors its thread id (a dormant pane whose session was evicted, or a
//     restored pane for a thread opened outside the studio), re-attach that
//     pane in place — one pane per conversation, however the session arrives.
//     Otherwise append an entry for it. This is how the boot thread and
//     pill-opened threads get into the row.
//   · DORMANT — an entry whose mapped session vanished. A session disappears
//     for two reasons and only one is a close: a studio close() already removed
//     the entry (so this never sees it), while a useAgent eviction leaves the
//     conversation alive in SQLite. So drop the *mapping* only and keep the
//     entry — the pane goes dormant and re-attaches on focus. The one entry we
//     do remove is a blank thread (anchor with no threadId): it never sent, so
//     there is nothing to re-attach to.

import { persistableThreadId } from "~/utils/studioAnchors";
import { foldThreadPanes } from "~/utils/panes";
import type { PaneAnchor, PaneEntry, PaneId, PaneKind } from "~/types/studio";
import type { ThreadSession } from "~/composables/useAgent";
import type { TerminalSession } from "~/composables/useTerminal";
import type { ScratchpadSession } from "~/composables/useScratchpad";

/** The thread id an *entry* currently resolves to: its live session's id
 *  (via the runtime mapping) when attached, else its anchor's remembered id
 *  while dormant. Works on raw entries, so reconcile and open()'s in-lock
 *  dedup can read it where the panes join may not be computed yet. The
 *  mapping defaults to the live join; reconcile passes its staged copy so
 *  the id reflects uncommitted binds and unbinds within the same pass. */
export function entryThreadId(
  e: PaneEntry,
  agentSessions: readonly ThreadSession[],
  mapping: Record<PaneId, string>,
): string | null {
  if (e.kind !== "thread") return null;
  const sk = mapping[e.id];
  if (sk) {
    const s = agentSessions.find((x) => x.key === sk);
    if (s) return s.threadId.value;
  }
  return e.anchor.kind === "thread" ? e.anchor.threadId : null;
}

/** The source thread id a side-chat entry was forked from, or null if it is
 *  a root thread / non-thread pane. */
export function entrySideChatSource(
  e: PaneEntry,
  agentSessions: readonly ThreadSession[],
  mapping: Record<PaneId, string>,
): string | null {
  if (e.kind !== "thread") return null;
  const sk = mapping[e.id];
  if (sk) {
    const s = agentSessions.find((x) => x.key === sk);
    if (s?.isSideChat?.value) return s.sideChatSource?.value ?? null;
  }
  return e.anchor.kind === "thread" ? e.anchor.sideChatSource ?? null : null;
}

// Drop tombstones whose sessions left the registry (forget/sweep eviction).
// Without this a detached key would veto a future session reusing it forever;
// with it the veto lasts exactly as long as the detached session is resident.
export function pruneClosedKeys(
  closedThreadKeys: Set<string>,
  allLive: ReadonlySet<string>,
): void {
  if (closedThreadKeys.size === 0) return;
  // Deleting the visited key mid-iteration is safe for a Set iterator.
  for (const k of closedThreadKeys) {
    if (!allLive.has(k)) closedThreadKeys.delete(k);
  }
}

export interface StudioReconcileInput {
  entries: PaneEntry[];
  mapping: Record<PaneId, string>;
  focusedId: PaneId | null;
  agentSessions: readonly ThreadSession[];
  terminalSessions: readonly TerminalSession[];
  scratchpadSessions: readonly ScratchpadSession[];
  /** The row's close tombstones (see closedThreadKeys in useStudio). Mutated in
   *  place: pruned entries are deleted, so the caller's set stays current. */
  closedThreadKeys: Set<string>;
}

export interface StudioReconcileDeps {
  mintPaneId: () => PaneId;
  defaultWidth: (kind: PaneKind) => number;
  /** Where a new pane lands (right of focus/near, after side chats). Owned by
   *  the orchestrator — it needs live focus, which this pass must not own. */
  insertIndexFor: (o: { at?: number; near?: PaneId }, list: PaneEntry[]) => number;
  pinToPane: (key: string) => void;
  unpinFromPane: (key: string) => void;
}

export interface StudioReconcileResult {
  entries: PaneEntry[];
  mapping: Record<PaneId, string>;
  focusedId: PaneId | null;
  /** False when the pass changed nothing — the caller can skip committing. */
  changed: boolean;
}

export function reconcileRow(
  input: StudioReconcileInput,
  deps: StudioReconcileDeps,
): StudioReconcileResult {
  const { agentSessions, terminalSessions, scratchpadSessions, closedThreadKeys } = input;
  const allLive = new Set<string>([
    ...agentSessions.map((s) => s.key),
    ...terminalSessions.map((s) => s.key),
    ...scratchpadSessions.map((s) => s.key),
  ]);

  // A close is only a dismissal while its session is still around: once the
  // registry drops it (forget, sweep eviction) there is nothing left to
  // suppress, and holding the key would veto a future session that reuses it.
  pruneClosedKeys(closedThreadKeys, allLive);

  const threadIdOf = (e: PaneEntry, mapping: Record<PaneId, string>): string | null =>
    entryThreadId(e, agentSessions, mapping);

  const next = [...input.entries];
  const mapping = { ...input.mapping };
  let changed = false;

  // DORMANT / DROP — entries whose mapped session no longer exists. Run first
  // so dead mappings are cleared before the adopt pass checks for unmapped hosts.
  for (let i = next.length - 1; i >= 0; i--) {
    const entry = next[i]!;
    const sk = mapping[entry.id];
    if (!sk || allLive.has(sk)) continue;
    // The session is gone. Un-claim it either way.
    delete mapping[entry.id];
    changed = true;
    // The join this key held is gone too — drop the pin so a key whose
    // session was closed elsewhere (forgetThread, a dispose) can't sit in
    // the sweep's untouchable set forever.
    if (entry.kind === "thread") deps.unpinFromPane(sk);
    // A blank thread has nothing to re-attach to → remove it. Everything else
    // survives dormant (its anchor was kept fresh by syncAnchors).
    if (entry.anchor.kind === "thread" && !entry.anchor.threadId) {
      next.splice(i, 1);
    }
  }

  const claimed = new Set(Object.values(mapping));

  // ADOPT — unclaimed live sessions land to the right of the focused column,
  // same rule as open(). Several may arrive in one reconcile pass (pill opens,
  // resume); insert them in order after the focus point so they don't stack at
  // the same index and reverse.
  const toAdopt: Array<{ kind: PaneKind; key: string; anchor: PaneAnchor }> = [];
  const queueAdopt = (kind: PaneKind, key: string, anchor: PaneAnchor): void => {
    toAdopt.push({ kind, key, anchor });
  };
  for (const s of agentSessions) {
    if (claimed.has(s.key)) continue;
    // Put away by an explicit close (see closedThreadKeys): the adopt pass
    // must not resurrect the column — only an explicit open() re-binds it,
    // which clears the mark through record().
    if (closedThreadKeys.has(s.key)) continue;
    const tid = persistableThreadId(s);
    if (tid) {
      // A thread pane is the one host of its conversation. If an entry
      // already anchors this id — a dormant pane whose session was evicted,
      // or a restored pane for a thread opened outside the studio (launcher
      // resume, recent click, shell reveal) — re-attach it in place instead
      // of minting a second column for the same thread.
      const host = next.find((e) => threadIdOf(e, mapping) === tid);
      if (host) {
        if (!mapping[host.id]) {
          mapping[host.id] = s.key;
          changed = true;
          // Re-attaching a dormant pane to the thread it already hosts is
          // still a join landing — pin it the same as a fresh attach does.
          deps.pinToPane(s.key);
        }
        // A live host (or one claimed earlier in this pass) means a duplicate
        // session for an id the row already hosts — never a second pane;
        // the stray session just stays unclaimed.
        continue;
      }
    } else {
      // A blank thread session (no persistable id). If there is already a dormant
      // unmapped blank thread pane in the row (e.g. restored from persisted layout),
      // re-attach to that entry so its position and width are preserved.
      const host = next.find(
        (e) => e.kind === "thread" && threadIdOf(e, mapping) === null && !mapping[e.id],
      );
      if (host) {
        mapping[host.id] = s.key;
        changed = true;
        deps.pinToPane(s.key);
        continue;
      }
    }
    const isSide = Boolean(s.isSideChat?.value);
    const sideSrc = isSide ? s.sideChatSource?.value ?? null : null;
    const anchor: PaneAnchor = { kind: "thread", threadId: tid };
    if (sideSrc) anchor.sideChatSource = sideSrc;
    queueAdopt("thread", s.key, anchor);
  }
  for (const s of terminalSessions) {
    if (claimed.has(s.key)) continue;
    const host = next.find((e) => e.kind === "terminal" && !mapping[e.id]);
    if (host) {
      mapping[host.id] = s.key;
      changed = true;
      continue;
    }
    queueAdopt("terminal", s.key, { kind: "terminal", terminalId: s.terminalId });
  }
  for (const s of scratchpadSessions) {
    if (claimed.has(s.key)) continue;
    const host = next.find((e) => e.kind === "scratchpad" && !mapping[e.id]);
    if (host) {
      mapping[host.id] = s.key;
      changed = true;
      continue;
    }
    queueAdopt("scratchpad", s.key, { kind: "scratchpad", scratchpadId: s.scratchpadId });
  }
  if (toAdopt.length) {
    let insertAt = deps.insertIndexFor({}, next);
    for (const item of toAdopt) {
      const id = deps.mintPaneId();
      next.splice(insertAt, 0, {
        id,
        kind: item.kind,
        anchor: item.anchor,
        width: deps.defaultWidth(item.kind),
      });
      mapping[id] = item.key;
      insertAt += 1;
      changed = true;
      // Only a thread session is tracked by the agent registry's sweep, so
      // only a thread join is worth reporting up — a terminal/scratchpad
      // key would just sit unused in a set the sweep never reads it from.
      if (item.kind === "thread") deps.pinToPane(item.key);
    }
  }

  // FOLD DUPLICATES — one conversation, one pane. The adopt above and open()
  // both dedupe, but a second host can still slip in (concurrent opens racing
  // the adopt, a layout written before the law held): two entries resolving
  // to the same thread id, or two entries bound to one session key. Keep the
  // leftmost and drop the rest. The survivor inherits the dropped pane's
  // session when it has none, so it stays live; nothing here tears a session
  // down — an unbound survivor simply goes dormant and re-attaches on focus.
  // Blank slates (no id yet) are not conversations and are left alone.
  {
    // Session-key pass first: two thread entries bound to one live session
    // key converge left. The thread-id fold below exempts blanks, so without
    // this an attached blank duplicated across two panes would survive it.
    const seenKey = new Set<string>();
    const afterKey: PaneEntry[] = [];
    for (const entry of next) {
      if (entry.kind !== "thread") {
        afterKey.push(entry);
        continue;
      }
      const sk = mapping[entry.id];
      if (sk !== undefined) {
        if (seenKey.has(sk)) {
          delete mapping[entry.id];
          changed = true;
          continue;
        }
        seenKey.add(sk);
      }
      afterKey.push(entry);
    }
    // Thread-id pass: the canonical fold, resolving live ids through the
    // staged mapping so a just-bound session reads under its real id.
    const folded = foldThreadPanes(afterKey, (e) => threadIdOf(e, mapping));
    if (folded.length !== afterKey.length) {
      const keptIds = new Set<PaneId>(folded.map((e) => e.id));
      const survivorByTid = new Map<string, PaneEntry>();
      for (const e of folded) {
        if (e.kind !== "thread") continue;
        const tid = threadIdOf(e, mapping);
        if (tid !== null && tid !== "" && !survivorByTid.has(tid)) {
          survivorByTid.set(tid, e);
        }
      }
      const boundToKept = new Set<string>();
      for (const k of folded) {
        const ksk = mapping[k.id];
        if (ksk !== undefined) boundToKept.add(ksk);
      }
      for (const entry of afterKey) {
        if (keptIds.has(entry.id)) continue;
        const sk = mapping[entry.id];
        const tid = threadIdOf(entry, mapping);
        const survivor = tid !== null && tid !== "" ? survivorByTid.get(tid) : undefined;
        if (survivor && sk !== undefined && !mapping[survivor.id]) {
          mapping[survivor.id] = sk;
          boundToKept.add(sk);
        } else if (sk !== undefined && !boundToKept.has(sk)) {
          // Nobody left is bound to it — drop the pin so the sweep can see
          // the session is no longer sitting in a visible column.
          deps.unpinFromPane(sk);
        }
        if (sk !== undefined) delete mapping[entry.id];
        changed = true;
      }
      next.length = 0;
      next.push(...folded);
    } else if (afterKey.length !== next.length) {
      next.length = 0;
      next.push(...afterKey);
    }
  }

  // Focus never points at a gone pane; and the first pane to appear takes it.
  let focusedId = input.focusedId;
  if (!next.some((e) => e.id === focusedId)) {
    focusedId = next[0]?.id ?? null;
  }

  return {
    entries: changed ? next : input.entries,
    mapping: changed ? mapping : input.mapping,
    focusedId,
    changed,
  };
}
