// Kill-path and resume-handshake hardening for the Claude adapter.
//
// (termination-first stops, acknowledged subagent stops settled
// synthetically so the UI can't render a forever-running run, bounded
// stop-path provider calls). The SDK `query` is stubbed (mock.module, per the
// claudeGatewayInjection.test.ts pattern) so no real `claude` subprocess is
// spawned; the adapter is imported dynamically so the stub is in place first.

import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import { Database } from "bun:sqlite";

// The adapter transitively imports ConversationStore (via AttachmentStore),
// which loads node:sqlite — an Electron-runtime builtin this bun can't load.
// Stand it in with bun:sqlite and point the agent layer's state dir at a
// throwaway dir, the same pattern claudeGatewayInjection.test.ts uses.
const testUserDataDir = mkdtempSync(path.join(tmpdir(), "kone-claude-adapter-"));
mock.module("./sqlite.js", () => ({
  DatabaseSync: Database,
}));
setUserDataDir(testUserDataDir);

import type { RuntimeEvent } from "./types.js";

/** The events of exactly one type.
 *  SAFETY: the predicate compares e.type to the requested literal, so each
 *  element really is that union member. */
function ofType<T extends RuntimeEvent["type"]>(events: RuntimeEvent[], type: T) {
  return events.filter((e): e is Extract<RuntimeEvent, { type: T }> => e.type === type);
}

/** Controllable SDK message feed: the stubbed query yields exactly what the
 *  test pushes, when it pushes it. */
class MessageFeed {
  private readonly items: Array<Record<string, unknown>> = [];
  private waiter: ((item: IteratorResult<Record<string, unknown>>) => void) | null = null;

  push(message: Record<string, unknown>): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: message, done: false });
    } else {
      this.items.push(message);
    }
  }

  end(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>> {
    while (true) {
      const item = await new Promise<IteratorResult<Record<string, unknown>>>((resolve) => {
        if (this.items.length > 0) resolve({ value: this.items.shift()!, done: false });
        else this.waiter = resolve;
      });
      if (item.done) return;
      yield item.value;
    }
  }
}

type AdapterHarnessState = {
  feed: MessageFeed | null;
  stopTask: ReturnType<typeof mock> | null;
  interrupt: ReturnType<typeof mock> | null;
  /** The prompt iterable the SDK would pull from (the adapter's MessageQueue,
   *  passed as `query({ prompt })`). Captured at query() time; tests pull
   *  from it to assert what was offered into the queue — and that close()
   *  drops what was never pulled. */
  promptIterable: AsyncIterable<Record<string, unknown>> | null;
  /** The stubbed SDK's initializationResult — the adapter's request/ack point.
   *  Tests drive resume failures here (transport vs. refusal). */
  initializationResult: ReturnType<typeof mock> | null;
};

const state: AdapterHarnessState = { feed: null, stopTask: null, interrupt: null, promptIterable: null, initializationResult: null };

const stubQuery = mock((input: unknown) => {
  state.promptIterable =
    // SAFETY: the SDK query input carries the prompt iterable under `prompt`.
    (input as { prompt?: AsyncIterable<Record<string, unknown>> }).prompt ?? null;
  return {
    initializationResult: async () => state.initializationResult?.() ?? {},
    interrupt: () => state.interrupt?.(),
    stopTask: (taskId: string) => state.stopTask?.(taskId),
    setPermissionMode: async () => {},
    applyFlagSettings: async () => {},
    close: () => {},
    [Symbol.asyncIterator]: () =>
      state.feed ? state.feed[Symbol.asyncIterator]() : (async function* () {})(),
  };
});

mock.module("@anthropic-ai/claude-agent-sdk", () => ({ query: stubQuery }));

// Must be a dynamic import: a static import is hoisted above the mock.module
// calls, which defeats both stubs (see claudeGatewayInjection.test.ts).
const { ClaudeAdapter } = await import("./adapters/ClaudeAdapter.js");

const THREAD = "thread-1";

function setup() {
  const events: RuntimeEvent[] = [];
  const adapter = new ClaudeAdapter((event) => events.push(event));
  state.feed = new MessageFeed();
  state.stopTask = mock(async () => {});
  state.interrupt = mock(async () => {});
  state.initializationResult = mock(async () => ({}));
  state.promptIterable = null;
  return { adapter, events };
}

async function start(adapter: ClaudeAdapter): Promise<void> {
  await adapter.startSession({ threadId: THREAD, provider: "claudeAgent", cwd: "/tmp/kone-test-project" });
}

/** Let consume() drain the pushed messages (the for-await resumes on a
 *  microtask after push resolves the waiter). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

/** A turn with a live subagent run (`tool-1` → task `task-1`), the shape every
 *  stop-path test starts from. */
async function liveTurnWithSubagent(
  adapter: ClaudeAdapter,
): Promise<{ turnId: string }> {
  await start(adapter);
  const { turnId } = await adapter.sendTurn({
    threadId: THREAD,
    provider: "claudeAgent",
    input: "hello",
  });
  state.feed!.push({
    type: "system",
    subtype: "task_started",
    task_id: "task-1",
    tool_use_id: "tool-1",
  });
  await flush();
  return { turnId };
}

describe("Claude result handler", () => {
  test("result with no active turn (resume handshake) keeps usage, drops the lifecycle event, tripwires", async () => {
    const { adapter, events } = setup();
    await start(adapter);

    const warnCalls: unknown[][] = [];
    const originalWarn = console.warn;
    // SAFETY: the replacement keeps console.warn's call signature; only the
    // arguments are recorded.
    console.warn = ((...args: unknown[]) => {
      warnCalls.push(args);
    }) as typeof console.warn;
    try {
      state.feed!.push({
        type: "result",
        subtype: "success",
        num_turns: 0,
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      await flush();
    } finally {
      console.warn = originalWarn;
    }

    // Usage is still folded in...
    const usage = events.filter((e) => e.type === "thread.token-usage.updated");
    expect(usage).toHaveLength(1);
    expect(ofType(usage, "thread.token-usage.updated")[0].usage.total).toBe(15);
    // ...but no untargeted lifecycle event for a turn that never ran.
    expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "turn.aborted")).toHaveLength(0);
    expect(warnCalls.length).toBe(1);
    // SAFETY: the adapter warns with (message, payload) and this payload's fields are probed below.
    const payload = warnCalls[0][1] as { status?: string; numTurns?: number; hasUsage?: boolean };
    expect(payload.status).toBe("success");
    expect(payload.numTurns).toBe(0);
    expect(payload.hasUsage).toBe(true);
  });

  test("result with a live turn still completes it", async () => {
    const { adapter, events } = setup();
    await start(adapter);
    const { turnId } = await adapter.sendTurn({
      threadId: THREAD,
      provider: "claudeAgent",
      input: "hello",
    });
    state.feed!.push({
      type: "result",
      subtype: "success",
      num_turns: 1,
      is_error: false,
      usage: { input_tokens: 5 },
    });
    await flush();

    const completed = events.filter((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(completed).toHaveLength(1);
  });
});

describe("Claude stop paths", () => {
  test("stopSession settles live subagents as stopped, seals the turn, emits session.exited exactly once, evicts", async () => {
    const { adapter, events } = setup();
    const { turnId } = await liveTurnWithSubagent(adapter);

    await adapter.stopSession(THREAD);

    // Every live run got a terminal event with status stopped — the synthetic
    // settle that makes the UI authoritative even if the SDK notification
    // loses the race.
    const done = events.filter((e) => e.type === "subagent.completed");
    expect(done).toHaveLength(1);
    expect(ofType(done, "subagent.completed")[0].subagent.status).toBe(
      "stopped",
    );
    expect(ofType(done, "subagent.completed")[0].turnId).toBe(turnId);

    const aborted = events.filter(
      (e) => e.type === "turn.aborted" && e.turnId === turnId && e.reason === "interrupted",
    );
    expect(aborted).toHaveLength(1);

    // Terminal session.exited once — and not again when the stream drain ends.
    expect(events.filter((e) => e.type === "session.exited")).toHaveLength(1);
    expect(await adapter.hasSession(THREAD)).toBe(false);
    state.feed!.end();
    await flush();
    expect(events.filter((e) => e.type === "session.exited")).toHaveLength(1);
  });

  test("stopAll seals every session's turn and emits one exit per session", async () => {
    const { adapter, events } = setup();
    await liveTurnWithSubagent(adapter);

    await adapter.stopAll();

    const exited = events.filter((e) => e.type === "session.exited");
    expect(exited).toHaveLength(1);
    const aborted = events.filter((e) => e.type === "turn.aborted" && e.reason === "interrupted");
    expect(aborted).toHaveLength(1);
    const done = events.filter((e) => e.type === "subagent.completed");
    expect(done).toHaveLength(1);
    expect(ofType(done, "subagent.completed")[0].subagent.status).toBe(
      "stopped",
    );
    state.feed!.end();
    await flush();
  });

  test("stopSubagent: an acknowledged stop settles the run synthetically", async () => {
    const { adapter, events } = setup();
    await liveTurnWithSubagent(adapter);

    await adapter.stopSubagent(THREAD, "tool-1");

    expect(state.stopTask).toHaveBeenCalledWith("task-1");
    const done = events.filter((e) => e.type === "subagent.completed");
    expect(done).toHaveLength(1);
    expect(ofType(done, "subagent.completed")[0].subagent.status).toBe(
      "stopped",
    );
  });

  test("stopSubagent: a refused stop is left to the notification (no synthetic settle)", async () => {
    const { adapter, events } = setup();
    await liveTurnWithSubagent(adapter);
    state.stopTask = mock(async () => {
      throw new Error("already gone");
    });

    await adapter.stopSubagent(THREAD, "tool-1");

    expect(events.filter((e) => e.type === "subagent.completed")).toHaveLength(0);
  });

  test("interruptTurn stops live subagent tasks, settles acknowledged ones, and interrupts the turn", async () => {
    const { adapter, events } = setup();
    await liveTurnWithSubagent(adapter);

    await adapter.interruptTurn(THREAD);

    expect(state.stopTask).toHaveBeenCalledWith("task-1");
    expect(state.interrupt).toHaveBeenCalled();
    const done = events.filter((e) => e.type === "subagent.completed");
    expect(done).toHaveLength(1);
    expect(ofType(done, "subagent.completed")[0].subagent.status).toBe(
      "stopped",
    );
  });
});

describe("Claude steerTurn", () => {
  test("steer with a live turn: no turn.started, same turn id, message offered to the queue, turn.steered", async () => {
    const { adapter, events } = setup();
    await start(adapter);
    const { turnId } = await adapter.sendTurn({
      threadId: THREAD,
      provider: "claudeAgent",
      input: "hello",
    });

    // The SDK's streamInput would pull the first prompt eagerly; in the
    // harness nothing pulls, so drain it to leave only the steer queued.
    const iterator = state.promptIterable![Symbol.asyncIterator]();
    await iterator.next();

    const result = await adapter.steerTurn({
      threadId: THREAD,
      provider: "claudeAgent",
      input: "keep going",
    });

    // The ack names the LIVE turn — no phantom second turn.
    expect(result.turnId).toBe(turnId);
    // No new turn boundary.
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    const sessions = await adapter.listSessions();
    expect(sessions[0]?.activeTurnId).toBe(turnId);

    // The message was offered into the prompt queue...
    const { value, done } = await iterator.next();
    expect(done).toBe(false);
    // SAFETY: the queued steer round-trips through the adapter as a user message with text blocks.
    const content = (value as { message: { content: Array<{ text: string }> } }).message.content;
    expect(content[0]?.text).toBe("keep going");

    // ...and announced as a steer into the live turn.
    const steered = events.filter((e) => e.type === "turn.steered");
    expect(steered).toHaveLength(1);
    expect(ofType(steered, "turn.steered")[0].turnId).toBe(turnId);
    expect(ofType(steered, "turn.steered")[0].message).toBe(
      "keep going",
    );
  });

  test("steer with a session but no active turn falls back to sendTurn", async () => {
    const { adapter, events } = setup();
    await start(adapter);

    const result = await adapter.steerTurn({
      threadId: THREAD,
      provider: "claudeAgent",
      input: "hello",
    });

    const started = events.filter((e) => e.type === "turn.started");
    expect(started).toHaveLength(1);
    expect(ofType(started, "turn.started")[0].turnId).toBe(
      result.turnId,
    );
    expect(events.filter((e) => e.type === "turn.steered")).toHaveLength(0);
    // The fallback opened a real turn: activeTurnId now names it.
    const sessions = await adapter.listSessions();
    expect(sessions[0]?.activeTurnId).toBe(result.turnId);
  });

  test("steer with no session falls back to sendTurn, which rejects", async () => {
    const { adapter, events } = setup();

    await expect(
      adapter.steerTurn({ threadId: THREAD, provider: "claudeAgent", input: "hello" }),
    ).rejects.toThrow("No Claude session");
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(0);
  });

  test("stopSession after a steer closes the queue and drops the unconsumed steer", async () => {
    const { adapter } = setup();
    await start(adapter);
    await adapter.sendTurn({
      threadId: THREAD,
      provider: "claudeAgent",
      input: "hello",
    });
    const iterator = state.promptIterable![Symbol.asyncIterator]();
    await iterator.next();

    await adapter.steerTurn({
      threadId: THREAD,
      provider: "claudeAgent",
      input: "keep going",
    });
    await adapter.stopSession(THREAD);

    // The queue is shutdown: the parked steer is dropped, never delivered.
    const { done } = await iterator.next();
    expect(done).toBe(true);
  });
});

describe("Claude startSession resume fallback", () => {
  test("startSession surfaces a transport failure instead of masking it with a fresh start", async () => {
    const { adapter } = setup();
    let attempts = 0;
    state.initializationResult = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("connection refused");
      return {};
    });

    await expect(
      adapter.startSession({
        threadId: THREAD,
        provider: "claudeAgent",
        cwd: "/tmp/kone-test-project",
        resume: "conv-42",
      }),
    ).rejects.toThrow("connection refused");
  });

  test("startSession falls back to a fresh conversation only on a missing-resume refusal", async () => {
    const { adapter } = setup();
    let calls = 0;
    state.initializationResult = mock(async () => {
      calls += 1;
      if (calls === 1) throw new Error("No conversation found with session ID: abc");
      return {};
    });

    const session = await adapter.startSession({
      threadId: THREAD,
      provider: "claudeAgent",
      cwd: "/tmp/kone-test-project",
      resume: "abc",
    });

    expect(session.resumedFrom).toBeUndefined();
    expect(state.initializationResult).toHaveBeenCalledTimes(2);
  });
});
