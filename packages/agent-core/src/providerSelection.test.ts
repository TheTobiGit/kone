import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import { Database } from "bun:sqlite";

function useUserDataDir(dir: string): void {
  setUserDataDir(dir);
}
useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-selection-test-")));

class DatabaseSyncShim {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly
      ? new Database(filePath, { readonly: true })
      : new Database(filePath);
  }
  prepare(sql: string) {
    return this.db.prepare(sql);
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  close() {
    this.db.close();
  }
}

mock.module("./sqlite.js", () => ({
  DatabaseSync: DatabaseSyncShim,
}));

type ConversationStoreType = import("./ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

function freshStore(): ConversationStoreType {
  useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-selection-test-")));
  return new ConversationStoreCtor();
}

beforeAll(async () => {
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
});

describe("remembered provider/model options", () => {
  test("round-trips knobs per provider+model", () => {
    const store = freshStore();
    store.upsertProviderModelOptions({
      provider: "codex",
      model: "gpt-5",
      knobs: { effort: "high", serviceTier: "fast", contextWindow: "1m", mode: "accept-edits" },
      at: 1,
    });
    store.upsertProviderModelOptions({
      provider: "claudeAgent",
      model: "opus-4",
      knobs: { effort: "low" },
      at: 2,
    });
    const codex = store.getProviderModelOptions("codex", "gpt-5");
    expect(codex?.knobs).toEqual({
      effort: "high",
      serviceTier: "fast",
      contextWindow: "1m",
      mode: "accept-edits",
    });
    expect(store.getProviderModelOptions("claudeAgent", "opus-4")?.knobs).toEqual({ effort: "low" });
    expect(store.getProviderModelOptions("codex", "opus-4")).toBeNull();
  });

  test("upsert replaces rather than merges, so a dropped knob clears", () => {
    const store = freshStore();
    store.upsertProviderModelOptions({ provider: "codex", model: "gpt-5", knobs: { effort: "high" }, at: 1 });
    store.upsertProviderModelOptions({ provider: "codex", model: "gpt-5", knobs: {}, at: 2 });
    expect(store.getProviderModelOptions("codex", "gpt-5")?.knobs).toEqual({});
  });
});

describe("pending selection", () => {
  test("round-trips and clears", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "codex", model: "gpt-5" });
    expect(store.pendingSelection("t-1")).toBeNull();
    store.setPendingSelection("t-1", { provider: "claudeAgent", model: "opus-4", effort: "high", mode: "ask" });
    expect(store.pendingSelection("t-1")).toEqual({
      provider: "claudeAgent",
      model: "opus-4",
      effort: "high",
      mode: "ask",
    });
    store.clearPendingSelection("t-1");
    expect(store.pendingSelection("t-1")).toBeNull();
  });

  test("retarget writes provider, model and knobs and clears the pending pick", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "codex", model: "gpt-5" });
    store.setPendingSelection("t-1", { provider: "claudeAgent", model: "opus-4" });
    expect(
      store.retargetThreadSelection("t-1", { provider: "claudeAgent", model: "opus-4", effort: "low" }),
    ).toBe(true);
    const meta = store.threadMeta("t-1");
    expect(meta?.provider).toBe("claudeAgent");
    expect(meta?.model).toBe("opus-4");
    expect(meta?.selection?.effort).toBe("low");
    expect(store.pendingSelection("t-1")).toBeNull();
  });
});

describe("model/option change mark", () => {
  test("records a change when the model moves, and names both sides", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "codex", model: "gpt-5" });
    expect(store.modelChangesForThread("t-1")).toEqual([]);
    store.setThreadSelection("t-1", { model: "gpt-5.1" });
    const changes = store.modelChangesForThread("t-1");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.fromModel).toBe("gpt-5");
    expect(changes[0]?.toModel).toBe("gpt-5.1");
    expect(changes[0]?.fromProvider).toBe("codex");
    expect(changes[0]?.toProvider).toBe("codex");
    expect(changes[0]?.changedKnobs).toEqual([]);
  });

  test("records a knob change without a model move", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "codex", model: "gpt-5" });
    store.setThreadSelection("t-1", { model: "gpt-5", effort: "high" });
    const changes = store.modelChangesForThread("t-1");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changedKnobs).toEqual(["effort"]);
  });

  test("records nothing when nothing changed", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "codex", model: "gpt-5" });
    store.setThreadSelection("t-1", { model: "gpt-5", effort: "high" });
    store.setThreadSelection("t-1", { model: "gpt-5", effort: "high" });
    expect(store.modelChangesForThread("t-1")).toHaveLength(1);
  });
});

describe("queued row selection", () => {
  test("carries the provider it was enqueued on", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "codex", model: "gpt-5" });
    store.enqueueQueuedTurn({
      queueId: "q-1",
      threadId: "t-1",
      userBlockId: "ub-1",
      input: "hi",
      provider: "claudeAgent",
      model: "opus-4",
      effort: "high",
    });
    const rows = store.listQueuedTurns("t-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("claudeAgent");
    expect(rows[0]?.model).toBe("opus-4");
    expect(rows[0]?.effort).toBe("high");
  });
});
