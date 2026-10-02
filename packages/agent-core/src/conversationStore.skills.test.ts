import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import { parseSkillReferences, serializeSkillReferences } from "./conversationStoreTypes.js";
import type { SkillReference } from "./types.js";

// ConversationStore imports node:sqlite, which bun can't load: stand it in
// with bun:sqlite and import the store only once the stub is in place.
let testUserDataDir = "";

class DatabaseSyncShim {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly ? new Database(filePath, { readonly: true }) : new Database(filePath);
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

type ConversationStoreType = import("./ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

function freshStore(): ConversationStoreType {
  testUserDataDir = mkdtempSync(path.join(tmpdir(), "kone-skills-store-test-"));
  setUserDataDir(testUserDataDir);
  return new ConversationStoreCtor();
}

function rawDb(): Database {
  return new Database(path.join(testUserDataDir, "kone.sqlite"));
}

beforeAll(async () => {
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
});

const ANIMATE: SkillReference = { name: "animate-text", path: "/home/u/.claude/skills/animate-text/SKILL.md" };
const TYPO: SkillReference = { name: "better-typography", path: "/repo/.claude/skills/better-typography/SKILL.md" };

function userSkills(store: ConversationStoreType, threadId: string): Array<SkillReference[] | undefined> {
  const loaded = store.loadThread(threadId);
  expect(loaded).not.toBeNull();
  return loaded!.blocks.flatMap((b) => (b.role === "user" ? [b.skills] : []));
}

describe("invoked skills on user blocks", () => {
  test("skills journaled on a prompt rehydrate on reload, in order", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-s", projectPath: "/repo", provider: "claudeAgent" });
    store.recordUserBlock({ threadId: "t-s", text: "polish the heading", at: 100, skills: [ANIMATE, TYPO] });

    const reopened = new ConversationStoreCtor();
    expect(userSkills(reopened, "t-s")).toEqual([[ANIMATE, TYPO]]);
  });

  test("a skill-only prompt with empty text keeps its skills", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-s", projectPath: "/repo", provider: "codex" });
    store.recordUserBlock({ threadId: "t-s", text: "", at: 100, skills: [ANIMATE] });

    const loaded = store.loadThread("t-s");
    const user = loaded!.blocks.find((b) => b.role === "user");
    expect(user?.role === "user" ? user.text : null).toBe("");
    expect(userSkills(store, "t-s")).toEqual([[ANIMATE]]);
  });

  test("a prompt without skills stores NULL and reads back without the field", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-s", projectPath: "/repo", provider: "claudeAgent" });
    store.recordUserBlock({ threadId: "t-s", text: "plain", at: 100 });
    store.recordUserBlock({ threadId: "t-s", text: "empty list", at: 200, skills: [] });

    expect(userSkills(store, "t-s")).toEqual([undefined, undefined]);
    const db = rawDb();
    // SAFETY: the projection names exactly one nullable TEXT column.
    const rows = db.prepare("SELECT skills_json FROM blocks WHERE role = 'user'").all() as Array<{ skills_json: string | null }>;
    db.close();
    expect(rows.map((r) => r.skills_json)).toEqual([null, null]);
  });
});

describe("invoked skills on queued turns", () => {
  test("a queued turn carries its skills through list and claim", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-q", projectPath: "/repo", provider: "claudeAgent" });
    store.enqueueQueuedTurn({ threadId: "t-q", queueId: "q-1", userBlockId: "ub-1", input: "", skills: [TYPO], at: 100 });
    store.enqueueQueuedTurn({ threadId: "t-q", queueId: "q-2", userBlockId: "ub-2", input: "no skills", at: 200 });

    const listed = new ConversationStoreCtor().listQueuedTurns("t-q");
    expect(listed.map((r) => r.skills)).toEqual([[TYPO], undefined]);

    const claimed = store.claimNextQueuedTurn("t-q");
    expect(claimed?.queueId).toBe("q-1");
    expect(claimed?.skills).toEqual([TYPO]);
  });
});

describe("skill reference column codec", () => {
  test("round-trips and keeps only name and path", () => {
    const withExtra = [{ ...ANIMATE, description: "dropped" }];
    expect(parseSkillReferences(serializeSkillReferences(withExtra))).toEqual([ANIMATE]);
  });

  test("bad or deviant JSON reads as no skills", () => {
    for (const json of [
      null,
      undefined,
      "",
      "not json",
      "{}",
      "[]",
      '[{"name":""}]',
      '[{"name":"","path":"x"}]',
      '[{"name":"x","path":""}]',
      '[{"name":"x","path":1}]',
    ]) {
      expect(parseSkillReferences(json)).toBeUndefined();
    }
  });
});
