import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { callSignFor } from "@kone/protocol/agent-call-sign";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { composeTurnDelivery } from "./dispatch.js";
import { isWorkspaceCancel } from "@kone/protocol/ipc-error";
import { setUserDataDir } from "./userDataDir.js";
import type {
  EmitEvent,
  ProviderAdapter,
  QueuedTurnStore,
  RuntimeEvent,
  SendTurnInput,
  SessionStartInput,
  TurnStartResult,
  UserInputRespondResult,
} from "./types.js";
import { assistantWorkingDir } from "./assistantWorkspace.js";
import { GLOBAL_ASSISTANT_PROJECT_PATH, type CheckpointStore } from "./conversationStoreTypes.js";

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
const CWD = path.join(tmpdir(), "kone-dispatch");
let lastDataDir = "";

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
  static sentSkills: Array<SendTurnInput["skills"]> = [];
  static startedCwds: string[] = [];
  static startedAgents: Array<SessionStartInput["agent"]> = [];
  /** The conversation each session start asked to resume. */
  static startedResumes: Array<string | undefined> = [];
  /** Whether the adapter still holds a session for the thread — what an exit
   *  from a session it has since replaced looks like. */
  static holding = false;
  static turnCounter = 0;
  /** The provider refuses the next turn sent to it. */
  static refuseNext: Error | null = null;
  constructor(readonly emit: EmitEvent) {}
  async discover(): Promise<never[]> {
    return [];
  }
  async listModels(): Promise<never[]> {
    return [];
  }
  async startSession(
    input: Pick<SessionStartInput, "threadId" | "cwd" | "agent" | "resume">,
  ): Promise<{ threadId: string; provider: "codex" }> {
    // The directory a provider process would have been spawned in. Recorded
    // before the gate so a test can tell the session has started coming up.
    FakeAdapter.startedCwds.push(input.cwd);
    FakeAdapter.startedAgents.push(input.agent);
    FakeAdapter.startedResumes.push(input.resume);
    if (startGate) await startGate;
    return { threadId: input.threadId, provider: "codex" };
  }
  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const refused = FakeAdapter.refuseNext;
    FakeAdapter.refuseNext = null;
    if (refused) throw refused;
    FakeAdapter.sent.push(input.input);
    FakeAdapter.sentSkills.push(input.skills);
    return { threadId: input.threadId, turnId: `turn-${++FakeAdapter.turnCounter}` };
  }
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async respondToUserInput(): Promise<UserInputRespondResult> {
    return { owned: true };
  }
  async listSessions(): Promise<never[]> {
    return [];
  }
  async hasSession(): Promise<boolean> {
    return FakeAdapter.holding;
  }
}

type StoreType = import("./ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;
let AgentServiceCtor: typeof import("./AgentService.js").AgentService;
let initThreadDispatcher: typeof import("./dispatch.js").initThreadDispatcher;
let IrcMailboxCtor: typeof import("./gateway/tools/irc.js").IrcMailbox;

beforeAll(async () => {
  IrcMailboxCtor = (await import("./gateway/tools/irc.js")).IrcMailbox;
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
  initThreadDispatcher = (await import("./dispatch.js")).initThreadDispatcher;
});

/** A dispatcher wired to a fresh store, a real service, and one fake adapter,
 *  with the thread already registered and its session up. */
/** What the injected provisioner was asked for. The real one runs git; here the
 *  point is the ordering around it, not the checkout. */
const provisioned: Array<{ projectPath: string; branch?: string; base?: string }> = [];
let provisionFails = false;
/** Override what the fake provisioner reports about the branch it built. Absent
 *  means derived: a build with no requested branch reports a generated one, a
 *  build with a requested name reports a user-named one. */
let provisionGeneratedOverride: boolean | undefined;
let provisionAttachedOverride: boolean | undefined;
let releaseFails = false;
/** Holds the creation open so a test can act mid-build — a cancel only means
 *  anything while git is still writing, which is the whole point of it. */
let provisionGate: Promise<void> | null = null;
let openProvisionGate: (() => void) | null = null;

function holdProvisioning(): void {
  provisionGate = new Promise<void>((resolve) => {
    openProvisionGate = resolve;
  });
}
function releaseProvisioning(): void {
  openProvisionGate?.();
  provisionGate = null;
  openProvisionGate = null;
}
/** Holds the provider session start open so a test can act while the stepper
 *  shows Starting session — the window where backing out has nothing left to
 *  undo and the UI withholds the Cancel affordance. */
let startGate: Promise<void> | null = null;
let openStartGate: (() => void) | null = null;

function holdSessionStart(): void {
  startGate = new Promise<void>((resolve) => {
    openStartGate = resolve;
  });
}
function releaseSessionStart(): void {
  openStartGate?.();
  startGate = null;
  openStartGate = null;
}
/** Resolve once `condition` holds, or throw after a short budget. Lets a test
 *  wait until the session start is actually parked on the gate rather than
 *  racing the provision that precedes it. */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the session start");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
/** Worktrees the dispatcher asked to have removed again, with the branch
 *  cleanup flag it passed each time. */
const released: Array<{
  worktreePath: string;
  branch?: string;
  reclaimGeneratedBranch?: boolean;
}> = [];
/** Every workspace progress report, in order. */
let journaledEvents: Array<{ id: string; text: string; sender?: unknown }> = [];
/** Every block renderers were told to take back down, in order. */
let unjournaledEvents: string[] = [];
const steps: Array<{ step: string; state: string }> = [];
/** The note each finished fetch step carried, in order. */
const fetchNotes: Array<string | undefined> = [];
/** The error each failed step carried, in order. */
const stepErrors: Array<string | undefined> = [];
/** Every base freshen request, and what the next one answers (or throws). */
const freshened: Array<{ projectPath: string; base?: string }> = [];
let freshenAnswer: { base?: string; note?: string } | Error = {};
/** Every branch rename the dispatcher asked for. */
const renamed: Array<{ worktreePath: string; title: string }> = [];

async function harness(options: { reopen?: boolean; checkpoints?: CheckpointStore } = {}): Promise<{
  store: StoreType;
  dispatcher: import("./dispatch.js").ThreadDispatcher;
  emit: EmitEvent;
  service: import("./AgentService.js").AgentService;
  mailbox: import("./gateway/tools/irc.js").IrcMailbox;
}> {
  // Reopening is the next process on the same disk: the last harness's store.
  if (!options.reopen) lastDataDir = mkdtempSync(path.join(tmpdir(), "kone-dispatch-test-"));
  setUserDataDir(lastDataDir);
  const store = new ConversationStoreCtor();
  const mailbox = new IrcMailboxCtor(store);
  let captured: EmitEvent | undefined;
  const serviceOptions: ConstructorParameters<typeof AgentServiceCtor>[0] = {
    // SAFETY: the real store satisfies the queue slice the service reads.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    store: store as unknown as QueuedTurnStore,
    adapters: (emit) => {
      captured = emit;
      // SAFETY: one fake adapter is the whole provider roster here.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      return [new FakeAdapter(emit) as unknown as ProviderAdapter];
    },
  };
  if (options.checkpoints) serviceOptions.checkpointStore = options.checkpoints;
  const service = new AgentServiceCtor(serviceOptions);
  const dispatcher = initThreadDispatcher({
    service,
    store,
    mailbox,
    broadcast: (event) => {
      if (event.type === "thread.message-journaled") journaledEvents.push(event.block);
      if (event.type === "thread.message-unjournaled") unjournaledEvents.push(event.blockId);
      if (event.type === "thread.workspace.progress") {
        steps.push({ step: event.step, state: event.state });
        if (event.step === "fetch" && event.state === "done") fetchNotes.push(event.note);
        if (event.state === "failed") stepErrors.push(event.error);
      }
    },
    provisionWorkspace: async (request) => {
      provisioned.push(request);
      if (provisionGate) await provisionGate;
      if (provisionFails) throw new Error("git said no");
      const branch = request.branch ?? "kone/deadbeef";
      return {
        path: `/tmp/kone-worktrees/${branch.replace(/\//g, "-")}`,
        branch,
        generatedBranch: provisionGeneratedOverride ?? (request.branch === undefined),
        attachedExisting: provisionAttachedOverride ?? false,
      };
    },
    releaseWorkspace: async (input) => {
      if (releaseFails) throw new Error("remove refused");
      released.push(input);
    },
    freshenWorkspaceBase: async (input) => {
      freshened.push(input);
      if (freshenAnswer instanceof Error) throw freshenAnswer;
      return freshenAnswer;
    },
    renameWorkspaceBranch: async (input) => {
      renamed.push(input);
      return null;
    },
  });
  store.ensureThread({ threadId: THREAD, projectPath: CWD, provider: "codex" });
  await dispatcher.startThread({ threadId: THREAD, provider: "codex", cwd: CWD });
  if (!captured) throw new Error("the fake adapter was not constructed");
  return { store, dispatcher, emit: captured, service, mailbox };
}

/** Every prompt the dispatcher journaled, id and text — the raw journal,
 *  including prompts still waiting behind the running turn. loadThread hides
 *  those until their queue row settles (that filtering is
 *  conversationStore.test.ts's to pin); these tests pin that the prompt was
 *  journaled at all. */
function userTexts(store: StoreType): string[] {
  return userBlocks(store).map((b) => b.text);
}

/** The thread's journaled user blocks, id and text. */
function userBlocks(_store: StoreType): Array<{ id: string; text: string }> {
  const db = new Database(path.join(lastDataDir, "kone.sqlite"), { readonly: true });
  try {
    // SAFETY: the SELECT projects exactly block_id and text.
    const rows = db
      .prepare(
        `SELECT block_id, text FROM blocks WHERE thread_id = ? AND role = 'user' ORDER BY seq`,
      )
      .all(THREAD) as Array<{ block_id: string; text: string }>;
    return rows.map((r) => ({ id: r.block_id, text: r.text }));
  } finally {
    db.close();
  }
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
    // The strip hangs the queued row off this block — anchoring it to the
    // previous send put the row under the wrong message.
    expect(row?.userBlockId).toBe(steerBlock?.id);
  });

  test("a silent turn reaches the agent but leaves no user block", async () => {
    const { store, dispatcher } = await harness();
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "first message" });

    await dispatcher.sendThreadTurn(
      { threadId: THREAD, input: "your background subagents finished" },
      { silent: true },
    );

    // The agent got it...
    expect(FakeAdapter.sent).toEqual(["first message", "your background subagents finished"]);
    // ...but nobody said it, so the transcript does not claim anyone did.
    expect(userTexts(store)).toEqual(["first message"]);
  });

  test("an agent-sent turn is journaled with its sender and dispatched under a header", async () => {
    const { store, dispatcher } = await harness();
    await dispatcher.sendThreadTurn({
      threadId: THREAD,
      input: "Audit the migration tests",
      sender: { kind: "agent", threadId: "t-parent", relationship: "parent", messageKind: "brief" },
    });

    // The words are journaled as they were written, with the sender as data...
    expect(userTexts(store)).toEqual(["Audit the migration tests"]);
    const block = store.loadThread(THREAD)?.blocks.find((b) => b.role === "user");
    expect(block?.role === "user" ? block.sender : undefined).toEqual({
      kind: "agent",
      threadId: "t-parent",
      relationship: "parent",
      messageKind: "brief",
    });
    // ...and the agent reads who said them.
    expect(FakeAdapter.sent).toHaveLength(1);
    expect(FakeAdapter.sent[0]).toContain('relationship="parent"');
    expect(FakeAdapter.sent[0]).toEndWith("Audit the migration tests");
  });

  test("an agent-sent turn is announced to renderers under the block id it was stored with", async () => {
    const { store, dispatcher } = await harness();
    journaledEvents = [];
    await dispatcher.sendThreadTurn({
      threadId: THREAD,
      input: "Build the login screen",
      sender: { kind: "agent", threadId: "t-lead", relationship: "delegator", messageKind: "brief" },
    });
    const stored = store.loadThread(THREAD)?.blocks.find((b) => b.role === "user");
    expect(journaledEvents).toHaveLength(1);
    expect(journaledEvents[0]?.id).toBe(stored?.id);
    expect(journaledEvents[0]?.text).toBe("Build the login screen");
  });

  test("a message recorded without a turn is journaled and announced; the user's own words never are", async () => {
    const { store, dispatcher } = await harness();
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "hello" });
    journaledEvents = [];
    const blockId = dispatcher.recordAgentMessage({
      threadId: THREAD,
      text: "Is OAuth in scope?",
      sender: { kind: "agent", threadId: "t-child", relationship: "delegate", messageKind: "question" },
    });
    expect(userTexts(store)).toEqual(["hello", "Is OAuth in scope?"]);
    expect(journaledEvents.map((b) => b.text)).toEqual(["Is OAuth in scope?"]);
    // The id it hands back is the block's, so the turn that delivers the words
    // can name it.
    expect(blockId).toBe(journaledEvents[0]!.id);
  });

  test("a user turn reads back with no sender", async () => {
    const { store, dispatcher } = await harness();
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "hello" });
    const block = store.loadThread(THREAD)?.blocks.find((b) => b.role === "user");
    expect(block?.role === "user" ? block.sender : "missing").toBeUndefined();
  });

  test("a contractor's session wakes as the contractor, whoever starts it", async () => {
    const { store, dispatcher } = await harness();
    const contract = {
      name: "Frontend Auth",
      role: "Frontend auth specialist",
      instructions: "Keep components small.",
      scope: "Login screens.",
      deliverable: "Working screens.",
      doneCriteria: "Tests pass.",
    };
    store.writeSpawnedThread({
      threadId: "t-contractor",
      projectPath: CWD,
      provider: "codex",
      createdAt: 1,
      title: "Login screens",
      lineage: { parentThreadId: THREAD, relationshipToParent: "delegation", rootThreadId: THREAD },
      contract,
    });
    FakeAdapter.startedAgents = [];

    // A start that names no persona — the user reopening the thread, a resume.
    await dispatcher.startThread({ threadId: "t-contractor", provider: "codex", cwd: CWD });

    expect(FakeAdapter.startedAgents.at(-1)?.name).toBe("Frontend Auth");
    expect(FakeAdapter.startedAgents.at(-1)?.instructions).toContain("Frontend auth specialist");
    expect(FakeAdapter.startedAgents.at(-1)?.instructions).toContain("Keep components small.");
  });

  test("a guest's session wakes knowing the call sign other agents address it by", async () => {
    const { dispatcher } = await harness();
    FakeAdapter.startedAgents = [];
    await dispatcher.startThread({ threadId: THREAD, provider: "codex", cwd: CWD });
    expect(FakeAdapter.startedAgents.at(-1)).toEqual({ name: callSignFor(THREAD), guest: true });
  });

  test("a silent first turn does not name the thread after itself", async () => {
    const { store, dispatcher } = await harness();

    await dispatcher.sendThreadTurn(
      { threadId: THREAD, input: "your background subagents finished" },
      { silent: true },
    );

    expect(store.getTitle(THREAD) ?? "").not.toContain("background subagents");
  });

  test("a steer with no live turn is a plain send, and still journaled", async () => {
    const { store, dispatcher } = await harness();

    await dispatcher.steerThreadTurn({ threadId: THREAD, input: "start here" });

    expect(FakeAdapter.sent).toEqual(["start here"]);
    expect(userTexts(store)).toEqual(["start here"]);
    // First user turn on the thread — it names it, exactly like a send would.
    expect(store.getTitle(THREAD)).toBeTruthy();
  });

  test("a send the provider refuses leaves no block behind", async () => {
    const { store, dispatcher } = await harness();
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "first message" });

    FakeAdapter.refuseNext = new Error("No agent session for thread t-dispatch");
    await expect(
      dispatcher.sendThreadTurn({ threadId: THREAD, input: "hi", userBlockId: "ub-refused" }),
    ).rejects.toThrow("No agent session");

    // The renderer dropped its copy and gave the words back to the composer;
    // a block left in the journal reloaded as sent and never answered.
    expect(userTexts(store)).toEqual(["first message"]);
  });

  test("a refused send takes back its block even when it named none", async () => {
    const { store, dispatcher } = await harness();

    FakeAdapter.refuseNext = new Error("provider gone");
    await expect(dispatcher.steerThreadTurn({ threadId: THREAD, input: "hi" })).rejects.toThrow(
      "provider gone",
    );

    expect(userTexts(store)).toEqual([]);
  });

  test("a refused send never takes a block a queue row still carries", async () => {
    const { store, dispatcher, emit, service } = await harness();
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "first message" });
    turnStarted(emit, "turn-1");
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "queued behind it" });
    const [row] = await service.listQueuedTurns(THREAD);

    expect(row && store.discardUnsentUserBlock(THREAD, row.userBlockId)).toBe(false);
    expect(userTexts(store)).toEqual(["first message", "queued behind it"]);
  });

  test("an agent's refused message is taken back down wherever it was announced", async () => {
    const { dispatcher } = await harness();
    journaledEvents = [];
    unjournaledEvents = [];

    FakeAdapter.refuseNext = new Error("No agent session for thread t-dispatch");
    await expect(
      dispatcher.sendThreadTurn({
        threadId: THREAD,
        input: "Build the login screen",
        sender: { kind: "agent", threadId: "t-lead", relationship: "delegator", messageKind: "brief" },
      }),
    ).rejects.toThrow("No agent session");

    // Announced when journaled, so an open view placed it; only this tells
    // that view the store no longer has it.
    expect(journaledEvents).toHaveLength(1);
    expect(unjournaledEvents).toEqual([journaledEvents[0]!.id]);
  });
});

describe("composeTurnDelivery", () => {
  test("an ordinary turn is journaled and dispatched as itself", () => {
    expect(composeTurnDelivery({ message: "fix the bug" })).toEqual({
      journal: "fix the bug",
      dispatch: "fix the bug",
    });
  });

  test("a preamble reaches the provider and never the transcript", () => {
    const delivery = composeTurnDelivery({ message: "continue", preamble: "<recovered>…</recovered>" });
    expect(delivery.journal).toBe("continue");
    expect(delivery.dispatch).toBe("<recovered>…</recovered>\n\ncontinue");
  });

  test("a silent turn is dispatched but journaled nowhere — nobody said it", () => {
    const delivery = composeTurnDelivery({ message: "your subagents finished", silent: true });
    expect(delivery.journal).toBeNull();
    expect(delivery.dispatch).toBe("your subagents finished");
  });

  test("the two axes are independent: a silent turn can still carry a preamble", () => {
    const delivery = composeTurnDelivery({ message: "go on", preamble: "history", silent: true });
    expect(delivery.journal).toBeNull();
    expect(delivery.dispatch).toBe("history\n\ngo on");
  });

  test("an agent sender is headed in the dispatch and kept out of the journal", () => {
    const delivery = composeTurnDelivery({
      message: "Build the login form",
      sender: { kind: "agent", threadId: "t-main", name: "Maya", relationship: "delegator", messageKind: "brief" },
    });
    expect(delivery.journal).toBe("Build the login form");
    expect(delivery.dispatch).toStartWith('<from_agent name="Maya" relationship="delegator" kind="brief">');
    expect(delivery.dispatch).toContain("not by the user");
    expect(delivery.dispatch).toEndWith("\n\nBuild the login form");
  });

  test("the sender header sits between the preamble and the words it attributes", () => {
    const delivery = composeTurnDelivery({
      message: "go on",
      preamble: "history",
      sender: { kind: "agent", threadId: "t-main", relationship: "parent" },
    });
    expect(delivery.dispatch.startsWith("history\n\n<from_agent")).toBe(true);
    expect(delivery.dispatch.endsWith("</from_agent>\n\ngo on")).toBe(true);
  });

  test("the user as sender changes nothing", () => {
    expect(composeTurnDelivery({ message: "hi", sender: { kind: "user" } })).toEqual({
      journal: "hi",
      dispatch: "hi",
    });
  });

  test("an empty preamble changes nothing", () => {
    expect(composeTurnDelivery({ message: "hi", preamble: "" }).dispatch).toBe("hi");
    expect(composeTurnDelivery({ message: "hi", preamble: null }).dispatch).toBe("hi");
  });
});

// The global assistant has no project, and its project path says so: a
// sentinel, not a directory. It is the right thing to store and to scope tools
// by — and the wrong thing to hand a child process, which is what took the
// assistant's very first send down: no CLI came up, so the turn arrived at a
// thread with no session behind it.
/** The provider's session ending without anyone stopping it — its process
 *  died, its stream closed. */
function sessionExited(emit: EmitEvent, provider: "codex" | "claudeAgent" = "codex"): void {
  emit({ type: "session.exited", threadId: THREAD, provider, at: Date.now(), source: "codex.rpc.lifecycle", code: 1 });
}

describe("thread dispatcher: a session that ends on its own", () => {
  beforeEach(() => {
    FakeAdapter.sent.length = 0;
    FakeAdapter.startedResumes.length = 0;
    FakeAdapter.holding = false;
  });

  test("the next wake brings it back up, resuming its conversation", async () => {
    const { store, dispatcher, emit, service } = await harness();
    store.captureConversationId(THREAD, "conv-1");
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "first message" });

    sessionExited(emit);
    await waitFor(() => !service.hasLiveSession(THREAD));
    await dispatcher.ensureThreadSession(THREAD, { resume: true });
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "hi" });

    // Kept as live, the thread was never restarted and every send reached an
    // adapter with no session for it.
    expect(FakeAdapter.startedResumes).toEqual([undefined, "conv-1"]);
    expect(FakeAdapter.sent).toHaveLength(2);
    expect(FakeAdapter.sent[1]).toEndWith("hi");
  });

  test("an exit the adapter has already replaced leaves the thread live", async () => {
    const { emit, service } = await harness();
    FakeAdapter.holding = true;

    sessionExited(emit);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(service.hasLiveSession(THREAD)).toBe(true);
  });

  test("an exit from a provider the thread is not on leaves it live", async () => {
    const { emit, service } = await harness();

    sessionExited(emit, "claudeAgent");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(service.hasLiveSession(THREAD)).toBe(true);
  });
});

describe("thread dispatcher: where a session is spawned", () => {
  beforeEach(() => {
    FakeAdapter.sent.length = 0;
    FakeAdapter.startedCwds.length = 0;
    FakeAdapter.turnCounter = 0;
  });

  test("an assistant thread keeps the sentinel and spawns in a real directory", async () => {
    const { store, dispatcher } = await harness();
    FakeAdapter.startedCwds.length = 0;

    const assistantThread = "t-assistant";
    await dispatcher.startThread({
      threadId: assistantThread,
      provider: "codex",
      cwd: GLOBAL_ASSISTANT_PROJECT_PATH,
    });

    // The thread's identity is untouched — this is what the gateway reads to
    // know it is talking to the assistant rather than to a worker.
    expect(store.threadProjectPath(assistantThread)).toBe(GLOBAL_ASSISTANT_PROJECT_PATH);
    const spawnedIn = FakeAdapter.startedCwds;
    expect(spawnedIn).toEqual([assistantWorkingDir()]);
    expect(existsSync(spawnedIn[0] ?? "")).toBe(true);
  });

  test("a project thread spawns where it lives", async () => {
    const { dispatcher } = await harness();
    FakeAdapter.startedCwds.length = 0;

    await dispatcher.startThread({ threadId: "t-project", provider: "codex", cwd: CWD });

    expect(FakeAdapter.startedCwds).toEqual([CWD]);
  });

  test("a thread with a worktree spawns there, not in its project", async () => {
    const { store, dispatcher } = await harness();
    FakeAdapter.startedCwds.length = 0;
    const worktree = "/tmp/kone-dispatch-worktree";

    store.ensureThread({ threadId: "t-wt", projectPath: CWD, provider: "codex" });
    store.setThreadWorkspace("t-wt", { envMode: "worktree", worktreePath: worktree });

    // The renderer has no idea the thread lives anywhere but its project — it
    // sends the project path, exactly as it does for every other thread.
    await dispatcher.startThread({ threadId: "t-wt", provider: "codex", cwd: CWD });

    expect(FakeAdapter.startedCwds).toEqual([worktree]);
    // Identity untouched: the thread is still this project's.
    expect(store.threadProjectPath("t-wt")).toBe(CWD);
  });

  test("a thread that asks for a worktree gets one built before its session", async () => {
    const { store, dispatcher } = await harness();
    FakeAdapter.startedCwds.length = 0;
    provisioned.length = 0;

    await dispatcher.startThread({
      threadId: "t-ask",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "feature/foo" },
    });

    expect(provisioned).toEqual([{ projectPath: CWD, branch: "feature/foo" }]);
    expect(FakeAdapter.startedCwds).toEqual(["/tmp/kone-worktrees/feature-foo"]);
    // Both halves are recorded: what was asked for, and what was built. The
    // request clears once the directory exists.
    expect(store.threadWorkspace("t-ask")).toEqual({
      envMode: "worktree",
      worktreePath: "/tmp/kone-worktrees/feature-foo",
      requestedBranch: null,
    });
    expect(store.threadProjectPath("t-ask")).toBe(CWD);
  });

  test("two conversations in one project run on two branches", async () => {
    const { store, dispatcher } = await harness();
    FakeAdapter.startedCwds.length = 0;

    await dispatcher.startThread({
      threadId: "t-a",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "one" },
    });
    await dispatcher.startThread({
      threadId: "t-b",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "two" },
    });

    const [a, b] = FakeAdapter.startedCwds;
    expect(a).not.toBe(b);
    // Neither moved the other, and both are still this project's threads.
    expect(store.threadWorkspace("t-a")?.worktreePath).toBe(a ?? "");
    expect(store.threadWorkspace("t-b")?.worktreePath).toBe(b ?? "");
    expect(store.threadProjectPath("t-a")).toBe(CWD);
    expect(store.threadProjectPath("t-b")).toBe(CWD);
  });

  test("reopening a worktree thread reuses its directory, building nothing", async () => {
    const { store, dispatcher } = await harness();
    store.ensureThread({ threadId: "t-reopen", projectPath: CWD, provider: "codex" });
    store.setThreadWorkspace("t-reopen", {
      envMode: "worktree",
      worktreePath: "/tmp/kone-worktrees/already",
    });
    FakeAdapter.startedCwds.length = 0;
    provisioned.length = 0;

    await dispatcher.startThread({
      threadId: "t-reopen",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "already" },
    });

    expect(provisioned).toEqual([]);
    expect(FakeAdapter.startedCwds).toEqual(["/tmp/kone-worktrees/already"]);
  });

  test("a failed build fails the send and spawns nothing", async () => {
    const { store, dispatcher } = await harness();
    FakeAdapter.startedCwds.length = 0;
    provisionFails = true;

    await expect(
      dispatcher.startThread({
        threadId: "t-fail",
        provider: "codex",
        cwd: CWD,
        workspace: { mode: "worktree", branch: "doomed" },
      }),
    ).rejects.toThrow();
    provisionFails = false;

    expect(FakeAdapter.startedCwds).toEqual([]);
    // Left pending, not local: the thread still wants a worktree, and a retry
    // must not quietly run it in the project's checkout instead. The request
    // stays beside the intent so the retry rebuilds the same branch.
    expect(store.threadWorkspace("t-fail")).toEqual({
      envMode: "worktree",
      worktreePath: null,
      requestedBranch: "doomed",
    });
  });

  test("asking for local changes nothing", async () => {
    const { dispatcher } = await harness();
    FakeAdapter.startedCwds.length = 0;
    provisioned.length = 0;

    await dispatcher.startThread({
      threadId: "t-local",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "local" },
    });

    expect(provisioned).toEqual([]);
    expect(FakeAdapter.startedCwds).toEqual([CWD]);
  });

  test("reports each step of the build, in order", async () => {
    const { dispatcher } = await harness();
    steps.length = 0;

    await dispatcher.startThread({
      threadId: "t-steps",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "stepped" },
    });

    expect(steps).toEqual([
      { step: "fetch", state: "running" },
      { step: "fetch", state: "done" },
      { step: "create", state: "running" },
      { step: "create", state: "done" },
      { step: "link", state: "running" },
      { step: "link", state: "done" },
      { step: "start", state: "running" },
      { step: "start", state: "done" },
    ]);
  });

  test("a new branch starts from the freshened base, and says where", async () => {
    const { dispatcher } = await harness();
    provisioned.length = 0;
    freshened.length = 0;
    fetchNotes.length = 0;
    freshenAnswer = { base: "abc123", note: "Started from the latest origin/main." };

    await dispatcher.startThread({
      threadId: "t-fresh",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", base: "main" },
    });
    freshenAnswer = {};

    expect(freshened).toEqual([{ projectPath: CWD, base: "main" }]);
    expect(provisioned.at(-1)?.base).toBe("abc123");
    expect(fetchNotes).toEqual(["Started from the latest origin/main."]);
  });

  test("a freshen that throws still builds, from the base as asked", async () => {
    const { dispatcher } = await harness();
    provisioned.length = 0;
    fetchNotes.length = 0;
    freshenAnswer = new Error("network down");

    await dispatcher.startThread({
      threadId: "t-stale",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", base: "main" },
    });
    freshenAnswer = {};

    expect(provisioned.at(-1)?.base).toBe("main");
    expect(fetchNotes).toHaveLength(1);
    expect(fetchNotes[0]).toContain("your copy");
  });

  test("a named branch is moved in as it stands, not freshened", async () => {
    const { dispatcher } = await harness();
    freshened.length = 0;
    fetchNotes.length = 0;

    await dispatcher.startThread({
      threadId: "t-named",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "feature" },
    });

    expect(freshened).toEqual([]);
    expect(fetchNotes).toEqual([undefined]);
  });

  test("the thread's first title names its worktree branch", async () => {
    const { dispatcher } = await harness();
    renamed.length = 0;
    await dispatcher.startThread({
      threadId: "t-rename",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree" },
    });

    await dispatcher.sendThreadTurn(
      { threadId: "t-rename", input: "fix the login redirect" },
      { title: "Fix login redirect" },
    );

    expect(renamed).toEqual([
      { worktreePath: "/tmp/kone-worktrees/kone-deadbeef", title: "Fix login redirect" },
    ]);
  });

  test("a thread in the project's own checkout has no branch to rename", async () => {
    const { dispatcher } = await harness();
    renamed.length = 0;

    await dispatcher.sendThreadTurn(
      { threadId: THREAD, input: "first message" },
      { title: "First message" },
    );

    expect(renamed).toEqual([]);
  });

  test("a thread that never asked for a worktree reports nothing", async () => {
    const { dispatcher } = await harness();
    steps.length = 0;

    await dispatcher.startThread({ threadId: "t-quiet", provider: "codex", cwd: CWD });

    expect(steps).toEqual([]);
  });

  test("a failed build marks the step it failed on and stops there", async () => {
    const { dispatcher } = await harness();
    steps.length = 0;
    stepErrors.length = 0;
    provisionFails = true;

    await expect(
      dispatcher.startThread({
        threadId: "t-step-fail",
        provider: "codex",
        cwd: CWD,
        workspace: { mode: "worktree", branch: "doomed" },
      }),
    ).rejects.toThrow();
    provisionFails = false;

    expect(steps).toEqual([
      { step: "fetch", state: "running" },
      { step: "fetch", state: "done" },
      { step: "create", state: "running" },
      { step: "create", state: "failed" },
    ]);
    expect(stepErrors).toEqual(["git said no"]);
  });

  test("the start says which worktree the thread runs in, and a local one says none", async () => {
    const { dispatcher } = await harness();

    const built = await dispatcher.startThread({
      threadId: "t-where",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "where" },
    });
    const local = await dispatcher.startThread({ threadId: "t-here", provider: "codex", cwd: CWD });

    expect(built.worktreePath).toBe("/tmp/kone-worktrees/where");
    expect(local.worktreePath).toBeUndefined();
  });

  test("cancelling mid-build removes what the creation produced", async () => {
    const { store, dispatcher } = await harness();
    steps.length = 0;
    released.length = 0;
    provisionGeneratedOverride = undefined;
    provisionAttachedOverride = undefined;
    FakeAdapter.startedCwds.length = 0;
    holdProvisioning();

    const starting = dispatcher.startThread({
      threadId: "t-cancel",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "abandoned" },
    });
    // The user backs out while git is still writing. Nothing is interrupted.
    dispatcher.cancelThreadWorkspace("t-cancel");
    releaseProvisioning();

    const failure: unknown = await starting.then(
      () => null,
      (error) => error,
    );
    // A user cancel is typed, not a crash: the renderer tells it apart from a
    // real build failure and returns to idle quietly instead of erroring.
    expect(isWorkspaceCancel(failure)).toBe(true);

    // What was made is unmade, and no session was ever spawned in it.
    expect(released.map((r) => r.worktreePath)).toEqual(["/tmp/kone-worktrees/abandoned"]);
    // A branch the user named is kept: the directory goes, the ref stays.
    expect(released[0]?.reclaimGeneratedBranch ?? false).toBe(false);
    expect(released[0]?.branch).toBe("abandoned");
    expect(FakeAdapter.startedCwds).toEqual([]);
    // The thread is handed back as an ordinary local one rather than left
    // pending forever on a worktree it no longer wants.
    expect(store.threadWorkspace("t-cancel")).toEqual({
      envMode: "local",
      worktreePath: null,
      requestedBranch: null,
    });
  });

  test("cancelling a generated-branch build reclaims its branch", async () => {
    const { dispatcher } = await harness();
    released.length = 0;
    provisionGeneratedOverride = true;
    provisionAttachedOverride = false;
    FakeAdapter.startedCwds.length = 0;
    holdProvisioning();

    const starting = dispatcher.startThread({
      threadId: "t-cancel-generated",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree" },
    });
    dispatcher.cancelThreadWorkspace("t-cancel-generated");
    releaseProvisioning();

    const generatedFailure: unknown = await starting.then(
      () => null,
      (error) => error,
    );
    expect(isWorkspaceCancel(generatedFailure)).toBe(true);
    provisionGeneratedOverride = undefined;
    provisionAttachedOverride = undefined;

    // The directory removal also carries the reclaim flag, so no kone/<hex>
    // branch is stranded behind the cancelled build.
    expect(released.length).toBe(1);
    expect(released[0]?.branch).toBe("kone/deadbeef");
    expect(released[0]?.reclaimGeneratedBranch).toBe(true);
    expect(FakeAdapter.startedCwds).toEqual([]);
  });

  test("cancelling an attached-existing build keeps its branch", async () => {
    const { dispatcher } = await harness();
    released.length = 0;
    provisionGeneratedOverride = false;
    provisionAttachedOverride = true;
    FakeAdapter.startedCwds.length = 0;
    holdProvisioning();

    const starting = dispatcher.startThread({
      threadId: "t-cancel-attached",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "dormant" },
    });
    dispatcher.cancelThreadWorkspace("t-cancel-attached");
    releaseProvisioning();

    const attachedFailure: unknown = await starting.then(
      () => null,
      (error) => error,
    );
    expect(isWorkspaceCancel(attachedFailure)).toBe(true);
    provisionGeneratedOverride = undefined;
    provisionAttachedOverride = undefined;

    // The worktree existed before this build, so only the registration goes —
    // the pre-existing branch is never reclaimed.
    expect(released.length).toBe(1);
    expect(released[0]?.branch).toBe("dormant");
    expect(released[0]?.reclaimGeneratedBranch ?? false).toBe(false);
  });

  test("a failed removal still reports the cancellation", async () => {
    const { dispatcher } = await harness();
    released.length = 0;
    provisionGeneratedOverride = true;
    provisionAttachedOverride = false;
    FakeAdapter.startedCwds.length = 0;
    releaseFails = true;
    holdProvisioning();

    const starting = dispatcher.startThread({
      threadId: "t-cancel-release-fails",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree" },
    });
    dispatcher.cancelThreadWorkspace("t-cancel-release-fails");
    releaseProvisioning();

    // Best effort: the teardown failure is logged, and the caller still sees
    // the cancellation rather than the removal error.
    const removalFailure: unknown = await starting.then(
      () => null,
      (error) => error,
    );
    expect(isWorkspaceCancel(removalFailure)).toBe(true);
    releaseFails = false;
    provisionGeneratedOverride = undefined;
    provisionAttachedOverride = undefined;
    expect(FakeAdapter.startedCwds).toEqual([]);
  });

  test("a cancel that arrives after the build finished does not affect the next one", async () => {
    const { store, dispatcher } = await harness();
    released.length = 0;
    provisionGeneratedOverride = undefined;
    provisionAttachedOverride = undefined;
    releaseFails = false;

    dispatcher.cancelThreadWorkspace("t-stale");
    await dispatcher.startThread({
      threadId: "t-stale",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "kept" },
    });

    expect(released).toEqual([]);
    expect(store.threadWorkspace("t-stale")?.worktreePath).toBe(
      "/tmp/kone-worktrees/kept",
    );
  });

  test("forgetting a thread clears a stale cancel so a reused id builds normally", async () => {
    const { store, dispatcher } = await harness();
    released.length = 0;
    FakeAdapter.startedCwds.length = 0;

    dispatcher.cancelThreadWorkspace("t-reuse");
    dispatcher.forgetThread("t-reuse");

    await dispatcher.startThread({
      threadId: "t-reuse",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "reused" },
    });

    expect(released).toEqual([]);
    expect(FakeAdapter.startedCwds).toEqual(["/tmp/kone-worktrees/reused"]);
    expect(store.threadWorkspace("t-reuse")?.worktreePath).toBe("/tmp/kone-worktrees/reused");
  });

  test("a cancel landing during the session start does not stop it", async () => {
    const { store, dispatcher } = await harness();
    released.length = 0;
    steps.length = 0;
    provisionGeneratedOverride = undefined;
    provisionAttachedOverride = undefined;
    FakeAdapter.startedCwds.length = 0;
    holdSessionStart();

    const starting = dispatcher.startThread({
      threadId: "t-late",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "late" },
    });
    try {
      // Wait until the build has linked and the session is coming up — the
      // stepper shows Starting session, where the UI withholds Cancel because
      // there is nothing left to undo.
      await waitFor(() =>
        FakeAdapter.startedCwds.includes("/tmp/kone-worktrees/late"),
      );
      dispatcher.cancelThreadWorkspace("t-late");
    } finally {
      releaseSessionStart();
    }

    // The late cancel is ignored: the session owns the linked worktree now, so
    // it starts rather than throwing a cancellation for a teardown that would
    // strand it.
    const session = await starting;
    expect(session.threadId).toBe("t-late");
    expect(released).toEqual([]);
    expect(store.threadWorkspace("t-late")).toEqual({
      envMode: "worktree",
      worktreePath: "/tmp/kone-worktrees/late",
      requestedBranch: null,
    });
    expect(steps).toEqual([
      { step: "fetch", state: "running" },
      { step: "fetch", state: "done" },
      { step: "create", state: "running" },
      { step: "create", state: "done" },
      { step: "link", state: "running" },
      { step: "link", state: "done" },
      { step: "start", state: "running" },
      { step: "start", state: "done" },
    ]);
  });

  test("a thread pending on a stored request builds it without being re-asked", async () => {
    const { store, dispatcher } = await harness();
    FakeAdapter.startedCwds.length = 0;
    provisioned.length = 0;
    steps.length = 0;

    store.ensureThread({ threadId: "t-pending", projectPath: CWD, provider: "codex" });
    store.setThreadWorkspace("t-pending", { envMode: "worktree", requestedBranch: "feature/stored" });

    // The existing-thread send carries no workspace — the renderer never stages
    // one for a thread that already exists — yet the build still happens from
    // the stored branch.
    await dispatcher.startThread({ threadId: "t-pending", provider: "codex", cwd: CWD });

    expect(provisioned).toEqual([{ projectPath: CWD, branch: "feature/stored" }]);
    expect(FakeAdapter.startedCwds).toEqual(["/tmp/kone-worktrees/feature-stored"]);
    expect(store.threadWorkspace("t-pending")).toEqual({
      envMode: "worktree",
      worktreePath: "/tmp/kone-worktrees/feature-stored",
      requestedBranch: null,
    });
    expect(steps).toEqual([
      { step: "fetch", state: "running" },
      { step: "fetch", state: "done" },
      { step: "create", state: "running" },
      { step: "create", state: "done" },
      { step: "link", state: "running" },
      { step: "link", state: "done" },
      { step: "start", state: "running" },
      { step: "start", state: "done" },
    ]);
  });

  test("a pending thread with no stored branch still provisions with a generated one", async () => {
    const { store, dispatcher } = await harness();
    FakeAdapter.startedCwds.length = 0;
    provisioned.length = 0;

    store.ensureThread({ threadId: "t-pending-generated", projectPath: CWD, provider: "codex" });
    store.setThreadWorkspace("t-pending-generated", { envMode: "worktree" });

    await dispatcher.startThread({ threadId: "t-pending-generated", provider: "codex", cwd: CWD });

    expect(provisioned).toEqual([{ projectPath: CWD }]);
    expect(FakeAdapter.startedCwds).toEqual(["/tmp/kone-worktrees/kone-deadbeef"]);
    expect(store.threadWorkspace("t-pending-generated")).toEqual({
      envMode: "worktree",
      worktreePath: "/tmp/kone-worktrees/kone-deadbeef",
      requestedBranch: null,
    });
  });

  test("a reload that wipes the staged workspace still builds from the store", async () => {
    const { store, dispatcher } = await harness();
    FakeAdapter.startedCwds.length = 0;
    provisioned.length = 0;

    // First send stages the request and fails before the session comes up —
    // the row keeps the intent plus the branch while the renderer's in-memory
    // draft is gone (the reload simulation: nothing is re-staged).
    provisionFails = true;
    await expect(
      dispatcher.startThread({
        threadId: "t-reload",
        provider: "codex",
        cwd: CWD,
        workspace: { mode: "worktree", branch: "feature/reload" },
      }),
    ).rejects.toThrow();
    provisionFails = false;
    expect(store.threadWorkspace("t-reload")).toEqual({
      envMode: "worktree",
      worktreePath: null,
      requestedBranch: "feature/reload",
    });

    // Second send after reload: no workspace on the input, no staged draft.
    provisioned.length = 0;
    FakeAdapter.startedCwds.length = 0;
    await dispatcher.startThread({ threadId: "t-reload", provider: "codex", cwd: CWD });

    expect(provisioned).toEqual([{ projectPath: CWD, branch: "feature/reload" }]);
    expect(FakeAdapter.startedCwds).toEqual(["/tmp/kone-worktrees/feature-reload"]);
    expect(store.threadWorkspace("t-reload")?.worktreePath).toBe(
      "/tmp/kone-worktrees/feature-reload",
    );
  });

  test("an explicit request wins over a stale stored branch", async () => {
    const { store, dispatcher } = await harness();
    FakeAdapter.startedCwds.length = 0;
    provisioned.length = 0;

    store.ensureThread({ threadId: "t-override", projectPath: CWD, provider: "codex" });
    store.setThreadWorkspace("t-override", { envMode: "worktree", requestedBranch: "stale/branch" });

    await dispatcher.startThread({
      threadId: "t-override",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "fresh/branch" },
    });

    expect(provisioned).toEqual([{ projectPath: CWD, branch: "fresh/branch" }]);
    expect(FakeAdapter.startedCwds).toEqual(["/tmp/kone-worktrees/fresh-branch"]);
  });
});

// Manual compaction through the dispatcher: guards on compactability here, the
// service owns the busy / single-flight guards, and nothing is journaled —
// the settled boundary is the record, not a user message.
describe("thread dispatcher: compactThread", () => {
  /** The harness fake with a native compaction call that announces its own
   *  boundary, the way Codex/OpenCode do. */
  class CompactAdapter extends FakeAdapter {
    override capabilities = {
      sessionModelSwitch: "unsupported" as const,
      streamsText: false,
      supportsToolEvents: false,
      supportsResume: false,
      supportsModelList: false,
      supportsSubagents: false,
      compaction: { kind: "native" as const },
    };
    static compactCalls: string[] = [];

    override async compactThread(threadId: string): Promise<void> {
      CompactAdapter.compactCalls.push(threadId);
      this.emit({
        threadId,
        provider: "codex",
        at: Date.now(),
        source: "kone.store",
        type: "thread.state.changed",
        state: "compacted",
      });
    }
  }

  async function compactHarness(): Promise<{
    store: StoreType;
    dispatcher: import("./dispatch.js").ThreadDispatcher;
    service: import("./AgentService.js").AgentService;
  }> {
    lastDataDir = mkdtempSync(path.join(tmpdir(), "kone-dispatch-test-"));
    setUserDataDir(lastDataDir);
    const store = new ConversationStoreCtor();
    const service = new AgentServiceCtor({
      // SAFETY: the real store satisfies the queue slice the service reads.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      store: store as unknown as QueuedTurnStore,
      adapters: (emit) => {
        // SAFETY: one fake adapter is the whole provider roster here.
        // eslint-disable-next-line anti-slop/no-chained-type-assertions
        return [new CompactAdapter(emit) as unknown as ProviderAdapter];
      },
    });
    const dispatcher = initThreadDispatcher({ service, store, broadcast: () => {} });
    store.ensureThread({ threadId: THREAD, projectPath: CWD, provider: "codex" });
    await dispatcher.startThread({ threadId: THREAD, provider: "codex", cwd: CWD });
    return { store, dispatcher, service };
  }

  beforeEach(() => {
    CompactAdapter.compactCalls.length = 0;
  });

  test("rejects an unknown thread", async () => {
    const { dispatcher } = await harness();
    await expect(dispatcher.compactThread("t-missing")).rejects.toThrow("Unknown thread");
  });

  test("rejects a thread with no conversation yet", async () => {
    const { dispatcher } = await harness();
    await expect(dispatcher.compactThread(THREAD)).rejects.toThrow(
      "requires an existing conversation",
    );
  });

  test("rejects when the provider supports no manual compaction", async () => {
    const { store, dispatcher } = await harness();
    store.recordUserBlock({ threadId: THREAD, text: "hello" });
    await expect(dispatcher.compactThread(THREAD)).rejects.toThrow("not supported");
  });

  test("compacts without journaling anything", async () => {
    const { store, dispatcher } = await compactHarness();
    store.recordUserBlock({ threadId: THREAD, text: "hello" });
    const before = store.loadThread(THREAD)?.blocks.length ?? 0;

    const result = await dispatcher.compactThread(THREAD);

    expect(result).toEqual({ threadId: THREAD, provider: "codex", native: true });
    expect(CompactAdapter.compactCalls).toEqual([THREAD]);
    // No user block, no assistant block: the boundary event is the record.
    expect(store.loadThread(THREAD)?.blocks.length).toBe(before);
  });

  test("adopts a live session when the thread has history but none", async () => {
    const { store, dispatcher, service } = await compactHarness();
    // History without a session: a thread opened where it never started (fresh
    // launch, reaped idle session, inbox opening another surface's thread).
    const idle = "t-idle";
    store.ensureThread({ threadId: idle, projectPath: CWD, provider: "codex" });
    store.recordUserBlock({ threadId: idle, text: "hello" });
    expect(service.hasLiveSession(idle)).toBe(false);

    const result = await dispatcher.compactThread(idle);

    expect(result).toEqual({ threadId: idle, provider: "codex", native: true });
    expect(service.hasLiveSession(idle)).toBe(true);
    expect(CompactAdapter.compactCalls).toEqual([idle]);
  });
});

describe("thread dispatcher: invoked skills", () => {
  // A codex-native project skill under the thread's own cwd, named so no
  // skill the machine's user has installed can collide with it.
  const SKILL_NAME = "kone-dispatch-qa-skill";
  const SKILL_DIR = path.join(CWD, ".agents", "skills", SKILL_NAME);
  const SKILL_PATH = path.join(SKILL_DIR, "SKILL.md");

  beforeAll(() => {
    mkdirSync(SKILL_DIR, { recursive: true });
    writeFileSync(SKILL_PATH, `---\nname: ${SKILL_NAME}\ndescription: dispatcher fixture\n---\nDo the thing.\n`);
  });
  afterAll(() => {
    rmSync(path.join(CWD, ".agents"), { recursive: true, force: true });
  });
  beforeEach(() => {
    FakeAdapter.sent.length = 0;
    FakeAdapter.sentSkills.length = 0;
    FakeAdapter.turnCounter = 0;
  });

  function blockSkills(): Array<string | null> {
    const db = new Database(path.join(lastDataDir, "kone.sqlite"), { readonly: true });
    try {
      // SAFETY: the SELECT projects exactly one nullable TEXT column.
      const rows = db
        .prepare(`SELECT skills_json FROM blocks WHERE thread_id = ? AND role = 'user' ORDER BY seq`)
        .all(THREAD) as Array<{ skills_json: string | null }>;
      return rows.map((r) => r.skills_json);
    } finally {
      db.close();
    }
  }

  test("a skill resolved by name, any case, is journaled and sent as the listed copy", async () => {
    const { dispatcher } = await harness();
    await dispatcher.sendThreadTurn({
      threadId: THREAD,
      input: "",
      skills: [{ name: SKILL_NAME.toUpperCase(), path: "/elsewhere/SKILL.md" }],
    });

    const resolved = [{ name: SKILL_NAME, path: SKILL_PATH }];
    expect(blockSkills()).toEqual([JSON.stringify(resolved)]);
    expect(FakeAdapter.sentSkills).toEqual([resolved]);
  });

  test("an unknown skill rejects before anything is journaled or sent", async () => {
    const { store, dispatcher } = await harness();
    const send = dispatcher.sendThreadTurn({
      threadId: THREAD,
      input: "use it",
      skills: [{ name: "kone-no-such-skill", path: "/nowhere/kone-no-such-skill/SKILL.md" }],
    });

    await expect(send).rejects.toThrow('Skill "kone-no-such-skill" is not available');
    expect(userTexts(store)).toEqual([]);
    expect(FakeAdapter.sent).toEqual([]);
  });

  test("a malformed reference rejects before anything is journaled", async () => {
    const { store, dispatcher } = await harness();
    for (const bad of [
      { name: "", path: SKILL_PATH },
      { name: SKILL_NAME, path: "relative/SKILL.md" },
      { name: SKILL_NAME, path: SKILL_DIR },
    ]) {
      await expect(dispatcher.sendThreadTurn({ threadId: THREAD, input: "x", skills: [bad] })).rejects.toThrow(
        "is not available",
      );
    }
    expect(userTexts(store)).toEqual([]);
  });

  test("a busy send queues its skills and the promoted turn carries them", async () => {
    const { dispatcher, emit, service } = await harness();
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "first message" });
    turnStarted(emit, "turn-1");

    const queuedEvents: RuntimeEvent[] = [];
    const unsubscribe = service.onEvent((event) => {
      if (event.type === "turn.queued") queuedEvents.push(event);
    });
    await dispatcher.sendThreadTurn({
      threadId: THREAD,
      input: "then this",
      skills: [{ name: SKILL_NAME, path: SKILL_PATH }],
    });
    const resolved = [{ name: SKILL_NAME, path: SKILL_PATH }];

    const [row] = await service.listQueuedTurns(THREAD);
    expect(row?.skills).toEqual(resolved);
    unsubscribe();
    expect(queuedEvents.map((e) => (e.type === "turn.queued" ? e.skills : undefined))).toEqual([resolved]);

    // SAFETY: a complete turn.completed literal, the shape an adapter emits.
    emit({ type: "turn.completed", threadId: THREAD, provider: "codex", turnId: "turn-1", at: Date.now(), source: "codex.app-server" } as RuntimeEvent);
    await waitFor(() => FakeAdapter.sent.length === 2);
    expect(FakeAdapter.sent[1]).toBe("then this");
    expect(FakeAdapter.sentSkills[1]).toEqual(resolved);
  });

  test("a steer while busy carries its skills onto the queue row and its block", async () => {
    const { dispatcher, emit, service } = await harness();
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "first message" });
    turnStarted(emit, "turn-1");

    await dispatcher.steerThreadTurn({
      threadId: THREAD,
      input: "",
      skills: [{ name: SKILL_NAME, path: SKILL_PATH }],
    });

    const resolved = [{ name: SKILL_NAME, path: SKILL_PATH }];
    const [row] = await service.listQueuedTurns(THREAD);
    expect(row?.skills).toEqual(resolved);
    expect(blockSkills()).toEqual([null, JSON.stringify(resolved)]);
  });

  test("a skill send followed at once by a plain send journals in call order", async () => {
    const { store, dispatcher } = await harness();

    // Fired without awaiting: skill resolution reads asynchronously, so the
    // plain send's journal used to land first and the transcript read
    // second-first.
    const skill = dispatcher.sendThreadTurn({
      threadId: THREAD,
      input: "run the skill",
      skills: [{ name: SKILL_NAME, path: SKILL_PATH }],
    });
    const plain = dispatcher.sendThreadTurn({ threadId: THREAD, input: "plain follow-up" });
    await Promise.all([skill, plain]);

    expect(userTexts(store)).toEqual(["run the skill", "plain follow-up"]);
  });

  test("a plain send with nothing ahead of it journals in the same tick", async () => {
    const { store, dispatcher } = await harness();

    const pending = dispatcher.sendThreadTurn({ threadId: THREAD, input: "first message" });

    // The service's busy check queues a second send behind the first only when
    // the first journaled before the second was called.
    expect(userTexts(store)).toEqual(["first message"]);
    await pending;
  });
});

describe("moving a thread into a worktree", () => {
  test("builds a worktree, rebinds the session and resumes the conversation", async () => {
    const { store, dispatcher } = await harness();
    store.captureConversationId(THREAD, "conv-move");
    FakeAdapter.startedCwds.length = 0;
    FakeAdapter.startedResumes.length = 0;
    provisioned.length = 0;

    const result = await dispatcher.moveThreadToWorktree(THREAD);

    expect(result).toEqual({ ok: true, worktreePath: "/tmp/kone-worktrees/kone-deadbeef" });
    expect(provisioned).toHaveLength(1);
    expect(store.threadWorkspace(THREAD)?.worktreePath).toBe("/tmp/kone-worktrees/kone-deadbeef");
    // The session was restarted in the worktree, resuming the conversation.
    expect(FakeAdapter.startedCwds).toEqual(["/tmp/kone-worktrees/kone-deadbeef"]);
    expect(FakeAdapter.startedResumes).toEqual(["conv-move"]);
  });

  test("a thread already in a worktree is returned as-is, building nothing", async () => {
    const { store, dispatcher } = await harness();
    store.setThreadWorkspace(THREAD, {
      envMode: "worktree",
      worktreePath: "/tmp/kone-worktrees/already",
    });
    provisioned.length = 0;

    expect(await dispatcher.moveThreadToWorktree(THREAD)).toEqual({
      ok: true,
      worktreePath: "/tmp/kone-worktrees/already",
    });
    expect(provisioned).toHaveLength(0);
  });

  test("an unknown thread is refused", async () => {
    const { dispatcher } = await harness();
    expect(await dispatcher.moveThreadToWorktree("nope")).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  test("a provisioning failure is reported, not thrown", async () => {
    const { dispatcher } = await harness();
    provisionFails = true;
    try {
      const result = await dispatcher.moveThreadToWorktree(THREAD);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("failed");
    } finally {
      provisionFails = false;
    }
  });
});
