// A text selection the user attached to a composer as context.
//
// The reference is immutable: the exact selected bytes plus the provenance
// needed to say where they came from. It travels as attachment metadata (see
// ChatAttachment in agent-core/types.ts and the desktop mirror), so no file is
// uploaded and the existing attachment JSON storage carries it unchanged.
//
// Stays environment-agnostic (no electron, no DOM, no node builtins) because
// the renderer, the main process and the provider adapters all import it.

import { z } from "zod";

export type TextReference = {
  /** The exact selected bytes. Never trimmed, re-wrapped or reformatted. */
  text: string;
  /** The pane the selection was made in. */
  sourcePaneId: string;
  /** The thread that pane showed, when it had one (a blank thread has none). */
  sourceThreadId?: string;
  /** The message the selection started in. Omitted for a selection that
   *  crosses messages, where no single message id is honest. */
  sourceMessageId?: string;
  /** A human title for the source (thread name), when available. */
  sourceTitle?: string;
};

/** Wire schema for a TextReference. Empty text is refused: an empty selection
 *  is never a reference, and accepting one would let a blank quote travel. */
export const TextReferenceSchema = z.object({
  text: z.string().min(1),
  sourcePaneId: z.string(),
  sourceThreadId: z.string().optional(),
  sourceMessageId: z.string().optional(),
  sourceTitle: z.string().optional(),
});

/** The attachment subtype that carries a reference. `type` discriminates it
 *  from an image/file in every attachment list, and `reference` holds the
 *  actual text so a provider never has to resolve a UI id. */
export const ReferenceAttachmentSchema = z.object({
  type: z.literal("reference"),
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  reference: TextReferenceSchema,
});

export type ReferenceAttachment = z.infer<typeof ReferenceAttachmentSchema>;

/** Whether an attachment is a usable text reference. The discriminator alone
 *  is not enough: persisted or foreign metadata can carry `type: "reference"`
 *  with no payload, and every prompt builder reads `.reference.text`. The full
 *  schema is the one canonical guard shared by the renderer, the store and the
 *  provider adapters, so an invalid record is treated as a plain attachment
 *  (and fails on its own missing file) instead of crashing a send. */
export function isReferenceAttachment(
  attachment: { type?: unknown } | null | undefined,
): attachment is ReferenceAttachment {
  return Boolean(attachment && attachment.type === "reference" && ReferenceAttachmentSchema.safeParse(attachment).success);
}
