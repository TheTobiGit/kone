import type { UserInputAnswers, UserInputQuestion } from "./types.js";
import type { UserInputJsonValue } from "./adapters/userInputQuestions.js";

// Formats a print-mode aftermath ask's answers as the follow-up turn that
// delivers them. The asking process is already gone, so the answers travel as
// an ordinary user message — quoting each question with its picks keeps the
// agent's context explicit. Questions with no usable answer (missing, null,
// or blank/whitespace-only) are skipped: omitted from the follow-up with no
// "No answer" marker, so a partial answer quotes only what was actually
// picked. Returns undefined when nothing was actually answered (a dismissal),
// so the caller sends no turn.
//
// Total over the IPC boundary: answers arrive as decoded JSON, so any value
// can sit under a key at runtime. Numbers coerce through String (a numeric
// pick is still an answer); booleans, objects and nested arrays carry no
// answer text and are dropped; null, undefined and whitespace-only strings
// are skipped. Nothing here throws, so the owner can format after clearing
// its park without risking a cleared-but-undeliverable answer.

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

export function formatPostTurnAskFollowUp(
  questions: UserInputQuestion[],
  answers: UserInputAnswers,
): string | undefined {
  const blocks: string[] = [];
  for (const question of questions) {
    const joined = joinAnswerValues(answers[question.id]);
    if (!joined) continue;
    blocks.push(`**${question.question}**\n${joined}`);
  }
  if (blocks.length === 0) return undefined;
  return `My answers to your questions:\n\n${blocks.join("\n\n")}`;
}
