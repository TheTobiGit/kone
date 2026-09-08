// One thread as prose and rows: the list's line-per-thread text and the
// structured row behind it, plus the small pure pieces those two are built
// from. Everything here is a pure function of its arguments — no store, no
// emit, no services — so it can live apart from the tool handlers that call
// it.

import { ago, compact } from "../helpers.js";
import type { GatewayRecord } from "../schemas.js";
import type { StoredBlock, StoredThreadMeta, ThreadStatus } from "../../types.js";
import type { ProjectRosterEntry } from "./appProjects.js";

/** One thread as a list entry. */
export interface ThreadReading {
  meta: StoredThreadMeta;
  project: ProjectRosterEntry | null;
  agentName: string | null;
  status: ThreadStatus;
}

export const TRUNCATION_MARKER = "\n...[truncated]";

export function truncateTo(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return `${text.slice(0, budget).trimEnd()}${TRUNCATION_MARKER}`;
}

/** A block's model-readable narrative: the prompt for user blocks, the ordered
 *  assistant text for assistant blocks. Tool calls stay out — the thread's raw
 *  tool traffic belongs to the thread, and a reader asking what was said is not
 *  asking for it. */
export function blockText(block: StoredBlock): string {
  if (block.role === "user") return block.text;
  return block.items
    .filter((item) => item.kind === "assistant_text")
    .map((item) => item.text)
    .join("\n");
}

/** An epoch stamp as a date a model can reason about, or null. */
export function iso(at: number | null | undefined): string | null {
  return at === null || at === undefined ? null : new Date(at).toISOString();
}

/**
 * One thread as a row.
 *
 * `withProject` names which project the thread is on, and is only set on a list
 * that spans several — a list scoped to one project says so once at the top
 * instead of repeating an absolute path on every row. It is the project's NAME
 * rather than its path because every tool here takes a project by name, so the
 * row already reads back as a valid argument.
 *
 * The flags are omitted when false rather than sent as `false`. On a list of
 * twenty that is most of the payload, and "not unread, not done, not
 * archived" is the ordinary case a reader can assume. `status` is the
 * exception: it is always present, because it is the primary answer to "what
 * is this thread doing" — `idle` included, so a reader never has to infer it
 * from the absence of every flag. Whether a thread is live right now is read
 * off `status` (`working` / `starting`), not a second field saying the same
 * thing a different way.
 */
export function threadPayload(reading: ThreadReading, withProject: boolean): GatewayRecord {
  const meta = reading.meta;
  const lastActivityAt = meta.lastActivityAt ?? meta.updatedAt;
  // Unread and done are both comparisons against the last activity rather than
  // flags, which is why they are computed here instead of read: a thread the
  // agent has spoken in since you marked it done is asking again.
  const unread = (meta.lastVisitedAt ?? 0) < lastActivityAt;
  const done = meta.doneAt !== null && (meta.doneAt ?? 0) >= lastActivityAt;
  const row: GatewayRecord = {
    threadId: meta.threadId,
    title: meta.title ?? null,
    model: meta.model ?? meta.provider,
    agent: reading.agentName,
    branch: meta.branch ?? null,
    lastActivityAt: iso(lastActivityAt),
    status: reading.status,
  };
  if (withProject) row.project = reading.project?.name ?? meta.projectPath;
  if (unread) row.unread = true;
  if (done) row.done = true;
  if (meta.archivedAt !== null) row.archived = true;
  return compact(row);
}

/** One thread as a single prose line. One, not two: on a twenty-row answer the
 *  second line was costing more than everything it carried. The status rides
 *  along only when it asks something of the reader — working, waiting, failed,
 *  interrupted, starting — while `idle` stays unsaid: fifteen rows saying so
 *  is fifteen rows of nothing, and the structured row carries it anyway. */
export function threadLine(reading: ThreadReading, withProject: boolean): string {
  const meta = reading.meta;
  const marks = [
    meta.threadId,
    reading.agentName,
    meta.model ?? meta.provider,
    withProject ? (reading.project?.name ?? meta.projectPath) : null,
    ago(meta.lastActivityAt ?? meta.updatedAt),
    reading.status !== "idle" ? reading.status : null,
  ].filter((mark): mark is string => mark !== null);
  return `- ${meta.title ?? "(untitled)"} — ${marks.join(" · ")}`;
}
