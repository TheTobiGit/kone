// Thread export contracts shared between the desktop main process (which reads
// the store and writes the files) and the web renderer (which gates the export
// affordance and interprets the outcome). Both sides import this module, so the
// caller and the handler can never disagree about what is exportable or what
// an exported file holds. Stays environment-agnostic: no electron, no DOM, no
// node builtins beyond standard globals.

import { z } from "zod";

// ── format ────────────────────────────────────────────────────────────────────

export type ThreadExportFormat = "markdown" | "json";

const ThreadExportFormatSchema = z.enum(["markdown", "json"]);

/** Decode a caller-supplied format at the I/O boundary. Null means the caller
 *  did not name a real format. */
export function parseThreadExportFormat(value: string): ThreadExportFormat | null {
  const parsed = ThreadExportFormatSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ── export eligibility ────────────────────────────────────────────────────────
// The single predicate both sides share. An export must never capture
// in-flight output: a partial assistant reply would be frozen into the file as
// if it were the settled turn. And a thread with no completed turn has no
// transcript worth a file — just prompts, or nothing at all.

/** The cheapest store facts the predicate needs. agent-core builds this with
 *  one bounded page walk; the renderer never builds it — it reads the outcome
 *  code off the IPC result, which was computed by this same predicate. */
export type ThreadExportSnapshot = {
  readonly exists: boolean;
  readonly completedTurns: number;
  readonly runningTurns: number;
};

export type ThreadExportBlockedCode = "thread-not-found" | "thread-running" | "no-completed-turns";

/** Null means exportable; otherwise the machine-readable reason it is not.
 *  Callers needing words map the code through threadExportBlockedMessage. */
export function threadExportBlockedCode(
  snapshot: ThreadExportSnapshot,
): ThreadExportBlockedCode | null {
  if (!snapshot.exists) return "thread-not-found";
  if (snapshot.runningTurns > 0) return "thread-running";
  if (snapshot.completedTurns <= 0) return "no-completed-turns";
  return null;
}

export function isThreadExportable(snapshot: ThreadExportSnapshot): boolean {
  return threadExportBlockedCode(snapshot) === null;
}

export function threadExportBlockedMessage(code: ThreadExportBlockedCode): string {
  switch (code) {
    case "thread-not-found":
      return "Thread not found: it may have been deleted.";
    case "thread-running":
      return "Thread is still running: wait for the current turn to finish before exporting.";
    case "no-completed-turns":
      return "Nothing to export yet: this thread has no completed turns.";
  }
}

// ── save dialog ───────────────────────────────────────────────────────────────
// The native save dialog runs in the desktop main process; the renderer only
// suggests a file name. A dismissal resolves `{ canceled: true }` —
// deliberately a different shape from the file outcome below, so a caller can
// tell "picked nothing" apart from "wrote nothing".

export type ThreadExportDialogResult =
  | { canceled: true }
  | { canceled: false; filePath: string };

// ── JSON transcript shape ─────────────────────────────────────────────────────
// The lossless export: every block in arrival order with its full items,
// including tool-call bodies at full length. The Markdown export carries a
// bounded excerpt of those bodies instead; this document is where nothing is
// cut. Written by agent-core one page at a time, decoded here with zod so a
// corrupt or foreign file reads as null rather than a half-trusted object.

export const THREAD_EXPORT_JSON_VERSION = 1;

const ExportAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  type: z.enum(["image", "file"]),
});

export type ThreadExportPlanTask = {
  id: string;
  content: string;
  activeForm?: string;
  status: "pending" | "in-progress" | "completed";
};

const ExportPlanTaskSchema: z.ZodType<ThreadExportPlanTask> = z.object({
  id: z.string(),
  content: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(["pending", "in-progress", "completed"]),
});

export type ThreadExportItem = {
  itemId: string;
  kind: "assistant_text" | "reasoning_text" | "plan_text" | "tool_call";
  status: "in-progress" | "completed" | "failed";
  text: string;
  name?: string;
  detail?: string;
  tasks?: ThreadExportPlanTask[];
  subagent?: ThreadExportSubagentRun;
};

export type ThreadExportSubagentRun = {
  toolUseId: string;
  taskId?: string;
  parentItemId?: string;
  agentType?: string;
  description?: string;
  prompt?: string;
  model?: string;
  effort?: string;
  background?: boolean;
  status: "starting" | "running" | "completed" | "failed" | "stopped";
  summary?: string;
  lastToolName?: string;
  tokens?: number;
  toolUses?: number;
  startedAt: number;
  endedAt?: number;
  items: ThreadExportItem[];
};

// The item schema names the subagent schema lazily: the two are mutually
// recursive, and the callback only resolves once the module has finished
// loading, so declaration order below is irrelevant at parse time.
const ExportItemSchema: z.ZodType<ThreadExportItem> = z.object({
  itemId: z.string(),
  kind: z.enum(["assistant_text", "reasoning_text", "plan_text", "tool_call"]),
  status: z.enum(["in-progress", "completed", "failed"]),
  text: z.string(),
  name: z.string().optional(),
  detail: z.string().optional(),
  tasks: z.array(ExportPlanTaskSchema).optional(),
  subagent: z.lazy((): z.ZodType<ThreadExportSubagentRun> => ExportSubagentRunSchema).optional(),
});

const ExportSubagentRunSchema: z.ZodType<ThreadExportSubagentRun> = z.object({
  toolUseId: z.string(),
  taskId: z.string().optional(),
  parentItemId: z.string().optional(),
  agentType: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  background: z.boolean().optional(),
  status: z.enum(["starting", "running", "completed", "failed", "stopped"]),
  summary: z.string().optional(),
  lastToolName: z.string().optional(),
  tokens: z.number().optional(),
  toolUses: z.number().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  items: z.array(ExportItemSchema),
});

const ExportUserBlockSchema = z.object({
  id: z.string(),
  role: z.literal("user"),
  text: z.string(),
  at: z.number(),
  attachments: z.array(ExportAttachmentSchema).optional(),
  source: z.literal("fork-import").optional(),
});

const ExportAssistantBlockSchema = z.object({
  id: z.string(),
  role: z.literal("assistant"),
  turnId: z.string(),
  state: z.enum(["running", "completed", "failed", "interrupted"]),
  error: z.string().optional(),
  at: z.number(),
  endedAt: z.number().optional(),
  source: z.literal("fork-import").optional(),
  items: z.array(ExportItemSchema),
});

const ExportBlockSchema: z.ZodType<ThreadExportBlock> = z.union([
  ExportUserBlockSchema,
  ExportAssistantBlockSchema,
]);

export type ThreadExportBlock = {
  id: string;
  role: "user";
  text: string;
  at: number;
  attachments?: Array<{
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    type: "image" | "file";
  }>;
  source?: "fork-import";
} | {
  id: string;
  role: "assistant";
  turnId: string;
  state: "running" | "completed" | "failed" | "interrupted";
  error?: string;
  at: number;
  endedAt?: number;
  source?: "fork-import";
  items: ThreadExportItem[];
};

const ExportCompactionSchema = z.object({
  at: z.number(),
  beforeTokens: z.number().nullable(),
  afterTokens: z.number().nullable(),
});

const ExportTurnUsageSchema = z.object({
  turnId: z.string(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  reasoningTokens: z.number(),
  at: z.number(),
});

export type ThreadExportTurnUsage = z.infer<typeof ExportTurnUsageSchema>;

const ThreadExportJsonSchema = z.object({
  version: z.literal(THREAD_EXPORT_JSON_VERSION),
  exportedBy: z.literal("kone"),
  thread: z.object({
    threadId: z.string(),
    projectPath: z.string(),
    provider: z.string(),
    model: z.string().nullable(),
    createdAt: z.number(),
    title: z.string().nullable(),
  }),
  compactions: z.array(ExportCompactionSchema),
  usage: z.array(ExportTurnUsageSchema),
  blocks: z.array(ExportBlockSchema),
});

export type ThreadExportJson = z.infer<typeof ThreadExportJsonSchema>;

/** Decode an exported JSON transcript. Null for anything that is not one:
 *  unparseable text, a version this reader does not know, or a document that
 *  fails the transcript schema. */
export function decodeThreadExportJson(text: string): ThreadExportJson | null {
  let parsed: unknown;
  try {
    // SAFETY: JSON.parse yields whatever the text held; the zod schema below
    // is the only gate before the value is trusted.
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const result = ThreadExportJsonSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
