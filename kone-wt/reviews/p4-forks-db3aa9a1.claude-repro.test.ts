import { afterAll, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const root = "/home/gideonsarfo/Developer/kone-wt/p4-forks";
mock.module(`${root}/packages/agent-core/src/sqlite.js`, () => ({ DatabaseSync: Database }));
const { setUserDataDir } = await import(`${root}/packages/agent-core/src/userDataDir.ts`);
const dataDir = mkdtempSync(path.join(tmpdir(), "p4-claude-review-"));
setUserDataDir(dataDir);
class Feed {
  items: any[] = []; waiter: any;
  push(value: any) { if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter({ value, done: false }); } else this.items.push(value); }
  end() { this.waiter?.({ done: true }); this.waiter = null; }
  async *[Symbol.asyncIterator]() { while (true) { const item: any = await new Promise(resolve => { if (this.items.length) resolve({ value: this.items.shift(), done: false }); else this.waiter = resolve; }); if (item.done) return; yield item.value; } }
}
let options: any;
let feed: Feed;
let forkCount = 0;
mock.module(`${root}/packages/agent-core/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, () => ({
  forkSession: async () => { forkCount++; return { sessionId: "fork-session" }; },
  query: (input: any) => { options = input.options; feed = new Feed(); return { initializationResult: async () => ({}), setPermissionMode: async () => {}, setModel: async () => {}, applyFlagSettings: async () => {}, interrupt: async () => {}, [Symbol.asyncIterator]: () => feed[Symbol.asyncIterator]() }; },
}));
const { ClaudeAdapter } = await import(`${root}/packages/agent-core/src/adapters/ClaudeAdapter.ts`);
const { getConversationStore, resetConversationStoreForTests } = await import(`${root}/packages/agent-core/src/ConversationStore.ts`);
const { initThreadDispatcher } = await import(`${root}/packages/agent-core/src/dispatch.ts`);
afterAll(() => { resetConversationStoreForTests(); rmSync(dataDir, { recursive: true, force: true }); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test("F5 native fork has no source resume UUID; first own answer persists fork-local cursor and resumes it", async () => {
  const events: any[] = [];
  const store = getConversationStore();
  const { forkThreadAtTurn } = await import(`${root}/packages/agent-core/src/threadFork.ts`);
  store.ensureThread({ threadId: "source", provider: "claudeAgent", projectPath: dataDir });
  store.recordUserBlock({ threadId: "source", text: "source prompt", at: 1 });
  store.applyEvent({ type: "turn.started", threadId: "source", provider: "claudeAgent", turnId: "source-turn", at: 2, source: "test" });
  store.applyEvent({ type: "turn.completed", threadId: "source", provider: "claudeAgent", turnId: "source-turn", assistantUuid: "source-uuid", at: 3, source: "test" });
  store.captureConversationId("source", "source-session");
  forkThreadAtTurn({ sourceThreadId: "source", threadId: "fork", requestId: "fork", turnId: "source-turn", userBlockId: null, supportsFork: true });
  expect(store.threadForkContext("fork").nativeFork.assistantUuid).toBe("source-uuid");
  const adapter = new ClaudeAdapter((event: any) => { events.push(event); store.applyEvent(event); });
  await adapter.startSession({ threadId: "fork", provider: "claudeAgent", cwd: dataDir, forkFrom: { conversationId: "source-session", assistantUuid: "source-uuid" } });
  expect(options.resume).toBe("fork-session");
  expect(options.resumeSessionAt).toBeUndefined();
  expect(events.find(e => e.type === "session.started").refs?.resumeSessionAt).toBeUndefined();
  feed.push({ type: "system", subtype: "init", session_id: "fork-session", model: "sonnet" });
  await tick();
  const first = await adapter.sendTurn({ threadId: "fork", input: "First message" });
  feed.push({ type: "assistant", uuid: "fork-local-answer-uuid", session_id: "fork-session", message: { role: "assistant", content: [{ type: "text", text: "Own first answer" }] } });
  feed.push({ type: "result", subtype: "success", is_error: false, session_id: "fork-session", num_turns: 1, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, usage: {} });
  await tick();
  const completed = events.find(e => e.type === "turn.completed");
  expect(completed.assistantUuid).toBe("fork-local-answer-uuid");
  expect(store.turnAssistantUuid("fork", first.turnId)).toBe("fork-local-answer-uuid");
  expect(store.threadMeta("fork").conversationId).toBe("fork-session");
  expect(store.threadMeta("fork").resumeSessionAt).toBe("fork-local-answer-uuid");
  feed.end(); await adapter.stopAll();
  const starts: any[] = [];
  const dispatch = initThreadDispatcher({ store, broadcast: () => {}, service: { hasLiveSession: () => false, startSession: async (input: any) => { starts.push(input); return adapter.startSession(input); } } });
  await dispatch.ensureThreadSession("fork", { resume: true });
  expect(starts[0].forkFrom).toBeUndefined();
  expect(options.resume).toBe("fork-session");
  expect(options.resumeSessionAt).toBe("fork-local-answer-uuid");
  expect(forkCount).toBe(1);
  feed.end(); await adapter.stopAll();
});
