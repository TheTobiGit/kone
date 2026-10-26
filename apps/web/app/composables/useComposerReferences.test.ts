import { describe, expect, test } from "bun:test";
import type { ChatAttachment, TextReference } from "~/types/desktop";
import { useComposerReferences } from "./useComposerReferences";
import {
  isReferenceAttachment,
  referenceAttachmentOf,
  sameTextReference,
  splitReferenceAttachments,
} from "~/utils/composerReferences";

const SELECTION: TextReference = {
  text: "first line\n    indented line\n",
  sourcePaneId: "pane-a",
  sourceThreadId: "thread-a",
  sourceMessageId: "message-a",
  sourceTitle: "Thread A",
};

describe("the composer's references", () => {
  test("adds a selection as an immutable reference attachment", () => {
    const refs = useComposerReferences();
    expect(refs.add(SELECTION)).toBe(true);

    const [held] = refs.references.value;
    expect(held?.type).toBe("reference");
    expect(held?.reference).toEqual(SELECTION);
    expect(held?.mimeType).toBe("text/plain");
    // The chip names its source, but the exact bytes are what travel.
    expect(held?.name).toBe("Thread A");
    expect(held?.sizeBytes).toBe(new TextEncoder().encode(SELECTION.text).length);

    // A later change at the source cannot rewrite what was attached.
    SELECTION.text = "mutated";
    expect(held?.reference.text).toBe("first line\n    indented line\n");
    SELECTION.text = "first line\n    indented line\n";
  });

  test("deduplicates the identical selection and keeps distinct ones", () => {
    const refs = useComposerReferences();
    expect(refs.add(SELECTION)).toBe(true);
    expect(refs.add({ ...SELECTION })).toBe(false);
    expect(refs.references.value).toHaveLength(1);

    const other = { ...SELECTION, sourceMessageId: "message-b" };
    expect(refs.add(other)).toBe(true);
    expect(refs.references.value).toHaveLength(2);
    expect(refs.references.value[1]?.reference.sourceMessageId).toBe("message-b");

    // Same text from another pane is a different source.
    expect(refs.add({ ...SELECTION, sourcePaneId: "pane-b", sourceMessageId: undefined })).toBe(true);
    expect(refs.references.value).toHaveLength(3);
  });

  test("removes one by id, clears all, and ignores an empty selection", () => {
    const refs = useComposerReferences();
    refs.add(SELECTION);
    refs.add({ ...SELECTION, sourceMessageId: "message-b" });
    expect(refs.add({ ...SELECTION, text: "" })).toBe(false);

    const id = refs.references.value[0]?.id;
    expect(id).toBeTruthy();
    refs.remove(id ?? "");
    expect(refs.references.value).toHaveLength(1);
    expect(refs.references.value[0]?.reference.sourceMessageId).toBe("message-b");

    refs.clear();
    expect(refs.hasReferences.value).toBe(false);
  });

  test("restores from a queued turn's attachments without duplicating", () => {
    const refs = useComposerReferences();
    refs.add(SELECTION);
    const attachment = referenceAttachmentOf(SELECTION);
    const file: ChatAttachment = {
      type: "file",
      id: "att_1",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
    };

    refs.restore([file, attachment]);
    expect(refs.references.value).toHaveLength(1);
    expect(refs.attachments()).toHaveLength(1);
    expect(refs.attachments()[0]?.reference).toEqual(SELECTION);
  });

  test("snapshots plain references for the draft envelope", () => {
    const refs = useComposerReferences();
    refs.add(SELECTION);
    const snapshot = refs.snapshot();
    expect(snapshot).toEqual([SELECTION]);

    snapshot[0]!.text = "changed";
    expect(refs.references.value[0]?.reference.text).toBe(SELECTION.text);
  });

  test("the exact bytes survive add, snapshot and a send attachment", () => {
    const refs = useComposerReferences();
    const indented: TextReference = {
      text: "    leading spaces\n\tone tab\n\n  trailing spaces  \n",
      sourcePaneId: "pane-1",
      sourceMessageId: "message-1",
    };
    refs.add(indented);

    expect(refs.snapshot()[0]?.text).toBe(indented.text);
    expect(refs.attachments()[0]?.reference.text).toBe(indented.text);
  });

  test("a reference-typed attachment with no usable payload is not a reference", () => {
    // Foreign or corrupted storage can carry the discriminator without the
    // text; treating it as a reference would throw before the send.
    // SAFETY: this test builds the exact foreign shape the guard must reject;
    // the assertion is only here because ChatAttachment's `reference` field
    // would otherwise demand a valid TextReference.
    const broken = {
      type: "reference",
      id: "ref_broken",
      name: "Selection",
      mimeType: "text/plain",
      sizeBytes: 0,
    } as ChatAttachment;
    expect(isReferenceAttachment(broken)).toBe(false);
    // SAFETY: same foreign shape with an empty payload object; the guard, not
    // the type, is what has to reject it.
    expect(isReferenceAttachment({ ...broken, reference: {} } as ChatAttachment)).toBe(false);

    // It also cannot sneak into a restore or a split as a quote.
    const refs = useComposerReferences();
    refs.restore([broken]);
    expect(refs.references.value).toHaveLength(0);
    expect(splitReferenceAttachments([broken]).files).toEqual([broken]);
  });

  test("splitting a hand-back keeps files and references in their own lists", () => {
    const file: ChatAttachment = {
      type: "file",
      id: "att_9",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
    };
    const { files, references } = splitReferenceAttachments([file, referenceAttachmentOf(SELECTION)]);
    expect(files).toEqual([file]);
    expect(references).toHaveLength(1);
    expect(references[0]?.reference).toEqual(SELECTION);
  });

  test("identity is content plus source, not a UI id", () => {
    expect(sameTextReference(SELECTION, { ...SELECTION })).toBe(true);
    expect(sameTextReference(SELECTION, { ...SELECTION, text: `${SELECTION.text} ` })).toBe(false);
    expect(sameTextReference(SELECTION, { ...SELECTION, sourceThreadId: "thread-b" })).toBe(false);
    expect(referenceAttachmentOf(SELECTION).id).toBe(referenceAttachmentOf({ ...SELECTION }).id);
  });
});
