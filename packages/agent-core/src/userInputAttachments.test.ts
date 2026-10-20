import { describe, expect, test } from "bun:test";
import { answerAttachmentRefLines, withAnswerAttachmentRefs } from "./userInputAttachments.js";
import { selectQuestionOption } from "./adapters/antigravityAcpProtocol.js";
import type { ChatAttachment } from "./types.js";

const image: ChatAttachment = { type: "image", id: "att_1", name: 'shot "one".png', mimeType: "image/png", sizeBytes: 3 };
const file: ChatAttachment = { type: "file", id: "att_2", name: "brief.pdf", mimeType: "application/pdf", sizeBytes: 5 };
const pathOf = (id: string): string | null => (id === "att_1" ? "/store/shot one.png" : id === "att_2" ? "/store/brief.pdf" : null);

describe("answer attachments for text-only question protocols", () => {
  test("each file is named with its kind, quoted name and quoted path", () => {
    expect(answerAttachmentRefLines([image, file], pathOf)).toEqual([
      'Attached image "shot \\"one\\".png": "/store/shot one.png"',
      'Attached file "brief.pdf": "/store/brief.pdf"',
    ]);
  });

  test("a string answer stays whole as the first entry, the paths after it", () => {
    // A picked label must survive verbatim: fixed-choice protocols match it
    // exactly, and read the first entry of a list.
    expect(withAnswerAttachmentRefs({ q0: "The left one" }, { q0: [image] }, pathOf)).toEqual({
      q0: ["The left one", 'Attached image "shot \\"one\\".png": "/store/shot one.png"'],
    });
  });

  test("a multi-select answer gains the paths as a final entry, an empty one is only the paths", () => {
    const folded = withAnswerAttachmentRefs({ q0: ["A", "B"], q1: "  ", q2: null }, { q0: [file], q1: [file], q2: [file] }, pathOf);
    expect(folded.q0).toEqual(["A", "B", 'Attached file "brief.pdf": "/store/brief.pdf"']);
    expect(folded.q1).toEqual('Attached file "brief.pdf": "/store/brief.pdf"');
    expect(folded.q2).toEqual('Attached file "brief.pdf": "/store/brief.pdf"');
  });

  test("an answer with no attachments is returned untouched", () => {
    const answers = { q0: "A" };
    expect(withAnswerAttachmentRefs(answers, undefined, pathOf)).toBe(answers);
    expect(withAnswerAttachmentRefs(answers, {}, pathOf)).toBe(answers);
  });

  test("a file whose path no longer resolves is still named, by its id", () => {
    const gone: ChatAttachment = { type: "image", id: "att_gone", name: "gone.png", mimeType: "image/png", sizeBytes: 1 };
    expect(withAnswerAttachmentRefs({}, { q0: [gone] }, pathOf)).toEqual({
      q0: 'Attached image "gone.png": "att_gone"',
    });
  });

  test("a picked label still selects its option on a fixed-choice protocol", () => {
    const folded = withAnswerAttachmentRefs({ q0: "Beta" }, { q0: [file] }, pathOf);
    const parsed = { question: { id: "q0", header: "Pick", question: "Pick", options: [{ label: "Alpha" }, { label: "Beta" }] }, optionIds: ["a", "b"] };
    const params = { options: [{ optionId: "a", name: "Alpha" }, { optionId: "b", name: "Beta" }] };
    expect(selectQuestionOption(parsed, folded, params)).toBe("b");
  });
});
