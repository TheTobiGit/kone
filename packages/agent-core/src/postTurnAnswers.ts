import type { UserInputJsonValue } from "./adapters/userInputQuestions.js";

// Native question transports that require text use this shared normalizer.
// Multiple selections join with commas; non-text values are ignored.

/** Coerce one answer value to its quoted text, or undefined when it carries no answer. */
function answerText(value: UserInputJsonValue | undefined): string | undefined {
  if (value === undefined || value === null || value === true || value === false) return undefined;
  if (value instanceof Object) return undefined;
  if (Number.isFinite(value)) return String(value);
  if (Number.isNaN(value)) return undefined;
  if (value === Infinity || value === -Infinity) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

/** Coerce one answer value to the ", "-joined display string. Single values
 *  collapse to their quoted text (or "" when they carry no answer); arrays
 *  join their usable picks, skipping anything without answer text. The ", "
 *  separator is the contract every consumer already shows, so it stays. This
 *  is the one place the coercion lives: the post-turn follow-up formatter,
 *  Claude's SDK answer coercion, and opencode's echoed-reply mapping all go
 *  through it rather than each re-joining. Tightenings versus the old inline
 *  joins are deliberate: padded strings trim, numbers stringify, and
 *  booleans/objects/nested arrays (which the old joins stringified into
 *  "false"/"[object Object]") are dropped as non-answers. */
export function joinAnswerValues(value: UserInputJsonValue | undefined): string {
  if (Array.isArray(value)) {
    const picked: string[] = [];
    for (const entry of value) {
      const text = answerText(entry);
      if (text !== undefined) picked.push(text);
    }
    return picked.join(", ");
  }
  return answerText(value) ?? "";
}
