import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import { HAND_IN_MESSAGE_TOO_LONG } from "./handIn.js";
import { cacheStatuses } from "./providerCache.js";
import type { EmitEvent, ProviderAdapter, ProviderKind, SendTurnInput, TurnStartResult } from "./types.js";

class DatabaseSyncShim {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly ? new Database(filePath, { readonly: true }) : new Database(filePath);
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

mock.module("./sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

type ConversationStoreType = import("./ConversationStore.js").ConversationStore;
type AgentServiceType = import("./AgentService.js").AgentService;
let getConversationStore: typeof import("./ConversationStore.js").getConversationStore;
let resetConversationStoreForTests: typeof import("./ConversationStore.js").resetConversationStoreForTests;
let AgentServiceCtor: typeof import("./AgentService.js").AgentService;

class FakeProv {
  capabilities = {
    sessionModelSwitch: "unsupported" as const,
    streamsText: false,
    supportsToolEvents: false,
    supportsResume: false,
    supportsModelList: false,
    supportsSubagents: false,
    cancelKeepsCompletedTools: false,
  };
  sent: SendTurnInput[] = [];
  starts = 0;
  stops = 0;
  private turns = 0;
  private readonly emit: EmitEvent;
  constructor(readonly provider: ProviderKind, emit: EmitEvent) {
    this.emit = emit;
  }
  private base(threadId: string) {
    return { threadId, provider: this.provider, at: Date.now(), source: "kone.store" as const };
  }
  startTurn(threadId: string, turnId: string): void {
    this.emit({ ...this.base(threadId), type: "turn.started", turnId });
  }
  async startSession(): Promise<object> {
    this.starts += 1;
    return {};
  }
  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    this.sent.push(input);
    const turnId = `t-${this.provider}-${++this.turns}`;
    this.emit({ ...this.base(input.threadId), type: "turn.started", turnId });
    return { threadId: input.threadId, turnId };
  }
  finishTurn(threadId: string, turnId: string): void {
    this.emit({ ...this.base(threadId), type: "turn.completed", turnId });
  }
  async stopSession(): Promise<void> {
    this.stops += 1;
  }
  async stopAll(): Promise<void> {}
  async listSessions(): Promise<unknown[]> {
    return [];
  }
  async hasSession(): Promise<boolean> {
    return false;
  }
  async discover(): Promise<unknown[]> {
    return [];
  }
  async listModels(): Promise<unknown[]> {
    return [];
  }
}

let tmpDir = "";
let store: ConversationStoreType;
let service: AgentServiceType;
let codex: FakeProv;
let claude: FakeProv;
let seq = 0;

beforeAll(async () => {
  const storeModule = await import("./ConversationStore.js");
  getConversationStore = storeModule.getConversationStore;
  resetConversationStoreForTests = storeModule.resetConversationStoreForTests;
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
});

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "kone-p5-test-"));
  setUserDataDir(tmpDir);
  resetConversationStoreForTests();
  // The same singleton the hand-in and replay paths reach, so every writer and
  // reader is one store on one file.
  store = getConversationStore();
  cacheStatuses([]);
  service = new AgentServiceCtor({
    store,
    historyStore: store,
    selectionStore: store,
    checkpointStore: null,
    retentionSweepMs: 0,
    wedgeSweepMs: 60_000,
    idleSweepMs: 60_000,
    queueRetryDelaysMs: [20, 20],
    adapters: (emit) => {
      codex = new FakeProv("codex", emit);
      claude = new FakeProv("claudeAgent", emit);
      // SAFETY: the fakes cover every adapter method these paths reach.
      return [codex, claude] as ProviderAdapter[];
    },
  });
});

afterEach(() => {
  resetConversationStoreForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  await service?.stopAll();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function waitFor(check: () => boolean, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3_000) throw new Error(`timed out waiting for ${label}`);
    await tick();
  }
}

/** A codex thread with one settled exchange and a live session. */
async function openCodexThread(): Promise<string> {
  const threadId = `t-${++seq}`;
  store.ensureThread({ threadId, projectPath: "/repo", provider: "codex", model: "gpt-5" });
  store.recordUserBlock({ blockId: `ub-${threadId}`, threadId, text: "first question", at: 1 });
  store.applyEvent({ type: "turn.started", threadId, provider: "codex", at: 2, source: "kone.store", turnId: "seed" });
  store.applyEvent({
    type: "item.updated",
    threadId,
    turnId: "seed",
    provider: "codex",
    at: 3,
    source: "kone.store",
    item: { itemId: "i-seed", kind: "assistant_text", status: "completed", text: "first answer" },
  });
  store.applyEvent({ type: "turn.completed", threadId, provider: "codex", at: 4, source: "kone.store", turnId: "seed" });
  await service.startSession({ threadId, provider: "codex", cwd: "/tmp", mode: "ask" });
  return threadId;
}

function liveTurn(threadId: string, turnId: string): void {
  codex.startTurn(threadId, turnId);
}

describe("queued provider switches at delivery", () => {
  test("two switches apply in order, each handing the thread over", async () => {
    const thread = await openCodexThread();
    liveTurn(thread, "live-1");

    // Queue a switch to claude, then a switch back to codex, while busy.
    const first = await service.sendTurn({
      threadId: thread,
      input: "do it on claude",
      provider: "claudeAgent",
      model: "claude-x",
      userBlockId: "ub-sw1",
    });
    const second = await service.sendTurn({
      threadId: thread,
      input: "back on codex",
      provider: "codex",
      model: "gpt-5",
      userBlockId: "ub-sw2",
    });
    expect(first.queued).toBe(true);
    expect(second.queued).toBe(true);

    const rows = store.listQueuedTurns(thread);
    expect(rows.map((r) => r.provider)).toEqual(["claudeAgent", "codex"]);

    // End the live turn: the drain hands over to claude and runs row one.
    codex.finishTurn(thread, "live-1");
    await waitFor(() => claude.sent.length === 1, "claude's first turn");
    expect(codex.stops).toBe(1);
    expect(store.threadMeta(thread)?.provider).toBe("claudeAgent");
    expect(claude.sent[0]?.input).toContain("do it on claude");
    expect(claude.sent[0]?.input).toContain("first question");

    // Finish claude's turn: the drain hands back to codex for row two.
    const claudeTurn = claude.sent.length;
    claude.finishTurn(thread, `t-claudeAgent-${claudeTurn}`);
    await waitFor(() => codex.sent.length === 1, "codex's second turn");
    expect(claude.stops).toBe(1);
    expect(store.threadMeta(thread)?.provider).toBe("codex");
    expect(codex.sent[0]?.input).toContain("back on codex");
  });

  test("a no-op second pick runs without a hand-in", async () => {
    const thread = await openCodexThread();
    liveTurn(thread, "live-1");
    await service.sendTurn({ threadId: thread, input: "one", provider: "claudeAgent", model: "claude-x", userBlockId: "ub-1" });
    await service.sendTurn({ threadId: thread, input: "two", provider: "claudeAgent", model: "claude-x", userBlockId: "ub-2" });
    codex.finishTurn(thread, "live-1");

    await waitFor(() => claude.sent.length === 1, "claude's first turn");
    claude.finishTurn(thread, "t-claudeAgent-1");
    await waitFor(() => claude.sent.length === 2, "claude's second turn");
    // One hand-in only: the second row's provider already owns the thread.
    expect(codex.stops).toBe(1);
    expect(claude.starts).toBe(1);
    expect(claude.sent[1]?.input).toContain("two");
  });

  test("an unavailable target refuses the row, keeps the owner, and the queue continues", async () => {
    cacheStatuses([
      {
        provider: "claudeAgent",
        label: "Claude",
        available: false,
        authStatus: "unknown",
        readiness: "not-installed",
        enabled: true,
        message: "Claude is not installed on this machine.",
      },
    ]);
    const thread = await openCodexThread();
    liveTurn(thread, "live-1");
    await service.sendTurn({ threadId: thread, input: "switch", provider: "claudeAgent", userBlockId: "ub-1" });
    await service.sendTurn({ threadId: thread, input: "stays codex", provider: "codex", userBlockId: "ub-2" });
    codex.finishTurn(thread, "live-1");

    await waitFor(() => codex.sent.some((s) => s.input.includes("stays codex")), "the row behind to run");
    const refused = store.listQueuedTurns(thread).find((r) => r.userBlockId === "ub-1");
    expect(refused?.state).toBe("refused");
    expect(refused?.refusalReason).toBe("Claude is not installed on this machine.");
    expect(store.threadMeta(thread)?.provider).toBe("codex");
    expect(codex.stops).toBe(0);
    expect(claude.starts).toBe(0);
  });

  test("a replay that cannot fit the P1 budget refuses with P1's reason", async () => {
    const thread = await openCodexThread();
    liveTurn(thread, "live-1");
    const huge = "x".repeat(200_000);
    await service.sendTurn({ threadId: thread, input: huge, provider: "claudeAgent", userBlockId: "ub-huge" });
    codex.finishTurn(thread, "live-1");

    await waitFor(
      () => store.listQueuedTurns(thread).some((r) => r.state === "refused"),
      "the over-long row to refuse",
    );
    const refused = store.listQueuedTurns(thread).find((r) => r.userBlockId === "ub-huge");
    expect(refused?.refusalReason).toBe(HAND_IN_MESSAGE_TOO_LONG);
    expect(store.threadMeta(thread)?.provider).toBe("codex");
    expect(codex.stops).toBe(0);
  });
});

describe("pending selection at turn end", () => {
  test("a pick made while busy applies at turn end with no turn", async () => {
    const thread = await openCodexThread();
    liveTurn(thread, "live-1");
    service.setPendingSelection(thread, { provider: "claudeAgent", model: "claude-x" });
    expect(store.pendingSelection(thread)).toEqual({ provider: "claudeAgent", model: "claude-x" });

    codex.finishTurn(thread, "live-1");
    await waitFor(() => store.threadMeta(thread)?.provider === "claudeAgent", "the hand-over");
    expect(claude.starts).toBe(1);
    expect(claude.sent).toHaveLength(0);
    expect(store.pendingSelection(thread)).toBeNull();
  });

  test("a pick with rows queued waits until the queue is empty", async () => {
    const thread = await openCodexThread();
    liveTurn(thread, "live-1");
    await service.sendTurn({ threadId: thread, input: "queued row", provider: "codex", userBlockId: "ub-1" });
    service.setPendingSelection(thread, { provider: "claudeAgent", model: "claude-x" });
    codex.finishTurn(thread, "live-1");

    // The queued row runs first, on codex (no switch), and the pending waits.
    await waitFor(() => codex.sent.some((s) => s.input.includes("queued row")), "the queued row");
    expect(store.threadMeta(thread)?.provider).toBe("codex");
    codex.finishTurn(thread, "t-codex-1");

    await waitFor(() => store.threadMeta(thread)?.provider === "claudeAgent", "the pending to apply");
    expect(claude.sent).toHaveLength(0);
  });
});

describe("self-switch", () => {
  test("an idle self-switch writes the selection now and records the knobs", async () => {
    const thread = await openCodexThread();
    const outcome = await service.switchOwnSelection(thread, {
      provider: "claudeAgent",
      model: "claude-x",
      effort: "high",
    });
    expect(outcome).toEqual({
      applied: "direct",
      selection: { provider: "claudeAgent", model: "claude-x", effort: "high" },
    });
    expect(store.threadMeta(thread)?.provider).toBe("claudeAgent");
    expect(store.getProviderModelOptions("claudeAgent", "claude-x")?.knobs.effort).toBe("high");
  });

  test("returning to a provider/model restores the knobs it last ran with", async () => {
    const thread = await openCodexThread();
    await service.switchOwnSelection(thread, { provider: "claudeAgent", model: "claude-x", effort: "high" });
    // Away and back, naming no effort the second time.
    await service.switchOwnSelection(thread, { provider: "codex", model: "gpt-5" });
    const back = await service.switchOwnSelection(thread, { provider: "claudeAgent", model: "claude-x" });
    expect(back).toEqual({
      applied: "direct",
      selection: { provider: "claudeAgent", model: "claude-x", effort: "high" },
    });
  });

  test("a switch on a fork before its first message retargets the placeholder", async () => {
    const source = await openCodexThread();
    const forkId = `fork-${++seq}`;
    const { forkThreadAtTurn } = await import("./threadFork.js");
    const result = forkThreadAtTurn({
      requestId: `req-${seq}`,
      threadId: forkId,
      sourceThreadId: source,
      turnId: "seed",
      userBlockId: null,
      target: { provider: "codex", model: "gpt-5" },
    });
    expect(result.status).toBe("created");
    expect(store.threadForkContext(forkId)?.bootstrapStatus).toBe("pending");

    const outcome = await service.switchOwnSelection(forkId, { provider: "claudeAgent", model: "claude-x" });
    expect(outcome).toEqual({
      applied: "direct",
      selection: { provider: "claudeAgent", model: "claude-x" },
    });
    expect(store.threadMeta(forkId)?.provider).toBe("claudeAgent");
    // Nothing was handed in: a placeholder has no session to replace.
    expect(claude.starts).toBe(0);
    expect(codex.stops).toBe(0);
  });

  test("a busy self-switch becomes pending and never interrupts", async () => {
    const thread = await openCodexThread();
    liveTurn(thread, "live-1");
    const outcome = await service.switchOwnSelection(thread, { provider: "claudeAgent", model: "claude-x" });
    expect(outcome.applied).toBe("pending");
    expect(store.pendingSelection(thread)?.provider).toBe("claudeAgent");
    // The live codex turn is untouched.
    expect(codex.stops).toBe(0);
    expect(store.threadMeta(thread)?.provider).toBe("codex");
  });
});
