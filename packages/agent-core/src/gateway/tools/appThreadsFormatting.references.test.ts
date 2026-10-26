import { describe, expect, it } from "bun:test";

import type { ChatAttachment, StoredBlock } from "../../types.js";
import { blockText, readMessageRow } from "./appThreadsFormatting.js";

const QUOTED = "  if (ready) {\n\treturn value;\n  }\n";

const reference: ChatAttachment = {
  type: "reference",
  id: "ref-1",
  name: "Selection",
  mimeType: "text/plain",
  sizeBytes: QUOTED.length,
  reference: {
    text: QUOTED,
    sourcePaneId: "pane-1",
    sourceThreadId: "thread-1",
  },
};

function user(text: string, attachments?: ChatAttachment[]): StoredBlock {
  const block: StoredBlock = { id: "u-1", role: "user", text, at: 1 };
  if (attachments) block.attachments = attachments;
  return block;
}

describe("reading a turn that carried a reference", () => {
  it("includes the exact quoted text in the prose read", () => {
    // app_read_thread's default representation is prose; a reader that only
    // saw the attachment name could never recover the quote.
    const row = readMessageRow(user("what does this do?", [reference]), 10_000, 0);
    expect(row.text).toContain("what does this do?");
    expect(row.text).toContain(QUOTED);
  });

  it("includes it in the rich representation too, and paginates the exact bytes", () => {
    const row = readMessageRow(user("what does this do?", [reference]), 10_000, 0, "rich");
    expect(row.text).toContain(QUOTED);
    expect(row.nextTextOffset).toBeNull();
  });

  it("a reference-only turn reads back as its quote", () => {
    const row = readMessageRow(user("", [reference]), 10_000, 0);
    expect(row.text).toContain(QUOTED);
  });

  it("blockText leaves a plain user message unchanged", () => {
    expect(blockText(user("  exact prose  "))).toBe("  exact prose  ");
  });

  it("ignores a reference-typed attachment with no payload", () => {
    const broken: ChatAttachment = {
      type: "reference",
      id: "ref-broken",
      name: "Selection",
      mimeType: "text/plain",
      sizeBytes: 0,
    };
    expect(blockText(user("just prose", [broken]))).toBe("just prose");
    expect(readMessageRow(user("just prose", [broken]), 10_000, 0).text).toBe("just prose");
  });
});
