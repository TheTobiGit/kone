import {
  computed,
  ref,
  shallowRef,
  type ComputedRef,
  type Ref,
  type ShallowRef,
} from "vue";
import type {
  BenchCreateInput,
  ChatAttachment,
  JobPatch,
  JobRow,
  JobStatus,
  JobTarget,
  RuntimeEvent,
} from "~/types/desktop";

// useBench — the bench portal's read model.
//
// The store is the only copy of the queue, so nothing here caches a second
// one: every mutation writes through the bridge and re-reads the list. That
// costs a round trip per action and buys the thing that matters on a queue —
// the order the user sees is the order the runner will take, with no window
// where an optimistic local guess disagrees with it.
//
// One list, across every project. A job is queued against a checkout, but the
// person watching the queue has one attention: a per-project bench would hide
// that three other projects are each running something, and would make "what
// is on my bench" a question you have to ask four times. Which project a job
// belongs to is on the job, so the row can say it.
//
// State lives at module scope rather than per-instance, for the same reason
// the session registry's does: the portal is mounted once for the life of the
// app and outlives any project page, so a per-instance copy would be thrown
// away on a project switch and re-fetched on the way back.

/** The groups the bench renders, in the order they are shown. Running leads —
 *  it is the one thing actually happening — then what is about to run, then
 *  what is parked, then what is finished with. */
export const BENCH_GROUPS = [
  { status: "running", label: "Running" },
  { status: "queued", label: "Queued" },
  { status: "draft", label: "Drafts" },
  { status: "done", label: "Finished" },
  { status: "failed", label: "Failed" },
  { status: "cancelled", label: "Cancelled" },
] as const satisfies ReadonlyArray<{ status: JobStatus; label: string }>;

export type BenchGroup = {
  status: JobStatus;
  label: string;
  jobs: JobRow[];
};

const jobs = shallowRef<JobRow[]>([]);
const loading = ref(false);
const loaded = ref(false);

/** Set by the first useBench so the event listener can drive a read without
 *  owning one. Every caller installs the same function over the same refs, so
 *  which one won the race does not matter. */
let reread: () => Promise<void> = async (): Promise<void> => {};

/** One listener, attached on first use and never torn down — the same reason
 *  the session registry keeps one: the portal outlives any page, and a
 *  subscription attached and dropped on every project switch would miss jobs
 *  that keep running regardless. */
let listenerAttached = false;

function attachListener(): void {
  if (!import.meta.client || listenerAttached) return;
  const api = window.koneDesktop?.agent;
  if (!api) return;
  listenerAttached = true;
  api.onEvent((event: RuntimeEvent) => {
    // Any project's job moving is this list's business, because this list is
    // every project's.
    if (event.type === "bench.job-changed") void reread();
  });
}

function bridge() {
  return import.meta.client ? window.koneDesktop?.bench : undefined;
}

/** A job id the renderer mints, so the row it draws and the row the store
 *  keeps are the same one. */
function newJobId(): string {
  if (import.meta.client && window.crypto?.randomUUID instanceof Function) {
    return `job-${window.crypto.randomUUID()}`;
  }
  return `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The first line of a body, as the title for a job filed without one. Quick
 *  capture should not demand two fields when the first sentence is almost
 *  always the name of the thing. */
export function titleFromBody(body: string, fallback = "Untitled job"): string {
  const first = body.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!first) return fallback;
  const trimmed = first.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

export interface UseBench {
  jobs: Readonly<ShallowRef<JobRow[]>>;
  /** Jobs bucketed for display, every group present whether or not it holds
   *  anything. An empty status is a fact about the bench — nothing queued is
   *  worth seeing — and a list whose sections come and go as jobs move is a
   *  list that never looks the same way twice. */
  groups: ComputedRef<BenchGroup[]>;
  loading: Readonly<Ref<boolean>>;
  /** True once a list has come back at least once, so the portal can tell
   *  "nothing filed yet" from "not read yet" and show the right empty state. */
  loaded: Readonly<Ref<boolean>>;
  /** Count of everything not finished with — what a nav badge would show. */
  pendingCount: ComputedRef<number>;
  refresh: () => Promise<void>;
  file: (input: {
    /** Which checkout this job runs in. Chosen in the composer, so a job can be
     *  filed against a project other than the one on screen. */
    projectPath: string;
    title?: string;
    body: string;
    target: JobTarget;
    queue: boolean;
    /** Bytes-free metadata for files already uploaded, kept on the row so the
     *  opening turn carries them. */
    attachments?: ChatAttachment[];
  }) => Promise<JobRow | null>;
  edit: (jobId: string, patch: JobPatch) => Promise<JobRow | null>;
  setQueued: (jobId: string, queued: boolean) => Promise<JobRow | null>;
  requeue: (jobId: string) => Promise<JobRow | null>;
  reorder: (projectPath: string, jobIds: string[]) => Promise<void>;
  remove: (jobId: string) => Promise<void>;
}

export function useBench(): UseBench {
  attachListener();

  async function refresh(): Promise<void> {
    const api = bridge();
    if (!api) {
      // No bridge means no store — `nuxt dev` in a browser. An empty list that
      // has been read is the truth there, and the portal's empty state is the
      // right thing to show for it.
      loaded.value = true;
      return;
    }
    loading.value = true;
    try {
      // No project named: every project's. The narrower read is still on the
      // bridge for anything that wants one project's queue.
      jobs.value = await api.list({});
      loaded.value = true;
    } finally {
      loading.value = false;
    }
  }
  reread = refresh;

  /** Every mutation ends here. Re-reading rather than patching in place is the
   *  point: a write can be refused (editing a job that just started running),
   *  and a list rebuilt from the store cannot show a change the store did not
   *  make. */
  async function afterWrite<T>(result: T): Promise<T> {
    await refresh();
    return result;
  }

  async function file(input: {
    projectPath: string;
    title?: string;
    body: string;
    target: JobTarget;
    queue: boolean;
    attachments?: ChatAttachment[];
  }): Promise<JobRow | null> {
    const api = bridge();
    if (!api) return null;
    const body = input.body.trim();
    if (!body) return null;
    const payload: BenchCreateInput = {
      jobId: newJobId(),
      projectPath: input.projectPath,
      title: input.title?.trim() || titleFromBody(body),
      body,
      status: input.queue ? "queued" : "draft",
      target: input.target,
    };

    if (input.attachments?.length) payload.attachments = input.attachments;

    return await afterWrite(await api.create(payload));
  }

  async function edit(jobId: string, patch: JobPatch): Promise<JobRow | null> {
    const api = bridge();
    if (!api) return null;
    return await afterWrite(await api.update({ jobId, patch }));
  }

  async function setQueued(
    jobId: string,
    queued: boolean,
  ): Promise<JobRow | null> {
    const api = bridge();
    if (!api) return null;
    return await afterWrite(await api.setQueued({ jobId, queued }));
  }

  async function requeue(jobId: string): Promise<JobRow | null> {
    const api = bridge();
    if (!api) return null;
    return await afterWrite(await api.requeue({ jobId }));
  }

  /** Reordering is per project, because draining is: a queue's order only
   *  means anything among the jobs competing for the same checkout. */
  async function reorder(projectPath: string, jobIds: string[]): Promise<void> {
    const api = bridge();
    if (!api) return;
    await api.reorder({ projectPath, jobIds });
    await refresh();
  }

  async function remove(jobId: string): Promise<void> {
    const api = bridge();
    if (!api) return;
    await api.delete({ jobId });
    await refresh();
  }

  const groups = computed<BenchGroup[]>(() => {
    const byStatus = new Map<JobStatus, JobRow[]>();
    for (const job of jobs.value) {
      const bucket = byStatus.get(job.status);
      if (bucket) bucket.push(job);
      else byStatus.set(job.status, [job]);
    }
    return BENCH_GROUPS.map((group) => ({
      status: group.status,
      label: group.label,
      jobs: byStatus.get(group.status) ?? [],
    }));
  });

  const pendingCount = computed(
    () =>
      jobs.value.filter(
        (job) =>
          job.status === "queued" ||
          job.status === "running" ||
          job.status === "draft",
      ).length,
  );

  return {
    jobs,
    groups,
    loading,
    loaded,
    pendingCount,
    refresh,
    file,
    edit,
    setQueued,
    requeue,
    reorder,
    remove,
  };
}
