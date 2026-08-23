import { describe, expect, test } from "bun:test";

import type { ForkContext, StoredThreadMeta } from "~/types/desktop";
import type { SessionSummary } from "~/types/session";
import { byRecency, liftLegacyPins, SESSION_PIN_KEY, summarizeSession } from "./sessionList";

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
