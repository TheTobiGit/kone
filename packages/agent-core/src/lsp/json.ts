// Shared json guards for the language-server integration.
//
// Every boundary in this folder meets untyped wire or file data. Records are
// narrowed by constructor, numbers by finiteness, and text by excluding every
// other variant — never by inspecting representations.

import type { LspJsonObject, LspJsonValue } from "./types.js";

// A plain record. Arrays are excluded because a list is never a valid params,
// config, or notification object.
export function isRecord(value: LspJsonValue | undefined): value is LspJsonObject {
  return value instanceof Object && !Array.isArray(value);
}

// A wire list behind a typed guard, so iterating it needs no assertion.
export function isJsonList(value: LspJsonValue | undefined): value is readonly LspJsonValue[] {
  return Array.isArray(value);
}

// A finite number. NaN, infinities, and every non-number fail, so counters
// and protocol codes never inherit arithmetic poison.
export function isJsonNumber(value: LspJsonValue | undefined): value is number {
  return Number.isFinite(value);
}

// Text is whatever remains after excluding every other variant.
export function jsonText(value: LspJsonValue | undefined): string | null {
  if (value === undefined || value === null || value === true || value === false) return null;
  if (Array.isArray(value) || value instanceof Object || isJsonNumber(value)) return null;
  return value;
}

// A strict integer, or null when the value is fractional, non-numeric, or
// absent. This never rounds: a limit of 1.5 is a caller mistake, not a limit
// of 1.
export function asInt(value: LspJsonValue | undefined): number | null {
  if (!isJsonNumber(value) || !Number.isInteger(value)) return null;
  return value;
}

// A positive budget (timeouts, retry delays): nothing usable — absent,
// non-finite, zero, or negative — means the caller's default, since no wait
// can be honoured with those. Anything else floors to whole milliseconds.
export function positiveInt(raw: number | undefined, fallback: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

// An integer knob clamped to [min, max]; absent or non-finite means the
// fallback. Unlike positiveInt, out-of-range values clamp instead of falling
// back, for knobs like attempt counts where any in-range number is usable.
export function clampInt(
  raw: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.floor(raw), min), max);
}
