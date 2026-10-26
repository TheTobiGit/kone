// Text references on their way to a turn.
//
// A reference is ordinary attachment metadata with `type: "reference"` and the
// exact selected text in `reference`. There are no bytes to upload and no file
// on disk, so the composer holds it in its own list and every host merges it
// into the draft's attachments right before sending.
//
// Identity is derived from the content and its source, not from a UI object:
// once added, a reference is an immutable snapshot, and the same selection made
// twice produces the same id so the composer can dedupe it.

import { isReferenceAttachment as isTextReferenceAttachment } from "@kone/protocol/text-reference";
import type { ChatAttachment, TextReference } from "~/types/desktop";

export type ReferenceChatAttachment = ChatAttachment & {
  type: "reference";
  reference: TextReference;
};

/** Whether an attachment carries a usable text reference. The canonical
 *  protocol guard validates the payload too, so a reference-shaped record with
 *  no text is treated as a plain attachment rather than a quote. */
export function isReferenceAttachment(
  attachment: ChatAttachment,
): attachment is ReferenceChatAttachment {
  return isTextReferenceAttachment(attachment);
}

/** The comparable identity of a reference: the exact text plus where it came
 *  from. The title is presentation only, so it never splits a duplicate. */
function referenceKey(reference: TextReference): string {
  return JSON.stringify([
    reference.text,
    reference.sourcePaneId,
    reference.sourceThreadId ?? "",
    reference.sourceMessageId ?? "",
  ]);
}

/** Two references are the same selection when their bytes and source agree. */
export function sameTextReference(a: TextReference, b: TextReference): boolean {
  return referenceKey(a) === referenceKey(b);
}

/** A stable, short id for an attachment list. Not content addressing — the
 *  authoritative text always rides `reference.text`. */
function referenceId(reference: TextReference): string {
  const key = referenceKey(reference);
  // FNV-1a: tiny, dependency-free and stable across runs.
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `ref_${hash.toString(36)}_${key.length.toString(36)}`;
}

/** Build the attachment a composer carries for one reference. Copies the
 *  reference so a later edit at the source cannot mutate what will be sent. */
export function referenceAttachmentOf(reference: TextReference): ReferenceChatAttachment {
  const copy: TextReference = {
    text: reference.text,
    sourcePaneId: reference.sourcePaneId,
  };
  if (reference.sourceThreadId !== undefined) copy.sourceThreadId = reference.sourceThreadId;
  if (reference.sourceMessageId !== undefined) copy.sourceMessageId = reference.sourceMessageId;
  if (reference.sourceTitle !== undefined) copy.sourceTitle = reference.sourceTitle;
  const name = reference.sourceTitle?.trim() || "Selection";
  return {
    type: "reference",
    id: referenceId(copy),
    name,
    mimeType: "text/plain",
    sizeBytes: new TextEncoder().encode(copy.text).length,
    reference: copy,
  };
}

/** The selection as a chip shows it: one line, whitespace folded. The chip
 *  truncates with CSS; the cap only keeps a huge selection out of the DOM.
 *  The exact text stays on `reference.text` for the tooltip and the turn. */
export function referenceGlance(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** Split an attachment list into the files/images that need restoring and the
 *  references that only need their metadata back. */
export function splitReferenceAttachments(attachments: readonly ChatAttachment[]) {
  const files: ChatAttachment[] = [];
  const references: ReferenceChatAttachment[] = [];
  for (const attachment of attachments) {
    if (isReferenceAttachment(attachment)) references.push(attachment);
    else files.push(attachment);
  }
  return { files, references };
}

/** A reference-only attachment list, for a restore that starts from stored
 *  TextReference values rather than attachments. */
export function referenceAttachmentsOf(
  references: readonly TextReference[],
): ReferenceChatAttachment[] {
  return references.map(referenceAttachmentOf);
}
