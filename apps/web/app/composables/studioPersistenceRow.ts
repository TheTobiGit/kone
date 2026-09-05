// studioPersistenceRow — the row's durable shape: serialize, restore, sanitize.
//
// The entry's anchor is the persisted unit (plain JSON), read off the live
// session when attached and off the stored anchor when dormant. Restoring is a
// whole-row swap: unpin what the old mapping held, install the sanitized
// entries with an empty mapping, then eagerly attach only what's cheap (the
// scratchpad) or needed to land on content (the focused pane, every stored
// thread unless the caller defers heavy attach). Everything else stays dormant
// until focused — a PTY is a process, and the column already invites the click
// that starts it.

import type { Ref } from "vue";
import type { Pane, PaneAnchor, PaneEntry, PaneId, PaneKind, StudioRow } from "~/types/studio";
import { paneKindMeta } from "~/utils/paneKinds";
import { foldThreadPanes } from "~/utils/panes";
import { anchorId, liveAnchor } from "~/utils/studioAnchors";
import { rememberSideChatSource } from "~/composables/sideChats";
import type { RestoreOptions, UseStudioOptions } from "./useStudio";

/** The strip's practical column limit — also the cap on how many panes a
 *  restored row may bring back, which bounds restore cost (each pane past the
 *  focused one attaches on demand, but they still cost DOM + a join entry). */
export const MAX_RESTORED_PANES = 8;

export interface StudioSanitizeDeps {
  defaultWidth: (kind: PaneKind) => number;
  mintPaneId: () => PaneId;
}

/** Trim a persisted row to what can be safely restored: known kinds only; a
 *  thread must remember its id (or be the one preserved blank slot); one
 *  singleton max; leftmost MAX_RESTORED_PANES. Pane ids are *carried through*
 *  (validated + de-duped) rather than re-minted, so focus and any id-keyed UI
 *  state survive a relaunch (G1) — an invalid or duplicate id falls back to a
 *  fresh mint.
 *
 *  No version check here: the version belongs to the plane, not to one row of
 *  it, and the loader gates on it before any row is handed over. */
export function sanitizeRow(
  row: StudioRow | null,
  knownThreadIds: ReadonlySet<string> | undefined,
  deps: StudioSanitizeDeps,
): PaneEntry[] {
  if (!row || !Array.isArray(row.panes)) return [];
  const seenSingleton = new Set<PaneKind>();
  const seenIds = new Set<string>();
  let keptBlankThread = false;
  const kept: PaneEntry[] = [];
  for (const raw of row.panes) {
    if (!raw || !(raw instanceof Object)) continue;
    const kind = raw.kind;
    if (kind !== "thread" && kind !== "terminal" && kind !== "scratchpad") continue;
    const rawAnchor = raw.anchor;
    if (!rawAnchor || rawAnchor.kind !== kind) continue;
    // Branch on the ANCHOR's own discriminant, not on `kind`: the two are
    // proven equal a line above, but `kind` is a variable, so comparing
    // against it narrows nothing and every field read below is off the whole
    // union. Reading rawAnchor.kind directly narrows it to the thread arm.
    let anchor: PaneAnchor = rawAnchor;
    if (rawAnchor.kind === "thread") {
      const rawThreadId = rawAnchor.threadId;
      const threadId = rawThreadId ? String(rawThreadId).trim() || null : null;
      anchor = {
        kind: "thread",
        threadId,
      };
      const rawSource = rawAnchor.sideChatSource;
      if (rawSource) {
        const sideChatSource = String(rawSource).trim();
        if (sideChatSource) anchor.sideChatSource = sideChatSource;
      }
    }
    if (anchor.kind === "thread" && anchor.threadId && anchor.sideChatSource) {
      rememberSideChatSource(anchor.threadId, anchor.sideChatSource);
    }
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
    // no list, so fall back to keeping the id rather than wiping the row.
    if (
      anchor.kind === "thread" &&
      knownThreadIds &&
      anchor.threadId &&
      !knownThreadIds.has(anchor.threadId)
    ) {
      continue;
    }
    // A layout written before one-pane-per-thread held can carry two panes
    // for the same id. The fold below keeps the leftmost and runs after the
    // phantom filter, so a dropped phantom never consumes the real pane's
    // slot — and after collection, so duplicates never consume the restore
    // cap ahead of distinct panes.
    const meta = paneKindMeta(kind);
    if (meta.singleton) {
      if (seenSingleton.has(kind)) continue;
      seenSingleton.add(kind);
    }
    const rawId = raw.id;
    const id = rawId && !seenIds.has(String(rawId)) ? String(rawId) : deps.mintPaneId();
    seenIds.add(id);
    const width =
      raw.width !== undefined && raw.width !== null && Number.isFinite(raw.width)
        ? Number(raw.width)
        : deps.defaultWidth(kind);
    const paneEntry: PaneEntry = { id, kind, anchor, width };
    if (raw.zen) {
      paneEntry.zen = true;
    }
    kept.push(paneEntry);
  }
  return foldThreadPanes(kept).slice(0, MAX_RESTORED_PANES);
}

/** Rebuild a project's persisted row from live panes — order, kinds,
 *  the current backend ids (read from live sessions when attached) and widths. */
export function serializeRow(
  panes: Pane[],
  focusedId: PaneId | null,
  projectPath: string,
): StudioRow {
  return {
    projectPath,
    panes: panes.map((p) => {
      const paneRecord: PaneEntry = {
        id: p.id,
        kind: p.kind,
        anchor: liveAnchor(p),
        width: p.entry.width,
      };
      if (p.entry.zen) {
        paneRecord.zen = true;
      }
      return paneRecord;
    }),
    focusedId,
  };
}

/** A cheap string that changes whenever the *persisted* shape does (order,
 *  kind, backend id, width, focus) — never on a streamed token. Feed the save
 *  debounce off this, not a deep watch of the entries. */
export function studioSaveSignature(panes: Pane[], focusedId: PaneId | null): string {
  return (
    panes
      .map((p) => `${p.kind}:${anchorId(liveAnchor(p))}:${p.entry.width}:${p.entry.zen ? "z" : ""}`)
      .join("|") + `#${focusedId ?? ""}`
  );
}

export interface StudioRestoreContext extends StudioSanitizeDeps {
  entries: Ref<PaneEntry[]>;
  mapping: Ref<Record<PaneId, string>>;
  focusedId: Ref<PaneId | null>;
  agent: UseStudioOptions["agent"];
  attach: (id: PaneId) => Promise<void>;
  /** The orchestrator's re-entrant mutation guard (see useStudio). */
  mutate: <T>(fn: () => Promise<T>) => Promise<T>;
}

// Returns whether a persisted row was applied. An intentionally EMPTY row
// counts as true: closing every pane is a layout the user chose. A row whose
// panes all failed sanitising (every stored thread a phantom) returns false —
// the row keeps whatever reconcile already adopted.
export async function restoreRow(
  row: StudioRow | null,
  knownThreadIds: ReadonlySet<string> | undefined,
  opts: RestoreOptions | undefined,
  ctx: StudioRestoreContext,
): Promise<boolean> {
  if (!row || !Array.isArray(row.panes)) return false;
  const sanitized = sanitizeRow(row, knownThreadIds, ctx);
  if (!sanitized.length && row.panes.length > 0) return false;
  const deferHeavy = opts?.deferHeavyAttach ?? false;

  await ctx.mutate(async () => {
    // A restore wipes the whole mapping in one shot rather than closing each
    // pane through close() — unpin whatever it held first, or a row restored
    // a second time (or over live state) leaks the old bindings into the
    // sweep's untouchable set for good.
    for (const [paneId, sk] of Object.entries(ctx.mapping.value)) {
      const prevEntry = ctx.entries.value.find((e) => e.id === paneId);
      if (prevEntry?.kind === "thread") ctx.agent.unpinFromPane(sk);
    }
    ctx.entries.value = sanitized;
    ctx.mapping.value = {};
    ctx.focusedId.value = sanitized.some((e) => e.id === row.focusedId)
      ? row.focusedId
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
    const focusedEntry = sanitized.find((e) => e.id === ctx.focusedId.value);
    if (focusedEntry && !deferHeavy) toAttach.add(focusedEntry.id);
    if (!deferHeavy) {
      for (const e of sanitized) if (e.kind === "thread") toAttach.add(e.id);
    }
    for (const id of toAttach) await ctx.attach(id);

    // G6 — dispose stray idle blank threads. useAgent still spawns one session at
    // construction; if restore attached a stored thread, openThread should have
    // evicted that idle boot, but no primitive lets us *reuse* it. Also catches
    // sessions that appear from outside the studio (launcher resume, away-pill open)
    // when they weren't claimed by a pane. Only ever a blank, idle, unclaimed
    // session — never one we just bound or that carries a turn.
    const claimed = new Set(Object.values(ctx.mapping.value));
    for (const s of ctx.agent.sessions.value) {
      if (claimed.has(s.key)) continue;
      if (s.blocks.value.length === 0 && !s.busy.value) await ctx.agent.closeThread(s.key);
    }
  });
  // A layout was applied — the caller must not run start() on top of it.
  return true;
}
