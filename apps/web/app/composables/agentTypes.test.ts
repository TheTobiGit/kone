import { describe, expect, test } from "bun:test";
import type { ChatAttachment, TextReference } from "~/types/desktop";
import {
  mergeComposerAttachments,
  normalizeComposerDraft,
  referencesOfAttachments,
  type ComposerDraft,
} from "./agentTypes";
import { referenceAttachmentOf } from "~/utils/composerReferences";

const REFERENCE: TextReference = {
  text: "one\n  two\n",
  sourcePaneId: "pane-1",
  sourceThreadId: "thread-1",
  sourceTitle: "Source",
};
const reference: ChatAttachment = referenceAttachmentOf(REFERENCE);
const file: ChatAttachment = {
  type: "file",
  id: "att_1",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
};

describe("composer draft references", () => {
  test("normalization keeps references beside files and skills", () => {
    const draft: ComposerDraft = {
      text: "look",
      files: [],
      skills: [{ name: "review", path: "/s/review/SKILL.md" }],
      references: [reference],
    };
    expect(normalizeComposerDraft(draft)).toEqual(draft);
  });

  test("hosts combine uploaded files with reference attachments", () => {
    expect(mergeComposerAttachments([file], [reference])).toEqual([file, reference]);
    expect(mergeComposerAttachments(undefined, [reference])).toEqual([reference]);
    expect(mergeComposerAttachments([file], undefined)).toEqual([file]);
    expect(mergeComposerAttachments([], [])).toBeUndefined();
    // References are not duplicated if a host accidentally hands the same list
    // to both halves.
    expect(mergeComposerAttachments([reference], [reference])).toEqual([reference]);
  });

  test("a refusal carries only the references that rode the turn", () => {
    expect(referencesOfAttachments([file, reference])).toEqual([REFERENCE]);
    expect(referencesOfAttachments([file])).toEqual([]);
    expect(referencesOfAttachments(undefined)).toEqual([]);
  });
});
