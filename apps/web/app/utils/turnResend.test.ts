import { describe, expect, test } from "bun:test";

import type { ChatAttachment, TextReference } from "~/types/desktop";
import { referenceAttachmentOf } from "./composerReferences";
import { resendDraft } from "./turnResend";

const SELECTION: TextReference = {
  text: "  quoted\n\tbytes\n",
  sourcePaneId: "pane-1",
  sourceThreadId: "thread-1",
};

const reference: ChatAttachment = referenceAttachmentOf(SELECTION);
const file: ChatAttachment = {
  type: "file",
  id: "att_1",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 4,
};

describe("a retried or edited turn's send", () => {
  test("a reference-only turn stays retryable and carries its quote", () => {
    const draft = resendDraft("", [reference]);
    expect(draft).not.toBeNull();
    expect(draft?.text).toBe("");
    expect(draft?.attachments).toEqual([reference]);
  });

  test("prose and attachments travel together", () => {
    const draft = resendDraft("  what does this do?  ", [reference, file]);
    expect(draft).toEqual({ text: "what does this do?", attachments: [reference, file] });
  });

  test("a file-only turn survives as well", () => {
    expect(resendDraft("", [file])?.attachments).toEqual([file]);
  });

  test("nothing worth sending is refused", () => {
    expect(resendDraft("   ", [])).toBeNull();
    expect(resendDraft("   ", undefined)).toBeNull();
  });

  test("the caller's attachment list cannot mutate the send", () => {
    const attachments = [reference];
    const draft = resendDraft("go", attachments);
    attachments.push(file);
    expect(draft?.attachments).toEqual([reference]);
  });
});
