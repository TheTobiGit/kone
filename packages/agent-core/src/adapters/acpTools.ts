// Tool calls over ACP — the one reading of a `tool_call` / `tool_call_update`
// that Cursor, Droid, Cline and Antigravity's ACP server all share. ACP sends
// each call as a run of partial snapshots: a kind, a title, raw input,
// locations, a content collection (text, diff and resource blocks) and raw
// output, any of which a later update may restate or omit. Each update is read
// into a ToolObservation and folded into the call's ToolCallAccumulator, which
// decides what a later, weaker update may not overwrite.

import type { PlanTask } from "@kone/protocol/plan-tasks";
import { ToolActionSchema, type ToolFileChange } from "@kone/protocol/tool-call";
import type { JsonValue } from "../lib-jsonValue.js";
import type { ToolCallAccumulator, ToolObservation } from "../toolCallAccumulator.js";
import type { RuntimeItemStatus } from "../types.js";
import { beforeAfterDiff, inferAction, inputTarget, object, string } from "./toolCalls.js";

/** ACP tool kinds → the tool name a call carries when ACP names no tool of its
 *  own. The action (see acpObservation) is what the row phrases; the name only
 *  labels a call whose action stays `other`. */
export const ACP_TOOL_KIND_NAMES: Record<string, string> = {
  read: "read_file",
  edit: "edit_file",
  delete: "delete_file",
  move: "move_file",
  execute: "run",
  search: "search",
  fetch: "web_fetch",
  think: "think",
  switch_mode: "switch_mode",
  other: "tool",
};

/** The expandable body of a tool row: the text blocks of its content plus its
 *  raw output — a structured output's `content`/`output`/`stdout`/
 *  `combinedOutput`/`text` when it has one, else the whole record as JSON. Kept
 *  whole: the store holds full bodies and the IPC projection bounds the
 *  renderer's copy (conversationWire.ts). */
export function acpToolDetail(update: JsonValue): string {
  const raw = object(update);
  const parts: string[] = [];
  const push = (text: string | undefined) => {
    if (text?.trim()) parts.push(text);
  };
  for (const block of Array.isArray(raw?.content) ? raw.content : []) {
    const entry = object(block);
    push(string(object(entry?.content)?.text) ?? string(entry?.text));
  }
  const output = raw?.rawOutput;
  const record = output === undefined ? undefined : object(output);
  if (record) {
    push(
      string(record.content) ??
        string(record.output) ??
        string(record.stdout) ??
        string(record.combinedOutput) ??
        string(record.text) ??
        JSON.stringify(record, null, 2),
    );
  } else if (output !== undefined) {
    push(string(output));
  }
  return parts.join("\n").trim();
}

/** ACP updates are partial snapshots. A title never outranks structured input. */
export function acpObservation(update: JsonValue, name: string | undefined, detail: string): ToolObservation {
  const raw = object(update) ?? {};
  const input = raw.rawInput;
  const title = string(raw.title);
  const target = inputTarget(input, inferAction(name));
  const locations = Array.isArray(raw.locations) ? raw.locations : [];
  const path = string(object(locations[0])?.path);
  const kind = string(raw.kind);
  const action = kind === "execute" ? "run" : kind === "fetch" ? "fetch"
    : kind === "move" ? "edit" : kind === "think" || kind === "other" ? "other"
    : kind && ["read", "edit", "delete", "search"].includes(kind) ? ToolActionSchema.parse(kind) : undefined;
  const status = string(raw.status);
  const observation: ToolObservation = {
    title,
    name: name ? { value: name, authority: kind ? "explicit" : "fallback" } : undefined,
    action: { value: action ?? inferAction(name), authority: action ? "explicit" : "inferred" },
    target: target !== undefined ? { value: target, authority: "explicit" }
      : path ? { value: locations.length > 1 ? `${path} +${locations.length - 1} more` : path, authority: "explicit" }
      : title !== undefined ? { value: title, authority: "inferred" } : undefined,
    input: input !== undefined ? JSON.stringify(input, null, 2) : undefined,
    status: status === undefined ? undefined : status === "failed" ? "failed"
      : status === "completed" ? "completed" : "in-progress",
  };
  if (detail) observation.detail = { value: detail, mode: "snapshot" };
  const blocks = Array.isArray(raw.content) ? raw.content : [];
  const changes: ToolFileChange[] = [];
  for (const b of blocks) {
    const block = object(b);
    if (block?.type !== "diff") continue;
    const file = string(block.path);
    // A created file's block carries `oldText: null` (Droid, live capture).
    const before = block.oldText === null ? "" : string(block.oldText);
    const after = block.newText === null ? "" : string(block.newText);
    if (file && before !== undefined && after !== undefined) changes.push({ path: file,
      kind: before === "" ? "created" : after === "" ? "removed" : "edited",
      diff: beforeAfterDiff(before, after), applied: status === "completed" });
  }
  const filePath = string(object(input)?.file_path) ?? string(object(input)?.path) ?? string(object(input)?.TargetFile) ?? path;
  const mutation = action ?? inferAction(name);
  if (!changes.length && filePath && ["edit", "write", "delete"].includes(mutation)) {
    changes.push({ path: filePath, kind: mutation === "delete" ? "removed" : "edited", applied: status === "completed" });
  }
  if (changes.length) observation.fileChanges = changes;
  return observation;
}

/** Fold one ACP tool update into its call. A completion confirms the call's
 *  file changes as applied, even when it restates none of them — ACP sends a
 *  diff on the call's first update and only a status on its last. Returns the
 *  call's status after the fold. */
export function foldAcpToolCall(state: ToolCallAccumulator, update: JsonValue): RuntimeItemStatus {
  const raw = object(update);
  const kind = string(raw?.kind);
  state.observe(acpObservation(update, kind ? ACP_TOOL_KIND_NAMES[kind] ?? "tool" : undefined, acpToolDetail(update)));
  if (string(raw?.status) === "completed" && state.fileChanges) {
    state.observe({ fileChanges: state.fileChanges.map((f) => ({ ...f, applied: true })) });
  }
  return state.status;
}

/** ACP plan entries are `{ content, status }` with `in_progress` spelled with
 *  an underscore; kone's PlanTaskStatus uses a hyphen. */
export function parseAcpPlan(update: JsonValue): Omit<PlanTask, "id">[] | undefined {
  const entries = object(update)?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const out: Omit<PlanTask, "id">[] = [];
  for (const entry of entries) {
    const content = string(object(entry)?.content)?.trim();
    if (!content) continue;
    const rawStatus = string(object(entry)?.status);
    const status = rawStatus === "completed" ? "completed" : rawStatus === "in_progress" ? "in-progress" : "pending";
    out.push({ content, status });
  }
  return out.length > 0 ? out : undefined;
}
