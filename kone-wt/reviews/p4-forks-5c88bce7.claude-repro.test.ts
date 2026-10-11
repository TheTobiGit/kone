import { expect, mock, test } from "bun:test";
const root = "/home/gideonsarfo/Developer/kone-wt/p4-forks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const { setUserDataDir } = await import(`${root}/packages/agent-core/src/userDataDir.ts`);
const dataDir = mkdtempSync(path.join(tmpdir(), "p4-claude-review-"));
setUserDataDir(dataDir);
let options: any;
mock.module(`${root}/packages/agent-core/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, () => ({
  forkSession: async () => ({ sessionId: "fork-session" }),
  query: (input: any) => {
    options = input.options;
    return { initializationResult: async () => ({}), async *[Symbol.asyncIterator]() {} };
  },
}));
const { ClaudeAdapter } = await import(`${root}/packages/agent-core/src/adapters/ClaudeAdapter.ts`);
test("F5 fork session publishes its source UUID as a resume cursor even though forkSession remaps UUIDs", async () => {
  const events: any[] = [];
  const adapter = new ClaudeAdapter((event: any) => events.push(event));
  await adapter.startSession({ threadId: "fork", provider: "claudeAgent", cwd: "/tmp", forkFrom: { conversationId: "source-session", assistantUuid: "source-uuid" } });
  expect(options.resume).toBe("fork-session");
  expect(options.resumeSessionAt).toBeUndefined();
  const started = events.find((e) => e.type === "session.started");
  expect(started.refs.resumeSessionAt).toBe("source-uuid");
  await adapter.stopAll();
  rmSync(dataDir, { recursive: true, force: true });
});
