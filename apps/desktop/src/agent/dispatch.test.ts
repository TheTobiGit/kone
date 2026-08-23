import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import type {
  EmitEvent,
  ProviderAdapter,
  QueuedTurnStore,
  RuntimeEvent,
  SendTurnInput,
  TurnStartResult,
} from "./types.js";

// The thread dispatcher against a REAL ConversationStore and a real
// AgentService, with only the provider adapter faked. The store is what makes
// these tests worth having: the defect they lock down — a steer that never
// reached recordUserBlock — was invisible to a fake queue store that journaled
// a block of its own on every enqueue.
//
// ConversationStore imports node:sqlite (an Electron built-in this bun can't
// load); stand it in for bun:sqlite and point the state dir at a temp dir, the
// same pattern conversationStore.test.ts uses.
setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-dispatch-test-")));
mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

const THREAD = "t-dispatch";
const CWD = "/tmp/kone-dispatch";

/** Records what reached the provider, and whether a live-steer channel exists
 *  — Codex/Cursor/Droid/Antigravity have none, so their steers take the queue's
 *  steer lane, which is where the userBlockId collision lived. */
class FakeAdapter {
  provider = "codex" as const;
  capabilities = {
    sessionModelSwitch: "unsupported" as const,
    streamsText: false,
    supportsToolEvents: false,
    supportsResume: false,
    supportsModelList: false,
    supportsSubagents: false,
  };
  static sent: string[] = [];
  static turnCounter = 0;
  constructor(readonly emit: EmitEvent) {}
  async discover(): Promise<never[]> {
    return [];
  }
  async listModels(): Promise<never[]> {
    return [];
  }
  async startSession(): Promise<{ threadId: string; provider: "codex" }> {
    return { threadId: THREAD, provider: "codex" };
  }
  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    FakeAdapter.sent.push(input.input);
    return { threadId: input.threadId, turnId: `turn-${++FakeAdapter.turnCounter}` };
  }
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async respondToUserInput(): Promise<void> {}
  async listSessions(): Promise<never[]> {
    return [];
  }
  async hasSession(): Promise<boolean> {
    return false;
  }
}

type StoreType = import("./ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;
let AgentServiceCtor: typeof import("./AgentService.js").AgentService;
let initThreadDispatcher: typeof import("./dispatch.js").initThreadDispatcher;

beforeAll(async () => {
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
  initThreadDispatcher = (await import("./dispatch.js")).initThreadDispatcher;
});

/** A dispatcher wired to a fresh store, a real service, and one fake adapter,
 *  with the thread already registered and its session up. */
async function harness(): Promise<{
  store: StoreType;
  dispatcher: import("./dispatch.js").ThreadDispatcher;
  emit: EmitEvent;
  service: import("./AgentService.js").AgentService;
}> {
  setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-dispatch-test-")));
  const store = new ConversationStoreCtor();
  let captured: EmitEvent | undefined;
  const service = new AgentServiceCtor({
    // SAFETY: the real store satisfies the queue slice the service reads.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    store: store as unknown as QueuedTurnStore,
    adapters: (emit) => {
      captured = emit;
      // SAFETY: one fake adapter is the whole provider roster here.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      return [new FakeAdapter(emit) as unknown as ProviderAdapter];
    },
  });
  const dispatcher = initThreadDispatcher({ service, store, broadcast: () => {} });
  store.ensureThread({ threadId: THREAD, projectPath: CWD, provider: "codex" });
  await dispatcher.startThread({ threadId: THREAD, provider: "codex", cwd: CWD });
  if (!captured) throw new Error("the fake adapter was not constructed");
  return { store, dispatcher, emit: captured, service };
}

/** The user-visible transcript: what reopening the thread would show. */
function userTexts(store: StoreType): string[] {
  return userBlocks(store).map((b) => b.text);
}

/** The thread's journaled user blocks, id and text. */
function userBlocks(store: StoreType): Array<{ id: string; text: string }> {
  const thread = store.loadThread(THREAD);
  if (!thread) return [];
  const out: Array<{ id: string; text: string }> = [];
  for (const block of thread.blocks) {
    if (block.role !== "user") continue;
    // SAFETY: the store's user blocks carry the prompt text.
    const text = (block as { text?: string }).text ?? "";
    out.push({ id: block.id, text });
  }
  return out;
}

function turnStarted(emit: EmitEvent, turnId: string): void {
  // SAFETY: this is a complete turn.started literal — the exact event shape a
  // provider adapter emits when its turn begins.
  const started = {
    type: "turn.started",
    threadId: THREAD,
    provider: "codex",
    turnId,
    at: Date.now(),
    source: "codex.app-server",
  } as RuntimeEvent;
  emit(started);
}

describe("thread dispatcher: a steer is the user speaking", () => {
  beforeEach(() => {
    FakeAdapter.sent.length = 0;
    FakeAdapter.turnCounter = 0;
  });

  test("a steer lands in the transcript, like a send", async () => {
    const { store, dispatcher, emit } = await harness();
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "first message" });
    turnStarted(emit, "turn-1");

    await dispatcher.steerThreadTurn({ threadId: THREAD, input: "actually, use the other file" });

    // Routing steers straight at AgentService skipped recordUserBlock, so
    // reopening the thread showed the agent reacting to a message that wasn't
    // there.
    expect(userTexts(store)).toEqual(["first message", "actually, use the other file"]);
  });

  test("two steers are two queue rows, not one swallowed as a replay", async () => {
    const { store, dispatcher, emit, service } = await harness();
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "first message" });
    turnStarted(emit, "turn-1");

    await dispatcher.steerThreadTurn({ threadId: THREAD, input: "steer one" });
    await dispatcher.steerThreadTurn({ threadId: THREAD, input: "steer two" });

    // Each steer journals its own block, so each queue row anchors to its own
    // message. Deriving both from the previous send's block collided them on
    // the (thread_id, user_block_id) index and the second was acked as an
    // idempotent replay — the user's message simply vanished.
    const rows = await service.listQueuedTurns(THREAD);
    expect(rows.map((r) => r.input)).toEqual(["steer two", "steer one"]); // newest steer claims first
    expect(new Set(rows.map((r) => r.userBlockId)).size).toBe(2);
    expect(userTexts(store)).toEqual(["first message", "steer one", "steer two"]);
  });

  test("each queue row anchors to its OWN user block", async () => {
    const { store, dispatcher, emit, service } = await harness();
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "first message" });
    turnStarted(emit, "turn-1");
    await dispatcher.steerThreadTurn({ threadId: THREAD, input: "steer one" });

    const steerBlock = userBlocks(store).find((b) => b.text === "steer one");
    const [row] = await service.listQueuedTurns(THREAD);
    // The renderer hangs the queued chip off this block — anchoring it to the
    // previous send put the chip under the wrong message.
    expect(row?.userBlockId).toBe(steerBlock?.id);
  });

  test("a steer with no live turn is a plain send, and still journaled", async () => {
    const { store, dispatcher } = await harness();

    await dispatcher.steerThreadTurn({ threadId: THREAD, input: "start here" });

    expect(FakeAdapter.sent).toEqual(["start here"]);
    expect(userTexts(store)).toEqual(["start here"]);
    // First user turn on the thread — it names it, exactly like a send would.
    expect(store.getTitle(THREAD)).toBeTruthy();
  });
});
