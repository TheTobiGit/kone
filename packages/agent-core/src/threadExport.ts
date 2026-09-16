// Thread export — Markdown and JSON transcripts written from the store, not
// the wire projection.
//
// conversationWire.ts caps tool_call.detail at 8000 chars for IPC while the
// database keeps the full body. The export reads full rows through the store's
// page API, so a file never inherits the wire truncation: Markdown carries a
// bounded, clearly-marked excerpt and JSON carries every byte.
//
// Both formats stream: the thread is walked with the existing keyset cursor
// (one bounded page in memory at a time) and each page is rendered and written
// before the next is loaded, so a very long thread has bounded peak memory.
// Pages read newest-first, so the walk first collects the cursor chain and
// then re-reads it oldest-first; the whole pipeline is synchronous, which
// keeps the two passes from seeing different threads.

import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

import { formatPlanTasks } from "@kone/protocol/plan-tasks";
import {
  THREAD_EXPORT_JSON_VERSION,
  parseThreadExportFormat,
  threadExportBlockedCode,
  threadExportBlockedMessage,
  type ThreadExportBlockedCode,
  type ThreadExportBlock,
  type ThreadExportFormat,
  type ThreadExportItem,
  type ThreadExportPlanTask,
  type ThreadExportSubagentRun,
  type ThreadExportTurnUsage,
} from "@kone/protocol/thread-export";
import type {
  RuntimeItem,
  StoredBlock,
  StoredThreadMeta,
  SubagentRun,
} from "./types.js";
import type { StoredThreadPage, TurnUsageRecord } from "./conversationStoreTypes.js";

/** The store surface the export reads. Narrow on purpose: tests drive the
 *  renderers through fakes without standing up a database. */
export type ThreadExportStore = {
  threadExists(threadId: string): boolean;
  threadMeta(threadId: string): StoredThreadMeta | null;
  loadThreadPage(
    threadId: string,
    options?: { limit?: number; maxRaw?: number; cursor?: string },
  ): StoredThreadPage | null;
  listCompactions(threadId: string): { at: number; beforeTokens: number | null; afterTokens: number | null }[];
  listTurnUsage(threadId: string): TurnUsageRecord[];
};

/** User blocks per page on the export walk. Larger than the UI's window —
 *  fewer round trips — but still a bounded slice per chunk. */
export const EXPORT_PAGE_USER_BLOCKS = 50;

/** Chars of a tool-call body the Markdown export shows before marking the
 *  cut. The full body always lands in the JSON export. */
export const TOOL_DETAIL_EXPORT_EXCERPT_CHARS = 2000;

// ── eligibility ───────────────────────────────────────────────────────────────
// Built here, judged in protocol: the snapshot is store facts, the verdict is
// the shared predicate, so the IPC handler and any future caller read the
// same answer.

/** The shared verdict for a thread: null means exportable, otherwise the
 *  machine-readable reason it is not. Both the IPC handler and the caller
 *  gate on this one function. */
export function exportEligibility(
  store: ThreadExportStore,
  threadId: string,
): ThreadExportBlockedCode | null {
  if (!store.threadExists(threadId)) {
    return threadExportBlockedCode({ exists: false, completedTurns: 0, runningTurns: 0 });
  }
  let completedTurns = 0;
  let runningTurns = 0;
  let cursor: string | undefined;
  for (;;) {
    const page =
      cursor === undefined
        ? store.loadThreadPage(threadId, { limit: EXPORT_PAGE_USER_BLOCKS })
        : store.loadThreadPage(threadId, { limit: EXPORT_PAGE_USER_BLOCKS, cursor });
    if (!page) {
      return threadExportBlockedCode({ exists: false, completedTurns: 0, runningTurns: 0 });
    }
    for (const block of page.blocks) {
      if (block.role !== "assistant") continue;
      if (block.state === "completed") completedTurns += 1;
      else if (block.state === "running") runningTurns += 1;
    }
    // Both facts known: no need to walk the rest of history.
    if (completedTurns > 0 && runningTurns > 0) break;
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return threadExportBlockedCode({ exists: true, completedTurns, runningTurns });
}

// ── page walk ─────────────────────────────────────────────────────────────────
// Pass one collects the cursor chain newest-first; pass two re-reads it
// oldest-first so the file runs in timeline order with one page resident.

function collectExportCursors(
  store: ThreadExportStore,
  threadId: string,
  pageUserBlocks: number,
): (string | null)[] | null {
  const cursors: (string | null)[] = [null];
  let cursor: string | undefined;
  for (;;) {
    const page =
      cursor === undefined
        ? store.loadThreadPage(threadId, { limit: pageUserBlocks })
        : store.loadThreadPage(threadId, { limit: pageUserBlocks, cursor });
    if (!page) return null;
    const next = page.nextCursor;
    if (!page.hasMore || !next) return cursors;
    cursor = next;
    cursors.push(next);
  }
}

function readExportPage(
  store: ThreadExportStore,
  threadId: string,
  pageUserBlocks: number,
  cursor: string | null,
): StoredThreadPage | null {
  return cursor === null
    ? store.loadThreadPage(threadId, { limit: pageUserBlocks })
    : store.loadThreadPage(threadId, { limit: pageUserBlocks, cursor });
}

function failExport(message: string): never {
  throw new Error(message);
}

/** One page of blocks per yield, oldest page first. Throws when the thread
 *  cannot be read — the file writer turns that into a failed outcome and
 *  removes the partial file. */
function* exportPagesOldestFirst(
  store: ThreadExportStore,
  threadId: string,
  pageUserBlocks: number,
): Generator<StoredBlock[]> {
  const cursors = collectExportCursors(store, threadId, pageUserBlocks);
  if (!cursors) failExport(`Cannot export thread ${threadId}: it cannot be read.`);
  for (let index = cursors.length - 1; index >= 0; index--) {
    const cursor = cursors[index];
    if (cursor === undefined) {
      failExport(`Cannot export thread ${threadId}: its pages shifted mid-export.`);
    }
    const page = readExportPage(store, threadId, pageUserBlocks, cursor);
    if (!page) failExport(`Cannot export thread ${threadId}: a page failed to load.`);
    yield page.blocks;
  }
}

// ── Markdown ──────────────────────────────────────────────────────────────────

function isoDate(at: number): string {
  return new Date(at).toISOString();
}

/** The fence that cannot appear in the text: one backtick longer than the
 *  longest run inside, so an excerpt containing fences stays intact. */
function fenceFor(text: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** Inline code that cannot break out of its span: provider tool names are
 *  identifiers, but a deviant one must not rewrite the heading. */
function inlineCode(text: string): string {
  return `\`${text.replaceAll("`", "'")}\``;
}

/** The readable cut of a tool body: bounded, with its bounds stated, so the
 *  excerpt is never mistaken for the whole result. */
function excerptDetail(detail: string): string {
  if (detail.length <= TOOL_DETAIL_EXPORT_EXCERPT_CHARS) return detail;
  const shown = detail.slice(0, TOOL_DETAIL_EXPORT_EXCERPT_CHARS);
  return (
    `${shown}\n[… showing ${TOOL_DETAIL_EXPORT_EXCERPT_CHARS} of ${detail.length} ` +
    `chars — the full output is in the JSON export]`
  );
}

function tokensOrUnknown(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function renderCompactionMarker(at: number, beforeTokens: number | null, afterTokens: number | null): string {
  return `> Compaction · ${isoDate(at)} · ${tokensOrUnknown(beforeTokens)} → ${tokensOrUnknown(afterTokens)} tokens`;
}

function renderUsageLine(usage: TurnUsageRecord): string {
  const parts = `${tokensOrUnknown(usage.inputTokens)} in · ${tokensOrUnknown(usage.outputTokens)} out · ${tokensOrUnknown(usage.totalTokens)} total`;
  const extras: string[] = [];
  if (usage.cacheReadTokens > 0) extras.push(`${usage.cacheReadTokens} cached`);
  if (usage.reasoningTokens > 0) extras.push(`${usage.reasoningTokens} reasoning`);
  return extras.length > 0 ? `*Usage: ${parts} (${extras.join(", ")})*` : `*Usage: ${parts}*`;
}

function renderSubagentRun(run: SubagentRun, level: number): string {
  const heading = "#".repeat(Math.min(6, level));
  const label = run.description ?? run.agentType ?? run.toolUseId;
  const lines = [`${heading} Subagent ${inlineCode(label)} · ${run.status}`];
  if (run.prompt) lines.push("", `Prompt: ${run.prompt}`);
  if (run.summary) lines.push("", `Summary: ${run.summary}`);
  const nested = renderExportItems(run.items, level + 1);
  if (nested) lines.push("", nested);
  return lines.join("\n");
}

function renderExportItems(items: RuntimeItem[], level: number): string {
  const heading = "#".repeat(Math.min(6, level));
  const sections: string[] = [];
  const narrative: string[] = [];
  const reasoning: string[] = [];
  const flushNarrative = (): void => {
    if (narrative.length === 0) return;
    sections.push(`${heading} Narrative\n\n${narrative.join("\n\n")}`);
    narrative.length = 0;
  };
  const flushReasoning = (): void => {
    if (reasoning.length === 0) return;
    sections.push(`${heading} Reasoning\n\n${reasoning.join("\n\n")}`);
    reasoning.length = 0;
  };
  // Text and reasoning arrive interleaved; flushing the other kind first
  // keeps the two passages in arrival order instead of grouping by kind.
  for (const item of items) {
    if (item.kind === "assistant_text") {
      flushReasoning();
      if (item.text) narrative.push(item.text);
      continue;
    }
    if (item.kind === "reasoning_text") {
      flushNarrative();
      if (item.text) reasoning.push(item.text);
      continue;
    }
    flushNarrative();
    flushReasoning();
    if (item.kind === "plan_text") {
      if (item.text) {
        sections.push(`${heading} Plan\n\n${item.text}`);
      } else if (item.tasks && item.tasks.length > 0) {
        sections.push(`${heading} Plan\n\n${formatPlanTasks(item.tasks)}`);
      }
      continue;
    }
    const head = `${heading} Tool ${inlineCode(item.name ?? "unnamed")} · ${item.status}`;
    const parts = [head];
    if (item.text) parts.push("", item.text);
    if (item.detail) {
      const fence = fenceFor(item.detail);
      parts.push("", `${fence}\n${excerptDetail(item.detail)}\n${fence}`);
    }
    if (item.subagent) parts.push("", renderSubagentRun(item.subagent, level + 1));
    sections.push(parts.join("\n"));
  }
  flushNarrative();
  flushReasoning();
  return sections.join("\n\n");
}

function renderUserBlock(block: Extract<StoredBlock, { role: "user" }>): string {
  const lines = [`## User · ${isoDate(block.at)}`, "", block.text];
  if (block.attachments && block.attachments.length > 0) {
    lines.push(
      "",
      "Attachments:",
      ...block.attachments.map((a) => `- ${a.name} (${a.mimeType}, ${a.sizeBytes} bytes)`),
    );
  }
  return lines.join("\n");
}

function renderAssistantBlock(
  block: Extract<StoredBlock, { role: "assistant" }>,
  usageByTurn: Map<string, TurnUsageRecord>,
): string {
  const lines = [`## Assistant · ${isoDate(block.at)} · ${block.state}`, ""];
  if (block.error) lines.push(`Error: ${block.error}`, "");
  const body = renderExportItems(block.items, 3);
  if (body) lines.push(body, "");
  const usage = usageByTurn.get(block.turnId);
  if (usage) lines.push(renderUsageLine(usage));
  return lines.join("\n").trimEnd();
}

function renderExportBlock(block: StoredBlock, usageByTurn: Map<string, TurnUsageRecord>): string {
  return block.role === "user" ? renderUserBlock(block) : renderAssistantBlock(block, usageByTurn);
}

function renderExportHeader(meta: StoredThreadMeta): string {
  return [
    `# ${meta.title ?? "Untitled thread"}`,
    "",
    "Exported from kone.",
    "",
    `- Thread: ${meta.threadId}`,
    `- Provider: ${meta.provider}`,
    `- Model: ${meta.model ?? "unknown"}`,
    `- Created: ${isoDate(meta.createdAt)}`,
    "",
  ].join("\n");
}

/** Chunks of the Markdown transcript, oldest first. One chunk per page after
 *  the header, so the writer never holds more than a page. */
export function* exportThreadMarkdownChunks(
  store: ThreadExportStore,
  threadId: string,
  pageUserBlocks: number = EXPORT_PAGE_USER_BLOCKS,
): Generator<string> {
  const meta = store.threadMeta(threadId);
  if (!meta) failExport(`Cannot export thread ${threadId}: it cannot be read.`);
  const compactions = store.listCompactions(threadId);
  const usageByTurn = new Map(store.listTurnUsage(threadId).map((u) => [u.turnId, u]));
  yield renderExportHeader(meta);
  let compactionIndex = 0;
  for (const page of exportPagesOldestFirst(store, threadId, pageUserBlocks)) {
    const parts: string[] = [];
    for (const block of page) {
      // Markers sort with the transcript by timestamp: a marker lands before
      // the first block newer than it, so the compaction reads where it
      // happened rather than in an appendix.
      while (compactionIndex < compactions.length) {
        const marker = compactions[compactionIndex];
        if (marker === undefined || marker.at > block.at) break;
        parts.push(renderCompactionMarker(marker.at, marker.beforeTokens, marker.afterTokens));
        compactionIndex += 1;
      }
      parts.push(renderExportBlock(block, usageByTurn));
    }
    if (parts.length > 0) yield `\n---\n\n${parts.join("\n\n---\n\n")}\n`;
  }
  while (compactionIndex < compactions.length) {
    const marker = compactions[compactionIndex];
    if (marker === undefined) break;
    yield `\n---\n\n${renderCompactionMarker(marker.at, marker.beforeTokens, marker.afterTokens)}\n`;
    compactionIndex += 1;
  }
}

// ── JSON ──────────────────────────────────────────────────────────────────────

function toExportItem(item: RuntimeItem): ThreadExportItem {
  const out: ThreadExportItem = {
    itemId: item.itemId,
    kind: item.kind,
    status: item.status,
    text: item.text,
  };
  if (item.name !== undefined) out.name = item.name;
  // The full body: this document is the lossless export, so the wire cap
  // never applies here.
  if (item.detail !== undefined) out.detail = item.detail;
  if (item.tasks !== undefined) {
    out.tasks = item.tasks.map((t): ThreadExportPlanTask => {
      const task: ThreadExportPlanTask = { id: t.id, content: t.content, status: t.status };
      if (t.activeForm !== undefined) task.activeForm = t.activeForm;
      return task;
    });
  }
  if (item.subagent !== undefined) out.subagent = toExportSubagentRun(item.subagent);
  return out;
}

function toExportSubagentRun(run: SubagentRun): ThreadExportSubagentRun {
  const out: ThreadExportSubagentRun = {
    toolUseId: run.toolUseId,
    status: run.status,
    startedAt: run.startedAt,
    items: run.items.map(toExportItem),
  };
  if (run.taskId !== undefined) out.taskId = run.taskId;
  if (run.parentItemId !== undefined) out.parentItemId = run.parentItemId;
  if (run.agentType !== undefined) out.agentType = run.agentType;
  if (run.description !== undefined) out.description = run.description;
  if (run.prompt !== undefined) out.prompt = run.prompt;
  if (run.model !== undefined) out.model = run.model;
  if (run.effort !== undefined) out.effort = run.effort;
  if (run.background !== undefined) out.background = run.background;
  if (run.summary !== undefined) out.summary = run.summary;
  if (run.lastToolName !== undefined) out.lastToolName = run.lastToolName;
  if (run.tokens !== undefined) out.tokens = run.tokens;
  if (run.toolUses !== undefined) out.toolUses = run.toolUses;
  if (run.endedAt !== undefined) out.endedAt = run.endedAt;
  return out;
}

function toExportBlock(block: StoredBlock): ThreadExportBlock {
  if (block.role === "user") {
    const userBlock: Extract<ThreadExportBlock, { role: "user" }> = {
      id: block.id,
      role: "user",
      text: block.text,
      at: block.at,
    };
    if (block.attachments !== undefined) {
      userBlock.attachments = block.attachments.map((a) => ({
        id: a.id,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        type: a.type,
      }));
    }
    if (block.source === "fork-import") userBlock.source = "fork-import";
    return userBlock;
  }
  const assistantBlock: Extract<ThreadExportBlock, { role: "assistant" }> = {
    id: block.id,
    role: "assistant",
    turnId: block.turnId,
    state: block.state,
    at: block.at,
    items: block.items.map(toExportItem),
  };
  if (block.error !== undefined) assistantBlock.error = block.error;
  if (block.endedAt !== undefined) assistantBlock.endedAt = block.endedAt;
  if (block.source === "fork-import") assistantBlock.source = "fork-import";
  return assistantBlock;
}

function toExportUsage(usage: TurnUsageRecord): ThreadExportTurnUsage {
  return {
    turnId: usage.turnId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    reasoningTokens: usage.reasoningTokens,
    at: usage.at,
  };
}

/** Chunks of the JSON transcript, oldest first. The envelope opens in the
 *  first chunk, each page appends its blocks, and the last chunk closes the
 *  document — the full JSON string never exists as one value. */
export function* exportThreadJsonChunks(
  store: ThreadExportStore,
  threadId: string,
  pageUserBlocks: number = EXPORT_PAGE_USER_BLOCKS,
): Generator<string> {
  const meta = store.threadMeta(threadId);
  if (!meta) failExport(`Cannot export thread ${threadId}: it cannot be read.`);
  const compactions = store.listCompactions(threadId);
  const usage = store.listTurnUsage(threadId);
  const head = {
    version: THREAD_EXPORT_JSON_VERSION,
    exportedBy: "kone",
    thread: {
      threadId: meta.threadId,
      projectPath: meta.projectPath,
      provider: meta.provider,
      model: meta.model ?? null,
      createdAt: meta.createdAt,
      title: meta.title ?? null,
    },
    compactions: compactions.map((c) => ({
      at: c.at,
      beforeTokens: c.beforeTokens,
      afterTokens: c.afterTokens,
    })),
    usage: usage.map(toExportUsage),
  };
  // SAFETY: head is built from plain data above, so its serialization cannot fail.
  const envelope = JSON.stringify(head) as string;
  yield `${envelope.slice(0, -1)},"blocks":[`;
  let blocksEmitted = 0;
  for (const page of exportPagesOldestFirst(store, threadId, pageUserBlocks)) {
    for (const block of page) {
      const prefix = blocksEmitted > 0 ? "," : "";
      blocksEmitted += 1;
      yield `${prefix}${JSON.stringify(toExportBlock(block))}`;
    }
  }
  yield "]}";
}

/** Chunks of the thread export in the requested format, oldest first. */
export function* exportThreadChunks(
  store: ThreadExportStore,
  threadId: string,
  format: ThreadExportFormat,
  pageUserBlocks: number = EXPORT_PAGE_USER_BLOCKS,
): Generator<string> {
  if (format === "json") {
    yield* exportThreadJsonChunks(store, threadId, pageUserBlocks);
    return;
  }
  yield* exportThreadMarkdownChunks(store, threadId, pageUserBlocks);
}

// ── file outcome ──────────────────────────────────────────────────────────────

export type ThreadExportOutcome =
  | { ok: true; path: string; bytes: number; format: ThreadExportFormat }
  | { ok: false; reason: string; message: string };

function failedExport(reason: string, message: string): ThreadExportOutcome {
  return { ok: false, reason, message };
}

/** Write the thread export to a caller-supplied absolute path, streaming one
 *  page at a time. Synchronous end to end: reads and writes interleave with
 *  nothing, so the file is one stable read of the store. */
export function exportThread(
  store: ThreadExportStore,
  threadId: string,
  format: string,
  filePath: string,
): ThreadExportOutcome {
  if (threadId.length === 0) {
    return failedExport("invalid-thread-id", "Thread id is empty.");
  }
  const parsedFormat = parseThreadExportFormat(format);
  if (!parsedFormat) {
    return failedExport("invalid-format", `Unknown export format: "${format}".`);
  }
  if (filePath.length === 0 || !path.isAbsolute(filePath)) {
    return failedExport("invalid-path", "Export path must be an absolute path.");
  }
  const blocked = exportEligibility(store, threadId);
  if (blocked) {
    return failedExport(blocked, threadExportBlockedMessage(blocked));
  }
  let fd = -1;
  let bytes = 0;
  try {
    fd = openSync(filePath, "w");
    for (const chunk of exportThreadChunks(store, threadId, parsedFormat)) {
      const body = Buffer.from(chunk, "utf8");
      writeSync(fd, body);
      bytes += body.length;
    }
  } catch (err) {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // The close failed after the write already did; the unlink below is
        // what keeps the failed export from leaving a half-file behind.
      }
      fd = -1;
    }
    try {
      unlinkSync(filePath);
    } catch {
      // Best effort: a half-written file the OS would not let go of is still
      // reported as a failure, which is the part the caller acts on.
    }
    const message = err instanceof Error ? err.message : String(err);
    return failedExport("write-failed", `Could not write the export: ${message}`);
  }
  if (fd >= 0) closeSync(fd);
  return { ok: true, path: filePath, bytes, format: parsedFormat };
}
