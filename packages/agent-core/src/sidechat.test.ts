import { describe, expect, mock, test } from "bun:test";

import { setUserDataDir } from "./userDataDir.js";

// sidechat.ts imports the store, which imports node:sqlite (an Electron-runtime
// built-in this bun can't load) — stub it, then import the module under test
// dynamically so the stub is in place first. The pure functions under test
// never touch the database.
mock.module("./sqlite.js", () => ({
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
  buildForkReplayContext,
  handInFraming,
  replayForTurn,
  SIDECHAT_BOUNDARY_INSTRUCTION,
  SIDECHAT_SEND_TURN_MAX_INPUT_CHARS,
} = await import("./sidechat.js");
const { HANDOFF_HISTORY_NOTE } = await import("./contextBudget.js");

import type { StoredBlock, StoredThread } from "./types.js";

// buildForkReplayContext + assembleSidechatPreamble are pure — the store
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

function nativeToolOnly(text: string, name: string, at: number): StoredBlock {
  return {
    id: `nt-${at}`,
    role: "assistant",
    turnId: `ntt-${at}`,
    items: [{ itemId: `nt-${at}-tool`, kind: "tool_call", status: "completed", name, text }],
    state: "completed",
    at,
    endedAt: at,
  };
}

function nativeEmpty(at: number): StoredBlock {
  return {
    id: `ne-${at}`,
    role: "assistant",
    turnId: `net-${at}`,
    items: [],
    state: "completed",
    at,
    endedAt: at,
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

const replay = (blocks: StoredBlock[], budgetTokens = 10_000, title = "A prior conversation") =>
  buildForkReplayContext(thread(blocks, title), {
    budgetTokens,
    intro: "This sidechat was cloned from an earlier conversation.",
  });

describe("buildForkReplayContext", () => {
  test("nothing to replay when there are no imported blocks", () => {
    expect(replay([nativeBlock(1)])).toBeNull();
    expect(replay([])).toBeNull();
  });

  test("frames the import as reference context with the source title", () => {
    const result = replay([
      importedUser("Why did the build fail?", 1),
      importedAssistant("The test env was missing.", 2),
    ]);
    expect(result).not.toBeNull();
    const context = result!.context;
    expect(context).toContain("This sidechat was cloned from an earlier conversation.");
    expect(context).toContain("Original conversation title: A prior conversation");
    expect(context).toContain("User:\nWhy did the build fail?");
    expect(context).toContain("Assistant:\nThe test env was missing.");
    expect(context).toContain(HANDOFF_HISTORY_NOTE);
  });

  test("keeps messages whole — never a mid-message cut", () => {
    const long = "x".repeat(50_000);
    const result = replay([importedUser(long, 1)], 20_000);
    expect(result).not.toBeNull();
    // The 50k-char message is ~12.5k tokens, which fits a 20k budget, so it is
    // kept entire — no truncation marker anywhere.
    expect(result!.context).toContain(long);
    expect(result!.context).not.toContain("...[truncated]");
  });

  test("omits a message too big for the budget whole, and says how to read it", () => {
    const long = "x".repeat(200_000);
    const result = replay([importedUser(long, 1), importedUser("small question", 2)], 500);
    expect(result).not.toBeNull();
    expect(result!.context).toContain("small question");
    expect(result!.context).not.toContain(long);
    expect(result!.omittedBlockIds).toEqual(["iu-1"]);
    expect(result!.context).toContain("omitted 1");
    expect(result!.context).toContain('app_read_thread({ threadId: "side-chat-1"');
  });

  test("honours the budget", () => {
    const blocks: StoredBlock[] = [];
    for (let i = 1; i <= 60; i++) {
      blocks.push(importedUser(`question ${i} `.repeat(200), i * 2 - 1));
      blocks.push(importedAssistant(`answer ${i} `.repeat(200), i * 2));
    }
    const result = replay(blocks, 2_000);
    expect(result).not.toBeNull();
    // The whole rendered context is bounded by the budget (chars ≈ tokens*4)
    // plus the framing wrapper.
    expect(result!.context.length).toBeLessThanOrEqual(2_000 * 4 + 2_000);
    // The newest exchange survives the squeeze.
    expect(result!.context).toContain("question 60");
  });

  test("a tool-only turn replays its commands, whole — not a truncated note", () => {
    const result = buildForkReplayContext(
      thread([
        { id: "u-1", role: "user", text: "migrate the db", at: 1 },
        nativeToolOnly("src/schema.prisma", "Edit", 2),
      ]),
      {
        budgetTokens: 10_000,
        intro: "This sidechat was cloned from an earlier conversation.",
        include: () => true,
      },
    );
    expect(result).not.toBeNull();
    expect(result!.context).toContain("User:\nmigrate the db");
    expect(result!.context).toContain("[Tool] Edit: src/schema.prisma");
    expect(result!.context).not.toContain("[No written summary");
  });

  test("a genuinely empty block is skipped from the replay", () => {
    const result = buildForkReplayContext(
      thread([
        { id: "u-1", role: "user", text: "migrate the db", at: 1 },
        nativeEmpty(2),
      ]),
      {
        budgetTokens: 10_000,
        intro: "This sidechat was cloned from an earlier conversation.",
        include: () => true,
      },
    );
    expect(result).not.toBeNull();
    expect(result!.context).toContain("User:\nmigrate the db");
    expect(result!.context).not.toContain("Assistant:");
  });

  test("defaults to fork-imported rows only", () => {
    const result = replay([nativeBlock(1), importedUser("imported prompt", 2)]);
    expect(result).not.toBeNull();
    expect(result!.context).toContain("imported prompt");
    expect(result!.context).not.toContain("native prompt");
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
    const context = "c".repeat(SIDECHAT_SEND_TURN_MAX_INPUT_CHARS - 2_000);
    const preamble = assembleSidechatPreamble(context, "short");
    expect(preamble.length).toBeLessThan(SIDECHAT_SEND_TURN_MAX_INPUT_CHARS);
  });
});

describe("replayForTurn mandatory framing", () => {
  // One message too large for any history budget, so every replay below is a
  // zero-history replay and its rendered size is exactly framing + prompt.
  const oversized = thread([importedAssistant("x".repeat(400_000))], "Exact fit");
  const render = (input: string, windowTokens: number) =>
    replayForTurn(oversized, input, handInFraming, { windowTokens, tokenCap: 1_024 });
  const framingChars = render("", 1_000_000)!.preamble.length;
  const framingTokens = Math.ceil(framingChars / 4);

  test("an exact transport fit with zero history is accepted, one token more is refused", () => {
    const transportTokens = Math.floor(SIDECHAT_SEND_TURN_MAX_INPUT_CHARS / 4);
    const prompt = "p".repeat((transportTokens - framingTokens) * 4);
    const fitted = render(prompt, 1_000_000);
    expect(fitted?.omittedBlockIds).toEqual(["ia-2"]);
    expect(fitted!.preamble.length).toBe(framingChars + prompt.length);
    expect(() => render(`${prompt}p`, 1_000_000)).toThrow(handInFraming.tooLong);
  });

  test("an exact window fit with zero history is accepted, one token more is refused", () => {
    // An 8k window keeps half as headroom, leaving 4k tokens.
    const prompt = "p".repeat((4_000 - framingTokens) * 4);
    expect(render(prompt, 8_000)?.preamble.length).toBe(framingChars + prompt.length);
    expect(() => render(`${prompt}p`, 8_000)).toThrow(handInFraming.tooLong);
  });
});
