import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";

import type { StoredAttachment } from "./ConversationStore.js";
import type { AttachmentRegistry } from "./AttachmentStore.js";

// AttachmentStore imports ConversationStore → node:sqlite. Stand bun's
// Database in so this file can load without Electron; do not mock
// ConversationStore itself — that replacement is process-wide in bun and
// would strip methods other suites need.
mock.module("./sqlite.js", () => ({
  DatabaseSync: Database,
}));

setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-att-store-")));

const { AttachmentStore } = await import("./AttachmentStore.js");

const rowsByThread = new Map<string, StoredAttachment[]>();
const childrenByParent = new Map<string, Array<{ threadId: string }>>();
const forgotten: string[] = [];

function allRows(): StoredAttachment[] {
  return [...rowsByThread.values()].flat();
}

function collectIds(root: string): string[] {
  const out = [root];
  const stack = [root];
  const seen = new Set<string>([root]);
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const child of childrenByParent.get(id) ?? []) {
      if (seen.has(child.threadId)) continue;
      seen.add(child.threadId);
      out.push(child.threadId);
      stack.push(child.threadId);
    }
  }
  return out;
}

function fakeRegistry(): AttachmentRegistry {
  return {
    listSubtreeAttachments: (threadId: string) =>
      collectIds(threadId).flatMap((id) => rowsByThread.get(id) ?? []),
    listAllAttachments: () => allRows().filter((row) => !forgotten.includes(row.id)),
    getAttachment: (id: string) => allRows().find((row) => row.id === id) ?? null,
    registerAttachment: (row: StoredAttachment) => {
      const list = rowsByThread.get(row.threadId) ?? [];
      list.push(row);
      rowsByThread.set(row.threadId, list);
      return true;
    },
    forgetAttachment: (id: string) => {
      forgotten.push(id);
    },
  };
}

let tmp: string;

afterEach(() => {
  rowsByThread.clear();
  childrenByParent.clear();
  forgotten.length = 0;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function row(threadId: string, id: string, relPath: string): StoredAttachment {
  return {
    id,
    threadId,
    type: "file",
    name: relPath,
    mimeType: "text/plain",
    sizeBytes: 4,
    relPath,
    createdAt: 1,
  };
}

function seedFile(storeDir: string, relPath: string): string {
  const abs = path.join(storeDir, "attachments", relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, "data");
  return abs;
}

describe("AttachmentStore.deleteThreadFiles", () => {
  test("unlinks spawned children's files, not just the parent thread's", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "kone-att-"));
    setUserDataDir(tmp);
    const store = new AttachmentStore(tmp, fakeRegistry());

    const parentFile = seedFile(tmp, "att_parent.txt");
    const childFile = seedFile(tmp, "att_child.txt");
    const grandchildFile = seedFile(tmp, "att_grand.txt");

    rowsByThread.set("parent-1", [row("parent-1", "att_parent", "att_parent.txt")]);
    rowsByThread.set("child-1", [row("child-1", "att_child", "att_child.txt")]);
    rowsByThread.set("grand-1", [row("grand-1", "att_grand", "att_grand.txt")]);
    childrenByParent.set("parent-1", [{ threadId: "child-1" }]);
    childrenByParent.set("child-1", [{ threadId: "grand-1" }]);

    await store.deleteThreadFiles("parent-1");

    expect(existsSync(parentFile)).toBe(false);
    expect(existsSync(childFile)).toBe(false);
    expect(existsSync(grandchildFile)).toBe(false);
  });

  test("a thread with no children leaves a sibling thread's file alone", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "kone-att-"));
    setUserDataDir(tmp);
    const store = new AttachmentStore(tmp, fakeRegistry());

    const parentFile = seedFile(tmp, "att_parent.txt");
    const siblingFile = seedFile(tmp, "att_sibling.txt");

    rowsByThread.set("parent-1", [row("parent-1", "att_parent", "att_parent.txt")]);
    rowsByThread.set("sibling-1", [row("sibling-1", "att_sibling", "att_sibling.txt")]);

    await store.deleteThreadFiles("parent-1");

    expect(existsSync(parentFile)).toBe(false);
    expect(existsSync(siblingFile)).toBe(true);
  });

  test("a thread with no attachment rows is a no-op", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "kone-att-"));
    setUserDataDir(tmp);
    const store = new AttachmentStore(tmp, fakeRegistry());

    await expect(store.deleteThreadFiles("ghost-1")).resolves.toBeUndefined();
  });

  test("when unlink fails, the registry row is forgotten", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "kone-att-"));
    setUserDataDir(tmp);
    const store = new AttachmentStore(tmp, fakeRegistry());

    // unlink on a directory fails on POSIX, which is how we force a failed
    // unlink without fighting the retry loop.
    mkdirSync(path.join(tmp, "attachments", "att_dir"), { recursive: true });
    rowsByThread.set("parent-1", [row("parent-1", "att_dir_row", "att_dir")]);

    await store.deleteThreadFiles("parent-1");

    expect(forgotten).toContain("att_dir_row");
  });

  test("a relPath that escapes the attachments dir is never unlinked", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "kone-att-"));
    setUserDataDir(tmp);
    const store = new AttachmentStore(tmp, fakeRegistry());

    const escapeFile = path.join(tmp, "escape.txt");
    writeFileSync(escapeFile, "outside");

    rowsByThread.set("parent-1", [row("parent-1", "att_escape", "../escape.txt")]);

    await store.deleteThreadFiles("parent-1");

    expect(existsSync(escapeFile)).toBe(true);
  });
});

describe("AttachmentStore.save", () => {
  test("a file uploaded before its thread has a row still resolves, and registers once it does", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "kone-att-"));
    const threads = new Set<string>();
    const registry = fakeRegistry();
    const store = new AttachmentStore(tmp, {
      ...registry,
      registerAttachment: (r) => threads.has(r.threadId) && registry.registerAttachment(r),
    });

    const saved = await store.save({
      threadId: "new-thread",
      name: "shot.png",
      mimeType: "image/png",
      data: Buffer.from("png").toString("base64"),
    });
    expect(registry.getAttachment(saved.id)).toBeNull();

    threads.add("new-thread");
    const abs = store.resolveAbsPath(saved.id);
    expect(abs).not.toBeNull();
    expect(existsSync(abs!)).toBe(true);
    expect(registry.getAttachment(saved.id)?.threadId).toBe("new-thread");
  });

  test("a held-back file is not swept as an orphan", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "kone-att-"));
    const store = new AttachmentStore(tmp, { ...fakeRegistry(), registerAttachment: () => false });

    const saved = await store.save({
      threadId: "new-thread",
      name: "shot.png",
      mimeType: "image/png",
      data: Buffer.from("png").toString("base64"),
    });
    await store.sweepOrphans();

    expect(existsSync(store.resolveAbsPath(saved.id)!)).toBe(true);
  });

  test("deleting a thread removes its held-back files too", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "kone-att-"));
    const store = new AttachmentStore(tmp, { ...fakeRegistry(), registerAttachment: () => false });

    const saved = await store.save({
      threadId: "new-thread",
      name: "shot.png",
      mimeType: "image/png",
      data: Buffer.from("png").toString("base64"),
    });
    const abs = store.resolveAbsPath(saved.id)!;
    await store.deleteThreadFiles("new-thread");

    expect(existsSync(abs)).toBe(false);
    expect(store.resolveAbsPath(saved.id)).toBeNull();
  });
});
