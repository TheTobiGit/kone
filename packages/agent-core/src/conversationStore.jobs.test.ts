import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";

import { Database } from "bun:sqlite";

// Same standing as the other store tests: node:sqlite is an Electron-runtime
// built-in this bun can't load, so bun:sqlite stands in for it, and
// ConversationStore is imported dynamically so the stub is in place before the
// module graph resolves.
let testUserDataDir = "";
function useUserDataDir(dir: string): string {
  testUserDataDir = dir;
  setUserDataDir(dir);
  return dir;
}
useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-jobs-store-")));

mock.module("./sqlite.js", () => ({
  DatabaseSync: Database,
}));

type ConversationStoreType = import("./ConversationStore.js").ConversationStore;
type JobCreateInput = import("./conversationStoreTypes.js").JobCreateInput;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

function freshStore(): ConversationStoreType {
  useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-jobs-store-")));
  return new ConversationStoreCtor();
}

function rawDb(): Database {
  return new Database(path.join(testUserDataDir, "kone.sqlite"));
}

/** A second store over the same file — what the next launch sees, and what
 *  runs the open-time recovery passes. */
function reopenStore(): ConversationStoreType {
  return new ConversationStoreCtor();
}

const PROJECT = "/tmp/project-a";

/** Create the thread a run binds to. `job_runs.thread_id` is a real foreign
 *  key, so a test that binds has to have a thread to bind to. */
function thread(store: ConversationStoreType, threadId: string): string {
  store.ensureThread({ threadId, projectPath: PROJECT, provider: "codex" });
  return threadId;
}

function draft(overrides: Partial<JobCreateInput> = {}): JobCreateInput {
  const input: JobCreateInput = {
    jobId: overrides.jobId ?? `job-${Math.random().toString(36).slice(2)}`,
    projectPath: overrides.projectPath ?? PROJECT,
    title: overrides.title ?? "Fix the auth bug",
    body: overrides.body ?? "The OAuth callback 500s on a missing state param.",
    status: overrides.status ?? "draft",
    target: overrides.target ?? { provider: "codex" },
  };
  if (overrides.at !== undefined) input.at = overrides.at;
  return input;
}

beforeAll(async () => {
  const storeModule = await import("./ConversationStore.js");
  ConversationStoreCtor = storeModule.ConversationStore;
});

describe("job rows", () => {
  test("a filed draft round-trips every target field", () => {
    const store = freshStore();
    const created = store.createJob(
      draft({
        jobId: "t1",
        target: {
          provider: "claudeAgent",
          model: "claude-opus-5",
          effort: "high",
          mode: "accept-edits",
          workspace: { mode: "worktree", branch: "feat/auth", base: "main" },
          fallbacks: [
            { provider: "codex", model: "gpt-5" },
            { provider: "droid" },
          ],
        },
      }),
    );
    expect(created?.status).toBe("draft");
    const read = store.getJob("t1");
    expect(read?.target).toEqual({
      provider: "claudeAgent",
      model: "claude-opus-5",
      effort: "high",
      mode: "accept-edits",
      workspace: { mode: "worktree", branch: "feat/auth", base: "main" },
      fallbacks: [{ provider: "codex", model: "gpt-5" }, { provider: "droid" }],
    });
  });

  test("a job with no worktree choice stores null, not an empty record", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1" }));
    // SAFETY: single selected column, so the row shape is fixed by the SQL.
    const row = rawDb()
      .prepare(
        `SELECT workspace_json, fallbacks_json FROM jobs WHERE job_id = ?`,
      )
      .get("t1") as {
      workspace_json: string | null;
      fallbacks_json: string | null;
    };
    expect(row.workspace_json).toBeNull();
    expect(row.fallbacks_json).toBeNull();
    expect(store.getJob("t1")?.target.workspace).toBeUndefined();
  });

  test("a corrupt workspace column reads as no choice rather than throwing", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1" }));
    rawDb()
      .prepare(`UPDATE jobs SET workspace_json = ? WHERE job_id = ?`)
      .run('"nope"', "t1");
    const read = store.getJob("t1");
    expect(read).not.toBeNull();
    expect(read?.target.workspace).toBeUndefined();
  });

  test("editing is refused once the job is running", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued" }));
    expect(store.updateJob("t1", { title: "Edited" })?.title).toBe("Edited");
    store.claimNextJob({ projectPath: PROJECT, claimedBy: "runner-1" });
    expect(store.updateJob("t1", { title: "Too late" })).toBeNull();
    expect(store.getJob("t1")?.title).toBe("Edited");
  });

  test("queueing and unqueueing only move between draft and queued", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1" }));
    expect(store.setJobQueued("t1", true)?.status).toBe("queued");
    expect(store.setJobQueued("t1", true)).toBeNull();
    expect(store.setJobQueued("t1", false)?.status).toBe("draft");
  });
});

describe("claiming", () => {
  test("claims in drain order, explicit positions first", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "old", status: "queued", at: 1_000 }));
    store.createJob(draft({ jobId: "new", status: "queued", at: 2_000 }));
    store.reorderJobs(PROJECT, ["new"]);

    const first = store.claimNextJob({ projectPath: PROJECT, claimedBy: "r" });
    expect(first?.job.jobId).toBe("new");
  });

  test("with no reorder, the oldest queued job drains first", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "new", status: "queued", at: 2_000 }));
    store.createJob(draft({ jobId: "old", status: "queued", at: 1_000 }));
    expect(
      store.claimNextJob({ projectPath: PROJECT, claimedBy: "r" })?.job.jobId,
    ).toBe("old");
  });

  test("a draft is never claimed", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "draft" }));
    expect(
      store.claimNextJob({ projectPath: PROJECT, claimedBy: "r" }),
    ).toBeNull();
  });

  test("one job at a time per project", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued", at: 1_000 }));
    store.createJob(draft({ jobId: "t2", status: "queued", at: 2_000 }));
    expect(
      store.claimNextJob({ projectPath: PROJECT, claimedBy: "r" })?.job.jobId,
    ).toBe("t1");
    expect(
      store.claimNextJob({ projectPath: PROJECT, claimedBy: "r" }),
    ).toBeNull();
  });

  test("a busy project does not block another project's queue", () => {
    const store = freshStore();
    store.createJob(
      draft({ jobId: "a1", projectPath: "/tmp/a", status: "queued" }),
    );
    store.createJob(
      draft({ jobId: "b1", projectPath: "/tmp/b", status: "queued" }),
    );
    expect(
      store.claimNextJob({ projectPath: "/tmp/a", claimedBy: "r" })?.job.jobId,
    ).toBe("a1");
    expect(
      store.claimNextJob({ projectPath: "/tmp/b", claimedBy: "r" })?.job.jobId,
    ).toBe("b1");
  });

  test("attempts number upward across retries", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued" }));
    const first = store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
    });
    expect(first?.run.attempt).toBe(1);
    store.settleJobRun("run-1", { status: "failed", error: "boom" });

    store.requeueJob("t1");
    const second = store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-2",
    });
    expect(second?.run.attempt).toBe(2);
    expect(store.listJobRuns("t1").map((r) => r.attempt)).toEqual([2, 1]);
  });
});

describe("run lifecycle", () => {
  test("binding a thread ends the claim window", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued" }));
    const claimed = store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
    });
    expect(claimed?.run.status).toBe("claimed");
    expect(claimed?.run.leaseExpiresAt).toBeDefined();

    const bound = store.bindRunThread("run-1", thread(store, "thread-1"));
    expect(bound?.status).toBe("running");
    expect(bound?.threadId).toBe("thread-1");
    expect(bound?.leaseExpiresAt).toBeUndefined();
  });

  test("binding twice is refused", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued" }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
    });
    expect(
      store.bindRunThread("run-1", thread(store, "thread-1")),
    ).not.toBeNull();
    expect(store.bindRunThread("run-1", thread(store, "thread-2"))).toBeNull();
  });

  test("settling a run settles its job in the same breath", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued" }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
    });
    store.bindRunThread("run-1", thread(store, "thread-1"));
    store.settleJobRun("run-1", { status: "done" });

    expect(store.getJob("t1")?.status).toBe("done");
    expect(store.getJob("t1")?.endedAt).toBeDefined();
    expect(store.getJobRun("run-1")?.status).toBe("done");
  });

  test("a settled job frees the project for the next claim", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued", at: 1_000 }));
    store.createJob(draft({ jobId: "t2", status: "queued", at: 2_000 }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
    });
    store.settleJobRun("run-1", { status: "done" });
    expect(
      store.claimNextJob({ projectPath: PROJECT, claimedBy: "r" })?.job.jobId,
    ).toBe("t2");
  });

  test("a failed dispatch returns the job to the queue, not to failed", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued" }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
    });
    expect(store.releaseJobClaim("run-1", "no provider available")).toBe(true);

    expect(store.getJob("t1")?.status).toBe("queued");
    expect(store.getJob("t1")?.startedAt).toBeUndefined();
    expect(store.getJobRun("run-1")?.error).toBe("no provider available");
    expect(
      store.claimNextJob({ projectPath: PROJECT, claimedBy: "r" })?.job.jobId,
    ).toBe("t1");
  });

  test("releasing a bound run is refused — the thread is already live", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued" }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
    });
    store.bindRunThread("run-1", thread(store, "thread-1"));
    expect(store.releaseJobClaim("run-1", "late")).toBe(false);
    expect(store.getJob("t1")?.status).toBe("running");
  });

  test("settling the same run twice changes nothing the second time", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued" }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
    });
    store.settleJobRun("run-1", { status: "done" }, 5_000);
    expect(
      store.settleJobRun("run-1", { status: "failed", error: "late" }),
    ).toBeNull();
    expect(store.getJob("t1")?.status).toBe("done");
    expect(store.getJobRun("run-1")?.endedAt).toBe(5_000);
  });
});

describe("crash recovery", () => {
  test("reopening releases a claim the previous process was holding", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "j1", status: "queued" }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "dead-runner",
      runId: "run-1",
      leaseMs: 60 * 60_000,
    });
    expect(store.getJob("j1")?.status).toBe("running");

    // The lease is nowhere near expiry, but no runner survives a restart.
    const next = reopenStore();
    expect(next.getJob("j1")?.status).toBe("queued");
    expect(next.getJob("j1")?.startedAt).toBeUndefined();
    expect(next.getJobRun("run-1")?.status).toBe("failed");
    expect(next.getJobRun("run-1")?.error).toBe(
      "interrupted before the thread started",
    );
  });

  test("reopening leaves a run that reached its thread alone", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "j1", status: "queued" }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
    });
    store.bindRunThread("run-1", thread(store, "thread-1"));

    const next = reopenStore();
    expect(next.getJob("j1")?.status).toBe("running");
    expect(next.getJobRun("run-1")?.status).toBe("running");
  });

  test("an expired claim returns the job to the queue", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued" }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "dead-runner",
      runId: "run-1",
      at: 1_000,
      leaseMs: 100,
    });
    expect(store.getJob("t1")?.status).toBe("running");

    expect(store.sweepExpiredJobClaims(5_000)).toBe(1);
    expect(store.getJob("t1")?.status).toBe("queued");
    expect(store.getJobRun("run-1")?.status).toBe("failed");
    expect(store.getJobRun("run-1")?.error).toBe("claim expired");
  });

  test("the sweep leaves a bound run alone — the thread is the evidence", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued" }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
      at: 1_000,
      leaseMs: 100,
    });
    store.bindRunThread("run-1", thread(store, "thread-1"));
    expect(store.sweepExpiredJobClaims(5_000)).toBe(0);
    expect(store.getJob("t1")?.status).toBe("running");
  });

  test("a live lease is not swept", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued" }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
      at: 1_000,
      leaseMs: 10_000,
    });
    expect(store.sweepExpiredJobClaims(2_000)).toBe(0);
    expect(store.getJob("t1")?.status).toBe("running");
  });
});

describe("listing", () => {
  test("queued jobs lead the list in the order they will run", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "done-1", status: "queued", at: 1_000 }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
    });
    store.settleJobRun("run-1", { status: "done" });
    store.createJob(draft({ jobId: "q-old", status: "queued", at: 2_000 }));
    store.createJob(draft({ jobId: "q-new", status: "queued", at: 3_000 }));
    store.createJob(draft({ jobId: "d-1", status: "draft", at: 4_000 }));

    const ids = store.listJobs(PROJECT).map((t) => t.jobId);
    expect(ids.slice(0, 2)).toEqual(["q-old", "q-new"]);
    expect(ids).toContain("done-1");
    expect(ids).toContain("d-1");
  });

  test("a listed job carries the branch its latest attempt ran on", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "ran", status: "queued" }));
    store.claimNextJob({ projectPath: PROJECT, claimedBy: "r", runId: "run-1" });
    store.bindRunThread("run-1", thread(store, "thread-1"));
    store.recordRepoStats({ threadId: "thread-1", branch: "dev" });

    expect(store.listJobs(PROJECT)[0]?.branch).toBe("dev");
    expect(store.listAllJobs()[0]?.branch).toBe("dev");
  });

  test("a job that has not run yet carries no branch", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "waiting", status: "queued" }));
    // The checkout can still move before the runner takes it, so there is no
    // honest answer to give — not the project's branch as it stands right now.
    expect(store.listJobs(PROJECT)[0]?.branch).toBeUndefined();
  });

  test("a retry's branch replaces the earlier attempt's", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "retried", status: "queued" }));
    store.claimNextJob({ projectPath: PROJECT, claimedBy: "r", runId: "run-1" });
    store.bindRunThread("run-1", thread(store, "thread-1"));
    store.recordRepoStats({ threadId: "thread-1", branch: "old-branch" });
    store.settleJobRun("run-1", { status: "failed" });

    store.requeueJob("retried");
    store.claimNextJob({ projectPath: PROJECT, claimedBy: "r", runId: "run-2" });
    store.bindRunThread("run-2", thread(store, "thread-2"));
    store.recordRepoStats({ threadId: "thread-2", branch: "new-branch" });

    expect(store.listJobs(PROJECT)[0]?.branch).toBe("new-branch");
  });

  test("a project's list holds only its own jobs", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "a1", projectPath: "/tmp/a" }));
    store.createJob(draft({ jobId: "b1", projectPath: "/tmp/b" }));
    expect(store.listJobs("/tmp/a").map((t) => t.jobId)).toEqual(["a1"]);
  });

  test("the global list holds every project's jobs", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "a1", projectPath: "/tmp/a" }));
    store.createJob(draft({ jobId: "b1", projectPath: "/tmp/b" }));
    expect(
      store
        .listAllJobs()
        .map((t) => t.jobId)
        .sort(),
    ).toEqual(["a1", "b1"]);
  });

  test("the global list keeps each project's queue in the order it will run", () => {
    const store = freshStore();
    store.createJob(
      draft({
        jobId: "a-old",
        projectPath: "/tmp/a",
        status: "queued",
        at: 1_000,
      }),
    );
    store.createJob(
      draft({
        jobId: "b-old",
        projectPath: "/tmp/b",
        status: "queued",
        at: 2_000,
      }),
    );
    store.createJob(
      draft({
        jobId: "a-new",
        projectPath: "/tmp/a",
        status: "queued",
        at: 3_000,
      }),
    );
    store.createJob(
      draft({
        jobId: "d-1",
        projectPath: "/tmp/b",
        status: "draft",
        at: 4_000,
      }),
    );

    const ids = store.listAllJobs().map((t) => t.jobId);
    // Queued first, oldest-first — so each project's rows stay in its own
    // drain order even though the list interleaves two projects.
    expect(ids.slice(0, 3)).toEqual(["a-old", "b-old", "a-new"]);
    expect(ids.indexOf("a-old")).toBeLessThan(ids.indexOf("a-new"));
    expect(ids.at(-1)).toBe("d-1");
  });

  test("deleting a settled job takes its runs with it", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued" }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
    });
    store.settleJobRun("run-1", { status: "done" });

    expect(store.deleteJob("t1")).toBe(true);
    expect(store.getJobRun("run-1")).toBeNull();
  });

  // The delete cascades the runs away, so doing it to a running job would
  // leave the provider it started with nothing in the store pointing at it.
  test("deleting a running job is refused", () => {
    const store = freshStore();
    store.createJob(draft({ jobId: "t1", status: "queued" }));
    store.claimNextJob({
      projectPath: PROJECT,
      claimedBy: "r",
      runId: "run-1",
    });

    expect(store.getJob("t1")?.status).toBe("running");
    expect(store.deleteJob("t1")).toBe(false);
    expect(store.getJob("t1")).not.toBeNull();
    expect(store.getJobRun("run-1")).not.toBeNull();
  });
});

// A database that already sat at v9 is the case this migration exists for: the
// jobs tables were shipped there, and v10 corrects them in place rather than by
// editing v9 under a database that has already run it.
describe("migrating a v9 database to v10", () => {
  function columnNames(db: InstanceType<typeof Database>, table: string): string[] {
    // SAFETY: PRAGMA table_info projects a fixed row shape; only the name is read.
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  function indexNames(db: InstanceType<typeof Database>, table: string): string[] {
    // SAFETY: PRAGMA index_list projects a fixed row shape; only the name is read.
    const rows = db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  /** A database at v9, in the place the store will look for it. */
  async function v9(prefix: string) {
    const dir = useUserDataDir(mkdtempSync(path.join(tmpdir(), prefix)));
    const file = path.join(dir, "kone.sqlite");
    const migrations = await import("./conversationMigrations.js");
    const raw = new Database(file);

    migrations.migrate(raw, file, { toMigrationInclusive: 9 });

    return { raw, file, migrate: migrations.migrate };
  }

  test("adds the column, settles the order, and pins one run per thread", async () => {
    const { raw, file, migrate } = await v9("kone-jobs-v9-");

    // v9 shipped without it, which is why the files were being dropped.
    expect(columnNames(raw, "jobs")).not.toContain("attachments_json");
    expect(indexNames(raw, "job_runs")).toContain("idx_job_runs_task");

    // A row written under v9 carries the NULL that v10 has to settle.
    raw.exec(`
      INSERT INTO jobs (job_id, project_path, title, body, status, sort_key,
                        provider, created_at, updated_at)
      VALUES ('legacy', '/p', 'Old', 'Body', 'queued', NULL, 'codex', 1, 1);
    `);

    migrate(raw, file);

    expect(columnNames(raw, "jobs")).toContain("attachments_json");
    expect(indexNames(raw, "job_runs")).toContain("idx_job_runs_thread_unique");
    expect(indexNames(raw, "job_runs")).not.toContain("idx_job_runs_task");
    expect(indexNames(raw, "job_runs")).toContain("idx_job_runs_attempt");

    // SAFETY: one selected column, so the row shape is fixed by the SQL.
    const row = raw.prepare(`SELECT sort_key FROM jobs WHERE job_id = 'legacy'`).get() as {
      sort_key: number | null;
    };
    expect(row.sort_key).toBe(1e18);
    raw.close();

    // And the settled row still reads as one nobody ordered.
    const store = new ConversationStoreCtor();
    expect(store.getJob("legacy")?.sortKey).toBeUndefined();
  });

  test("is idempotent", async () => {
    const { raw, file, migrate } = await v9("kone-jobs-v10-again-");

    migrate(raw, file);
    expect(() => migrate(raw, file)).not.toThrow();
    expect(columnNames(raw, "jobs")).toContain("attachments_json");
    raw.close();
  });
});
