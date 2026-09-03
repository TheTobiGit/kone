import type { JsonObject, JsonValue } from "../lib-jsonValue.js";
import type { GatewayRecord } from "./schemas.js";

/** Ids and names compare without their punctuation or whitespace, so
 *  "code-reviewer", "Code Reviewer" and "codereviewer" all match. */
export function squash(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

/** One model reference as a structured gateway result record. */
export function modelRefPayload(ref: {
  provider: string;
  model?: string;
  label?: string;
}): GatewayRecord {
  const payload: GatewayRecord = { provider: ref.provider };
  if (ref.model) payload.model = ref.model;
  if (ref.label) payload.label = ref.label;
  return payload;
}

/**
 * The record with its empty fields dropped.
 *
 * A tool result is read by a model with a finite context, and `"agent": null`
 * next to `"branch": null` next to `"from": null` spends tokens to say nothing
 * — on a list of forty rows it is most of the payload. Absent and null carry
 * the same meaning to a reader, so only one of them is worth sending.
 *
 * Only `null` and empty arrays go. `false` and `0` stay, because those are
 * answers: a repo with `0` changed files is not a repo we failed to look at.
 * A tool whose booleans are cheaper omitted says so itself, field by field,
 * rather than having that decided for it here.
 */
export function compact(record: GatewayRecord): GatewayRecord {
  const out: GatewayRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/** A rough age — "4m", "3h", "6d" — or null. Prose says how long ago something
 *  happened because that is the question being asked; the exact stamp rides in
 *  the structured half for anything that needs to compute on it. */
export function ago(at: number | null | undefined, now: number = Date.now()): string | null {
  if (at === null || at === undefined) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ── paging ───────────────────────────────────────────────────────────────────
// A list tool answers with one page and, when there is more, a cursor that
// continues it. The cursor is opaque on purpose: a model that had to compute
// "next offset = 20 + 20" would get it wrong eventually, while one handed a
// string to pass back cannot. Opacity is also what lets each tool page the way
// its own data needs — a keyset where rows reorder under you, a plain offset
// where they do not — behind a single concept the caller learns once.


/** What a cursor can carry. `at`/`id` are a keyset boundary (everything after
 *  this exact row, in the list's own order); `skip` is a plain offset. */
export interface CursorFields {
  /** The last listed row's sort stamp — the keyset boundary. */
  at?: number;
  /** The last listed row's id, breaking ties within one stamp. */
  id?: string;
  /** How many rows the next page starts past. */
  skip?: number;
}

/** A cursor for `kind`, as a single opaque token. */
export function encodeCursor(kind: string, fields: CursorFields): string {
  const payload: JsonObject = { k: kind };
  if (fields.at !== undefined) payload.at = fields.at;
  if (fields.id !== undefined) payload.id = fields.id;
  if (fields.skip !== undefined) payload.skip = fields.skip;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** A number off the wire, or undefined — a cursor is user-supplied text, and a
 *  field that is not a finite number is not a boundary. */
function numberField(value: JsonValue): number | undefined {
  return Number.isFinite(value) ? Number(value) : undefined;
}

/**
 * The cursor's fields, or null when it is not this tool's cursor.
 *
 * Null covers every way a cursor can be wrong at once — truncated, hand-edited,
 * or minted by a different tool — because the caller's answer to all of them is
 * the same: say so, and hand back the first page's worth of guidance rather
 * than a page from the wrong place.
 */
export function decodeCursor(kind: string, cursor: string): CursorFields | null {
  let parsed: JsonValue;
  try {
    // SAFETY: JSON.parse yields exactly the JSON domain JsonValue names; every
    // field below is still checked before it is trusted.
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as JsonValue;
  } catch {
    return null;
  }
  if (!(parsed instanceof Object) || Array.isArray(parsed)) return null;
  if (parsed.k !== kind) return null;
  const fields: CursorFields = {};
  const at = numberField(parsed.at);
  if (at !== undefined) fields.at = at;
  if (parsed.id !== undefined && parsed.id !== null) fields.id = String(parsed.id);
  const skip = numberField(parsed.skip);
  if (skip !== undefined) fields.skip = Math.max(0, Math.trunc(skip));
  return fields;
}
