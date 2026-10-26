import { describe, expect, test } from "bun:test";
import type { ChatAttachment } from "./types.js";
import { parseAttachments, serializeAttachments } from "./conversationStoreTypes.js";

const reference: ChatAttachment = {
  type: "reference",
  id: "ref_1",
  name: "Source thread",
  mimeType: "text/plain",
  sizeBytes: 24,
  reference: {
    text: "  if (ready) {\n\treturn;\n}\n",
    sourcePaneId: "pane-1",
    sourceThreadId: "thread-1",
    sourceMessageId: "message-1",
    sourceTitle: "Source thread",
  },
};

const file: ChatAttachment = {
  type: "file",
  id: "att_1",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 4,
};

describe("attachment JSON storage", () => {
  test("round-trips a reference's exact text and provenance", () => {
    const json = serializeAttachments([file, reference]);
    expect(json).not.toBeNull();

    const parsed = parseAttachments(json);
    expect(parsed).toEqual([file, reference]);
    expect(parsed?.[1]?.reference?.text).toBe("  if (ready) {\n\treturn;\n}\n");
    expect(parsed?.[1]?.reference?.sourceMessageId).toBe("message-1");
  });

  test("a reference alone is enough to serialize", () => {
    const parsed = parseAttachments(serializeAttachments([reference]));
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.type).toBe("reference");
  });

  test("files without references keep the old shape", () => {
    const raw = serializeAttachments([file]);
    expect(raw).toBe(JSON.stringify([file]));
  });

  test("no attachments serialize to null", () => {
    expect(serializeAttachments([])).toBeNull();
    expect(serializeAttachments(undefined)).toBeNull();
  });
});
