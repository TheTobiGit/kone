import { describe, expect, it } from "bun:test";
import type { StoredBlock } from "../types.js";
import { buildSemanticBranchSummary, extractBlockOperations } from "./branchSummarization.js";
import { estimateBlockTokens, estimateContextTokens, findCutPoint } from "./cutPoint.js";

describe("compaction cutPoint", () => {
  it("estimates tokens across user and assistant blocks accurately", () => {
    const userBlock: StoredBlock = {
      id: "u1",
      role: "user",
      text: "Help me refactor the database layer to use SQLite.",
      at: 1000,
    };

    const assistantBlock: StoredBlock = {
      id: "a1",
      role: "assistant",
      turnId: "t1",
      state: "completed",
      at: 1100,
      items: [
        {
          itemId: "i1",
          kind: "tool_call",
          status: "completed",
          name: "read",
          text: "src/db.ts",
          detail: "export function getDb() { return null; }",
        },
        {
          itemId: "i2",
          kind: "assistant_text",
          status: "completed",
          text: "I read the db file and will migrate it to SQLite.",
        },
      ],
    };

    const userTokens = estimateBlockTokens(userBlock);
    const assistantTokens = estimateBlockTokens(assistantBlock);

    expect(userTokens).toBeGreaterThan(0);
    expect(assistantTokens).toBeGreaterThan(userTokens);

    const estimate = estimateContextTokens([userBlock, assistantBlock]);
    expect(estimate.tokens).toBe(userTokens + assistantTokens);
    expect(estimate.toolItemCount).toBe(1);
    expect(estimate.characters).toBeGreaterThan(0);
  });

  it("finds cut point while snapping strictly to user turn boundaries", () => {
    const blocks: StoredBlock[] = [
      { id: "u1", role: "user", text: "Task 1: Setup project structure and package.json", at: 1000 },
      {
        id: "a1",
        role: "assistant",
        turnId: "t1",
        state: "completed",
        at: 1100,
        items: [{ itemId: "i1", kind: "assistant_text", status: "completed", text: "Structure created successfully." }],
      },
      { id: "u2", role: "user", text: "Task 2: Implement authentication endpoints in auth.ts", at: 2000 },
      {
        id: "a2",
        role: "assistant",
        turnId: "t2",
        state: "completed",
        at: 2100,
        items: [{ itemId: "i2", kind: "assistant_text", status: "completed", text: "Auth endpoints are implemented." }],
      },
      { id: "u3", role: "user", text: "Task 3: Add automated test suite for endpoints", at: 3000 },
      {
        id: "a3",
        role: "assistant",
        turnId: "t3",
        state: "completed",
        at: 3100,
        items: [{ itemId: "i3", kind: "assistant_text", status: "completed", text: "Tests added and passing." }],
      },
    ];

    // Request keeping only the most recent tokens (~15 tokens)
    const result = findCutPoint(blocks, 15);

    // The cut point should snap to a user turn (e.g. index 4 which is u3)
    expect(result.cutIndex).toBe(4);
    expect(blocks[result.cutIndex].role).toBe("user");
    expect(result.preservedTokens).toBeGreaterThan(0);
    expect(result.compactedTokens).toBeGreaterThan(0);
  });
});

describe("branchSummarization", () => {
  it("extracts touched files, executed commands, and key points from blocks", () => {
    const blocks: StoredBlock[] = [
      { id: "u1", role: "user", text: "Migrate database schema", at: 1000 },
      {
        id: "a1",
        role: "assistant",
        turnId: "t1",
        state: "completed",
        at: 1100,
        items: [
          {
            itemId: "i1",
            kind: "tool_call",
            status: "completed",
            name: "read",
            text: "src/schema.prisma",
          },
          {
            itemId: "i2",
            kind: "tool_call",
            status: "completed",
            name: "edit",
            text: "src/schema.prisma",
          },
          {
            itemId: "i3",
            kind: "tool_call",
            status: "completed",
            name: "bash",
            text: "npx prisma migrate dev --name init",
          },
          {
            itemId: "i4",
            kind: "assistant_text",
            status: "completed",
            text: "- Completed database migration successfully\n- Applied indexes to user table",
          },
        ],
      },
    ];

    const ops = extractBlockOperations(blocks);
    expect(ops.filesRead).toContain("src/schema.prisma");
    expect(ops.filesModified).toContain("src/schema.prisma");
    expect(ops.commandsRun).toContain("npx prisma migrate dev --name init");
    expect(ops.keyPoints.length).toBeGreaterThan(0);

    const branchSummary = buildSemanticBranchSummary(blocks, {
      title: "Prisma Database Setup",
      branch: "feature/db-migration",
    });

    expect(branchSummary.summary).toContain("## Previous Conversation Context Summary");
    expect(branchSummary.summary).toContain("Prisma Database Setup");
    expect(branchSummary.summary).toContain("feature/db-migration");
    expect(branchSummary.summary).toContain("`src/schema.prisma`");
    expect(branchSummary.summary).toContain("`npx prisma migrate dev --name init`");
    expect(branchSummary.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("compaction edge cases", () => {
  it("handles empty block lists without throwing", () => {
    const emptyEstimate = estimateContextTokens([]);
    expect(emptyEstimate).toEqual({ tokens: 0, characters: 0, toolItemCount: 0 });

    const cut = findCutPoint([], 20_000);
    expect(cut).toEqual({ cutIndex: 0, preservedTokens: 0, compactedTokens: 0 });

    const ops = extractBlockOperations([]);
    expect(ops).toEqual({
      filesRead: [],
      filesModified: [],
      commandsRun: [],
      keyPoints: [],
    });

    const summary = buildSemanticBranchSummary([]);
    expect(summary.summary).toContain("## Previous Conversation Context Summary");
    expect(summary.operations.keyPoints).toEqual([]);
    expect(summary.estimatedTokens).toBeGreaterThan(0);
  });

  it("preserves short conversations instead of cutting them", () => {
    const blocks: StoredBlock[] = [
      { id: "u1", role: "user", text: "Hi", at: 1 },
      {
        id: "a1",
        role: "assistant",
        turnId: "t1",
        state: "completed",
        at: 2,
        items: [{ itemId: "i1", kind: "assistant_text", status: "completed", text: "Hello" }],
      },
    ];
    const cut = findCutPoint(blocks, 1);
    expect(cut.cutIndex).toBe(0);
    expect(cut.compactedTokens).toBe(0);
    expect(cut.preservedTokens).toBeGreaterThan(0);
  });
});
