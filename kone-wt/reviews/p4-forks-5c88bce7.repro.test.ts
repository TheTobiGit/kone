import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const root = "/home/gideonsarfo/Developer/kone-wt/p4-forks";
mock.module(`${root}/packages/agent-core/src/sqlite.js`, () => ({ DatabaseSync: Database }));
const { setUserDataDir } = await import(`${root}/packages/agent-core/src/userDataDir.ts`);
const { getConversationStore, resetConversationStoreForTests } = await import(`${root}/packages/agent-core/src/ConversationStore.ts`);
const { forkThreadAtTurn } = await import(`${root}/packages/agent-core/src/threadFork.ts`);
const { sidechatBootstrapForTurn } = await import(`${root}/packages/agent-core/src/sidechat.ts`);
const { initThreadDispatcher } = await import(`${root}/packages/agent-core/src/dispatch.ts`);
const { createAppForkTools } = await import(`${root}/packages/agent-core/src/gateway/tools/appForks.ts`);
const { createRegistry } = await import(`${root}/packages/agent-core/src/gateway/registry.ts`);
const { AgentService } = await import(`${root}/packages/agent-core/src/AgentService.ts`);
let dir: string;
let service: any;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "p4-review-")); setUserDataDir(dir); });
afterEach(async () => { await service?.stopAll(); service = undefined; resetConversationStoreForTests(); rmSync(dir, { recursive: true, force: true }); });
function seed(provider = "codex", native = true) {
  const store = getConversationStore();
  store.ensureThread({ threadId: "source", projectPath: dir, provider, model: "model" });
  store.recordUserBlock({ threadId: "source", blockId: "prompt", text: "Remember ALPHA", at: 1 });
  store.applyEvent({ type: "turn.started", threadId: "source", provider, turnId: "turn-1", at: 2, source: "test" });
  store.applyEvent({ type: "item.updated", threadId: "source", provider, turnId: "turn-1", at: 3, source: "test", item: { itemId: "item", kind: "assistant_text", status: "completed", text: "ALPHA remembered" } });
  store.applyEvent({ type: "turn.completed", threadId: "source", provider, turnId: "turn-1", at: 4, source: "test", ...(provider === "claudeAgent" ? { assistantUuid: "source-uuid" } : {}) });
  if (native) store.captureConversationId("source", "native-source");
  return store;
}
function fork(extra = {}) { return forkThreadAtTurn({ sourceThreadId: "source", turnId: "turn-1", userBlockId: null, threadId: "fork", requestId: "request", supportsFork: true, ...extra }); }
function dispatcher(store: any) {
  const starts: any[] = [];
  const fake = { hasLiveSession: () => false, startSession: async (input: any) => { starts.push(input); return { threadId: input.threadId, provider: input.provider }; } };
  return { starts, dispatch: initThreadDispatcher({ service: fake, store, broadcast: () => {} }) };
}
const ctx = { threadId: "assistant", turnId: "tool-turn", provider: "claudeAgent", cwd: dir, requestId: "tool" };
function registry(options = {}) { return createRegistry(createAppForkTools(options).map((entry: any) => ({ ...entry, target: "assistant" }))); }
// These tests assert the pinned faulty behavior, so passing means reproduced.
test("F1 normal startThread drops native fork and portable replay is disabled", async () => {
  const store = seed(); fork();
  const { starts, dispatch } = dispatcher(store);
  await dispatch.startThread({ threadId: "fork", provider: "codex", cwd: dir });
  expect(starts[0].forkFrom).toBeUndefined();
  expect(starts[0].resume).toBeUndefined();
  expect(store.loadThread("fork").blocks).toEqual([]);
  expect(sidechatBootstrapForTurn("fork", "What did I ask you to remember?")).toBeNull();
});
test("F2 native fork passes Codex conversation to chosen Claude provider", async () => {
  const store = seed(); fork({ target: { provider: "claudeAgent" } });
  const { starts, dispatch } = dispatcher(store);
  await dispatch.ensureThreadSession("fork", { resume: true });
  expect(starts[0].provider).toBe("claudeAgent");
  expect(starts[0].forkFrom).toEqual({ conversationId: "native-source", beforeTurnId: "turn-1" });
  expect(store.loadThread("fork").blocks).toEqual([]);
  expect(sidechatBootstrapForTurn("fork", "Continue")).toBeNull();
});
test("real prompt id works, null works with answer, null without answer refuses", async () => {
  const store = seed("codex", false);
  expect(fork({ supportsFork: false, userBlockId: "prompt" }).status).toBe("created");
  expect(store.loadThread("fork").blocks.length).toBe(2);
  expect(fork({ supportsFork: false, threadId: "fork-null", requestId: "null" }).status).toBe("created");
  store.ensureThread({ threadId: "no-answer", projectPath: dir, provider: "codex" });
  store.recordUserBlock({ threadId: "no-answer", blockId: "unanswered-prompt", text: "Never answered", at: 5 });
  expect(() => fork({ sourceThreadId: "no-answer", turnId: "unanswered", supportsFork: false, threadId: "no-answer-fork", requestId: "no-answer", userBlockId: null })).toThrow(/not part/);
  const refusal = await registry().call(ctx, "app_fork_thread", { sourceThreadId: "no-answer", turnId: "unanswered", userBlockId: null, threadId: "refused-fork", requestId: "refused" });
  expect(refusal.isError).toBe(true);
  expect(refusal.content[0].text).toContain("unanswered");
  expect(refusal.content[0].text).toContain("not part of this conversation");
  expect(store.threadMeta("refused-fork")).toBeNull();
  service = new AgentService({ adapters: () => [{ provider: "codex", capabilities: { supportsFork: false }, stopAll: async () => {} }], retentionSweepMs: 0, pullRequestSweepMs: 0 });
  expect(() => service.rewindConversationOnly({ sourceThreadId: "no-answer", turnId: "unanswered", userBlockId: null, threadId: "refused-rewind", requestId: "refused-rewind" })).toThrow(/unanswered/);
  expect(store.threadMeta("refused-rewind")).toBeNull();
  expect(service.hasLiveSession("refused-fork")).toBe(false);
  expect(service.hasLiveSession("refused-rewind")).toBe(false);
  expect(fork({ sourceThreadId: "no-answer", turnId: "unanswered", supportsFork: false, threadId: "prompt-fork", requestId: "prompt-fork", userBlockId: "unanswered-prompt" }).status).toBe("created");
});
test("gateway retry without threadId conflicts with its own requestId", async () => {
  seed(); let n = 0;
  const tools = registry({ newThreadId: () => `generated-${++n}` });
  const params = { sourceThreadId: "source", turnId: "turn-1", requestId: "same-request" };
  expect((await tools.call(ctx, "app_fork_thread", params)).isError).toBeUndefined();
  const replay = await tools.call(ctx, "app_fork_thread", params);
  expect(replay.isError).toBe(true);
  expect(replay.content[0].text).toContain("Idempotency conflict");
});
test("F3 real successful restore leaves turn forkable", async () => {
  const { initTestRepo } = await import(`${root}/packages/git-core/src/testRepo.ts`);
  const { createCheckpoint } = await import(`${root}/packages/git-core/src/checkpoint.ts`);
  const repo = await initTestRepo("p4-review-restore-");
  try {
    const store = seed();
    store.ensureThread({ threadId: "source", projectPath: repo, provider: "codex" });
    writeFileSync(path.join(repo, "review-file.txt"), "before");
    const checkpoint = await createCheckpoint(repo);
    store.recordTurnCheckpoint({ threadId: "source", turnId: "turn-1", checkpointId: checkpoint.id, ref: `refs/kone/checkpoints/${checkpoint.id}` });
    writeFileSync(path.join(repo, "review-file.txt"), "after");
    service = new AgentService({ adapters: () => [], retentionSweepMs: 0, pullRequestSweepMs: 0 });
    expect(await service.revertToTurnCheckpoint("source", "turn-1", true)).toEqual({ ok: true });
    expect(readFileSync(path.join(repo, "review-file.txt"), "utf8")).toBe("before");
    expect(store.isTurnRolledBack("source", "turn-1")).toBe(false);
    expect(fork({ supportsFork: false }).status).toBe("created");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
test("finished failed/interrupted/cancelled turns can fork portable context", () => {
  const store = getConversationStore();
  for (const reason of ["failed", "interrupted", "cancelled", "limited"]) {
    store.ensureThread({ threadId: reason, projectPath: dir, provider: "codex" });
    store.recordUserBlock({ threadId: reason, text: "go", at: 1 });
    store.applyEvent({ type: "turn.started", threadId: reason, provider: "codex", turnId: reason, at: 2, source: "test" });
    store.applyEvent({ type: "turn.aborted", threadId: reason, provider: "codex", turnId: reason, reason, at: 3, source: "test" });
    expect(fork({ sourceThreadId: reason, turnId: reason, supportsFork: false, threadId: `f-${reason}`, requestId: reason }).status).toBe("created");
  }
});
test("migrations 32 and 33 run independently and rerun without losing rows", async () => {
  const { migrationEntries, migrate } = await import(`${root}/packages/agent-core/src/conversationMigrations.ts`);
  const file = path.join(dir, "migrations.sqlite");
  const db = new Database(file);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, file, { toMigrationInclusive: 31 });
  const m32 = migrationEntries.find((m: any) => m.id === 32)!;
  const m33 = migrationEntries.find((m: any) => m.id === 33)!;
  m32.run(db); m33.run(db);
  db.exec("INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at) VALUES ('m', '/repo', 'codex', 1, 1)");
  db.exec("INSERT INTO turn_rollbacks VALUES ('m', 'turn', 10)");
  m32.run(db); m33.run(db);
  expect(db.query("SELECT * FROM turn_rollbacks").all()).toHaveLength(1);
  expect(db.query("PRAGMA table_info(blocks)").all().filter((c: any) => c.name === "assistant_uuid")).toHaveLength(1);
  db.exec("DELETE FROM threads WHERE thread_id = 'm'");
  expect(db.query("SELECT * FROM turn_rollbacks").all()).toEqual([]);
  db.close();
});

test("F4 gateway accepts a source with dispatch in flight before turn.started", async () => {
  const store = seed("codex", false);
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const fake = {
    provider: "codex", capabilities: { sessionModelSwitch: "unsupported", supportsModelList: false },
    startSession: async () => ({ threadId: "source", provider: "codex" }),
    sendTurn: async () => { await pending; return { threadId: "source", turnId: "next-turn" }; },
    stopAll: async () => {}, stopSession: async () => {}, listModels: async () => [],
  };
  service = new AgentService({ adapters: () => [fake], retentionSweepMs: 0, pullRequestSweepMs: 0, checkpointStore: null });
  await service.startSession({ threadId: "source", provider: "codex", cwd: dir });
  const sending = service.sendTurn({ threadId: "source", input: "next message" });
  try {
    expect(service.isThreadBusy("source")).toBe(true);
    expect(() => service.rewindConversationOnly({ sourceThreadId: "source", turnId: "turn-1", userBlockId: null, threadId: "rewind", requestId: "rewind" })).toThrow(/still running/);
    const result = await registry().call(ctx, "app_fork_thread", { sourceThreadId: "source", turnId: "turn-1", requestId: "busy", threadId: "busy-fork" });
    expect(result.isError).toBeUndefined();
    expect(store.threadMeta("busy-fork")).not.toBeNull();
  } finally { release(); await sending; }
});

test("Claude native target still starts after source rollback stamp", async () => {
  const store = seed("claudeAgent"); fork();
  store.markTurnsRolledBack("source", "turn-1");
  const { starts, dispatch } = dispatcher(store);
  await dispatch.ensureThreadSession("fork", { resume: true });
  expect(starts[0].forkFrom).toEqual({ conversationId: "native-source", assistantUuid: "source-uuid" });
});
