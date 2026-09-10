import { describe, expect, test } from "bun:test";

import type { ForkContext, StoredThreadMeta } from "~/types/desktop";
import type { SessionSummary } from "~/types/session";
import {
  byRecency,
  DONE_CLEARED,
  isThreadDone,
  isThreadUnread,
  liftLegacyPins,
  nextVisitStamp,
  SESSION_PIN_KEY,
  STALE_AFTER_MS,
  summarizeSession,
  type VisitStamp,
  type VisitStampInput,
} from "./sessionList";

/** Minimal persisted thread row; tests override just the fields under test. */
function meta(overrides: Partial<StoredThreadMeta> = {}): StoredThreadMeta {
  return {
    threadId: "thread-1",
    projectPath: "/repo",
    provider: "codex",
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function forkContext(): ForkContext {
  return {
    sourceThreadId: "thread-parent",
    forkPointBlockId: null,
    importedAt: 1000,
    bootstrapStatus: "completed",
  };
}

function spyApi() {
  const calls: Array<[string, boolean]> = [];
  const setPinned = (threadId: string, pinned: boolean) => {
    calls.push([threadId, pinned]);
    return Promise.resolve();
  };
  return { setPinned, calls };
}

describe("summarizeSession — flatten a stored thread into a list row", () => {
  test("maps the optional fields, blank title falls back, no lastActivityAt falls back to updatedAt", () => {
    const row = summarizeSession(
      meta({
        title: "  Wire up the bridge  ",
        model: "gpt-5.6-terra",
        branch: "feature/x",
        added: 120,
        removed: 30,
        tokens: 50_000,
      }),
      true,
    );
    expect(row).toMatchObject({
      threadId: "thread-1",
      title: "Wire up the bridge",
      provider: "codex",
      brand: "gpt",
      model: "gpt-5.6-terra",
      branch: "feature/x",
      added: 120,
      removed: 30,
      tokens: 50_000,
      updatedAt: 2000,
      pinned: true,
      sideChat: false,
    });
    expect(summarizeSession(meta({ title: "   " }), false).title).toBe("Untitled session");
    expect(summarizeSession(meta(), false).title).toBe("Untitled session");
  });

  test("uses lastActivityAt over updatedAt as the recency key", () => {
    const row = summarizeSession(meta({ updatedAt: 2000, lastActivityAt: 9000 }), false);
    expect(row.updatedAt).toBe(9000);
  });

  test("flags sideChat from forkContext presence", () => {
    expect(summarizeSession(meta({ forkContext: forkContext() }), false).sideChat).toBe(true);
    expect(summarizeSession(meta(), false).sideChat).toBe(false);
  });

  test("carries projectPath/projectName only when a project tag is passed", () => {
    const tagged = summarizeSession(meta(), false, { projectPath: "/other", projectName: "Other" });
    expect(tagged.projectPath).toBe("/other");
    expect(tagged.projectName).toBe("Other");

    const untagged = summarizeSession(meta(), false);
    expect(untagged.projectPath).toBeUndefined();
    expect(untagged.projectName).toBeUndefined();
  });

  test("carries snippet when present on meta", () => {
    expect(summarizeSession(meta({ snippet: "Done and reviewed." }), false).snippet).toBe("Done and reviewed.");
    expect(summarizeSession(meta(), false).snippet).toBeUndefined();
  });
});

describe("isThreadDone — the mark expires by comparison, not by a write", () => {
  test("a recent thread nobody has marked is not done", () => {
    const now = 1_000_000_000;
    expect(isThreadDone(meta({ lastActivityAt: now - 1000 }), now)).toBe(false);
    expect(isThreadDone(meta({ lastActivityAt: now - 1000, doneAt: null }), now)).toBe(false);
  });

  test("a thread quiet for longer than the stale window is done by itself", () => {
    const now = 1_000_000_000;
    // Nothing was written for this — an inbox left alone settles rather than
    // greeting you with a month of backlog.
    expect(isThreadDone(meta({ lastActivityAt: now - STALE_AFTER_MS - 1 }), now)).toBe(true);
    // Exactly at the window is still inside it.
    expect(isThreadDone(meta({ lastActivityAt: now - STALE_AFTER_MS }), now)).toBe(false);
  });

  test("an explicit un-mark outranks age", () => {
    const now = 1_000_000_000;
    const old = meta({ lastActivityAt: now - STALE_AFTER_MS * 3, doneAt: DONE_CLEARED });
    // Otherwise the un-mark button would silently do nothing on exactly the
    // threads someone is most likely to press it on.
    expect(isThreadDone(old, now)).toBe(false);
  });

  test("a turn after an un-mark leaves the thread not done, and it can age again", () => {
    const now = 1_000_000_000;
    const spoken = meta({ lastActivityAt: now - 1000, doneAt: DONE_CLEARED });
    expect(isThreadDone(spoken, now)).toBe(false);
  });

  test("a thread marked after its last activity is done", () => {
    const now = 10_000;
    expect(isThreadDone(meta({ lastActivityAt: 5000, doneAt: 5000 }), now)).toBe(true);
    expect(isThreadDone(meta({ lastActivityAt: 5000, doneAt: 6000 }), now)).toBe(true);
  });

  test("a thread the agent has spoken in since is asking again", () => {
    // Nothing cleared the stamp; the row simply stopped satisfying the
    // predicate. This is the whole reason done is a timestamp and not a flag.
    expect(isThreadDone(meta({ lastActivityAt: 9000, doneAt: 5000 }), 10_000)).toBe(false);
  });

  test("falls back to updatedAt when a pre-v18 row has no activity key", () => {
    expect(isThreadDone(meta({ updatedAt: 2000, doneAt: 3000 }), 4000)).toBe(true);
    expect(isThreadDone(meta({ updatedAt: 4000, doneAt: 3000 }), 5000)).toBe(false);
  });

  test("summarizeSession carries the verdict, not the stamp", () => {
    const now = Date.now();
    expect(summarizeSession(meta({ lastActivityAt: now - 100, doneAt: now }), false).done).toBe(
      true,
    );
    expect(summarizeSession(meta({ lastActivityAt: now, doneAt: now - 100 }), false).done).toBe(
      false,
    );
    // And the age rule reaches rows through the same path.
    expect(summarizeSession(meta({ lastActivityAt: now - STALE_AFTER_MS - 1 }), false).done).toBe(
      true,
    );
  });
});

describe("isThreadUnread — the agent has spoken since you last looked", () => {
  test("activity after the visit is unread", () => {
    expect(isThreadUnread(meta({ lastActivityAt: 5000, lastVisitedAt: 4000 }))).toBe(true);
  });

  test("a visit at or after the activity is read", () => {
    expect(isThreadUnread(meta({ lastActivityAt: 5000, lastVisitedAt: 5000 }))).toBe(false);
    expect(isThreadUnread(meta({ lastActivityAt: 5000, lastVisitedAt: 6000 }))).toBe(false);
  });

  test("falls back to updatedAt when the thread carries no activity stamp", () => {
    expect(isThreadUnread(meta({ updatedAt: 2000, lastVisitedAt: 1000 }))).toBe(true);
    expect(isThreadUnread(meta({ updatedAt: 2000, lastVisitedAt: 2000 }))).toBe(false);
  });

  test("never visited reads as unread — rows older than the stamp are backfilled", () => {
    expect(isThreadUnread(meta())).toBe(true);
    expect(isThreadUnread(meta({ lastVisitedAt: null }))).toBe(true);
  });

  test("epoch zero is a real visit, not an absent one — it just precedes everything", () => {
    expect(isThreadUnread(meta({ lastActivityAt: 0, lastVisitedAt: 0 }))).toBe(false);
  });

  test("summarizeSession carries the derived mark and the stamp behind it", () => {
    const unread = summarizeSession(meta({ lastActivityAt: 5000, lastVisitedAt: 4000 }), false);
    expect(unread.unread).toBe(true);
    expect(unread.lastVisitedAt).toBe(4000);
    const read = summarizeSession(meta({ lastActivityAt: 5000, lastVisitedAt: 5000 }), false);
    expect(read.unread).toBe(false);
  });
});

describe("byRecency — newest first", () => {
  test("sorts a newer updatedAt before an older one", () => {
    // SAFETY: the fixtures spell out every required SessionSummary field, and
    // byRecency reads only updatedAt — the optional members are never touched.
    const newer = { threadId: "a", title: "A", provider: "codex", brand: "gpt", updatedAt: 3000 } as SessionSummary;
    // SAFETY: the fixtures spell out every required SessionSummary field, and
    // byRecency reads only updatedAt — the optional members are never touched.
    const older = { threadId: "b", title: "B", provider: "codex", brand: "gpt", updatedAt: 1000 } as SessionSummary;
    expect(byRecency(newer, older)).toBeLessThan(0);
    expect(byRecency(older, newer)).toBeGreaterThan(0);
  });
});

describe("SESSION_PIN_KEY", () => {
  test("is the shared localStorage key both lists use", () => {
    expect(SESSION_PIN_KEY).toBe("kone:pinned-sessions");
  });
});

describe("liftLegacyPins — one-time localStorage→DB migration", () => {
  test("returns true for an empty list without touching the api", async () => {
    const api = spyApi();
    expect(await liftLegacyPins(api, [])).toBe(true);
    expect(api.calls).toEqual([]);
  });

  test("writes every id when all succeed and returns true", async () => {
    const api = spyApi();
    const ok = await liftLegacyPins(api, ["a", "b", "c"]);
    expect(ok).toBe(true);
    expect(api.calls).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
    ]);
  });

  test("returns false when any write rejects — the caller keeps the localStorage key", async () => {
    let calls = 0;
    const setPinned = () => {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error("db unavailable")) : Promise.resolve();
    };
    const ok = await liftLegacyPins({ setPinned }, ["a", "b", "c"]);
    expect(ok).toBe(false);
  });
});

describe("nextVisitStamp — one pure pass from latch plus list settle to stamp", () => {
  function row(
    threadId: string,
    unread: boolean,
    updatedAt = 5000,
  ): Pick<SessionSummary, "threadId" | "unread" | "updatedAt"> {
    return { threadId, unread, updatedAt };
  }

  function input(
    overrides: Partial<VisitStampInput> = {},
  ): VisitStampInput {
    return {
      reading: true,
      selectedThreadId: "a",
      rows: [row("a", true), row("b", false)],
      ...overrides,
    };
  }

  test("stamps the open unread thread", () => {
    const transition = nextVisitStamp(null, input());
    expect(transition.toStamp).toEqual({ threadId: "a", updatedAt: 5000 });
    expect(transition.next).toEqual({ threadId: "a", updatedAt: 5000 });
  });

  test("a hidden surface with a leftover selection stamps nothing and clears", () => {
    // The regression this gate exists for. The inbox portal hides rather than
    // unmounts and its lists are kept alive, so a thread selected an hour ago is
    // still selected. A reply landing now re-summarizes the row as unread and
    // would be stamped read by a list nobody can see — and the stamp only moves
    // forward, so that mark never comes back.
    const latched: VisitStamp = { threadId: "a", updatedAt: 5000 };
    const transition = nextVisitStamp(
      latched,
      input({ reading: false, rows: [row("a", true)] }),
    );
    expect(transition.toStamp).toBeNull();
    expect(transition.next).toBeNull();
  });

  test("nothing selected, or a selection the list does not carry, stamps nothing and clears", () => {
    const latched: VisitStamp = { threadId: "a", updatedAt: 5000 };
    const rows = [row("a", true)];
    expect(nextVisitStamp(latched, input({ selectedThreadId: null, rows })).next).toBeNull();
    expect(nextVisitStamp(latched, input({ selectedThreadId: undefined, rows })).next).toBeNull();
    expect(nextVisitStamp(latched, input({ selectedThreadId: "zzz", rows })).next).toBeNull();
    expect(nextVisitStamp(null, input({ selectedThreadId: "zzz", rows })).toStamp).toBeNull();
  });

  test("a thread already read is left alone and clears the latch", () => {
    const latched: VisitStamp = { threadId: "a", updatedAt: 5000 };
    const transition = nextVisitStamp(latched, input({ rows: [row("a", false)] }));
    expect(transition.toStamp).toBeNull();
    expect(transition.next).toBeNull();
  });

  test("polling the same unread generation twice stamps once and keeps the latch", () => {
    const first = nextVisitStamp(null, input({ rows: [row("a", true)] }));
    expect(first.toStamp).toEqual({ threadId: "a", updatedAt: 5000 });
    // The watcher's immediate run plus its first reactive run, and every
    // silent reload that re-summarizes unchanged rows, arrive exactly like
    // this — same thread, same activity stamp, fresh array each time.
    const second = nextVisitStamp(first.next, input({ rows: [row("a", true)] }));
    expect(second.toStamp).toBeNull();
    expect(second.next).toEqual({ threadId: "a", updatedAt: 5000 });
    const third = nextVisitStamp(second.next, input({ rows: [row("a", true)] }));
    expect(third.toStamp).toBeNull();
    expect(third.next).toEqual({ threadId: "a", updatedAt: 5000 });
  });

  test("a turn landing under the open thread re-stamps", () => {
    const first = nextVisitStamp(null, input({ rows: [row("a", true, 5000)] }));
    expect(first.toStamp).toEqual({ threadId: "a", updatedAt: 5000 });
    // The reload behind the landed turn re-summarizes the row: unread again,
    // with a newer activity stamp. That is a new generation, not an echo.
    const second = nextVisitStamp(first.next, input({ rows: [row("a", true, 8000)] }));
    expect(second.toStamp).toEqual({ threadId: "a", updatedAt: 8000 });
    expect(second.next).toEqual({ threadId: "a", updatedAt: 8000 });
  });

  test("a poll with nothing to stamp re-arms the latch", () => {
    const first = nextVisitStamp(null, input({ rows: [row("a", true)] }));
    expect(first.toStamp).toEqual({ threadId: "a", updatedAt: 5000 });
    // The row came back read — or the surface hid, or the selection moved on.
    // Either way the latch drops, so the next unread sighting stamps fresh:
    // a mark-unread picked back up, or a retry after a write that never
    // landed, both arrive as unread with the same activity stamp.
    const cleared = nextVisitStamp(first.next, input({ rows: [row("a", false)] }));
    expect(cleared.toStamp).toBeNull();
    expect(cleared.next).toBeNull();
    const restamped = nextVisitStamp(cleared.next, input({ rows: [row("a", true)] }));
    expect(restamped.toStamp).toEqual({ threadId: "a", updatedAt: 5000 });
  });
});
