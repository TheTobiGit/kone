import { describe, expect, test } from "bun:test";
import { referenceAttachmentOf, referenceGlance } from "./composerReferences";

describe("referenceGlance", () => {
  test("shows the selection once, on one line", () => {
    expect(referenceGlance("  Here’s the shape\n\n  of it\t now ")).toBe("Here’s the shape of it now");
  });

  test("caps a huge selection but leaves short ones whole", () => {
    expect(referenceGlance("short")).toBe("short");
    const long = "a".repeat(500);
    expect(referenceGlance(long)).toBe(`${"a".repeat(200)}…`);
  });

  test("leaves the exact text, line breaks included, for the tooltip", () => {
    const text = "line one\n  line two";
    const attachment = referenceAttachmentOf({ text, sourcePaneId: "p1" });
    expect(attachment.reference.text).toBe(text);
    expect(referenceGlance(attachment.reference.text)).toBe("line one line two");
  });
});
