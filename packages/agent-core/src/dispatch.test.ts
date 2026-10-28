import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { callSignFor } from "@kone/protocol/agent-call-sign";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { composeTurnDelivery, LIMIT_RESUME_PROMPT } from "./dispatch.js";
import { isWorkspaceCancel } from "@kone/protocol/ipc-error";
import { setUserDataDir } from "./userDataDir.js";
import type {
  AdapterCapabilities,
  ChatAttachment,
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
import { claimRestoreDir } from "./checkpointRestoreSafety.js";
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
  capabilities: AdapterCapabilities = {
    sessionModelSwitch: "unsupported",
    streamsText: false,
    supportsToolEvents: false,
    supportsResume: false,
    supportsModelList: false,
    supportsSubagents: false,
  };
  /** When set, a live steer round trip a test can gate — how a steer already
   *  admitted to the adapter outlives the turn it aimed at. `declare` so the
   *  field adds no own property that would shadow a subclass's method. */
  declare steerTurn?: (input: SendTurnInput) => Promise<TurnStartResult>;
  /** When set, the provider's native compaction call, for a test that holds a
   *  compaction running across a move. */
  declare compactThread?: (threadId: string) => Promise<void>;
  static sent: string[] = [];
  static sentAttachments: Array<SendTurnInput["attachments"]> = [];
  static sentSkills: Array<SendTurnInput["skills"]> = [];
  static startedCwds: string[] = [];
  static startedAgents: Array<SessionStartInput["agent"]> = [];
  /** The conversation each session start asked to resume. */
  static startedResumes: Array<string | undefined> = [];
  static startedForks: Array<SessionStartInput["forkFrom"]> = [];
  /** Whether the adapter still holds a session for the thread — what an exit
   *  from a session it has since replaced looks like. */
  static holding = false;
  static turnCounter = 0;
  /** The provider refuses the next turn sent to it. */
  static refuseNext: Error | null = null;
  /** Makes the next session start fail, for startup-failure coverage. */
  static startError: Error | null = null;
  static stopError: Error | null = null;
  constructor(readonly emit: EmitEvent) {}
  async discover(): Promise<never[]> {
    return [];
  }
  async listModels(): Promise<never[]> {
    return [];
  }
  async startSession(
    input: Pick<SessionStartInput, "threadId" | "cwd" | "agent" | "resume" | "forkFrom">,
  ): Promise<{ threadId: string; provider: "codex" }> {
    // The directory a provider process would have been spawned in. Recorded
    // before the gate so a test can tell the session has started coming up.
    FakeAdapter.startedCwds.push(input.cwd);
    FakeAdapter.startedAgents.push(input.agent);
    FakeAdapter.startedResumes.push(input.resume);
    FakeAdapter.startedForks.push(input.forkFrom);
    if (FakeAdapter.startError) throw FakeAdapter.startError;
    if (startGate) await startGate;
    return { threadId: input.threadId, provider: "codex" };
  }
  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const refused = FakeAdapter.refuseNext;
    FakeAdapter.refuseNext = null;
    if (refused) throw refused;
    FakeAdapter.sent.push(input.input);
    FakeAdapter.sentAttachments.push(input.attachments);
    FakeAdapter.sentSkills.push(input.skills);
    return { threadId: input.threadId, turnId: `turn-${++FakeAdapter.turnCounter}` };
  }
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {
    if (FakeAdapter.stopError) throw FakeAdapter.stopError;
  }
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
let resetConversationStoreForTests: typeof import("./ConversationStore.js").resetConversationStoreForTests;
let AgentServiceCtor: typeof import("./AgentService.js").AgentService;
let initThreadDispatcher: typeof import("./dispatch.js").initThreadDispatcher;
let IrcMailboxCtor: typeof import("./gateway/tools/irc.js").IrcMailbox;

beforeAll(async () => {
  IrcMailboxCtor = (await import("./gateway/tools/irc.js")).IrcMailbox;
  const conversationStore = await import("./ConversationStore.js");
  ConversationStoreCtor = conversationStore.ConversationStore;
  resetConversationStoreForTests = conversationStore.resetConversationStoreForTests;
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
  initThreadDispatcher = (await import("./dispatch.js")).initThreadDispatcher;
});

/** A dispatcher wired to a fresh store, a real service, and one fake adapter,
 *  with the thread already registered and its session up. */
/** What the injected provisioner was asked for. The real one runs git; here the
 *  point is the ordering around it, not the checkout. */
/** A recorded provision request: the arguments that matter, without its
 *  onProgress callback. */
type ProvisionRecord = { projectPath: string; branch?: string; base?: string };

const provisioned: Array<ProvisionRecord> = [];
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

/** The project's setup script, held open so a test can cancel during it. */
let setupScriptGate: Promise<void> | null = null;
let setupScriptStarted: (() => void) | null = null;
/** Worktree-setup snapshots broadcast during a build. */
type WorktreeSetupSnapshotLike = { phase: string; stages: Array<{ id: string; status: string }> };
const worktreeSetups: WorktreeSetupSnapshotLike[] = [];

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
  adapter: FakeAdapter;
}> {
  // A fresh process on the same disk for a reopen, else a fresh disk.
  if (!options.reopen) lastDataDir = mkdtempSync(path.join(tmpdir(), "kone-dispatch-test-"));
  setUserDataDir(lastDataDir);
  setupScriptGate = null;
  setupScriptStarted = null;
  FakeAdapter.stopError = null;
  worktreeSetups.length = 0;
  const store = new ConversationStoreCtor();
  const mailbox = new IrcMailboxCtor(store);
  let captured: EmitEvent | undefined;
  let capturedAdapter: FakeAdapter | undefined;
  const serviceOptions: ConstructorParameters<typeof AgentServiceCtor>[0] = {
    // SAFETY: the real store satisfies the queue slice the service reads.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    store: store as unknown as QueuedTurnStore,
    adapters: (emit) => {
      captured = emit;
      capturedAdapter = new FakeAdapter(emit);
      // SAFETY: one fake adapter is the whole provider roster here.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      return [capturedAdapter as unknown as ProviderAdapter];
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
      if (event.type === "thread.worktree.setup") worktreeSetups.push(event.snapshot);
    },
    provisionWorkspace: async (request) => {
      // Record the request without its onProgress callback, so expectations
      // read as the arguments that matter.
      const recorded: ProvisionRecord = {
        projectPath: request.projectPath,
      };
      if (request.branch !== undefined) recorded.branch = request.branch;
      if (request.base !== undefined) recorded.base = request.base;
      provisionHadProgress = request.onProgress !== undefined;
      provisioned.push(recorded);
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
    runSetupScript: async ({ onOutput }) => {
      setupScriptStarted?.();
      if (setupScriptGate) await setupScriptGate;
      onOutput?.("installing\n");
      return { code: 0, output: "installing\n" };
    },
  });
  store.ensureThread({ threadId: THREAD, projectPath: CWD, provider: "codex" });
  await dispatcher.startThread({ threadId: THREAD, provider: "codex", cwd: CWD });
  if (!captured || !capturedAdapter) throw new Error("the fake adapter was not constructed");
  return { store, dispatcher, emit: captured, service, mailbox, adapter: capturedAdapter };
}

/** Whether the last provision request carried an onProgress callback. */
let provisionHadProgress = false;

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

function turnCompleted(emit: EmitEvent, turnId: string): void {
  // SAFETY: a complete turn.completed literal, the shape an adapter emits.
  emit({
    type: "turn.completed",
    threadId: THREAD,
    provider: "codex",
    turnId,
    at: Date.now(),
    source: "codex.app-server",
  } as RuntimeEvent);
}

describe("thread dispatcher: a steer is the user speaking", () => {
  beforeEach(() => {
    FakeAdapter.sent.length = 0;
    FakeAdapter.turnCounter = 0;
    FakeAdapter.startError = null;
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
    const { dispatcher } = await harness();
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();
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

describe("thread dispatcher native fork startup", () => {
  test("normal startThread resolves the saved native fork target", async () => {
    const { store, dispatcher } = await harness();
    store.ensureThread({ threadId: "fork-source", projectPath: CWD, provider: "codex" });
    store.recordUserBlock({ threadId: "fork-source", blockId: "prompt", text: "remember ALPHA", at: 1 });
    store.applyEvent({ type: "turn.started", threadId: "fork-source", provider: "codex", turnId: "turn-native", at: 2, source: "test" });
    store.applyEvent({ type: "item.updated", threadId: "fork-source", provider: "codex", turnId: "turn-native", at: 3, source: "test", item: { itemId: "answer", kind: "assistant_text", status: "completed", text: "ALPHA" } });
    store.applyEvent({ type: "turn.completed", threadId: "fork-source", provider: "codex", turnId: "turn-native", at: 4, source: "test" });
    store.captureConversationId("fork-source", "native-conversation");
    store.writeForkThread({
      requestId: "native-start", threadId: "fork-start", sourceThreadId: "fork-source", projectPath: CWD,
      provider: "codex", createdAt: 5, importedBlocks: [], branch: null, envMode: null, worktreePath: null, requestedBranch: null,
      forkContext: { sourceThreadId: "fork-source", forkPointBlockId: "answer", importedAt: 5, bootstrapStatus: "pending", forkKind: "branch", sourceProvider: "codex", nativeFork: { conversationId: "native-conversation", beforeTurnId: "turn-native" } },
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "fork-start" },
    });
    await dispatcher.startThread({ threadId: "fork-start", provider: "codex", cwd: CWD });
    expect(FakeAdapter.startedForks.at(-1)).toEqual({ conversationId: "native-conversation", beforeTurnId: "turn-native" });
    store.writeForkThread({
      requestId: "portable-start", threadId: "fork-portable-start", sourceThreadId: "fork-source", projectPath: CWD,
      provider: "codex", createdAt: 6, importedBlocks: [{ id: "portable-prompt", role: "user", text: "remember ALPHA", at: 1 }],
      branch: null, envMode: null, worktreePath: null, requestedBranch: null,
      forkContext: { sourceThreadId: "fork-source", forkPointBlockId: "answer", importedAt: 6, bootstrapStatus: "pending", forkKind: "branch", sourceProvider: "claudeAgent", nativeFork: { conversationId: "foreign-session", assistantUuid: "foreign-uuid" } },
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "fork-portable-start" },
    });
    await dispatcher.startThread({ threadId: "fork-portable-start", provider: "codex", cwd: CWD });
    expect(FakeAdapter.startedForks.at(-1)).toBeUndefined();
  });
});

// The edit fork journals the replacement message (carrying what the replaced
// one carried) and replays only the blocks BEFORE it. So a reference or file
// on the edited message reaches the provider only if the fork's first send
// hands it over — the renderer's edit-fork call names the edited text alone.
describe("thread dispatcher: an edit fork's first turn", () => {
  const REFERENCE_TEXT = "const retry = () => attempt++;\n  return retry();";
  const reference: ChatAttachment = {
    type: "reference",
    id: "ref-1",
    name: "Retry loop",
    mimeType: "text/plain",
    sizeBytes: REFERENCE_TEXT.length,
    reference: {
      text: REFERENCE_TEXT,
      sourcePaneId: "pane-1",
      sourceThreadId: "t-source",
      sourceMessageId: "block-1",
      sourceTitle: "Retry work",
    },
  };
  const file: ChatAttachment = {
    type: "file",
    id: "att-1",
    name: "leak.ts",
    mimeType: "text/plain",
    sizeBytes: 12,
  };

  beforeEach(() => {
    // `editFork.ts` reads the module-level store, which outlives one test's
    // harness; a stale instance would fork against the previous temp dir.
    resetConversationStoreForTests();
    FakeAdapter.sent.length = 0;
    FakeAdapter.sentAttachments.length = 0;
    FakeAdapter.turnCounter = 0;
    FakeAdapter.startError = null;
  });

  test("sends the replaced message's stored reference, with normal attachments intact", async () => {
    const { store, dispatcher, emit, service } = await harness();
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "first question" });
    turnStarted(emit, "turn-1");
    turnCompleted(emit, "turn-1");
    await dispatcher.sendThreadTurn({
      threadId: THREAD,
      input: "second question",
      attachments: [reference, file],
    });
    turnStarted(emit, "turn-2");
    turnCompleted(emit, "turn-2");
    await waitFor(() => !service.isThreadBusy(THREAD));

    const sourceBlocks = userBlocks(store);
    expect(sourceBlocks.map((b) => b.text)).toEqual(["first question", "second question"]);
    const editedBlockId = sourceBlocks[1]!.id;

    const forked = await dispatcher.forkThreadTurn({
      requestId: "r-fork",
      threadId: "t-fork",
      sourceThreadId: THREAD,
      blockId: editedBlockId,
      editedText: "second question, revised",
    });
    expect(forked.status).toBe("created");

    // What the fork journaled on the replacement is what the provider gets —
    // exact reference bytes and provenance, and the file chip untouched.
    expect(FakeAdapter.sentAttachments.at(-1)).toEqual([reference, file]);
    // And it can come from nowhere else: the one-shot replay stops before the
    // edited message, so the quote is not duplicated into the prompt.
    const forkPrompt = FakeAdapter.sent.at(-1) ?? "";
    expect(forkPrompt).toContain("second question, revised");
    expect(forkPrompt).not.toContain(REFERENCE_TEXT);
    // The silent dispatch journals nothing, so the replacement is still the
    // only copy of the edited message in the fork.
    const forkTexts = store
      .loadThread("t-fork")!
      .blocks.filter((b) => b.role === "user")
      .map((b) => b.text);
    expect(forkTexts).toEqual(["first question", "second question, revised"]);
  });

  test("a reference-only original message is delivered when it is edited", async () => {
    const { store, dispatcher, emit, service } = await harness();
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "", attachments: [reference] });
    turnStarted(emit, "turn-1");
    turnCompleted(emit, "turn-1");
    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "and now the follow-up" });
    turnStarted(emit, "turn-2");
    turnCompleted(emit, "turn-2");
    await waitFor(() => !service.isThreadBusy(THREAD));

    const originalId = userBlocks(store)[0]!.id;
    const forked = await dispatcher.forkThreadTurn({
      requestId: "r-ref-only",
      threadId: "t-ref-only",
      sourceThreadId: THREAD,
      blockId: originalId,
      editedText: "start over with the reference",
    });
    expect(forked.status).toBe("created");

    // A valid edit of a quote-only message keeps its quote, exactly once.
    expect(FakeAdapter.sentAttachments.at(-1)).toEqual([reference]);
    expect(FakeAdapter.sent.at(-1)).toBe("start over with the reference");
    expect(
      store
        .loadThread("t-ref-only")!
        .blocks.filter((b) => b.role === "user")
        .map((b) => b.text),
    ).toEqual(["start over with the reference"]);
  });

  test("replaying the same fork creation sends no second turn", async () => {
    const { store, dispatcher, emit, service } = await harness();
    await dispatcher.sendThreadTurn({
      threadId: THREAD,
      input: "second question",
      attachments: [reference],
    });
    turnStarted(emit, "turn-1");
    turnCompleted(emit, "turn-1");
    await waitFor(() => !service.isThreadBusy(THREAD));
    const blockId = userBlocks(store).at(-1)!.id;

    const input = {
      requestId: "r-idempotent",
      threadId: "t-idempotent",
      sourceThreadId: THREAD,
      blockId,
      editedText: "second question, revised",
    };
    expect((await dispatcher.forkThreadTurn(input)).status).toBe("created");
    const sentAfterFork = FakeAdapter.sent.length;
    expect((await dispatcher.forkThreadTurn(input)).status).toBe("exists");
    expect(FakeAdapter.sent.length).toBe(sentAfterFork);
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

describe("thread dispatcher: restart background note", () => {
  beforeEach(() => {
    FakeAdapter.sent.length = 0;
    FakeAdapter.turnCounter = 0;
  });

  test("a thread's next turn carries what the restart cancelled, once", async () => {
    // First process: the turn is live with a subagent running and an open task.
    const first = await harness();
    const now = Date.now();
    first.store.applyEvent({
      type: "subagent.started",
      threadId: THREAD,
      provider: "codex",
      at: now,
      source: "codex.app-server",
      turnId: "turn-live",
      subagent: {
        toolUseId: "tool-1",
        taskId: "task-1",
        parentItemId: "call-1",
        agentType: "explore",
        description: "trace the callers",
        prompt: "trace them",
        model: "claude-haiku-4-5",
        status: "running",
        tokens: 0,
        toolUses: 0,
        startedAt: now,
      },
    });
    first.store.applyEvent({
      type: "item.started",
      threadId: THREAD,
      provider: "codex",
      at: now,
      source: "codex.app-server",
      turnId: "turn-live",
      item: {
        itemId: "plan-1",
        kind: "plan_text",
        status: "in-progress",
        text: "the plan",
        tasks: [{ id: "b", content: "write the tests", status: "in-progress" }],
      },
    });
    first.store.close();

    // The next process opens the same disk, seals the turn, and stages the note.
    const second = await harness({ reopen: true });
    second.dispatcher.recoverRestartBackgroundNotesAtBoot();
    await second.dispatcher.sendThreadTurn({ threadId: THREAD, input: "carry on" });

    const dispatched = FakeAdapter.sent[0] ?? "";
    expect(dispatched).toContain("kone restarted");
    expect(dispatched).toContain("- subagent: trace the callers");
    expect(dispatched).toContain("- task: write the tests");
    expect(dispatched).toEndWith("carry on");
    // The note is app-authored context, not the user's words.
    expect(userTexts(second.store)).toEqual(["carry on"]);

    // One-shot: the turn after it is not told again.
    await second.dispatcher.sendThreadTurn({ threadId: THREAD, input: "and again" });
    expect(FakeAdapter.sent[1]).toBe("and again");
  });

  test("staging a note never wakes a settled thread", async () => {
    const first = await harness();
    first.store.applyEvent({
      type: "subagent.started",
      threadId: THREAD,
      provider: "codex",
      at: Date.now(),
      source: "codex.app-server",
      turnId: "turn-live",
      subagent: {
        toolUseId: "tool-9",
        taskId: "task-9",
        parentItemId: "call-9",
        agentType: "explore",
        description: "someone's long job",
        prompt: "do it",
        model: "claude-haiku-4-5",
        status: "running",
        tokens: 0,
        toolUses: 0,
        startedAt: Date.now(),
      },
    });
    first.store.close();

    const second = await harness({ reopen: true });
    second.dispatcher.recoverRestartBackgroundNotesAtBoot();
    // No turn was sent: nothing reached the provider, so nothing was woken.
    expect(FakeAdapter.sent).toEqual([]);
  });

  test("a restore-held resume keeps replay and restart notes for the accepted retry", async () => {
    const first = await harness();
    await first.dispatcher.sendThreadTurn({ threadId: THREAD, input: "Prior instruction: audit critical deployment." });
    const now = Date.now();
    first.store.applyEvent({
      type: "item.started",
      threadId: THREAD,
      provider: "codex",
      at: now,
      source: "codex.app-server",
      turnId: "turn-live",
      item: {
        itemId: "plan-critical",
        kind: "plan_text",
        status: "in-progress",
        text: "Deployment audit",
        tasks: [{ id: "audit-task", content: "critical deployment audit", status: "in-progress" }],
      },
    });
    first.store.close();

    const second = await harness({ reopen: true });
    second.dispatcher.recoverRestartBackgroundNotesAtBoot();
    second.service.setThreadLimited(THREAD, Date.now() + 60_000);
    const sentBeforeResume = [...FakeAdapter.sent];
    const releaseRestore = claimRestoreDir(CWD);
    try {
      await expect(second.dispatcher.resumeLimitedThread(THREAD)).rejects.toThrow("held by a restore");
      expect(FakeAdapter.sent).toEqual(sentBeforeResume);
      expect(second.store.listQueuedTurns(THREAD)).toEqual([]);
    } finally {
      releaseRestore();
    }

    await second.dispatcher.resumeLimitedThread(THREAD);
    const accepted = FakeAdapter.sent.at(-1) ?? "";
    expect(accepted).toContain("<recovered-transcript>");
    expect(accepted).toContain("Prior instruction: audit critical deployment.");
    expect(accepted).toContain("kone restarted");
    expect(accepted).toContain("critical deployment audit");
    expect(second.store.threadMeta(THREAD)?.limitedAt ?? null).toBeNull();
  });
});

describe("thread dispatcher: durable continuations", () => {
  beforeEach(() => {
    FakeAdapter.sent.length = 0;
    FakeAdapter.turnCounter = 0;
  });

  test("an overdue continuation is recovered and dispatched at boot", async () => {
    const first = await harness();
    const recordedAt = Date.now() - 1_000;
    first.store.scheduleContinuation({
      threadId: THREAD,
      kind: "quit-resume",
      dueAt: recordedAt,
      payloadJson: JSON.stringify({ prompt: "continue where you left off", recordedAt }),
    });
    first.store.close();

    const second = await harness({ reopen: true });
    const result = await second.dispatcher.resumeQuitInterruptedChatsAtBoot();
    expect(result.resumed).toEqual([THREAD]);
    expect(FakeAdapter.sent).toContain("continue where you left off");
    // Consumed: a later boot must not run it again.
    expect(second.store.listContinuationsForThread(THREAD)).toEqual([]);
  });

  test("a claim left by a boot that died before dispatching is recovered", async () => {
    const first = await harness();
    const store = first.store;
    const recordedAt = Date.now() - 1_000;
    store.scheduleContinuation({
      threadId: THREAD,
      kind: "quit-resume",
      dueAt: recordedAt,
      payloadJson: JSON.stringify({ prompt: "finish the job", recordedAt }),
    });
    // This boot claimed the row and then died before dispatching it.
    expect(store.claimDueContinuations(Date.now())).toHaveLength(1);
    store.close();

    const second = await harness({ reopen: true });
    const result = await second.dispatcher.resumeQuitInterruptedChatsAtBoot();
    expect(result.resumed).toEqual([THREAD]);
    expect(FakeAdapter.sent).toContain("finish the job");
  });

  test("a user turn before the due time cancels the continuation", async () => {
    const { store, dispatcher } = await harness();
    store.scheduleContinuation({
      threadId: THREAD,
      kind: "quit-resume",
      dueAt: Date.now() + 60_000,
      payloadJson: JSON.stringify({ prompt: "later", recordedAt: Date.now() }),
    });

    await dispatcher.sendThreadTurn({ threadId: THREAD, input: "something the user said" });

    expect(FakeAdapter.sent).toEqual(["something the user said"]);
    expect(store.listContinuationsForThread(THREAD)).toEqual([]);
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
    expect(provisionHadProgress).toBe(true);
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
  test("does not rebind when the old session stop is unconfirmed", async () => {
    const { store, dispatcher } = await harness();
    provisioned.length = 0;
    FakeAdapter.stopError = new Error("stop timed out");
    try {
      expect(await dispatcher.moveThreadToWorktree(THREAD)).toMatchObject({
        ok: false,
        reason: "stop-unconfirmed",
      });
      expect(store.threadWorkspace(THREAD)?.worktreePath).toBeNull();
      expect(provisioned).toHaveLength(1);
    } finally {
      FakeAdapter.stopError = null;
    }
  });

  test("refuses while checkpoint restore holds the thread checkout", async () => {
    const { dispatcher } = await harness();
    provisioned.length = 0;
    const release = claimRestoreDir(CWD);
    try {
      expect(await dispatcher.moveThreadToWorktree(THREAD)).toEqual({
        ok: false,
        reason: "restoring",
      });
      expect(provisioned).toHaveLength(0);
    } finally {
      release();
    }
  });

  test("queues a send that arrives while the worktree is being built", async () => {
    const { store, dispatcher, service } = await harness();
    provisioned.length = 0;
    holdProvisioning();
    FakeAdapter.sent.length = 0;
    FakeAdapter.startedCwds.length = 0;
    try {
      const moving = dispatcher.moveThreadToWorktree(THREAD);
      for (let attempt = 0; attempt < 20 && provisioned.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(provisioned).toHaveLength(1);

      expect(await service.sendTurn({ threadId: THREAD, input: "during move" })).toMatchObject({ queued: true });
      expect(FakeAdapter.sent).toEqual([]);

      releaseProvisioning();
      expect(await moving).toMatchObject({ ok: true });
      expect(FakeAdapter.startedCwds).toEqual([
        "/tmp/kone-worktrees/kone-deadbeef",
      ]);
      expect(store.threadWorkspace(THREAD)?.worktreePath).toBe("/tmp/kone-worktrees/kone-deadbeef");
      // The send accepted during the build survives the handoff and is
      // delivered exactly once, into the replacement session — never cancelled
      // by the stop the move performs.
      await waitFor(() => FakeAdapter.sent.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(FakeAdapter.sent).toEqual(["during move"]);
      expect(store.listQueuedTurns(THREAD)).toHaveLength(0);
    } finally {
      releaseProvisioning();
    }
  });

  test("a due continuation is deferred by the move, kept, and runs after it", async () => {
    const { store, dispatcher } = await harness();
    provisioned.length = 0;
    FakeAdapter.sent.length = 0;
    // A limit-reset continuation only runs on a thread still marked limited.
    store.setLimited(THREAD, Date.now() - 1_000);
    const row = store.scheduleContinuation({
      threadId: THREAD,
      kind: "limit-reset",
      dueAt: Date.now() - 1_000,
      payloadJson: JSON.stringify({ prompt: "continue after reset", recordedAt: Date.now() - 1_000 }),
    });
    expect(row).not.toBeNull();
    holdProvisioning();
    try {
      const moving = dispatcher.moveThreadToWorktree(THREAD);
      await waitFor(() => provisioned.length === 1);

      const sweep = await dispatcher.dispatchDueContinuations();
      // Deferred, not consumed: nothing was queued, the row survives, and no
      // attempt was burned — so it is not enqueued and then cancelled.
      expect(sweep.resumed).toEqual([]);
      expect(store.listQueuedTurns(THREAD)).toHaveLength(0);
      const kept = store.getContinuation(row!.continuationId);
      expect(kept).not.toBeNull();
      expect(kept?.attempts).toBe(0);

      releaseProvisioning();
      expect(await moving).toMatchObject({ ok: true });
      await waitFor(() => store.getContinuation(row!.continuationId) === null);
      expect(FakeAdapter.sent).toContain(LIMIT_RESUME_PROMPT);
    } finally {
      releaseProvisioning();
    }
  });

  test("Send now during the move is refused and the row replays after it", async () => {
    const { store, dispatcher, service } = await harness();
    provisioned.length = 0;
    FakeAdapter.sent.length = 0;
    holdProvisioning();
    try {
      const moving = dispatcher.moveThreadToWorktree(THREAD);
      await waitFor(() => provisioned.length === 1);
      const queued = await service.sendTurn({ threadId: THREAD, input: "send during move" });
      expect(queued.queued).toBe(true);

      // Send now must not claim the row and dispatch it into a session the move
      // is tearing down: it refuses, and the row stays where it was.
      await expect(service.sendQueuedTurnNow(THREAD, queued.turnId)).rejects.toThrow(/worktree move/);
      expect(FakeAdapter.sent).toEqual([]);
      expect(store.listQueuedTurns(THREAD)).toHaveLength(1);

      releaseProvisioning();
      expect(await moving).toMatchObject({ ok: true });
      await waitFor(() => FakeAdapter.sent.length === 1);
      expect(FakeAdapter.sent).toEqual(["send during move"]);
    } finally {
      releaseProvisioning();
    }
  });

  test("a queue write failure during a move refuses instead of dispatching", async () => {
    const { store, dispatcher, service } = await harness();
    provisioned.length = 0;
    FakeAdapter.sent.length = 0;
    holdProvisioning();
    const saved = store.enqueueQueuedTurn;
    try {
      const moving = dispatcher.moveThreadToWorktree(THREAD);
      await waitFor(() => provisioned.length === 1);
      store.enqueueQueuedTurn = () => {
        throw new Error("disk write failure");
      };
      await expect(
        service.sendTurn({ threadId: THREAD, input: "send during failed queue write" }),
      ).rejects.toThrow(/disk write failure/);
      // The fallback must not start a turn in a session the move owns.
      expect(FakeAdapter.sent).toEqual([]);
      store.enqueueQueuedTurn = saved;
      releaseProvisioning();
      await moving;
    } finally {
      store.enqueueQueuedTurn = saved;
      releaseProvisioning();
    }
  });

  test("Send now during the stop window is refused and the send survives the move", async () => {
    const { dispatcher, service } = await harness();
    provisioned.length = 0;
    FakeAdapter.sent.length = 0;
    let releaseStop = (): void => {};
    let stopping = false;
    const original = FakeAdapter.prototype.stopSession;
    FakeAdapter.prototype.stopSession = async () => {
      stopping = true;
      await new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    };
    try {
      const moving = dispatcher.moveThreadToWorktree(THREAD);
      await waitFor(() => stopping);
      const queued = await service.sendTurn({ threadId: THREAD, input: "after final busy check" });
      expect(queued.queued).toBe(true);

      // The stop-window gap: Send now must not reach the old adapter here.
      await expect(service.sendQueuedTurnNow(THREAD, queued.turnId)).rejects.toThrow(/worktree move/);
      expect(FakeAdapter.sent).toEqual([]);

      releaseStop();
      expect(await moving).toMatchObject({ ok: true });
      await waitFor(() => FakeAdapter.sent.length === 1);
      expect(FakeAdapter.sent).toEqual(["after final busy check"]);
    } finally {
      FakeAdapter.prototype.stopSession = original;
      releaseStop();
    }
  });

  test("manual compaction is refused while the thread is being moved", async () => {
    const { dispatcher, service } = await harness();
    provisioned.length = 0;
    holdProvisioning();
    try {
      const moving = dispatcher.moveThreadToWorktree(THREAD);
      await waitFor(() => provisioned.length === 1);
      await expect(service.compactThread(THREAD)).rejects.toThrow(/being moved into a worktree/);
      releaseProvisioning();
      await moving;
    } finally {
      releaseProvisioning();
    }
  });

  test("sends during the stop and the replacement startup both survive the move", async () => {
    const { store, dispatcher, emit } = await harness();
    provisioned.length = 0;
    FakeAdapter.sent.length = 0;
    let releaseStop = (): void => {};
    let stopping = false;
    const original = FakeAdapter.prototype.stopSession;
    FakeAdapter.prototype.stopSession = async () => {
      stopping = true;
      await new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    };
    try {
      const moving = dispatcher.moveThreadToWorktree(THREAD);
      await waitFor(() => stopping);
      expect(
        await dispatcher.sendThreadTurn({ threadId: THREAD, input: "during stop" }),
      ).toMatchObject({ queued: true });

      holdSessionStart();
      releaseStop();
      await waitFor(() => FakeAdapter.startedCwds.length >= 2);
      // The replacement session has no routing yet; the reservation is what
      // accepts this send rather than refusing it.
      expect(
        await dispatcher.sendThreadTurn({ threadId: THREAD, input: "during restart" }),
      ).toMatchObject({ queued: true });

      releaseSessionStart();
      await moving;
      await waitFor(() => FakeAdapter.sent.length === 1);
      expect(FakeAdapter.sent).toEqual(["during stop"]);
      expect(store.listQueuedTurns(THREAD).map((row) => row.input)).toEqual(["during restart"]);

      // SAFETY: a complete turn.completed literal, the shape an adapter emits.
      emit({
        type: "turn.completed",
        threadId: THREAD,
        provider: "codex",
        turnId: "turn-x",
        at: Date.now(),
        source: "codex.app-server",
      } as RuntimeEvent);
      await waitFor(() => FakeAdapter.sent.length === 2);
      expect(FakeAdapter.sent).toEqual(["during stop", "during restart"]);
    } finally {
      FakeAdapter.prototype.stopSession = original;
      releaseStop();
      releaseSessionStart();
    }
  });

  test("a stop-unconfirmed refusal reclaims the built worktree; a retry builds afresh", async () => {
    const { store, dispatcher } = await harness();
    provisioned.length = 0;
    released.length = 0;
    FakeAdapter.stopError = new Error("stop refused");
    try {
      const result = await dispatcher.moveThreadToWorktree(THREAD);
      expect(result).toMatchObject({ ok: false, reason: "stop-unconfirmed" });
      expect(store.threadWorkspace(THREAD)?.worktreePath ?? null).toBeNull();
      // The generated-branch worktree is given back, so nothing is orphaned.
      expect(released.map((r) => r.worktreePath)).toEqual(["/tmp/kone-worktrees/kone-deadbeef"]);
      expect(released[0]?.reclaimGeneratedBranch).toBe(true);

      FakeAdapter.stopError = null;
      expect(await dispatcher.moveThreadToWorktree(THREAD)).toMatchObject({ ok: true });
    } finally {
      FakeAdapter.stopError = null;
    }
  });

  test("a named branch's worktree is released without reclaiming the branch", async () => {
    const { dispatcher } = await harness();
    provisioned.length = 0;
    released.length = 0;
    FakeAdapter.stopError = new Error("stop refused");
    try {
      const first = await dispatcher.moveThreadToWorktree(THREAD, { branch: "feature/mine" });
      expect(first).toMatchObject({ ok: false, reason: "stop-unconfirmed" });
      expect(provisioned.map((r) => r.branch)).toEqual(["feature/mine"]);
      // The directory this build created is given back, but a branch the user
      // named is never deleted.
      expect(released.map((r) => r.worktreePath)).toEqual(["/tmp/kone-worktrees/feature-mine"]);
      expect(released[0]?.reclaimGeneratedBranch ?? false).toBe(false);

      FakeAdapter.stopError = null;
      provisionAttachedOverride = true;
      expect(
        await dispatcher.moveThreadToWorktree(THREAD, { branch: "feature/mine" }),
      ).toMatchObject({ ok: true });
    } finally {
      FakeAdapter.stopError = null;
      provisionAttachedOverride = undefined;
    }
  });

  test("a pre-existing adopted worktree is never removed on refusal", async () => {
    const { dispatcher } = await harness();
    provisioned.length = 0;
    released.length = 0;
    FakeAdapter.stopError = new Error("stop refused");
    provisionAttachedOverride = true;
    try {
      const first = await dispatcher.moveThreadToWorktree(THREAD, { branch: "feature/theirs" });
      expect(first).toMatchObject({ ok: false, reason: "stop-unconfirmed" });
      // It existed before this build; removing it would destroy work that is
      // not kone's.
      expect(released).toEqual([]);
    } finally {
      FakeAdapter.stopError = null;
      provisionAttachedOverride = undefined;
    }
  });

  test("the destination is not published until the stop is confirmed", async () => {
    const { store, dispatcher } = await harness();
    provisioned.length = 0;
    let releaseStop = (): void => {};
    let stopping = false;
    const original = FakeAdapter.prototype.stopSession;
    FakeAdapter.prototype.stopSession = async () => {
      stopping = true;
      await new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    };
    try {
      const moving = dispatcher.moveThreadToWorktree(THREAD);
      await waitFor(() => stopping);
      // Mid-teardown the thread still reads local: the destination is a
      // candidate, not yet its binding.
      expect(store.threadWorkspace(THREAD)?.worktreePath ?? null).toBeNull();
      releaseStop();
      expect(await moving).toMatchObject({ ok: true });
      expect(store.threadWorkspace(THREAD)?.worktreePath).toBe("/tmp/kone-worktrees/kone-deadbeef");
    } finally {
      FakeAdapter.prototype.stopSession = original;
      releaseStop();
    }
  });

  test("a repeated move never reports a false success; it runs the real path", async () => {
    const { store, dispatcher } = await harness();
    provisioned.length = 0;
    released.length = 0;
    let releaseStop = (): void => {};
    let stopping = false;
    const original = FakeAdapter.prototype.stopSession;
    FakeAdapter.prototype.stopSession = async () => {
      stopping = true;
      await new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      throw new Error("stop unconfirmed");
    };
    try {
      const first = dispatcher.moveThreadToWorktree(THREAD);
      await waitFor(() => stopping);

      let settled = false;
      const repeated = dispatcher.moveThreadToWorktree(THREAD).then((result) => {
        settled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The repeat joins the move in flight; it must not answer success while
      // the first move is still unconfirmed.
      expect(settled).toBe(false);

      // The first stop is already parked inside the override; restore the
      // prototype so the repeat's own stop works, then let the first fail.
      FakeAdapter.prototype.stopSession = original;
      releaseStop();
      const outcome = await first;
      const repeatedResult = await repeated;

      expect(outcome).toMatchObject({ ok: false, reason: "stop-unconfirmed" });
      expect(repeatedResult).toMatchObject({ ok: true });
      expect(store.threadWorkspace(THREAD)?.worktreePath).toBe("/tmp/kone-worktrees/kone-deadbeef");
    } finally {
      FakeAdapter.prototype.stopSession = original;
      releaseStop();
    }
  });

  test("a failed restart restores the binding, reclaims the worktree, and a retry starts", async () => {
    const { store, dispatcher, service } = await harness();
    provisioned.length = 0;
    released.length = 0;
    FakeAdapter.startError = new Error("provider startup refused");
    try {
      const result = await dispatcher.moveThreadToWorktree(THREAD);
      expect(result).toMatchObject({ ok: false, reason: "failed" });
      expect(store.threadWorkspace(THREAD)?.worktreePath ?? null).toBeNull();
      expect(service.hasLiveSession(THREAD)).toBe(false);
      expect(released.map((r) => r.worktreePath)).toEqual(["/tmp/kone-worktrees/kone-deadbeef"]);

      FakeAdapter.startError = null;
      const startsBefore = FakeAdapter.startedCwds.length;
      expect(await dispatcher.moveThreadToWorktree(THREAD)).toMatchObject({ ok: true });
      // The retry ran the real path: it built and started a session, not a
      // stored-path shortcut.
      expect(FakeAdapter.startedCwds.length).toBeGreaterThan(startsBefore);
      expect(service.hasLiveSession(THREAD)).toBe(true);
      expect(store.threadWorkspace(THREAD)?.worktreePath).toBe("/tmp/kone-worktrees/kone-deadbeef");
    } finally {
      FakeAdapter.startError = null;
    }
  });

  test("a restore claimed on the destination during teardown refuses and reclaims", async () => {
    const { store, dispatcher } = await harness();
    provisioned.length = 0;
    released.length = 0;
    let releaseStop = (): void => {};
    let stopping = false;
    const original = FakeAdapter.prototype.stopSession;
    FakeAdapter.prototype.stopSession = async () => {
      stopping = true;
      await new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    };
    const releaseRestore = { fn: (): void => {} };
    try {
      const moving = dispatcher.moveThreadToWorktree(THREAD);
      await waitFor(() => stopping);
      // Claimed while the old session is stopping, on the destination the
      // build already produced: the post-stop recheck must catch it.
      releaseRestore.fn = claimRestoreDir("/tmp/kone-worktrees/kone-deadbeef");
      releaseStop();
      const result = await moving;
      expect(result).toMatchObject({ ok: false, reason: "restoring" });
      expect(store.threadWorkspace(THREAD)?.worktreePath ?? null).toBeNull();
      expect(released.map((r) => r.worktreePath)).toEqual(["/tmp/kone-worktrees/kone-deadbeef"]);
    } finally {
      releaseRestore.fn();
      FakeAdapter.prototype.stopSession = original;
      releaseStop();
    }
  });

  test("a connecting old-checkout start is refused by move admission", async () => {
    const { dispatcher, service } = await harness();
    await service.stopSession(THREAD);
    FakeAdapter.startedCwds.length = 0;
    provisioned.length = 0;
    holdSessionStart();
    try {
      const oldStart = dispatcher.startThread({ threadId: THREAD, provider: "codex", cwd: CWD });
      await waitFor(() => FakeAdapter.startedCwds.length >= 1);
      expect(service.hasLiveSession(THREAD)).toBe(false);

      // The connecting start owns the thread: the move refuses rather than
      // racing it and starting a second session in the worktree.
      expect(await dispatcher.moveThreadToWorktree(THREAD)).toEqual({ ok: false, reason: "busy" });
      expect(provisioned).toHaveLength(0);

      releaseSessionStart();
      await oldStart;
      expect(service.hasLiveSession(THREAD)).toBe(true);
      // It came up in the original checkout; the move never redirected it.
      expect(FakeAdapter.startedCwds).toEqual([CWD]);

      // Once the start has settled, the move runs its real path.
      expect(await dispatcher.moveThreadToWorktree(THREAD)).toMatchObject({ ok: true });
      expect(service.hasLiveSession(THREAD)).toBe(true);
    } finally {
      releaseSessionStart();
    }
  });

  test("a competing start is refused while a move holds the thread", async () => {
    const { dispatcher, service } = await harness();
    provisioned.length = 0;
    holdProvisioning();
    try {
      const moving = dispatcher.moveThreadToWorktree(THREAD);
      await waitFor(() => provisioned.length === 1);
      // The move's reservation owns the thread: a competing start is refused,
      // so nothing can publish an old-checkout session after the move.
      await expect(
        service.startSession({ threadId: THREAD, provider: "codex", cwd: CWD }),
      ).rejects.toThrow(/being moved into a worktree/);
      releaseProvisioning();
      expect(await moving).toMatchObject({ ok: true });
    } finally {
      releaseProvisioning();
    }
  });

  test("a steer already in flight blocks move admission until it settles", async () => {
    const { dispatcher, service, emit, adapter } = await harness();
    FakeAdapter.sent.length = 0;
    FakeAdapter.turnCounter = 0;
    provisioned.length = 0;
    let releaseSteer = (): void => {};
    const steerGate = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
    adapter.steerTurn = async (input) => {
      await steerGate;
      turnStarted(emit, "late-steer-turn");
      return adapter.sendTurn(input);
    };
    turnStarted(emit, "original-turn");
    const steering = service.steerTurn({ threadId: THREAD, input: "accepted user nudge" });
    // The original turn settles while the admitted steer still prepares: the
    // thread reads idle to `isBusy`, but the steer round trip owns it.
    // SAFETY: a complete turn.completed literal, the shape an adapter emits.
    emit({
      type: "turn.completed",
      threadId: THREAD,
      provider: "codex",
      turnId: "original-turn",
      at: Date.now(),
      source: "codex.app-server",
    } as RuntimeEvent);
    expect(service.isThreadBusy(THREAD)).toBe(false);
    try {
      // The move refuses before stopping rather than tearing down the session
      // under the steer and starting a fresh old-checkout turn.
      expect(await dispatcher.moveThreadToWorktree(THREAD)).toEqual({ ok: false, reason: "busy" });
      expect(FakeAdapter.sent).toEqual([]);

      releaseSteer();
      expect((await steering).queued).toBeUndefined();
      expect(FakeAdapter.sent).toEqual(["accepted user nudge"]);
      // SAFETY: a complete turn.completed literal, the shape an adapter emits.
      emit({
        type: "turn.completed",
        threadId: THREAD,
        provider: "codex",
        turnId: "late-steer-turn",
        at: Date.now(),
        source: "codex.app-server",
      } as RuntimeEvent);

      // Once the steer has settled, the move runs its real path.
      FakeAdapter.sent.length = 0;
      expect(await dispatcher.moveThreadToWorktree(THREAD)).toMatchObject({ ok: true });
    } finally {
      releaseSteer();
    }
  });

  test("an already-running native compaction blocks move admission", async () => {
    const { dispatcher, service, adapter } = await harness();
    provisioned.length = 0;
    adapter.capabilities.compaction = { kind: "native" };
    let releaseCompact = (): void => {};
    let enteredCompact = false;
    const gate = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    adapter.compactThread = async () => {
      enteredCompact = true;
      await gate;
      throw new Error("compaction cancelled by teardown");
    };
    const compaction = service.compactThread(THREAD);
    const rejected = compaction.catch((error: Error): string => error.message);
    try {
      await waitFor(() => enteredCompact);
      expect(service.isCompacting(THREAD)).toBe(true);
      // The running compaction owns the session: the move refuses rather than
      // stopping the session out from under it.
      expect(await dispatcher.moveThreadToWorktree(THREAD)).toEqual({ ok: false, reason: "busy" });
      expect(provisioned).toHaveLength(0);
    } finally {
      releaseCompact();
    }
    expect(await rejected).toBe("compaction cancelled by teardown");
  });

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

describe("worktree setup progress and cancellation", () => {
  test("reports staged progress and finishes only after the session starts", async () => {
    const { dispatcher } = await harness();

    await dispatcher.startThread({
      threadId: "t-stages",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "staged" },
    });

    const last = worktreeSetups.at(-1);
    expect(last?.phase).toBe("done");
    expect(last?.stages.map((s) => s.id)).toEqual([
      "fetch",
      "checkout",
      "submodules",
      "setup-script",
      "agent",
    ]);
    expect(last?.stages.find((s) => s.id === "agent")?.status).toBe("done");
    // fetch is reported running to the tracker, not only done.
    expect(
      worktreeSetups.some((s) => s.stages.find((x) => x.id === "fetch")?.status === "running"),
    ).toBe(true);
  });

  test("a failed build reports the setup failed", async () => {
    const { dispatcher } = await harness();
    provisionFails = true;
    try {
      await expect(
        dispatcher.startThread({
          threadId: "t-setup-fail",
          provider: "codex",
          cwd: CWD,
          workspace: { mode: "worktree", branch: "doomed" },
        }),
      ).rejects.toThrow();
    } finally {
      provisionFails = false;
    }
    expect(worktreeSetups.at(-1)?.phase).toBe("failed");
  });

  test("a cancel during the setup script is honoured before linking", async () => {
    const { store, dispatcher } = await harness();
    store.setProjectScript(CWD, "setup", "echo installing");
    let started: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => {};
    setupScriptStarted = started;
    setupScriptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    released.length = 0;

    const starting = dispatcher.startThread({
      threadId: "t-cancel-script",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "long-install" },
    });
    await startedPromise;
    dispatcher.cancelThreadWorkspace("t-cancel-script");
    release();

    const failure: unknown = await starting.then(
      () => null,
      (error) => error,
    );
    expect(isWorkspaceCancel(failure)).toBe(true);
    // The worktree the cancel produced is undone, and no session started.
    expect(released.map((r) => r.worktreePath)).toEqual(["/tmp/kone-worktrees/long-install"]);
    expect(store.threadWorkspace("t-cancel-script")).toEqual({
      envMode: "local",
      worktreePath: null,
      requestedBranch: null,
    });
  });

  test("the agent stage runs while the session connects", async () => {
    const { dispatcher } = await harness();
    holdSessionStart();
    const starting = dispatcher.startThread({
      threadId: "t-connect",
      provider: "codex",
      cwd: CWD,
      workspace: { mode: "worktree", branch: "connect" },
    });
    await waitFor(() => FakeAdapter.startedCwds.includes("/tmp/kone-worktrees/connect"));

    const during = worktreeSetups.at(-1);
    expect(during?.phase).toBe("running");
    expect(during?.stages.find((s) => s.id === "agent")?.status).toBe("running");

    releaseSessionStart();
    await starting;
    expect(worktreeSetups.at(-1)?.stages.find((s) => s.id === "agent")?.status).toBe("done");
  });

  test("a provider startup failure leaves the agent stage failed", async () => {
    const { dispatcher } = await harness();
    FakeAdapter.startError = new Error("provider refused");
    await expect(
      dispatcher.startThread({
        threadId: "t-start-fail",
        provider: "codex",
        cwd: CWD,
        workspace: { mode: "worktree", branch: "start-fail" },
      }),
    ).rejects.toThrow();

    const last = worktreeSetups.at(-1);
    expect(last?.phase).toBe("failed");
    expect(last?.stages.find((s) => s.id === "agent")?.status).toBe("failed");
  });
});
