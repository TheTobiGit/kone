/** Shared JSON probes for the Codex surface — one source for the session
 *  adapter and its approval/sandbox policy module.
 *
 *  Every RPC response, notification params, and nested item payload from
 *  `codex app-server` starts life as an untrusted decoded-JSON node; the probes
 *  below narrow it at the read sites. Import from here rather than copying a
 *  second record/string/array reader into a sibling module. */

import type { JsonObject, JsonValue } from "@kone/agent-core/lib-jsonValue.js";

/** One decoded JSON value from a codex app-server frame. Every RPC response,
 *  notification params, and nested item payload lands here first; field-level
 *  probes (`readString`, `numberOrUndefined`, …) narrow it at the read sites. */
export type CodexJsonValue = JsonValue;

export type CodexJsonObject = JsonObject;

export function asRecord(value: CodexJsonValue): CodexJsonObject | undefined {
  // SAFETY: value instanceof Object && !Array.isArray(value) verifies it is a record object.
  return value && value instanceof Object && !Array.isArray(value) ? (value as CodexJsonObject) : undefined;
}

export function readString(value: CodexJsonValue | null | undefined, ...path: string[]): string | undefined {
  let cursor: CodexJsonValue | null | undefined = value;
  for (const key of path) cursor = asRecord(cursor)?.[key];
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

/** The array under `key` when it is one.
 *  SAFETY: Array.isArray is checked before the cast, so only arrays pass. */
export function asArray(value: CodexJsonValue | null | undefined): CodexJsonValue[] {
  // SAFETY: Array.isArray is checked before the cast, so only arrays pass.
  return Array.isArray(value) ? (value as CodexJsonValue[]) : [];
}
