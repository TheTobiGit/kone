import { describe, expect, test } from "bun:test";
import { resolveAttachmentProtocolPath } from "./attachmentProtocol.js";

describe("resolveAttachmentProtocolPath", () => {
  const fakeStore: Record<string, string> = {
    "att_11111111-2222-3333-4444-555555555555": "/users/mock/attachments/att_11111111-2222-3333-4444-555555555555.png",
    "att_abc-123-def": "/users/mock/attachments/att_abc-123-def.pdf",
  };

  const testResolver = (id: string) => fakeStore[id] ?? null;

  test("resolves standard attachment://<id> URL", async () => {
    const result = await resolveAttachmentProtocolPath(
      "attachment://att_11111111-2222-3333-4444-555555555555",
      testResolver,
    );
    expect(result).toBe("/users/mock/attachments/att_11111111-2222-3333-4444-555555555555.png");
  });

  test("resolves attachment://<id>/<fileName> URL", async () => {
    const result = await resolveAttachmentProtocolPath(
      "attachment://att_11111111-2222-3333-4444-555555555555/screenshot.png",
      testResolver,
    );
    expect(result).toBe("/users/mock/attachments/att_11111111-2222-3333-4444-555555555555.png");
  });

  test("resolves pathname style attachment:///att_xxx", async () => {
    const result = await resolveAttachmentProtocolPath(
      "attachment:///att_abc-123-def/doc.pdf",
      testResolver,
    );
    expect(result).toBe("/users/mock/attachments/att_abc-123-def.pdf");
  });

  test("refuses non-attachment protocols", async () => {
    expect(await resolveAttachmentProtocolPath("http://att_abc-123-def", testResolver)).toBeNull();
    expect(await resolveAttachmentProtocolPath("file:///att_abc-123-def", testResolver)).toBeNull();
  });

  test("refuses directory traversal attempts in attachment id", async () => {
    expect(await resolveAttachmentProtocolPath("attachment://..%2F..%2Fetc%2Fpasswd", testResolver)).toBeNull();
    expect(await resolveAttachmentProtocolPath("attachment:///../secret", testResolver)).toBeNull();
  });

  test("refuses invalid / unsanitized attachment id patterns", async () => {
    expect(await resolveAttachmentProtocolPath("attachment://evil_id", testResolver)).toBeNull();
    expect(await resolveAttachmentProtocolPath("attachment://att_foo;rm -rf", testResolver)).toBeNull();
    expect(await resolveAttachmentProtocolPath("attachment://", testResolver)).toBeNull();
  });

  test("returns null when attachment id is not found in store", async () => {
    expect(await resolveAttachmentProtocolPath("attachment://att_00000000-0000-0000-0000-000000000000", testResolver)).toBeNull();
  });

  test("fails closed on unparseable URL", async () => {
    expect(await resolveAttachmentProtocolPath("not-a-url", testResolver)).toBeNull();
  });
});
