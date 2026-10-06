// What the agent-question dialog (UserInputModal) hands back, from its working
// state. Kept pure so every answer form is testable without a DOM: a picked
// option, several, a typed answer in place of the options ("write your own"),
// or free text when the question offers no options.

import type { UserInputAnswers, UserInputQuestion } from "~/types/desktop";

/** One question's working state: picked option labels (one for single-select,
 *  many for multi), whether the "write your own" field is on, and its text —
 *  the whole answer for an option-less question. */
export type UserInputDraft = {
  picks: string[];
  other: boolean;
  text: string;
};

export function emptyUserInputDraft(): UserInputDraft {
  return { picks: [], other: false, text: "" };
}

/** The answer one question would send: a label list for multi-select, else
 *  one string; null while nothing is chosen or typed. */
export function userInputAnswer(
  question: UserInputQuestion,
  draft: UserInputDraft,
): string | string[] | null {
  const custom = draft.text.trim();
  if (question.options.length === 0) return custom || null;
  if (question.multiSelect) {
    const selected = [...draft.picks];
    if (draft.other && custom && !selected.includes(custom)) selected.push(custom);
    return selected.length > 0 ? selected : null;
  }
  if (draft.other) return custom || null;
  return draft.picks[0] ?? null;
}

/** Every question's answer keyed by id, or null while any is still unanswered
 *  — the dialog sends all of them together or not at all. */
export function buildUserInputAnswers(
  questions: UserInputQuestion[],
  drafts: Record<string, UserInputDraft | undefined>,
): UserInputAnswers | null {
  const answers: UserInputAnswers = {};
  for (const question of questions) {
    const answer = userInputAnswer(question, drafts[question.id] ?? emptyUserInputDraft());
    if (answer === null) return null;
    answers[question.id] = answer;
  }
  return answers;
}
