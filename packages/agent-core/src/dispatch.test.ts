import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
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
import { GLOBAL_ASSISTANT_PROJECT_PATH } from "./conversationStoreTypes.js";

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
  static startedCwds: string[] = [];
  static turnCounter = 0;
  constructor(readonly emit: EmitEvent) {}
  async discover(): Promise<never[]> {
    return [];
  }
  async listModels(): Promise<never[]> {
    return [];
  }
  async startSession(
    input: Pick<SessionStartInput, "threadId" | "cwd">,
  ): Promise<{ threadId: string; provider: "codex" }> {
    // The directory a provider process would have been spawned in. Recorded
    // before the gate so a test can tell the session has started coming up.
    FakeAdapter.startedCwds.push(input.cwd);
    if (startGate) await startGate;
    return { threadId: input.threadId, provider: "codex" };
  }
  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    FakeAdapter.sent.push(input.input);
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

async function harness(): Promise<{
  store: StoreType;
  dispatcher: import("./dispatch.js").ThreadDispatcher;
  emit: EmitEvent;
  service: import("./AgentService.js").AgentService;
}> {
  lastDataDir = mkdtempSync(path.join(tmpdir(), "kone-dispatch-test-"));
  setUserDataDir(lastDataDir);
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
  const dispatcher = initThreadDispatcher({
    service,
    store,
    broadcast: (event) => {
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
  return { store, dispatcher, emit: captured, service };
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
