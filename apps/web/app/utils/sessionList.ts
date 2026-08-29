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
