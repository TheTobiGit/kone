import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import type { ThreadTitleMessage } from "./threadTitleContext.js";

const userDataDir = mkdtempSync(path.join(tmpdir(), "kone-regen-title-test-"));
setUserDataDir(userDataDir);

// The store imports node:sqlite; stand it in with bun:sqlite, the same pattern
// the sibling service tests use. Mocked before AgentService is imported.
mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

let AgentServiceCtor: typeof import("./AgentService.js").AgentService;

class FakeHistoryStore {
  meta = new Map<string, { provider: string; model: string | null; projectPath: string; title: string | null }>();
  origins = new Map<string, "auto" | "manual">();
  messages = new Map<string, ThreadTitleMessage[]>();
  workspacePath: string | null = null;
  written: Array<{ threadId: string; title: string }> = [];

  threadMeta(threadId: string) {
    const m = this.meta.get(threadId);
    if (!m) return null;
    return { threadId, provider: m.provider, model: m.model, projectPath: m.projectPath, title: m.title };
  }
  titleOrigin(threadId: string) {
    return this.origins.get(threadId) ?? "auto";
  }
  titleMessages(threadId: string) {
    return this.messages.get(threadId) ?? [];
  }
  threadWorkspace(_threadId: string) {
    return { envMode: "local" as const, worktreePath: this.workspacePath, requestedBranch: null };
  }
  setTitle(threadId: string, title: string): void {
    this.written.push({ threadId, title });
    const m = this.meta.get(threadId);
    if (m) m.title = title;
    this.origins.set(threadId, "auto");
  }
  // Unused by these paths but part of the injected slice's shape.
  setArchived() {
    return { ok: false as const, reason: "missing" as const };
  }
  setDone(): void {}
  staleThreadIds(): string[] {
    return [];
  }
}

const history = new FakeHistoryStore();
let service: import("./AgentService.js").AgentService;
const events: import("./types.js").RuntimeEvent[] = [];
const renames: Array<{ worktreePath: string; title: string }> = [];
let generateCalls: Array<{ cwd: string; context: string; provider: string; model?: string }> = [];

beforeAll(async () => {
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
  service = new AgentServiceCtor({
    retentionSweepMs: 0,
    // SAFETY: the fake implements exactly the history methods regeneration reads.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    historyStore: history as unknown as import("./AgentService.js").AgentServiceOptions["historyStore"],
    generateContextTitle: async (input) => {
      generateCalls.push(input);
      return "Whole conversation title";
    },
    renameWorkspaceBranch: async (input) => {
      renames.push(input);
      return input.title;
    },
  });
  service.onEvent((e) => events.push(e));
});

beforeEach(() => {
  history.meta.clear();
  history.origins.clear();
  history.messages.clear();
  history.written.length = 0;
  history.workspacePath = null;
  events.length = 0;
  renames.length = 0;
  generateCalls = [];
});

afterAll(() => {
  // Nothing to tear down: the temp userDataDir is left for the OS.
});

function seedThread(threadId: string, title: string | null = "Old title"): void {
  history.meta.set(threadId, {
    provider: "claudeAgent",
    model: "claude-haiku-4-5",
    projectPath: "/repo",
    title,
  });
  history.messages.set(threadId, [
    { role: "user", text: "rename the parser" },
    { role: "assistant", text: "I renamed it and updated the tests." },
  ]);
}

describe("AgentService.regenerateThreadTitle", () => {
  test("regenerates from the whole conversation and persists an auto title", async () => {
    seedThread("t1");
    const result = await service.regenerateThreadTitle("t1");
    expect(result).toEqual({ ok: true, title: "Whole conversation title", changed: true });
    expect(history.written).toEqual([{ threadId: "t1", title: "Whole conversation title" }]);
    expect(history.titleOrigin("t1")).toBe("auto");
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.context).toContain("rename the parser");
    expect(generateCalls[0]?.context).toContain("updated the tests");
    expect(events.some((e) => e.type === "thread.title.updated")).toBe(true);
  });

  test("never overwrites a manual rename", async () => {
    seedThread("t2", "My own title");
    history.origins.set("t2", "manual");
    const result = await service.regenerateThreadTitle("t2");
    expect(result).toEqual({ ok: false, reason: "manual_title" });
    expect(generateCalls).toHaveLength(0);
    expect(history.written).toHaveLength(0);
  });

  test("reports an unknown thread", async () => {
    expect(await service.regenerateThreadTitle("missing")).toEqual({ ok: false, reason: "unknown" });
  });

  test("reports a thread with nothing to title from", async () => {
    seedThread("t3");
    history.messages.set("t3", [{ role: "reasoning", text: "only thinking, no prose" }]);
    expect(await service.regenerateThreadTitle("t3")).toEqual({ ok: false, reason: "empty" });
  });

  test("writes nothing when the generated title is unchanged", async () => {
    seedThread("t4", "Whole conversation title");
    const result = await service.regenerateThreadTitle("t4");
    expect(result).toEqual({ ok: true, title: "Whole conversation title", changed: false });
    expect(history.written).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test("follows a worktree branch rename after a change", async () => {
    seedThread("t5");
    history.workspacePath = "/repo/.worktrees/t5";
    await service.regenerateThreadTitle("t5");
    // The rename is fired without awaiting; let its microtask land.
    await Promise.resolve();
    expect(renames).toEqual([{ worktreePath: "/repo/.worktrees/t5", title: "Whole conversation title" }]);
  });
});
