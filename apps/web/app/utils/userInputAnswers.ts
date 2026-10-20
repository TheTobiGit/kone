// What the agent-question dialog (UserInputModal) hands back, from its working
// state. Kept pure so every answer form is testable without a DOM: a picked
// option, several, a typed answer in place of the options ("write your own"),
// or free text when the question offers no options — plus an attachment-only
// answer, which is still an answer even with nothing typed or picked.

import type {
  ChatAttachment,
  UserInputAnswers,
  UserInputQuestion,
} from "~/types/desktop";

/** How many files may ride one answer across the whole dialog. Matches the
 *  backend's cap; the raw upload enforces the byte limits on top of it. */
export const USER_INPUT_ATTACHMENT_LIMIT = 8;

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
 *  one string; null while nothing is chosen or typed. `hasAttachments` says
 *  the question carries at least one file, which answers it on its own — an
 *  empty string for a single/free answer, an empty list for multi-select. */
export function userInputAnswer(
  question: UserInputQuestion,
  draft: UserInputDraft,
  hasAttachments = false,
): string | string[] | null {
  const custom = draft.text.trim();
  if (question.options.length === 0) {
    if (custom) return custom;
    return hasAttachments ? "" : null;
  }
  if (question.multiSelect) {
    const selected = [...draft.picks];
    if (draft.other && custom && !selected.includes(custom)) selected.push(custom);
    if (selected.length > 0) return selected;
    return hasAttachments ? [] : null;
  }
  if (draft.other && custom) return custom;
  if (!draft.other && draft.picks[0]) return draft.picks[0];
  return hasAttachments ? "" : null;
}

/** Every question's answer keyed by id, or null while any is still unanswered
 *  — the dialog sends all of them together or not at all. `attachmentsByQuestion`
 *  lets a file-carrying question with no words or picks count as answered. */
export function buildUserInputAnswers(
  questions: UserInputQuestion[],
  drafts: Record<string, UserInputDraft | undefined>,
  attachmentsByQuestion: Record<string, ChatAttachment[] | undefined> = {},
): UserInputAnswers | null {
  const answers: UserInputAnswers = {};
  for (const question of questions) {
    const attached = (attachmentsByQuestion[question.id]?.length ?? 0) > 0;
    const answer = userInputAnswer(
      question,
      drafts[question.id] ?? emptyUserInputDraft(),
      attached,
    );
    if (answer === null) return null;
    answers[question.id] = answer;
  }
  return answers;
}
