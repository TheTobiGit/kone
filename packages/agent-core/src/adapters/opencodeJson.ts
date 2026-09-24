/** Shared JSON probes for the OpenCode surface — one source for the adapter,
 *  the protocol dialect and the v2 event normalizer.
 *
 *  Every value off OpenCode's HTTP/SSE surface starts life as an untrusted
 *  decoded-JSON node; the probes below narrow it at the read sites. Copying
 *  them per module drifted before (three `record`/`textField` copies); import
 *  from here instead. */

export type OpenCodeJsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | RecordLike
  | OpenCodeJsonValue[];

/** A string-keyed JSON object as opencode returns it, before fields are trusted. */
export interface RecordLike {
  [key: string]: OpenCodeJsonValue;
}

export type OpenCodeEvent = { type: string; properties?: RecordLike };

export function record(value: OpenCodeJsonValue | null | undefined): RecordLike | undefined {
  // SAFETY: value instanceof Object && !Array.isArray(value) verifies it is a record object.
  return value && value instanceof Object && !Array.isArray(value) ? (value as RecordLike) : undefined;
}

export function responseData(value: any): any { return value?.data ?? value; }

export function nonNegativeInteger(value: OpenCodeJsonValue | null | undefined): number | undefined {
  return jsonNumber(value) && value >= 0 && Number.isInteger(value) ? value : undefined;
}

export function stringField(value: OpenCodeJsonValue | null | undefined, key: string): string | undefined {
  return textField(record(value)?.[key]);
}

/** A decoded JSON number — finiteness separates the number variant from every
 *  other JSON variant without inspecting representations. */
export function jsonNumber(value: OpenCodeJsonValue | undefined): value is number {
  return Number.isFinite(value);
}

/** The text under an opencode JSON field when it is one — the same variant
 *  split antigravitySubagents uses: booleans by value, numbers by finiteness,
 *  composites by their constructors. */
export function textField(value: OpenCodeJsonValue | undefined): string | undefined {
  if (value === undefined || value === null || value === true || value === false) return undefined;
  if (Array.isArray(value) || value instanceof Object || jsonNumber(value)) return undefined;
  return String(value);
}

export function modelSlug(slug: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!slug) return undefined; const at = slug.indexOf("/"); if (at <= 0 || at === slug.length - 1) return undefined;
  return { providerID: slug.slice(0, at), modelID: slug.slice(at + 1) };
}
