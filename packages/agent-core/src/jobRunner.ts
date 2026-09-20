// The bench runner: the loop that turns a queued job into a running thread.
//
// Everything durable already lives in the store (store/jobs.ts) — the queue,
// the claim lease, the attempt history. This module is the thin moving part
// between it and the thread dispatcher: claim a job, start its thread, hand it
// the opening prompt, and when that thread's turn settles, settle the run and
// take the next one.
//
// Deliberately NOT in threadSpawn.ts. That module already carries the whole
// spawn engine, and a queue drain has nothing to do with an agent dispatching
// workers mid-turn: they share the dispatcher and nothing else. Keeping them
// apart is also what lets this one be tested against a fake dispatcher with no
// provider anywhere in sight.
//
// The runner holds no queue state of its own. Every decision is a read of the
// store, so a second window, a boot sweep and an in-flight settle can all call
// in without agreeing on anything first — `claimNextJob` is the single atomic
// gate, and losing that race just means there was nothing to take.
//
// One turn per job, for now. A job is one prompt and one attempt at it; a job
// that needs a conversation is a thread, which is what the Inbox is for.

import { randomUUID } from "node:crypto";

import type { ClaimedJob, JobRunOutcome } from "./store/jobs.js";
import type { JobRow, JobRunRow } from "./conversationStoreTypes.js";
import type {
  JobStatus,
  ProviderKind,
  RuntimeEvent,
  SendTurnInput,
  Session,
  SessionStartInput,
  TurnStartResult,
} from "./types.js";

/** The store surface the runner uses. Structural so a unit test can hand in an
 *  in-memory fake; the real ConversationStore satisfies it. */
export interface JobRunnerStore {
  claimNextJob(input: {
    projectPath: string;
    claimedBy: string;
    at?: number;
    leaseMs?: number;
    runId?: string;
  }): ClaimedJob | null;
  bindRunThread(runId: string, threadId: string, at?: number): JobRunRow | null;
  releaseJobClaim(runId: string, error: string, at?: number): boolean;
  settleJobRun(runId: string, outcome: JobRunOutcome, at?: number): JobRunRow | null;
  getJobRunByThread(threadId: string): JobRunRow | null;
  getJob(jobId: string): JobRow | null;
  projectsWithQueuedJobs(): string[];
  sweepExpiredJobClaims(at?: number): number;
}

/** The slice of the thread dispatcher a job needs. Narrow on purpose: a job
 *  starts a thread and sends it one turn, and nothing here should be able to
 *  reach steering, forking or compaction. */
export interface JobThreadDispatcher {
  startThread(input: SessionStartInput): Promise<Session>;
  sendThreadTurn(input: SendTurnInput, options?: { title?: string }): Promise<TurnStartResult>;
  /** Tear down a thread this runner started and then could not use.
   *
   *  Both of `start`'s late failures leave a live provider behind: a bind that
   *  loses its claim to a sweep, and a turn that never starts. The thread is up
   *  either way, and without this the runner could recognise the failure and
   *  still have no way to close what it opened. Idempotent — it is called on
   *  paths where the thread may already be gone. */
  stopThread(threadId: string): Promise<void>;
}

export interface JobRunnerDeps {
  store: JobRunnerStore;
  dispatcher: JobThreadDispatcher;
  /** Announce that a project's bench moved. Optional so a test (or a headless
   *  host) can run the queue with nothing listening. */
  emit?: (event: RuntimeEvent) => void;
  /** Identifies this process in a claim, so a stranded claim can be attributed
   *  when the sweep takes it back. */
  runnerId?: string;
  /** Mint the thread id a job runs in. Injected so a test can make them
   *  predictable and a host can keep its own id scheme. */
  newThreadId?: () => string;
  now?: () => number;
}

/** What one drain attempt did. `idle` means there was nothing to take or the
 *  project was already busy — both are ordinary, and neither is an error. */
export type DrainResult =
  | { outcome: "started"; jobId: string; runId: string; threadId: string; turnId: string }
  | { outcome: "idle" }
  | { outcome: "failed"; jobId: string; runId: string; error: string };

/** The sentence a failed run's `error` column keeps, or `fallback` when the
 *  failure carries none worth reading. Narrowing to Error happens at the catch
 *  itself, so this never has to guess at an unparsed value. */
function messageOf(error: Error, fallback: string): string {
  return error.message.trim() || fallback;
}

/** The session start a job describes. This is the whole reason the job row
 *  stores the fields it does: the mapping is one-to-one, so there is nothing
 *  here to decide — only to hand over. */
function startInputFor(job: JobRow, threadId: string): SessionStartInput {
  const input: SessionStartInput = {
    threadId,
    provider: job.target.provider,
    cwd: job.projectPath,
  };
  if (job.target.model) input.model = job.target.model;
  if (job.target.effort) input.effort = job.target.effort;
  if (job.target.mode) input.mode = job.target.mode;
  if (job.target.workspace) input.workspace = job.target.workspace;
  if (job.target.fallbacks?.length) input.fallbacks = [...job.target.fallbacks];
  return input;
}

/** The opening turn. The job's body is the prompt and its title names the
 *  thread, so the bench and the thread strip agree on what this work is called
 *  without either having to ask the model for a title. */
function turnInputFor(job: JobRow, threadId: string): SendTurnInput {
  const input: SendTurnInput = { threadId, input: job.body };
  if (job.target.model) input.model = job.target.model;
  if (job.target.effort) input.effort = job.target.effort;
  if (job.target.mode) input.mode = job.target.mode;
  if (job.target.fallbacks?.length) input.fallbacks = [...job.target.fallbacks];
  // The files were uploaded when the job was filed. They ride the turn rather
  // than the session start, because the turn is the message they belong to.
  if (job.attachments?.length) input.attachments = [...job.attachments];
  return input;
}

export class JobRunner {
  private readonly store: JobRunnerStore;
  private readonly dispatcher: JobThreadDispatcher;
  private readonly runnerId: string;
  private readonly newThreadId: () => string;
  private readonly now: () => number;
  private readonly emit: (event: RuntimeEvent) => void;

  constructor(deps: JobRunnerDeps) {
    this.store = deps.store;
    this.dispatcher = deps.dispatcher;
    this.runnerId = deps.runnerId ?? `runner-${randomUUID()}`;
    this.newThreadId = deps.newThreadId ?? (() => randomUUID());
    this.now = deps.now ?? (() => Date.now());
    this.emit = deps.emit ?? ((): void => {});
  }

  /** Tell the bench a project moved. The event names what changed and where,
   *  never the row: the bench re-reads the list, so the store stays the one
   *  copy of the queue and the order on screen is always the order that will
   *  run. `threadId` is the job's thread when it has one — a filed draft
   *  belongs to no thread, and the empty string is how BaseEvent says so. */
  private announce(input: {
    projectPath: string;
    provider: ProviderKind;
    jobId: string;
    status?: JobStatus;
    threadId?: string;
  }): void {
    const event: RuntimeEvent = {
      type: "bench.job-changed",
      threadId: input.threadId ?? "",
      provider: input.provider,
      at: this.now(),
      source: "kone.store",
      projectPath: input.projectPath,
      jobId: input.jobId,
    };
    if (input.status) event.status = input.status;
    this.emit(event);
  }

  /** Take the next queued job in a project and start it, if there is one and
   *  the project is free. At most one job moves per call — the queue advances
   *  on settle, not by racing ahead.
   *
   *  Deliberately unguarded against re-entry. A set of in-flight projects used
   *  to sit here, and because a drain is held for the whole of `start` — a
   *  provider coming up, the opening turn going out — it swallowed the drain
   *  that a settle arriving inside that window asks for. The settle was
   *  dropped rather than deferred and the queue stopped with nothing visibly
   *  wrong. Nothing was lost by removing it: `claimNextJob` takes the row in
   *  one statement, so a redundant drain finds the project busy and returns
   *  idle, which is all the guard ever bought. */
  async drainProject(projectPath: string): Promise<DrainResult> {
    const claimed = this.store.claimNextJob({
      projectPath,
      claimedBy: this.runnerId,
      at: this.now(),
    });
    if (!claimed) return { outcome: "idle" };

    return await this.start(claimed);
  }

  /** Close a thread this runner opened and cannot use, so a failed start does
   *  not leave a provider running with nothing pointing at it. Never throws:
   *  it runs on paths that are already reporting a failure, and a teardown
   *  that fails must not replace the reason the attempt ended. */
  private async discard(threadId: string): Promise<void> {
    try {
      await this.dispatcher.stopThread(threadId);
    } catch (err) {
      console.error("[job-runner] could not stop an abandoned thread:", err);
    }
  }

  /** Start a claimed job: thread first, then bind, then the opening turn.
   *
   *  The order is the contract. `job_runs.thread_id` is a real foreign key, so
   *  the thread has to exist before the run can point at it; and the bind has
   *  to land before the turn starts, because a turn that settles faster than
   *  the bind would arrive at a run that does not yet know its own thread. */
  private async start(claimed: ClaimedJob): Promise<DrainResult> {
    const { job, run } = claimed;
    const threadId = this.newThreadId();
    // The claim already moved the job to 'running' in the store, so the bench
    // is told now rather than after the thread comes up: the wait for a
    // provider to start is exactly when the list should already show it
    // running, not still queued.
    this.announce({
      projectPath: job.projectPath,
      provider: job.target.provider,
      jobId: job.jobId,
      status: "running",
    });
    try {
      await this.dispatcher.startThread(startInputFor(job, threadId));
    } catch (err) {
      const error =
        err instanceof Error ? messageOf(err, "The thread could not start.") : "The thread could not start.";
      this.store.releaseJobClaim(run.runId, error, this.now());
      this.announce({
        projectPath: job.projectPath,
        provider: job.target.provider,
        jobId: job.jobId,
        status: "queued",
      });
      return { outcome: "failed", jobId: job.jobId, runId: run.runId, error };
    }

    if (!this.store.bindRunThread(run.runId, threadId, this.now())) {
      // The claim went somewhere else while the thread was starting — a sweep
      // took it back, or the job was cancelled. The thread is real but nothing
      // owns it, so nothing is dispatched into it.
      const error = "claim was no longer held when the thread came up";
      await this.discard(threadId);
      this.announce({
        projectPath: job.projectPath,
        provider: job.target.provider,
        jobId: job.jobId,
      });
      return { outcome: "failed", jobId: job.jobId, runId: run.runId, error };
    }

    try {
      const started = await this.dispatcher.sendThreadTurn(turnInputFor(job, threadId), {
        title: job.title,
      });
      return {
        outcome: "started",
        jobId: job.jobId,
        runId: run.runId,
        threadId,
        turnId: started.turnId,
      };
    } catch (err) {
      // The thread is up but the turn never started, so this attempt is spent
      // — a bound run cannot be released back to the queue, and pretending it
      // can would hand the same thread to a second attempt.
      const error =
        err instanceof Error ? messageOf(err, "The turn could not start.") : "The turn could not start.";
      this.store.settleJobRun(run.runId, { status: "failed", error }, this.now());
      await this.discard(threadId);
      this.announce({
        projectPath: job.projectPath,
        provider: job.target.provider,
        jobId: job.jobId,
        status: "failed",
        threadId,
      });
      return { outcome: "failed", jobId: job.jobId, runId: run.runId, error };
    }
  }

  /** A thread's turn settled. Settles the run it belongs to, then advances
   *  that project's queue. A thread carrying no run is an ordinary chat and is
   *  ignored, which is most of them. */
  async onThreadSettled(threadId: string, outcome: JobRunOutcome): Promise<DrainResult> {
    const run = this.store.getJobRunByThread(threadId);
    if (!run || run.status !== "running") return { outcome: "idle" };
    this.store.settleJobRun(run.runId, outcome, this.now());
    const job = this.store.getJob(run.jobId);
    if (!job) return { outcome: "idle" };
    this.announce({
      projectPath: job.projectPath,
      provider: job.target.provider,
      jobId: job.jobId,
      status: outcome.status,
      threadId,
    });
    return await this.drainProject(job.projectPath);
  }

  /** Boot: hand back claims stranded by a process that died mid-start, then
   *  wake every project that has queued work and nothing running.
   *
   *  Serialized rather than run in parallel: each drain starts a provider
   *  process, and a machine that was quit with six projects queued should not
   *  launch six CLIs in the same tick. Best-effort throughout — a project that
   *  fails to start leaves its job queued for the next drain, and never stops
   *  the others. */
  async recoverAtBoot(): Promise<{ reclaimed: number; started: string[] }> {
    const reclaimed = this.store.sweepExpiredJobClaims(this.now());
    const started: string[] = [];
    for (const projectPath of this.store.projectsWithQueuedJobs()) {
      const result = await this.drainProject(projectPath);
      if (result.outcome === "started") started.push(result.jobId);
    }
    return { reclaimed, started };
  }
}
