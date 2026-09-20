import type {
  ChatAttachment,
  JobPatch,
  JobRow,
  JobRunRow,
  JobTarget,
} from "@kone/agent-core/conversationStoreTypes.js";

/** Which jobs to read. No project means every project's — the bench is one
 *  list across all of them, and a project's own list is the narrower case. */
export type BenchListInput = {
  projectPath?: string;
};

/** Filing a job. The renderer mints the id so the row it just drew and the row
 *  the store keeps are the same one, the way every other create path here
 *  works. `status` is the composer's two buttons: park it, or queue it. */
export type BenchCreateInput = {
  jobId: string;
  projectPath: string;
  title: string;
  body: string;
  status: "draft" | "queued";
  target: JobTarget;
  attachments?: ChatAttachment[];
};

export type BenchUpdateInput = {
  jobId: string;
  patch: JobPatch;
};

export type BenchJobIdInput = {
  jobId: string;
};

/** Moving a job between the two states the user drives by hand. */
export type BenchQueueInput = {
  jobId: string;
  queued: boolean;
};

export type BenchReorderInput = {
  projectPath: string;
  jobIds: string[];
};

/** One job plus its attempts — what the bench's detail panel reads. */
export type BenchJobDetail = {
  job: JobRow;
  runs: JobRunRow[];
};
