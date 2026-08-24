import type { CanUseTool, HookInput, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ApprovalRequest,
  ApprovalRequestKind,
  UserInputQuestion,
  UserInputQuestionOption,
} from "../types.js";
import { formatPlanTasks, parseTodoWriteInput, reconcilePlanTasks } from "../planTasks.js";
import type { ClaudeItemBuffer } from "./claudeAdapterTypes.js";

/** A decoded JSON value from the Claude CLI's stream-json wire: scalars,
 *  null, arrays, or nested objects of the same. */
export type ClaudeJsonValue = string | number | boolean | null | ClaudeJsonObject | ClaudeJsonValue[];

/** One level of a decoded Claude CLI JSON payload (tool inputs, tool_result
 *  bodies, hook data): a string-keyed object whose values are plain JSON. */
export interface ClaudeJsonObject {
  [key: string]: ClaudeJsonValue;
}

/** One level of a decoded Claude CLI JSON payload (tool inputs, tool_result
 *  bodies, hook data): a string-keyed object whose values are plain JSON. */
export type ClaudeWirePayload =
  | ClaudeJsonValue
  | SDKMessage
  | Extract<SDKMessage, { type: "assistant" }>["message"]
  | Extract<SDKMessage, { type: "user" }>["message"]
  | Extract<SDKMessage, { type: "stream_event" }>["event"]
  | HookInput
  | Parameters<CanUseTool>[1]
  | null
  | undefined;

/** Narrow an opaque payload to the CLI's JSON object contract, or undefined
 *  when it is not an object. */
export function asRecord(value: ClaudeWirePayload): ClaudeJsonObject | undefined {
  // SAFETY: value instanceof Object && !Array.isArray(value) verifies it is a record object.
  return value && value instanceof Object && !Array.isArray(value) ? (value as ClaudeJsonObject) : undefined;
}

/** A terminal iterator result; the done slot must still carry the value type. */
function doneResult(): IteratorResult<SDKUserMessage> {
  // SAFETY: `done: true` means no value is ever read from this result.
  return { value: undefined as never, done: true };
}

export function readString(value: ClaudeWirePayload, ...path: string[]): string | undefined {
  if (path.length === 0) {
    if (
      value === undefined ||
      value === null ||
      value instanceof Object ||
      Number.isFinite(value) ||
      value === true ||
      value === false
    ) {
      return undefined;
    }
    return String(value);
  }
  let cursor: ClaudeJsonValue | null | undefined = asRecord(value);
  for (const key of path) {
    cursor = asRecord(cursor)?.[key];
  }
  if (
    cursor === undefined ||
    cursor === null ||
    cursor instanceof Object ||
    Number.isFinite(cursor) ||
    cursor === true ||
    cursor === false
  ) {
    return undefined;
  }
  return String(cursor);
}

export function readNumber(value: ClaudeWirePayload, ...path: string[]): number | undefined {
  if (path.length === 0) {
    if (value === undefined || value === null || value instanceof Object || !Number.isFinite(value)) {
      return undefined;
    }
    return Number(value);
  }
  let cursor: ClaudeJsonValue | null | undefined = asRecord(value);
  for (const key of path) {
    cursor = asRecord(cursor)?.[key];
  }
  if (cursor === undefined || cursor === null || cursor instanceof Object || !Number.isFinite(cursor)) {
    return undefined;
  }
  return Number(cursor);
}

/** Normalize a Claude tool call into the neutral ask the renderer shows. */
export function claudeApprovalRequest(
  toolName: string,
  input: Parameters<CanUseTool>[1],
): ApprovalRequest {
  // SAFETY: CanUseTool second parameter is JSON-compatible tool input.
  const record = asRecord(input as ClaudeJsonObject | undefined);
  const subject =
    readString(record, "command")?.trim() ??
    readString(record, "file_path")?.trim() ??
    readString(record, "path")?.trim() ??
    readString(record, "glob")?.trim();
  const kind: ApprovalRequestKind =
    /^(bash|shell|terminal)$/i.test(toolName)
      ? "command"
      : /^(read|glob|grep|ls)$/i.test(toolName)
        ? "file-read"
        : /^(write|edit|multi_edit|notebook_edit)$/i.test(toolName)
          ? "file-change"
          : "tool";
  const request: ApprovalRequest = {
    kind,
    title: subject ?? toolName,
  };
  if (subject) request.detail = toolName;
  return request;
}

export function parseAskUserQuestions(input: ClaudeWirePayload): UserInputQuestion[] {
  const rawQuestions = asRecord(input)?.questions;
  if (!Array.isArray(rawQuestions)) return [];

  const out: UserInputQuestion[] = [];
  for (const raw of rawQuestions) {
    const record = asRecord(raw);
    const question = readString(record, "question")?.trim();
    if (!question) continue;
    const header = readString(record, "header")?.trim() || "Question";

    const options: UserInputQuestionOption[] = [];
    const rawOptions = Array.isArray(record?.options) ? record!.options : [];
    for (const rawOption of rawOptions) {
      if (
        rawOption &&
        !(rawOption instanceof Object) &&
        !Number.isFinite(rawOption) &&
        rawOption !== true
      ) {
        const label = String(rawOption).trim();
        if (label) options.push({ label });
        continue;
      }
      const optionRecord = asRecord(rawOption);
      const label = readString(optionRecord, "label")?.trim();
      if (!label) continue;
      const description = readString(optionRecord, "description")?.trim();
      options.push(description ? { label, description } : { label });
    }

    out.push({
      id: question,
      header,
      question,
      options,
      multiSelect: record?.multiSelect === true,
    });
  }
  return out;
}

/** A short inline summary for a tool call, dug out of its (parsed) input. */
export function summarizeToolInput(
  toolName: string | undefined,
  rawInput: string,
): Pick<ClaudeItemBuffer, "text" | "detail"> {
  let parsed: ClaudeJsonObject | undefined;
  try {
    parsed = asRecord(JSON.parse(rawInput));
  } catch {
    parsed = undefined;
  }
  if (!parsed) return { text: "", detail: rawInput.trim() };

  // SAFETY: the find predicate keeps only non-empty strings, so the result is string or undefined.
  const target = [
    parsed.command,
    parsed.file_path,
    parsed.path,
    parsed.pattern,
    parsed.query,
    parsed.url,
    parsed.description,
    parsed.prompt,
  ].find((v) => v && !(v instanceof Object) && String(v).trim().length > 0) as string | undefined;

  const detail = JSON.stringify(parsed, null, 2);
  return { text: target?.trim() ?? toolName ?? "", detail };
}

export function isEmptyToolInput(input: ClaudeJsonValue | null | undefined): boolean {
  if (input === undefined || input === null) return true;
  if (!(input instanceof Object)) return String(input).trim().length === 0;
  if (!Array.isArray(input)) {
    return Object.keys(input).length === 0;
  }
  return false;
}

export const FILE_EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);

export function isClaudeFileEditTool(toolName: string | undefined): boolean {
  return !toolName ? false : FILE_EDIT_TOOLS.has(toolName.trim().toLowerCase());
}

/** Rebuild a unified-diff body from a file tool's structured `tool_use_result`. */
export function fileEditDiffBody(structuredResult: ClaudeWirePayload): string | undefined {
  const record = asRecord(structuredResult);
  if (!record) return undefined;

  const patch = record.structuredPatch;
  if (Array.isArray(patch) && patch.length > 0) {
    const lines: string[] = [];
    for (const hunk of patch) {
      const hunkLines = asRecord(hunk)?.lines;
      if (!Array.isArray(hunkLines)) continue;
      for (const line of hunkLines) {
        if (line && !(line instanceof Object)) lines.push(String(line));
      }
    }
    if (lines.length > 0) return lines.join("\n");
  }

  if (
    record.originalFile == null &&
    record.content &&
    !(record.content instanceof Object) &&
    String(record.content).length > 0
  ) {
    return String(record.content)
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n");
  }
  return undefined;
}

/** Apply a TodoWrite snapshot to a plan_text buffer when JSON parsing succeeds. */
export function applyPlanSnapshot(buffer: ClaudeItemBuffer, rawJson: string): boolean {
  const snapshot = parseTodoWriteInput(rawJson);
  if (!snapshot) return false;
  buffer.tasks = reconcilePlanTasks(buffer.tasks ?? [], snapshot);
  buffer.text = formatPlanTasks(buffer.tasks);
  return true;
}

/** Pull display text out of a tool_result's `content`. */
export function extractToolResultText(content: ClaudeJsonValue | null | undefined): string {
  if (!content) return "";
  if (!(content instanceof Object)) return String(content);
  if (Array.isArray(content)) {
    return content
      .map((block) => readString(block, "text") ?? "")
      .filter((v) => v.length > 0)
      .join("\n");
  }
  return "";
}

// ── prompt queue ──────────────────────────────────────────────────────────────

export class MessageQueue {
  private readonly items: SDKUserMessage[] = [];
  private readonly waiters: ((result: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  close(): void {
    this.closed = true;
    this.items.length = 0;
    let waiter: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
    while ((waiter = this.waiters.shift())) waiter(doneResult());
  }

  iterable(): AsyncIterable<SDKUserMessage> {
    const iterator: AsyncIterator<SDKUserMessage> = {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve(doneResult());
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }
}

/** A prompt iterable that yields nothing and only completes when `signal` aborts. */
export function idlePrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          return new Promise((resolve) => {
            if (signal.aborted) return resolve(doneResult());
            signal.addEventListener("abort", () => resolve(doneResult()), { once: true });
          });
        },
      };
    },
  };
}

/** A Claude turn `result` is an interruption when the CLI reports an abort. */
export function isInterruptedResult(
  message: Extract<SDKMessage, { type: "result" }>,
  errors: string[],
): boolean {
  if (message.subtype === "error_during_execution" && message.is_error === false) return true;
  const haystack = errors.join(" ").toLowerCase();
  return ["interrupt", "aborted", "request was aborted"].some((needle) => haystack.includes(needle));
}
