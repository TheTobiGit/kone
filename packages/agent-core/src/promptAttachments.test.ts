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
mock.module("./sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

import { setUserDataDir } from "./userDataDir.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "kone-prompt-attachments-test-"));
  setUserDataDir(tmpDir);
  const { getConversationStore } = await import("./ConversationStore.js");
  getConversationStore().ensureThread({
    threadId: "th_1",
    projectPath: tmpDir,
    provider: "claude",
  });
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

  test("buildTextAttachmentBlock returns empty string when no attachments exist", async () => {
    const { buildTextAttachmentBlock } = await import("./promptAttachments.js");
    expect(await buildTextAttachmentBlock(undefined)).toBe("");
    expect(await buildTextAttachmentBlock([])).toBe("");
  });

  test("an attachment missing from the store fails the turn instead of being left out", async () => {
    const { buildTextAttachmentBlock } = await import("./promptAttachments.js");
    expect(
      buildTextAttachmentBlock([
        { id: "non_existent_id", name: "ghost.txt", mimeType: "text/plain", sizeBytes: 10, type: "file" },
      ]),
    ).rejects.toThrow('Attachment "ghost.txt" could not be found');
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

  test("a reference is inlined as user-provided context and never resolved on disk", async () => {
    const { buildReferenceBlock, buildTextAttachmentBlock } = await import("./promptAttachments.js");
    const reference = {
      type: "reference" as const,
      id: "ref_1",
      name: "Source thread",
      mimeType: "text/plain",
      sizeBytes: 40,
      reference: {
        text: "  if (ready) {\n\treturn value;\n  }\n",
        sourcePaneId: "pane-1",
        sourceThreadId: "thread-1",
        sourceMessageId: "message-1",
        sourceTitle: "Source thread",
      },
    };

    const block = buildReferenceBlock([reference]);
    expect(block).toMatch(/^`{3}text$/m);
    expect(block).toContain("Source thread");
    // Exact bytes, including indentation, tab and trailing newline.
    expect(block).toContain("  if (ready) {\n\treturn value;\n  }\n");
    expect(block.trimEnd().endsWith("```")).toBe(true);

    // A reference-only turn is a real prompt block; no file lookup happens.
    expect(await buildTextAttachmentBlock([reference])).toBe(block);
  });

  test("references and files share the prompt in attachment order", async () => {
    const { getAttachmentStore } = await import("./AttachmentStore.js");
    const { buildTextAttachmentBlock, buildCodexAttachmentInput } = await import(
      "./promptAttachments.js"
    );
    const store = getAttachmentStore();
    const doc = await store.save({
      threadId: "th_1",
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("file body").toString("base64"),
    });
    const reference = {
      type: "reference" as const,
      id: "ref_2",
      name: "Selection",
      mimeType: "text/plain",
      sizeBytes: 11,
      reference: { text: "quoted text", sourcePaneId: "pane-1" },
    };

    const block = await buildTextAttachmentBlock([doc, reference]);
    expect(block).toContain("quoted text");
    expect(block).toContain("notes.txt");
    // The reference text stays separate from the file list.
    expect(block.indexOf("quoted text")).toBeLessThan(block.indexOf("<attached_files>"));

    expect((await buildCodexAttachmentInput([doc, reference])).fileBlock).toContain("quoted text");
  });

  test("every provider's non-native path carries the reference text", async () => {
    const {
      buildClaudeAttachmentContent,
      buildCursorAttachmentInput,
      buildCodexAttachmentInput,
    } = await import("./promptAttachments.js");
    const reference = {
      type: "reference" as const,
      id: "ref_4",
      name: "Selection",
      mimeType: "text/plain",
      sizeBytes: 10,
      reference: { text: "exact text", sourcePaneId: "pane-1" },
    };

    expect((await buildClaudeAttachmentContent([reference])).fileBlock).toContain("exact text");
    expect((await buildCursorAttachmentInput([reference])).fileBlock).toContain("exact text");
    expect((await buildCodexAttachmentInput([reference])).fileBlock).toContain("exact text");
  });

  test("buildOpenCodeAttachmentParts leaves references out of file parts", async () => {
    const { buildOpenCodeAttachmentParts, buildReferenceBlock } = await import(
      "./promptAttachments.js"
    );
    const reference = {
      type: "reference" as const,
      id: "ref_3",
      name: "Selection",
      mimeType: "text/plain",
      sizeBytes: 6,
      reference: { text: "opencode context", sourcePaneId: "pane-1" },
    };

    const parts = await buildOpenCodeAttachmentParts([reference]);
    expect(parts).toEqual([]);
    // OpenCode composes this into the prompt text, so the agent gets the bytes.
    expect(buildReferenceBlock([reference])).toContain("opencode context");
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

  test("a selection that contains the old closing marker cannot end its own quote", async () => {
    const { buildReferenceBlock } = await import("./promptAttachments.js");
    // A diff of this very file, a prompt, or documentation can contain both a
    // backtick run and the old closing tag. The delimiter has to be longer
    // than anything inside, and the selected bytes have to stay exact.
    const text = "before\n````\n</referenced_text>\nafter\n";
    const reference = {
      type: "reference" as const,
      id: "ref_fence",
      name: "Selection",
      mimeType: "text/plain",
      sizeBytes: text.length,
      reference: { text, sourcePaneId: "pane-1" },
    };

    const block = buildReferenceBlock([reference]);
    expect(block).toContain(text);

    const opening = /^(`{3,})text$/m.exec(block);
    expect(opening).not.toBeNull();
    // One backtick longer than the longest run in the quote.
    expect(opening![1]!.length).toBe(5);
    expect(block.endsWith(`\n${opening![1]}`)).toBe(true);
  });

  test("a reference-typed attachment with no usable payload is skipped safely", async () => {
    const { buildReferenceBlock, buildTextAttachmentBlock } = await import("./promptAttachments.js");
    // Persisted or foreign metadata can carry the discriminator without the
    // text; the builder must skip it instead of throwing at send time.
    const broken = {
      type: "reference" as const,
      id: "ref_broken",
      name: "Selection",
      mimeType: "text/plain",
      sizeBytes: 0,
    };
    expect(buildReferenceBlock([broken])).toBe("");
    expect(await buildTextAttachmentBlock([broken])).toBe("");
  });

  test("concurrent image reads keep attachment order with per-image bytes", async () => {
    const { getAttachmentStore } = await import("./AttachmentStore.js");
    const { buildCursorAttachmentInput } = await import("./promptAttachments.js");

    const store = getAttachmentStore();
    const payloads = ["first-bytes", "second-bytes", "third-bytes"];
    const images = [];
    for (const [index, payload] of payloads.entries()) {
      images.push(
        await store.save({
          threadId: "th_1",
          name: `img-${index}.png`,
          mimeType: "image/png",
          data: Buffer.from(payload).toString("base64"),
        }),
      );
    }

    const result = await buildCursorAttachmentInput(images);
    expect(result.imageBlocks).toHaveLength(3);
    expect(result.imageBlocks.map((block) => block.data)).toEqual(
      payloads.map((payload) => Buffer.from(payload).toString("base64")),
    );
  });
});
