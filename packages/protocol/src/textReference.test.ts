import { describe, expect, test } from "bun:test";

import {
  ReferenceAttachmentSchema,
  TextReferenceSchema,
  isReferenceAttachment,
} from "./textReference.js";

const REFERENCE = {
  text: "  const answer = 42;\n\treturn answer;\n",
  sourcePaneId: "pane-1",
  sourceThreadId: "thread-1",
  sourceMessageId: "message-1",
  sourceTitle: "A selection",
};

const ATTACHMENT = {
  type: "reference" as const,
  id: "ref_1",
  name: "A selection",
  mimeType: "text/plain",
  sizeBytes: 36,
  reference: REFERENCE,
};

describe("the canonical reference guard", () => {
  test("accepts a reference whose payload is actually a text reference", () => {
    expect(isReferenceAttachment(ATTACHMENT)).toBe(true);
  });

  test("refuses a reference-typed attachment with no usable payload", () => {
    // A persisted or foreign attachment can carry the discriminator without
    // the text. Treating that as a reference would crash every prompt builder.
    expect(isReferenceAttachment({ ...ATTACHMENT, reference: undefined })).toBe(false);
    expect(isReferenceAttachment({ ...ATTACHMENT, reference: {} })).toBe(false);
    expect(isReferenceAttachment({ ...ATTACHMENT, reference: { ...REFERENCE, text: "" } })).toBe(false);
    expect(isReferenceAttachment({ ...ATTACHMENT, reference: { ...REFERENCE, sourcePaneId: 7 } })).toBe(false);
  });

  test("leaves ordinary files and images alone", () => {
    expect(isReferenceAttachment({ ...ATTACHMENT, type: "file" })).toBe(false);
    expect(isReferenceAttachment(null)).toBe(false);
    expect(isReferenceAttachment(undefined)).toBe(false);
  });
});

describe("the reference wire schema", () => {
  test("keeps the exact bytes and every provenance field", () => {
    const parsed = TextReferenceSchema.parse(REFERENCE);
    expect(parsed.text).toBe(REFERENCE.text);
    expect(parsed.sourceMessageId).toBe("message-1");
    expect(ReferenceAttachmentSchema.parse(ATTACHMENT).reference.text).toBe(REFERENCE.text);
  });
});
