import type { StoredThreadMeta } from "~/types/desktop";
import { SESSION_BRAND, type SessionSummary } from "~/types/session";
import { rememberSideChatSource } from "~/composables/sideChats";

// Shared helpers behind the Project Home and App Home "recent conversations"
// lists (useRecentSessions / useAllRecentSessions). Both draw the same rows
// from the same persisted threads and differ only in how they gather the raw
// metadata (one project vs. a fan-out over recent projects), so the flattening,
// the recency sort, the pin key and the one-time localStorage→DB pin lift live
// here rather than in two near-identical copies.

/** localStorage pin key — browser-dev fallback and the one-time migration
 *  source for installs that pinned before pins moved into the DB (v18). */
export const SESSION_PIN_KEY = "kone:pinned-sessions";

/** Extra fields the cross-project launcher list attaches to a row. */
export interface SessionProjectTag {
  projectPath?: string;
  projectName?: string;
}

/** A thread nobody has touched in this long has stopped being a thing you are
 *  going to get back to. Two weeks is long enough to cover a holiday and short
 *  enough that the inbox does not silt up. */
export const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** `doneAt` written by an explicit un-mark, as opposed to never having been set
 *  at all. Epoch zero is not a time any thread was ever marked at, so it reads
 *  as "you decided this is not done" without a second column — and it is what
 *  keeps a deliberate un-mark from being immediately overruled by age. */
export const DONE_CLEARED = 0;

/**
 * Whether you are currently finished with this thread.
 *
 * Three ways to be done with something, and the stamp only records one of them.
 *
 * You marked it, and the agent has not spoken since — the comparison is what
 * expires that mark, which is why nothing writes to `doneAt` when a turn lands,
 * and why a crash between a turn and a clear cannot strand a live thread as
 * done. Or you never said anything and it simply went quiet long enough that
 * not answering *was* the answer; that one needs no write at all, so an inbox
 * left alone for a month settles itself instead of greeting you with a month of
 * backlog. Or you said out loud that you are not finished, which outranks age —
 * otherwise the un-mark button would silently do nothing on exactly the old
 * threads someone is most likely to press it on.
 */
export function isThreadDone(meta: StoredThreadMeta, now = Date.now()): boolean {
  const at = meta.doneAt;
  const activeAt = meta.lastActivityAt ?? meta.updatedAt;
  if (at === DONE_CLEARED) return false;
  if (at === null || at === undefined) return now - activeAt > STALE_AFTER_MS;
  return at >= activeAt;
}

/**
 * Whether the agent has spoken in this thread since you last had it in front of
 * you.
 *
 * Derived from two timestamps rather than carried as a flag, and that is what
 * makes it self-correcting. A flag needs setting by whoever appends a turn and
 * clearing by whoever shows the thread — two writers over one bit, where a crash
 * between a reply and its clear leaves a thread shouting forever, and a lost set
 * leaves a reply nobody is told about. A visit time has exactly one writer, and
 * every reader compares.
 *
 * A thread never visited is not automatically unread: rows that predate the
 * stamp are backfilled to their last activity, so an absent value here means a
 * thread minted since — and one you have not looked at since it last spoke is
 * exactly what unread means.
 */
export function isThreadUnread(meta: StoredThreadMeta): boolean {
  const activeAt = meta.lastActivityAt ?? meta.updatedAt;
  const visitedAt = meta.lastVisitedAt;
  if (visitedAt === null || visitedAt === undefined) return true;
  return activeAt > visitedAt;
}

/**
 * Which thread, if any, a list should stamp as read right now.
 *
 * Three conditions, and the first is the one that is easy to lose. A list keeps
 * a selection long after anyone stopped looking at it — the inbox portal hides
 * rather than unmounts, its views are held alive, and starting a new message
 * takes the reading pane without clearing what was picked. So the surface has
 * to say whether the selected thread is actually on screen; the selection alone
 * does not know. Without that, a reply landing while the user is somewhere else
 * entirely gets marked read by a list nobody can see, and the mark it should
 * have raised is gone for good — read state is a comparison against a stamp, and
 * a stamp that moved forward cannot be un-moved.
 *
 * Then: something has to be selected, and it has to be a row this list is
 * actually showing AND currently reading as unread. That last part is what keeps
 * the stamp live rather than one-shot — a turn landing under an open thread
 * re-summarizes the row as unread, and the same check takes the mark straight
 * back off.
 */
export function threadToStampVisited(input: {
  /** The selected thread is in front of the user right now. */
  reading: boolean;
  selectedThreadId: string | null | undefined;
  rows: readonly Pick<SessionSummary, "threadId" | "unread">[];
}): string | null {
  if (!input.reading) return null;
  const open = input.selectedThreadId;
  if (!open) return null;
  return input.rows.some((row) => row.threadId === open && row.unread) ? open : null;
}

/** The visits already written this run, keyed by what they acknowledged. A
 *  surface stamps on every settle of every thread it is showing, and several
 *  surfaces can be showing the same one — without this, a strip of five columns
 *  is five identical writes per landed turn. */
const stamped = new Map<string, number>();

/**
 * Record that the user has just had this thread in front of them.
 *
 * The one write behind read state, so every surface that shows a thread says
 * "read" the same way and means the same thing by it: the inbox reader, and a
 * studio column with the thread on screen. Fire-and-forget — read state is a
 * courtesy, and a failed write costs a stale dot until the next visit, which is
 * not worth an error in front of someone who is reading something else.
 *
 * `key` names what is being acknowledged (a turn id, say). Repeating a key is a
 * no-op, which is what keeps a settle seen by five open columns from being five
 * writes. Pass nothing when the visit is the event itself.
 */
export function markThreadVisited(threadId: string, key?: string, at = Date.now()): void {
  if (key) {
    const mark = `${threadId}:${key}`;
    if (stamped.has(mark)) return;
    stamped.set(mark, at);
  }
  if (!import.meta.client) return;
  void window.koneDesktop?.agent?.history?.setVisited(threadId, at).catch(() => {});
}

/** Flatten one stored thread into the row shape the list renders. */
export function summarizeSession(
  meta: StoredThreadMeta,
  pinned: boolean,
  project?: SessionProjectTag,
): SessionSummary {
  if (meta.forkContext?.sourceThreadId) {
    rememberSideChatSource(meta.threadId, meta.forkContext.sourceThreadId);
  }
  return {
    threadId: meta.threadId,
    title: meta.title?.trim() || "Untitled session",
    provider: meta.provider,
    brand: SESSION_BRAND[meta.provider] ?? "generic",
    model: meta.model,
    branch: meta.branch ?? undefined,
    added: meta.added,
    removed: meta.removed,
    tokens: meta.tokens,
    // Recency key: last conversation activity — a background rename must not
    // reshuffle the list (updatedAt also moves for title/archive bookkeeping).
    updatedAt: meta.lastActivityAt ?? meta.updatedAt,
    pinned,
    projectPath: project?.projectPath,
    projectName: project?.projectName,
    // A side chat is a fork — forkContext presence is the discriminator.
    sideChat: Boolean(meta.forkContext),
    done: isThreadDone(meta),
    unread: isThreadUnread(meta),
    lastVisitedAt: meta.lastVisitedAt ?? undefined,
    snippet: meta.snippet,
  };
}

/** Newest first, within each group. */
export function byRecency(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt - a.updatedAt;
}

/** One-time lift of browser-localStorage pins into the DB. Returns true when
 *  every legacy pin write succeeded (or there were none), so the caller clears
 *  the localStorage key only after a full success — a failed migration retries
 *  on the next load. */
export async function liftLegacyPins(
  api: { setPinned: (threadId: string, pinned: boolean) => Promise<void> },
  legacyIds: string[],
): Promise<boolean> {
  if (legacyIds.length === 0) return true;
  const results = await Promise.all(
    legacyIds.map((id) => api.setPinned(id, true).then(() => true).catch(() => false)),
  );
  return results.every(Boolean);
}
