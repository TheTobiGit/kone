import type { AntigravityJsonRecord } from "./antigravitySubagents.js";
import type { UserInputQuestion } from "./types.js";
import { normalizeUserInputQuestions } from "./adapters/userInputQuestions.js";

// Pure parsers for print-mode ask recovery: `agy -p` auto-skips ask_question
// headless, so every invocation the hooks report is unanswered by
// construction, and the adapter re-surfaces them as one post-turn modal.

/** True for the one tool print mode can never ask about interactively — the
 *  CLI auto-skips it headless, so every invocation the hooks report is
 *  unanswered by construction. */
export function isPrintAskQuestion(name: string | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === "ask_question";
}

/** Normalize one print-mode ask_question invocation's args into the questions
 *  the answer modal shows. `idPrefix` scopes the answer keys to the
 *  invocation (one turn can ask several times); entries without question text
 *  are dropped. Options arrive as plain strings or label/description objects;
 *  an ask with no options is a free-text prompt. */
export function parsePrintAskQuestions(
  args: AntigravityJsonRecord | undefined,
  idPrefix: string,
): UserInputQuestion[] {
  return normalizeUserInputQuestions(args?.questions, {
    idFor: (_entry, _question, index) => `${idPrefix}-${index}`,
    // The print-mode CLI fans out across three spellings for the same flag.
    isMultiSelect: (entry) =>
      entry.is_multi_select === true || entry.multiple === true || entry.multiSelect === true,
  });
}

/** One turn's ask_question invocations, in hook-report order. */
export interface PrintTurnAsk {
  args?: AntigravityJsonRecord;
}

/** Collapse one turn's ask_question invocations into the single question list
 *  the post-turn modal shows. Repeats of an already-surfaced question keep a
 *  single entry in first-seen order — the ids are synthetic per invocation,
 *  so first-wins and latest-wins are invisible to the agent either way, and
 *  first-wins keeps the modal in the order the agent asked. The content key
 *  is the JSON encoding of question, header, option labels with descriptions,
 *  and multi-select, so option text containing a separator can never collide
 *  two different questions the way a joined-string key would. */
export function collectPostTurnQuestions(turnAsks: readonly PrintTurnAsk[]): UserInputQuestion[] {
  const seen = new Set<string>();
  const questions: UserInputQuestion[] = [];
  turnAsks.forEach((ask, callIndex) => {
    for (const question of parsePrintAskQuestions(ask.args, `ask-${callIndex}`)) {
      const key = JSON.stringify([
        question.question,
        question.header,
        question.options,
        question.multiSelect ?? false,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      questions.push(question);
    }
  });
  return questions;
}
