// Answer attachments for provider-native questions.
//
// A provider's question protocol is text-only (Claude's AskUserQuestion, Codex's
// requestUserInput), so the files a user attaches to an answer cannot ride the
// protocol itself. They are already in the thread's attachment store — the
// renderer uploads them before responding — so what the model needs is the
// on-disk path, named in the answer text. This is the one place that wording is
// written, so every provider reads the same thing.

import type { ChatAttachment, UserInputAnswerAttachments, UserInputAnswers } from "./types.js";

/** One question's attachments as the lines that name them: the kind, the name
 *  the user sees, and where the file is. Both strings are JSON-quoted so a
 *  name with spaces and a path with unicode survive being read back. */
export function answerAttachmentRefLines(
  attachments: ChatAttachment[],
  pathOf: (id: string) => string | null,
): string[] {
  return attachments.map((attachment) => {
    const kind = attachment.type === "image" ? "image" : "file";
    const path = pathOf(attachment.id) ?? attachment.id;
    return `Attached ${kind} ${JSON.stringify(attachment.name)}: ${JSON.stringify(path)}`;
  });
}

/** Fold each question's attachments into its answer text. A string answer keeps
 *  its words and gains the paths below them, an array (multi-select) gains them
 *  as a final entry, and an empty or skipped answer is just the paths. Returns
 *  the answers untouched when nothing was attached. */
export function withAnswerAttachmentRefs(
  answers: UserInputAnswers,
  attachments: UserInputAnswerAttachments | undefined,
  pathOf: (id: string) => string | null,
): UserInputAnswers {
  if (!attachments) return answers;
  const folded: UserInputAnswers = { ...answers };
  let changed = false;
  for (const [questionId, files] of Object.entries(attachments)) {
    if (files.length === 0) continue;
    changed = true;
    const refs = answerAttachmentRefLines(files, pathOf).join("\n");
    const answer = folded[questionId];
    if (Array.isArray(answer)) folded[questionId] = [...answer, refs];
    else if (answer?.trim()) folded[questionId] = `${answer}\n\n${refs}`;
    else folded[questionId] = refs;
  }
  return changed ? folded : answers;
}
