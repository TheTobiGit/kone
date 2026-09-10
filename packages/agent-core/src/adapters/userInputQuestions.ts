import type { UserInputQuestion, UserInputQuestionOption } from "../types.js";

// One shared walk for every CLI's "ask the user" payload. The CLIs carry the
// same walk — drop entries without question text, default the header,
// normalize options as plain strings or label/description objects, free-text
// when there are no options — which had drifted apart across per-adapter
// copies; this is the single definition. The two genuine per-CLI deltas stay
// with the callers: how the question id is built, and which flags spell
// multi-select.

/** A decoded JSON value from a question payload: scalars, null, arrays, or
 *  nested objects of the same. `undefined` is included so callers can hand an
 *  absent field straight through. */
export type UserInputJsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | UserInputJsonRecord
  | UserInputJsonValue[];

/** One level of a decoded question payload: a string-keyed object whose
 *  values are plain JSON. */
export interface UserInputJsonRecord {
  [key: string]: UserInputJsonValue;
}

function isRecord(value: UserInputJsonValue | undefined): value is UserInputJsonRecord {
  return value instanceof Object && !Array.isArray(value);
}

/** Read a question-shaped string field: anything but a non-empty string is
 *  absent (numbers/bools/objects are never a question, header, or label).
 *  Exported for per-CLI id builders that derive their id from a raw field
 *  (Codex reads its own question id this way). */
export function readUserInputText(value: UserInputJsonValue | undefined): string | undefined {
  if (value === undefined || value === null || value === true || value === false) return undefined;
  if (Array.isArray(value) || value instanceof Object || Number.isFinite(value)) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

/** The per-CLI deltas the shared walk cannot decide: what answers are keyed
 *  by, and which entry flags spell multi-select. `idFor` sees the raw entry
 *  (Codex and opencode derive their ids from its fields) as well as the
 *  normalized question text and the entry's position in the raw array. */
export interface NormalizeUserInputQuestionsOptions {
  idFor: (entry: UserInputJsonRecord, question: string, index: number) => string;
  isMultiSelect: (entry: UserInputJsonRecord) => boolean;
}

/** Normalize a `questions` array into the questions the answer modal shows.
 *  Entries that are not objects, or carry no question text, are dropped; an
 *  ask with no options is a free-text prompt. `index` is the entry's position
 *  in the raw array (skipped entries still count), so callers that build
 *  positional ids stay aligned with the raw payload. Callers whose id ignores
 *  the index (Claude keys answers by question text, at the SDK's insistence)
 *  share one id across duplicate question texts — that collision is the
 *  caller's contract, not something this walk can resolve. */
export function normalizeUserInputQuestions(
  rawQuestions: UserInputJsonValue | undefined,
  options: NormalizeUserInputQuestionsOptions,
): UserInputQuestion[] {
  if (!Array.isArray(rawQuestions)) return [];
  const questions: UserInputQuestion[] = [];
  rawQuestions.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const question = readUserInputText(entry.question);
    if (!question) return;
    const header = readUserInputText(entry.header) || "Question";
    const normalized: UserInputQuestionOption[] = [];
    const rawOptions = entry.options;
    if (Array.isArray(rawOptions)) {
      for (const rawOption of rawOptions) {
        if (!isRecord(rawOption)) {
          const label = readUserInputText(rawOption);
          if (label) normalized.push({ label });
          continue;
        }
        // Options name their answer text under either `label` or `name` — the
        // question-emitting CLIs disagree on the key, so accept both rather
        // than dropping an option whose key was not expected.
        const label = readUserInputText(rawOption.label ?? rawOption.name);
        if (!label) continue;
        const description = readUserInputText(rawOption.description);
        normalized.push(description ? { label, description } : { label });
      }
    }
    questions.push({
      id: options.idFor(entry, question, index),
      header,
      question,
      options: normalized,
      multiSelect: options.isMultiSelect(entry),
    });
  });
  return questions;
}
