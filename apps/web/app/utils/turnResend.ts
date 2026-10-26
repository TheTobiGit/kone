// The draft a retry or an edit-and-resend sends.
//
// A turn is valid with prose, attachments, or both. Retry used to require text,
// which made a reference-only turn impossible to retry at all, and resend used
// to pass text alone, which silently dropped the quote the original turn
// carried. Both paths go through this helper so the rule lives once.

import type { ChatAttachment } from "~/types/desktop";

export type ResendDraft = { text: string; attachments?: ChatAttachment[] };

/** The send for a retried or edited turn, or null when there is nothing to
 *  send. Attachments are copied so a later list edit cannot mutate the send. */
export function resendDraft(
  text: string,
  attachments?: readonly ChatAttachment[],
): ResendDraft | null {
  const trimmed = text.trim();
  if (!trimmed && !attachments?.length) return null;
  const draft: ResendDraft = { text: trimmed };
  if (attachments?.length) draft.attachments = [...attachments];
  return draft;
}
