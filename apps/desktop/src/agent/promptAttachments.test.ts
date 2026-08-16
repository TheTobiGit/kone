import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

class DatabaseSyncShim {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly
      ? new Database(filePath, { readonly: true })
      : new Database(filePath);
  }
  prepare(sql: string) {
    return this.db.prepare(sql);
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  close() {
    this.db.close();
  }
}
mock.module("node:sqlite", () => ({ DatabaseSync: DatabaseSyncShim }));

import { setUserDataDir } from "./userDataDir.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "kone-prompt-attachments-test-"));
  setUserDataDir(tmpDir);
});

afterEach(async () => {
  const { resetAttachmentStoreForTests } = await import("./AttachmentStore.js");
  const { resetConversationStoreForTests } = await import("./ConversationStore.js");
  resetAttachmentStoreForTests();
  resetConversationStoreForTests();
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("promptAttachments", () => {
  test("buildTextAttachmentBlock includes both images and non-image files in the attached_files block", async () => {
    const { getAttachmentStore } = await import("./AttachmentStore.js");
    const { buildTextAttachmentBlock, composePromptText } = await import("./promptAttachments.js");

    const store = getAttachmentStore();
    const img = await store.save({
      threadId: "th_1",
      name: "diagram.png",
      mimeType: "image/png",
      data: Buffer.from("fake-png-bytes").toString("base64"),
    });
    const doc = await store.save({
      threadId: "th_1",
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello world").toString("base64"),
    });

    const block = await buildTextAttachmentBlock([img, doc]);
    expect(block).toContain("<attached_files>");
    expect(block).toContain("diagram.png");
    expect(block).toContain("image/png");
    expect(block).toContain("notes.txt");
    expect(block).toContain("text/plain");
    expect(block).toContain("</attached_files>");

    const composed = composePromptText("Inspect these files", block);
    expect(composed).toBe(`Inspect these files\n\n${block}`);

    const emptyTextComposed = composePromptText("", block);
    expect(emptyTextComposed).toBe(block);
  });

  test("buildTextAttachmentBlock returns empty string when no attachments exist or are missing from store", async () => {
    const { buildTextAttachmentBlock } = await import("./promptAttachments.js");
    expect(await buildTextAttachmentBlock(undefined)).toBe("");
    expect(await buildTextAttachmentBlock([])).toBe("");
    expect(
      await buildTextAttachmentBlock([
        { id: "non_existent_id", name: "ghost.txt", mimeType: "text/plain", sizeBytes: 10, type: "file" },
      ]),
    ).toBe("");
  });

  test("buildCursorAttachmentInput separates images into imageBlocks and non-images into fileBlock", async () => {
    const { getAttachmentStore } = await import("./AttachmentStore.js");
    const { buildCursorAttachmentInput } = await import("./promptAttachments.js");

    const store = getAttachmentStore();
    const img = await store.save({
      threadId: "th_1",
      name: "diagram.png",
      mimeType: "image/png",
      data: Buffer.from("image-bytes").toString("base64"),
    });
    const doc = await store.save({
      threadId: "th_1",
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("text-bytes").toString("base64"),
    });

    const result = await buildCursorAttachmentInput([img, doc]);
    expect(result.imageBlocks).toHaveLength(1);
    expect(result.imageBlocks[0]?.type).toBe("image");
    expect(result.imageBlocks[0]?.mimeType).toBe("image/png");
    expect(result.fileBlock).toContain("<attached_files>");
    expect(result.fileBlock).toContain("notes.txt");
    expect(result.fileBlock).not.toContain("diagram.png");
  });

  test("buildCodexAttachmentInput separates images into data URLs and non-images into fileBlock", async () => {
    const { getAttachmentStore } = await import("./AttachmentStore.js");
    const { buildCodexAttachmentInput } = await import("./promptAttachments.js");

    const store = getAttachmentStore();
    const img = await store.save({
      threadId: "th_1",
      name: "photo.jpeg",
      mimeType: "image/jpeg",
      data: Buffer.from("jpg-data").toString("base64"),
    });
    const doc = await store.save({
      threadId: "th_1",
      name: "data.csv",
      mimeType: "text/csv",
      data: Buffer.from("a,b,c").toString("base64"),
    });

    const result = await buildCodexAttachmentInput([img, doc]);
    expect(result.imageItems).toHaveLength(1);
    expect(result.imageItems[0]?.type).toBe("image");
    expect(result.imageItems[0]?.url).toContain("data:image/jpeg;base64,");
    expect(result.fileBlock).toContain("<attached_files>");
    expect(result.fileBlock).toContain("data.csv");
    expect(result.fileBlock).not.toContain("photo.jpeg");
  });

  test("buildClaudeAttachmentContent includes supported images as base64 blocks and unreadable/unsupported images in fileBlock", async () => {
    const { getAttachmentStore } = await import("./AttachmentStore.js");
    const { buildClaudeAttachmentContent } = await import("./promptAttachments.js");

    const store = getAttachmentStore();
    const png = await store.save({
      threadId: "th_1",
      name: "pic.png",
      mimeType: "image/png",
      data: Buffer.from("png-data").toString("base64"),
    });
    const svg = await store.save({
      threadId: "th_1",
      name: "vector.svg",
      mimeType: "image/svg+xml",
      data: Buffer.from("<svg></svg>").toString("base64"),
    });

    const result = await buildClaudeAttachmentContent([png, svg]);
    expect(result.imageBlocks).toHaveLength(1);
    expect(result.imageBlocks[0]?.source.media_type).toBe("image/png");
    // SVG is not in CLAUDE_NATIVE_IMAGE_MIME_TYPES so it falls through to fileBlock
    expect(result.fileBlock).toContain("vector.svg");
    expect(result.fileBlock).not.toContain("pic.png");
  });

  test("buildOpenCodeAttachmentParts returns file:// URLs for all attachments", async () => {
    const { getAttachmentStore } = await import("./AttachmentStore.js");
    const { buildOpenCodeAttachmentParts } = await import("./promptAttachments.js");

    const store = getAttachmentStore();
    const file = await store.save({
      threadId: "th_1",
      name: "script.ts",
      mimeType: "text/plain",
      data: Buffer.from("console.log(1)").toString("base64"),
    });

    const parts = await buildOpenCodeAttachmentParts([file]);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("file");
    expect(parts[0]?.filename).toBe("script.ts");
    expect(parts[0]?.url.startsWith("file://")).toBe(true);
  });
});
