import { ipcMain } from "electron";

import { getConversationStore } from "@kone/agent-core/ConversationStore.js";
import type { JobCreateInput, JobRow } from "@kone/agent-core/conversationStoreTypes.js";

import { getJobRunner } from "../../agent/agent-ipc.js";

import type {
  BenchCreateInput,
  BenchJobDetail,
  BenchJobIdInput,
  BenchListInput,
  BenchQueueInput,
  BenchReorderInput,
  BenchUpdateInput,
} from "./types.js";

let registered = false;

/** Register the bench:* IPC handlers. Call once, before creating the window. */
export function registerBenchIpc(): void {
  if (registered) return;
  registered = true;

  const store = getConversationStore();

  /** Nudge the project's queue after a write that may have given it something
   *  to take. Without this a job filed while the app is running would sit
   *  until the next settle or restart — the runner is event-driven and a new
   *  arrival is one of the events. Best-effort and not awaited: the write has
   *  already landed, and a drain that fails leaves the job queued for the next
   *  one rather than failing the call the user made.
   *
   *  Safe to call when nothing is takeable: a project already running claims
   *  nothing, and a draft is not claimed at all. */
  function nudge(job: JobRow | null): JobRow | null {
    if (job?.status === "queued") void getJobRunner()?.drainProject(job.projectPath);
    return job;
  }

  ipcMain.handle("bench:list", (_event, input: BenchListInput): JobRow[] =>
    input.projectPath === undefined ? store.listAllJobs() : store.listJobs(input.projectPath),
  );

  ipcMain.handle("bench:detail", (_event, input: BenchJobIdInput): BenchJobDetail | null => {
    const job = store.getJob(input.jobId);
    if (!job) return null;
    return { job, runs: store.listJobRuns(input.jobId) };
  });

  ipcMain.handle("bench:create", (_event, input: BenchCreateInput): JobRow | null => {
    const create: JobCreateInput = {
      jobId: input.jobId,
      projectPath: input.projectPath,
      title: input.title,
      body: input.body,
      status: input.status,
      target: input.target,
    };

    if (input.attachments?.length) create.attachments = input.attachments;

    return nudge(store.createJob(create));
  });

  ipcMain.handle("bench:update", (_event, input: BenchUpdateInput): JobRow | null =>
    store.updateJob(input.jobId, input.patch),
  );

  ipcMain.handle("bench:set-queued", (_event, input: BenchQueueInput): JobRow | null =>
    nudge(store.setJobQueued(input.jobId, input.queued)),
  );

  ipcMain.handle("bench:requeue", (_event, input: BenchJobIdInput): JobRow | null =>
    nudge(store.requeueJob(input.jobId)),
  );

  ipcMain.handle("bench:reorder", (_event, input: BenchReorderInput): boolean =>
    store.reorderJobs(input.projectPath, input.jobIds),
  );

  ipcMain.handle("bench:delete", (_event, input: BenchJobIdInput): boolean =>
    store.deleteJob(input.jobId),
  );
}
