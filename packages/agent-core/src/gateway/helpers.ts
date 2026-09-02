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
