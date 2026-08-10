import { describe, expect, mock, test } from "bun:test";

import { setUserDataDir } from "./userDataDir.js";

// sidechat.ts imports the store, which imports node:sqlite (an Electron-runtime
// built-in this bun can't load) — stub it, then import the module under test
// dynamically so the stub is in place first. The pure functions under test
// never touch the database.
mock.module("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {
    exec(): void {}
    prepare(): never {
      throw new Error("not implemented");
    }
  },
}));
setUserDataDir("/tmp");

const {
  assembleSidechatPreamble,
  buildSidechatForkContext,
  SIDECHAT_BOUNDARY_INSTRUCTION,
  SIDECHAT_SEND_TURN_MAX_INPUT_CHARS,
  SIDECHAT_TRANSCRIPT_CHAR_BUDGET,
} = await import("./sidechat.js");

import type { StoredBlock, StoredThread } from "./types.js";

// buildSidechatForkContext + assembleSidechatPreamble are pure — the store
// (createSidechatThread, sidechatBootstrapForTurn) needs Electron's sqlite and
// is exercised through the app like the rest of ConversationStore.

function importedUser(text: string, at = 1): StoredBlock {
  return { id: `iu-${at}`, role: "user", text, at, source: "fork-import" };
}

function importedAssistant(text: string, at = 2): StoredBlock {
  return {
    id: `ia-${at}`,
    role: "assistant",
    turnId: `it-${at}`,
    items: [{ itemId: `ia-${at}:narrative`, kind: "assistant_text", status: "completed", text }],
    state: "completed",
    at,
    endedAt: at,
    source: "fork-import",
  };
}

function nativeBlock(at: number): StoredBlock {
  return { id: `n-${at}`, role: "user", text: "native prompt", at };
}

function thread(blocks: StoredBlock[], title = "A prior conversation"): StoredThread {
  return {
    threadId: "side-chat-1",
    projectPath: "/tmp/proj",
    provider: "opencode",
    createdAt: 1,
    updatedAt: 1,
    title,
    blocks,
  };
}

describe("buildSidechatForkContext", () => {
  test("nothing to replay when there are no imported blocks", () => {
    expect(buildSidechatForkContext(thread([nativeBlock(1)]))).toBeNull();
    expect(buildSidechatForkContext(thread([]))).toBeNull();
  });

  test("frames the import as reference context with the source title", () => {
    const context = buildSidechatForkContext(
      thread(
        [importedUser("Why did the build fail?", 1), importedAssistant("The test env was missing.", 2)],
        "Fix the build",
      ),
    );
    expect(context).toContain("This sidechat was cloned from an earlier conversation.");
    expect(context).toContain("Original conversation title: Fix the build");
    expect(context).toContain("User:\nWhy did the build fail?");
    expect(context).toContain("Assistant:\nThe test env was missing.");
    // A short import has no earlier-summary section and no omitted count.
    expect(context).not.toContain("Earlier conversation summary");
  });

  test("keeps the last 6 verbatim and folds older ones into summaries", () => {
    const blocks: StoredBlock[] = [];
    for (let i = 1; i <= 10; i++) {
      blocks.push(importedUser(`question ${i}`, i * 2 - 1), importedAssistant(`answer ${i}`, i * 2));
    }
    const context = buildSidechatForkContext(thread(blocks));
    expect(context).toContain("Most recent imported messages:");
    // The newest exchange is verbatim…
    expect(context).toContain("User:\nquestion 10");
    expect(context).toContain("Assistant:\nanswer 10");
    // …and the first exchange is only a summary line.
    expect(context).toContain("- User: question 1");
    expect(context).toContain("omitted to fit the context budget");
  });

  test("truncates an over-long recent message to the 2400-char cap", () => {
    const long = "x".repeat(5_000);
    const context = buildSidechatForkContext(thread([importedUser(long, 1)]));
    expect(context).toContain("User:");
    // 2400 cap minus the "..." tail — nothing longer survives.
    const line = context?.split("\n").find((l) => l.includes("x".repeat(100))) ?? "";
    expect(line.length).toBeLessThanOrEqual(2_403);
  });

  test("respects the 32k transcript ceiling", () => {
    const blocks: StoredBlock[] = [];
    for (let i = 1; i <= 60; i++) {
      blocks.push(importedUser(`question ${i} `.repeat(200), i * 2 - 1));
      blocks.push(importedAssistant(`answer ${i} `.repeat(200), i * 2));
    }
    const context = buildSidechatForkContext(thread(blocks));
    expect(context && context.length).toBeLessThanOrEqual(SIDECHAT_TRANSCRIPT_CHAR_BUDGET);
  });

  test("a custom maxChars smaller than the ceiling is honoured", () => {
    const blocks = [importedUser("a".repeat(2_000), 1), importedAssistant("b".repeat(2_000), 2)];
    const context = buildSidechatForkContext(thread(blocks), 500);
    expect(context && context.length).toBeLessThanOrEqual(500);
  });
});

describe("assembleSidechatPreamble", () => {
  test("wraps context, boundary and the user's message in order", () => {
    const preamble = assembleSidechatPreamble("imported history", "my side question");
    expect(preamble).toBe(
      `<sidechat_context>\nimported history\n</sidechat_context>\n\n` +
        `<sidechat_boundary>\n${SIDECHAT_BOUNDARY_INSTRUCTION}\n</sidechat_boundary>\n` +
        `<latest_user_message>\nmy side question\n</latest_user_message>`,
    );
  });

  test("the boundary instruction is the verbatim battle-tested wording", () => {
    expect(SIDECHAT_BOUNDARY_INSTRUCTION).toContain(
      "Treat all prior conversation as reference-only context",
    );
    expect(SIDECHAT_BOUNDARY_INSTRUCTION).not.toContain("Do not continue any prior task automatically\n");
  });

  test("the assembled first turn never exceeds the send cap", () => {
    const context = "c".repeat(SIDECHAT_TRANSCRIPT_CHAR_BUDGET);
    const preamble = assembleSidechatPreamble(context, "short");
    expect(preamble.length).toBeLessThan(SIDECHAT_SEND_TURN_MAX_INPUT_CHARS);
  });
});
