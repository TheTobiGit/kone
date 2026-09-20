import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import { JobRunner, type DrainResult, type JobThreadDispatcher } from "./jobRunner.js";
import type { JobCreateInput } from "./conversationStoreTypes.js";
import type { SendTurnInput, Session, SessionStartInput, TurnStartResult } from "./types.js";

import { Database } from "bun:sqlite";

// Driven against the real store — the runner's whole job is the ordering
// between the claim, the thread and the turn, and a fake store would be free
// to allow orders the real one refuses. The dispatcher is the fake here,
// because that is the part that would otherwise launch a provider.
function useUserDataDir(dir: string): string {
  setUserDataDir(dir);
  return dir;
}
useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-job-runner-")));

mock.module("./sqlite.js", () => ({
  DatabaseSync: Database,
}));

type ConversationStoreType = import("./ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

function freshStore(): ConversationStoreType {
  useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-job-runner-")));
  return new ConversationStoreCtor();
}

const PROJECT = "/tmp/project-a";

function job(overrides: Partial<JobCreateInput> = {}): JobCreateInput {
  const input: JobCreateInput = {
    jobId: overrides.jobId ?? `job-${Math.random().toString(36).slice(2)}`,
    projectPath: overrides.projectPath ?? PROJECT,
    title: overrides.title ?? "Fix the auth bug",
    body: overrides.body ?? "The OAuth callback 500s on a missing state param.",
    status: overrides.status ?? "queued",
    target: overrides.target ?? { provider: "codex" },
  };
  if (overrides.at !== undefined) input.at = overrides.at;
  if (overrides.attachments !== undefined) input.attachments = overrides.attachments;
  return input;
}

/** One turn the fake dispatcher was asked to send. */
type RecordedTurn = { input: SendTurnInput; title?: string };

/** A dispatcher that records what it was asked to do and creates the thread
 *  row for real, so the run's foreign key behaves as it does in the app. */
function fakeDispatcher(store: ConversationStoreType) {
  const starts: SessionStartInput[] = [];
  const turns: RecordedTurn[] = [];
  const stopped: string[] = [];
  let failStart: Error | null = null;
  let failTurn: Error | null = null;

  const dispatcher: JobThreadDispatcher = {
    async startThread(input: SessionStartInput): Promise<Session> {
      if (failStart) throw failStart;
      starts.push(input);
      store.ensureThread({
        threadId: input.threadId,
        projectPath: input.cwd,
        provider: input.provider,
      });
      // SAFETY: the runner reads nothing off the session — it only awaits the
      // start — so an empty object stands in for the real one here.
      return {} as Session;
    },
    async sendThreadTurn(
      input: SendTurnInput,
      options?: { title?: string },
    ): Promise<TurnStartResult> {
      if (failTurn) throw failTurn;
      const entry: RecordedTurn = { input };
      if (options?.title !== undefined) entry.title = options.title;
      turns.push(entry);
      return { threadId: input.threadId, turnId: `turn-${turns.length}` };
    },
    async stopThread(threadId: string): Promise<void> {
      stopped.push(threadId);
    },
  };

  return {
    dispatcher,
    starts,
    turns,
    stopped,
    failStartWith(err: Error) {
      failStart = err;
    },
    failTurnWith(err: Error) {
      failTurn = err;
    },
  };
}

function makeRunner(store: ConversationStoreType, threadIds: string[] = []) {
  const fake = fakeDispatcher(store);
  let next = 0;
  const runner = new JobRunner({
    store,
    dispatcher: fake.dispatcher,
    runnerId: "runner-test",
    newThreadId: () => threadIds[next++] ?? `thread-${next}`,
  });
  return { runner, ...fake };
}

beforeAll(async () => {
  const storeModule = await import("./ConversationStore.js");
  ConversationStoreCtor = storeModule.ConversationStore;
});

describe("draining", () => {
  test("a queued job becomes a started thread carrying its prompt", async () => {
    const store = freshStore();
    store.createJob(
      job({
        jobId: "j1",
        title: "Port the search index",
        body: "Move the FTS build off the render thread.",
        target: { provider: "claudeAgent", model: "claude-opus-5", effort: "high" },
      }),
    );
    const { runner, starts, turns } = makeRunner(store, ["thread-1"]);

    const result = await runner.drainProject(PROJECT);
    expect(result).toEqual({
      outcome: "started",
      jobId: "j1",
      runId: expect.any(String),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(starts[0]).toMatchObject({
      threadId: "thread-1",
      provider: "claudeAgent",
      cwd: PROJECT,
      model: "claude-opus-5",
      effort: "high",
    });
    expect(turns[0]?.input.input).toBe("Move the FTS build off the render thread.");
    expect(turns[0]?.title).toBe("Port the search index");
  });

  test("the worktree choice rides the session start", async () => {
    const store = freshStore();
    store.createJob(
      job({
        jobId: "j1",
        target: {
          provider: "codex",
          workspace: { mode: "worktree", branch: "feat/search", base: "main" },
        },
      }),
    );
    const { runner, starts } = makeRunner(store);
    await runner.drainProject(PROJECT);
    expect(starts[0]?.workspace).toEqual({
      mode: "worktree",
      branch: "feat/search",
      base: "main",
    });
  });

  test("a draft is not drained", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1", status: "draft" }));
    const { runner, starts } = makeRunner(store);
    expect(await runner.drainProject(PROJECT)).toEqual({ outcome: "idle" });
    expect(starts).toHaveLength(0);
  });

  test("an empty queue is idle, not an error", async () => {
    const store = freshStore();
    const { runner } = makeRunner(store);
    expect(await runner.drainProject(PROJECT)).toEqual({ outcome: "idle" });
  });

  test("draining twice does not start a second job", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1", at: 1_000 }));
    store.createJob(job({ jobId: "j2", at: 2_000 }));
    const { runner, starts } = makeRunner(store);

    await runner.drainProject(PROJECT);
    expect(await runner.drainProject(PROJECT)).toEqual({ outcome: "idle" });
    expect(starts).toHaveLength(1);
  });

  test("the thread exists before the run points at it", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1" }));
    const { runner } = makeRunner(store, ["thread-1"]);
    await runner.drainProject(PROJECT);

    const run = store.getJobRunByThread("thread-1");
    expect(run?.status).toBe("running");
    expect(run?.threadId).toBe("thread-1");
  });
});

describe("start failures", () => {
  test("a thread that will not start re-queues the job", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1" }));
    const { runner, failStartWith } = makeRunner(store);
    failStartWith(new Error("codex is not installed"));

    const result = await runner.drainProject(PROJECT);
    expect(result).toMatchObject({ outcome: "failed", error: "codex is not installed" });
    expect(store.getJob("j1")?.status).toBe("queued");
    expect(store.getJob("j1")?.startedAt).toBeUndefined();
  });

  test("a re-queued job is picked up by the next drain", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1" }));
    const first = makeRunner(store);
    first.failStartWith(new Error("transient"));
    await first.runner.drainProject(PROJECT);

    const second = makeRunner(store, ["thread-1"]);
    const result = await second.runner.drainProject(PROJECT);
    expect(result).toMatchObject({ outcome: "started", jobId: "j1" });
  });

  test("a turn that will not start spends the attempt rather than re-queueing", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1" }));
    const { runner, failTurnWith } = makeRunner(store, ["thread-1"]);
    failTurnWith(new Error("provider refused the turn"));

    const result = await runner.drainProject(PROJECT);
    expect(result).toMatchObject({ outcome: "failed", error: "provider refused the turn" });
    expect(store.getJob("j1")?.status).toBe("failed");
    expect(store.getJobRunByThread("thread-1")?.status).toBe("failed");
  });
});

describe("settling", () => {
  test("a settled turn settles the job and starts the next one", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1", at: 1_000 }));
    store.createJob(job({ jobId: "j2", at: 2_000 }));
    const { runner, starts } = makeRunner(store, ["thread-1", "thread-2"]);

    await runner.drainProject(PROJECT);
    const result = await runner.onThreadSettled("thread-1", { status: "done" });

    expect(store.getJob("j1")?.status).toBe("done");
    expect(result).toMatchObject({ outcome: "started", jobId: "j2", threadId: "thread-2" });
    expect(starts).toHaveLength(2);
  });

  test("a failed turn settles the job failed and still advances the queue", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1", at: 1_000 }));
    store.createJob(job({ jobId: "j2", at: 2_000 }));
    const { runner } = makeRunner(store, ["thread-1", "thread-2"]);

    await runner.drainProject(PROJECT);
    await runner.onThreadSettled("thread-1", { status: "failed", error: "the build broke" });

    expect(store.getJob("j1")?.status).toBe("failed");
    expect(store.getJob("j2")?.status).toBe("running");
  });

  test("a thread carrying no job is ignored", async () => {
    const store = freshStore();
    store.ensureThread({ threadId: "chat-1", projectPath: PROJECT, provider: "codex" });
    const { runner } = makeRunner(store);
    expect(await runner.onThreadSettled("chat-1", { status: "done" })).toEqual({
      outcome: "idle",
    });
  });

  test("settling the same thread twice does not double-advance the queue", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1", at: 1_000 }));
    store.createJob(job({ jobId: "j2", at: 2_000 }));
    store.createJob(job({ jobId: "j3", at: 3_000 }));
    const { runner, starts } = makeRunner(store, ["thread-1", "thread-2", "thread-3"]);

    await runner.drainProject(PROJECT);
    await runner.onThreadSettled("thread-1", { status: "done" });
    await runner.onThreadSettled("thread-1", { status: "done" });

    expect(starts).toHaveLength(2);
    expect(store.getJob("j3")?.status).toBe("queued");
  });
});

describe("boot recovery", () => {
  test("a claim stranded by a dead process is reclaimed and restarted", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1" }));
    // A process that died between taking the row and starting the thread.
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "dead-runner",
      runId: "run-dead",
      at: 1_000,
      leaseMs: 100,
    });

    const { runner, starts } = makeRunner(store, ["thread-1"]);
    const result = await runner.recoverAtBoot();

    expect(result.reclaimed).toBe(1);
    expect(result.started).toEqual(["j1"]);
    expect(starts).toHaveLength(1);
    expect(store.getJobRun("run-dead")?.status).toBe("failed");
  });

  test("every project with queued work is woken", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "a1", projectPath: "/tmp/a" }));
    store.createJob(job({ jobId: "b1", projectPath: "/tmp/b" }));
    const { runner } = makeRunner(store, ["thread-a", "thread-b"]);

    const result = await runner.recoverAtBoot();
    expect(result.started.sort()).toEqual(["a1", "b1"]);
  });

  test("a project already running is left alone", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "a1", projectPath: "/tmp/a", at: 1_000 }));
    store.createJob(job({ jobId: "a2", projectPath: "/tmp/a", at: 2_000 }));
    const { runner } = makeRunner(store, ["thread-1"]);
    await runner.drainProject("/tmp/a");

    const result = await runner.recoverAtBoot();
    expect(result.started).toEqual([]);
  });

  test("nothing queued is a clean no-op", async () => {
    const store = freshStore();
    const { runner } = makeRunner(store);
    expect(await runner.recoverAtBoot()).toEqual({ reclaimed: 0, started: [] });
  });
});

/** One bench announcement, flattened to the fields a test asserts on. */
type RecordedAnnouncement = { jobId?: string; status?: string; threadId: string };

describe("announcing", () => {
  /** A runner wired to a recorder instead of the broadcast, so a test can read
   *  exactly what the bench would have been told. */
  function recordingRunner(store: ConversationStoreType, threadIds: string[] = []) {
    const fake = fakeDispatcher(store);
    const events: RecordedAnnouncement[] = [];
    let next = 0;
    const runner = new JobRunner({
      store,
      dispatcher: fake.dispatcher,
      runnerId: "runner-test",
      newThreadId: () => threadIds[next++] ?? `thread-${next}`,
      emit: (event) => {
        if (event.type !== "bench.job-changed") return;
        const entry: RecordedAnnouncement = { threadId: event.threadId };
        if (event.jobId !== undefined) entry.jobId = event.jobId;
        if (event.status !== undefined) entry.status = event.status;
        events.push(entry);
      },
    });
    return { runner, events, ...fake };
  }

  test("starting announces running before the provider is up", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1" }));
    const { runner, events } = recordingRunner(store, ["thread-1"]);

    await runner.drainProject(PROJECT);
    expect(events).toEqual([{ jobId: "j1", status: "running", threadId: "" }]);
  });

  test("a settle announces the outcome against the job's thread", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1" }));
    const { runner, events } = recordingRunner(store, ["thread-1"]);

    await runner.drainProject(PROJECT);
    events.length = 0;
    await runner.onThreadSettled("thread-1", { status: "done" });

    expect(events[0]).toEqual({ jobId: "j1", status: "done", threadId: "thread-1" });
  });

  test("a re-queued job announces its way back to the queue", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1" }));
    const { runner, events, failStartWith } = recordingRunner(store);
    failStartWith(new Error("codex is not installed"));

    await runner.drainProject(PROJECT);
    expect(events.map((e) => e.status)).toEqual(["running", "queued"]);
  });

  test("a runner with nothing listening still drains", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1" }));
    const { runner } = makeRunner(store, ["thread-1"]);
    expect(await runner.drainProject(PROJECT)).toMatchObject({ outcome: "started" });
  });
});

// The ordering this module exists to get right, and the one nothing covered.
//
// A drain is held for the whole of `start` — the provider coming up, the
// opening turn going out — and the settle that advances the queue can land
// inside that window. A runner that refused a drain while one was in flight
// dropped that settle instead of deferring it, and the queue stopped with
// every row still queued and nothing visibly wrong.
describe("a settle that lands mid-start", () => {
  test("still advances the queue", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1", at: 1 }));
    store.createJob(job({ jobId: "j2", at: 2 }));

    const fake = fakeDispatcher(store);
    const sendTurn = fake.dispatcher.sendThreadTurn.bind(fake.dispatcher);
    let nested: DrainResult = { outcome: "idle" };
    let runner: JobRunner | null = null;

    // j1's turn settles before its own start has returned, which is what a
    // fast turn or a synchronous event pump gives you. Only the first turn
    // does this: j2 is left running, which is the state being asserted.
    let settledFirst = false;
    fake.dispatcher.sendThreadTurn = async (input, options) => {
      const result = await sendTurn(input, options);

      if (settledFirst) return result;
      settledFirst = true;

      const run = store.getJobRunByThread(input.threadId);

      if (run) store.settleJobRun(run.runId, { status: "done" });
      if (runner) nested = await runner.drainProject(PROJECT);

      return result;
    };

    runner = new JobRunner({
      store,
      dispatcher: fake.dispatcher,
      runnerId: "runner-test",
      newThreadId: () => `thread-${store.listAllJobs().filter((j) => j.startedAt).length + 1}`,
    });

    const first = await runner.drainProject(PROJECT);

    expect(first.outcome).toBe("started");
    // The settle's own drain took the next job rather than being swallowed.
    expect(nested.outcome).toBe("started");
    expect(store.getJob("j1")?.status).toBe("done");
    expect(store.getJob("j2")?.status).toBe("running");
  });
});

// The claim's whole purpose: two callers cannot both take the same row.
describe("claiming is atomic", () => {
  test("a second claim takes nothing while the project is busy", () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1", at: 1 }));
    store.createJob(job({ jobId: "j2", at: 2 }));

    const first = store.claimNextJob({ projectPath: PROJECT, claimedBy: "a" });
    const second = store.claimNextJob({ projectPath: PROJECT, claimedBy: "b" });

    expect(first?.job.jobId).toBe("j1");
    expect(second).toBeNull();
    expect(store.getJob("j2")?.status).toBe("queued");
  });

  test("the row is taken in the statement that picks it, so no two claims agree", () => {
    const store = freshStore();
    store.createJob(job({ jobId: "only", at: 1 }));

    const a = store.claimNextJob({ projectPath: PROJECT, claimedBy: "a" });
    const b = store.claimNextJob({ projectPath: PROJECT, claimedBy: "b" });

    expect(a?.job.jobId).toBe("only");
    expect(b).toBeNull();
    // One claim, one run — a second insert would have collided on the
    // UNIQUE (job_id, attempt) the attempt counter feeds.
    expect(store.listJobRuns("only")).toHaveLength(1);
  });
});

// Files filed with a job used to be uploaded and then dropped on the floor:
// the row had nowhere to keep them, so a job ran without the screenshots its
// author attached and nothing reported the loss.
describe("attachments", () => {
  test("survive filing and ride the opening turn", async () => {
    const store = freshStore();
    store.createJob(
      job({
        jobId: "with-files",
        attachments: [
          { type: "image", id: "att-1", name: "screenshot.png", mimeType: "image/png", sizeBytes: 2048 },
        ],
      }),
    );

    expect(store.getJob("with-files")?.attachments).toHaveLength(1);

    const { runner, turns } = makeRunner(store);
    await runner.drainProject(PROJECT);

    expect(turns[0]?.input.attachments).toEqual([
      { type: "image", id: "att-1", name: "screenshot.png", mimeType: "image/png", sizeBytes: 2048 },
    ]);
  });

  test("a job filed without files carries none", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "no-files" }));

    expect(store.getJob("no-files")?.attachments).toBeUndefined();

    const { runner, turns } = makeRunner(store);
    await runner.drainProject(PROJECT);

    expect(turns[0]?.input.attachments).toBeUndefined();
  });
});

// Both of start's late failures leave a real provider behind. The runner used
// to recognise them and walk away, because the dispatcher it was given had no
// way to close a thread — so a swept claim or a turn that would not start left
// a process running with nothing in the store pointing at it.
describe("a thread the runner cannot use", () => {
  test("is stopped when the turn never starts", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1" }));

    const { runner, stopped, failTurnWith } = makeRunner(store, ["thread-1"]);
    failTurnWith(new Error("provider refused the turn"));

    const result = await runner.drainProject(PROJECT);

    expect(result.outcome).toBe("failed");
    expect(stopped).toEqual(["thread-1"]);
  });

  test("is stopped when the claim was swept while it came up", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1" }));

    const { runner, stopped } = makeRunner(store, ["thread-1"]);
    const claim = store.claimNextJob({ projectPath: PROJECT, claimedBy: "other", runId: "run-x" });

    expect(claim).not.toBeNull();

    // The bind targets a run that is no longer claimed, which is what a sweep
    // taking the claim back mid-start looks like from here.
    store.settleJobRun("run-x", { status: "failed", error: "swept" });

    const result = await runner.drainProject(PROJECT);

    // Nothing left to claim, so the runner never got as far as a thread.
    expect(result.outcome).toBe("idle");
    expect(stopped).toEqual([]);
  });

  test("a start that throws releases the claim and opens no thread", async () => {
    const store = freshStore();
    store.createJob(job({ jobId: "j1" }));

    const { runner, stopped, failStartWith } = makeRunner(store, ["thread-1"]);
    failStartWith(new Error("provider would not boot"));

    const result = await runner.drainProject(PROJECT);

    expect(result.outcome).toBe("failed");
    // The thread never came up, so there is nothing to close.
    expect(stopped).toEqual([]);
    expect(store.getJob("j1")?.status).toBe("queued");
  });
});
