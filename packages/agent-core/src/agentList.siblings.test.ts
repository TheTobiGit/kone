import { beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import { createRegistry } from "./gateway/registry.js";
import { createIrcTools, IrcMailbox } from "./gateway/tools/irc.js";

// ConversationStore imports node:sqlite, which bun can't load: stand it in
// with bun:sqlite and import the store only once the stub is in place.
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

let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

beforeAll(async () => {
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
});

const PROJECT = "/repo";

// Two delegates of one agent are peers: each may message the other, so each
// sees the other on its roster — from the store, before either has sent mail.
test("a delegate's roster lists its sibling delegate, read from the store", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-agent-list-siblings-"));
  setUserDataDir(dir);
  const store = new ConversationStoreCtor(dir);
  store.ensureThread({ threadId: "lead", projectPath: PROJECT, provider: "claudeAgent" });
  store.recordUserBlock({ threadId: "lead", text: "Build delivery." });
  for (const id of ["backend", "frontend"]) {
    store.writeSpawnedThread({
      threadId: id,
      projectPath: PROJECT,
      provider: "claudeAgent",
      createdAt: Date.now(),
      title: id,
      lineage: { parentThreadId: "lead", relationshipToParent: "delegation", rootThreadId: "lead" },
    });
    store.recordUserBlock({
      threadId: id,
      text: "Your part.",
      sender: { kind: "agent", threadId: "lead", name: "Lead", relationship: "delegator", messageKind: "followup" },
    });
  }

  const mailbox = new IrcMailbox();
  const registry = createRegistry(createIrcTools({ store, mailbox }));
  const ctx = { threadId: "backend", turnId: "turn-1", provider: "claudeAgent" as const, cwd: PROJECT, requestId: 1 };

  const listed = await registry.call(ctx, "agent_list", {});
  const peers = listed.structuredContent?.peers;
  // SAFETY: agent_list returns its rows as `peers`.
  const rows = (Array.isArray(peers) ? peers : []) as Array<{ id: string; relationship: string }>;
  expect(rows.find((r) => r.id === "frontend")?.relationship).toBe("peer");
  // Each row says how that agent relates to the reader.
  expect(rows.find((r) => r.id === "lead")?.relationship).toBe("delegator");
  expect(listed.content[0]!.text).toContain("`lead` (your delegator");
  expect(listed.content[0]!.text).toContain("`frontend` (teammate");

  const sent = await registry.call(ctx, "agent_message", { to: "frontend", message: "The IPC is in." });
  expect(sent.isError ?? false).toBe(false);
  expect(mailbox.getInbox("frontend", { peek: true }).messages).toHaveLength(1);
});
