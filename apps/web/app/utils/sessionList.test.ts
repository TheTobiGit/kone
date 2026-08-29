import { describe, expect, test } from "bun:test";

import type { ForkContext, StoredThreadMeta } from "~/types/desktop";
import type { SessionSummary } from "~/types/session";
import {
  byRecency,
  DONE_CLEARED,
  isThreadDone,
  liftLegacyPins,
  SESSION_PIN_KEY,
  STALE_AFTER_MS,
  summarizeSession,
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
