import { shallowRef, watch, type Ref } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import type { RuntimeEvent } from "~/types/desktop";
import { isThreadUnread, markThreadVisited, ROW_CHANGING_EVENTS } from "~/utils/sessionList";

/**
 * Which of a project's threads have spoken since you last had them in front of
 * you — the set behind the studio strip's unread dashes.
 *
 * What "unread" means is not decided here: `isThreadUnread` is the one
 * definition, the same one the inbox's conversation block renders, and the
 * write on the other side of it is `markThreadVisited`, which is already one
 * function every surface calls. This is only a narrower way to *read* it. The
 * lists ask for whole rows — titles, branches, diffstats, pins, token counts,
 * the recency split — because they draw them; a strip draws an 18px dash, and
 * mounting a list per row to decide its colour costs a project's full history
 * per row and a re-summarise of every one of those rows per settled turn.
 *
 * Shared per project and reference-counted, which is the other half of the
 * saving. Several rows of the plane can be looking at the same repository, and
 * the answer is a fact about the repository rather than about any one of them:
 * they hold the same set, one read fills it, and it is dropped when the last
 * one lets go. One event subscription serves all of them, for the same reason.
 */
interface ProjectUnread {
  /** How many live callers are holding this project. The entry is dropped at
   *  zero, so nothing accumulates for projects nobody is looking at. */
  holders: number;
  ids: Ref<ReadonlySet<string>>;
}

const projects = new Map<string, ProjectUnread>();

function historyApi() {
  return import.meta.client ? window.koneDesktop?.agent?.history : undefined;
}

/**
 * Re-read one project's threads and settle its unread set.
 *
 * Failure is silent and leaves the previous answer standing: an unread mark is
 * a courtesy, and the honest alternative to a stale dash is no dash at all,
 * which is a worse thing to show someone than a dash that is one turn behind.
 */
async function load(path: string): Promise<void> {
  const history = historyApi();
  if (!history) return;
  try {
    const metas = await history.list(path);
    // Re-read rather than closed over: the project may have been let go while
    // the round trip was out, and filling an entry nobody holds would put it
    // back into the map for good.
    const entry = projects.get(path);
    if (!entry) return;
    entry.ids.value = new Set(metas.filter(isThreadUnread).map((meta) => meta.threadId));
  } catch {
    // See above — a failed read costs a stale set until the next event.
  }
}

// One subscription for every project held, attached with the first and dropped
// with the last. The events do not name a project, and a turn landing anywhere
// can only have landed in one of the few being watched, so each refresh re-reads
// all of them — bounded by the rows on screen, not by the history behind them.
//
// Debounced and trailing, so a burst of events costs one read: a turn that
// starts, streams and settles is three events within a second, and all three
// say the same thing about the same row.
const REFRESH_DEBOUNCE_MS = 600;
let detachEvents: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function onRuntimeEvent(event: RuntimeEvent): void {
  if (!ROW_CHANGING_EVENTS.has(event.type)) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    for (const path of projects.keys()) void load(path);
  }, REFRESH_DEBOUNCE_MS);
}

function acquire(path: string): ProjectUnread {
  const held = projects.get(path);
  if (held) {
    held.holders += 1;
    return held;
  }
  const entry: ProjectUnread = { holders: 1, ids: shallowRef<ReadonlySet<string>>(new Set()) };
  projects.set(path, entry);
  if (!detachEvents && import.meta.client) {
    detachEvents = window.koneDesktop?.agent?.onEvent(onRuntimeEvent) ?? null;
  }
  void load(path);
  return entry;
}

function release(path: string): void {
  const entry = projects.get(path);
  if (!entry) return;
  entry.holders -= 1;
  if (entry.holders > 0) return;
  projects.delete(path);
  if (projects.size > 0) return;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  detachEvents?.();
  detachEvents = null;
}

/**
 * Which of this project's threads are unread, for as long as the caller lives.
 *
 * The path is read rather than passed, because a surface can travel: a strip
 * follows its row's project, and moving means letting go of one set and taking
 * hold of another rather than keeping both.
 */
export function useUnreadThreads(projectPath: () => string | null | undefined) {
  const entry = shallowRef<ProjectUnread | null>(null);
  let heldPath: string | null = null;

  function hold(path: string | null): void {
    if (path === heldPath) return;
    if (heldPath) release(heldPath);
    heldPath = path;
    entry.value = path ? acquire(path) : null;
  }

  watch(() => projectPath() ?? null, hold, { immediate: true });
  tryOnScopeDispose(() => hold(null));

  /** Whether a thread has spoken since it was last in front of anyone. */
  function isUnread(threadId: string): boolean {
    return entry.value?.ids.value.has(threadId) ?? false;
  }

  /**
   * Record that a thread has just been in front of the user.
   *
   * The durable stamp is the half that matters — clearing the mark locally
   * alone would put it back on the next read, because nothing would have told
   * the store the thread was seen. The local drop beside it is so the dash goes
   * out on the gesture rather than a round trip later, and it is applied to
   * every project holding the thread, since the same repository can be open in
   * several rows at once.
   */
  function markVisited(threadId: string): void {
    markThreadVisited(threadId);
    for (const project of projects.values()) {
      if (!project.ids.value.has(threadId)) continue;
      const next = new Set(project.ids.value);
      next.delete(threadId);
      project.ids.value = next;
    }
  }

  return { isUnread, markVisited };
}
