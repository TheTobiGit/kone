import { describe, expect, test } from "bun:test";
import type { RuntimeItem } from "../types/desktop";
import { toolDetailFull, toolMeta, toolPhrase, toolTargetRaw } from "./toolPresentation";
import { canonicalToolName } from "./toolName";

describe("toolPresentation", () => {
  describe("toolTargetRaw", () => {
    test("strips tool name prefix when present", () => {
      const item: RuntimeItem = {
        itemId: "item-1",
        kind: "tool_call",
        status: "completed",
        name: "view_file",
        text: "view_file: src/foo.ts",
      };
      expect(toolTargetRaw(item)).toBe("src/foo.ts");
    });

    test("returns empty string when text is identical to tool name", () => {
      const item1: RuntimeItem = {
        itemId: "item-1",
        kind: "tool_call",
        status: "completed",
        name: "run_command",
        text: "run_command",
      };
      expect(toolTargetRaw(item1)).toBe("");

      const item2: RuntimeItem = {
        itemId: "item-2",
        kind: "tool_call",
        status: "completed",
        name: "view_file",
        text: "view_file",
      };
      expect(toolTargetRaw(item2)).toBe("");

      const item3: RuntimeItem = {
        itemId: "item-3",
        kind: "tool_call",
        status: "completed",
        name: "manage_task",
        text: "manage task",
      };
      expect(toolTargetRaw(item3)).toBe("");
    });

    test("preserves genuine target arguments", () => {
      const item: RuntimeItem = {
        itemId: "item-1",
        kind: "tool_call",
        status: "completed",
        name: "run_command",
        text: "bun test",
      };
      expect(toolTargetRaw(item)).toBe("bun test");
    });

    test("peels a stamp left over from the name's qualified spelling", () => {
      const item: RuntimeItem = {
        itemId: "item-1",
        kind: "tool_call",
        status: "in-progress",
        name: "kone_spawn_batch",
        text: 'mcp__kone__kone_spawn_batch: {"path": "src/foo.ts"}',
      };
      expect(toolDetailFull(item)).toBe('{"path": "src/foo.ts"}');
    });

    test("suppresses an args blob from the row, keeping it in the full detail", () => {
      const item: RuntimeItem = {
        itemId: "item-1",
        kind: "tool_call",
        status: "in-progress",
        name: "kone_spawn_batch",
        text: 'kone_spawn_batch: {"items": []}',
      };
      expect(toolTargetRaw(item)).toBe("");
      expect(toolDetailFull(item)).toBe('{"items": []}');
    });

    test("peels a kone server stamp from the detail", () => {
      const item: RuntimeItem = {
        itemId: "item-1",
        kind: "tool_call",
        status: "in-progress",
        name: "kone_spawn_batch",
        text: "kone: dispatching 3 workers",
      };
      expect(toolTargetRaw(item)).toBe("dispatching 3 workers");
    });

    test("treats a humanized duplicate of the name as no target", () => {
      const item: RuntimeItem = {
        itemId: "item-1",
        kind: "tool_call",
        status: "in-progress",
        name: "kone_spawn_batch",
        text: "kone spawn batch",
      };
      expect(toolTargetRaw(item)).toBe("");
    });
  });

  describe("canonicalToolName", () => {
    test("unwraps kone server qualification to the bare tool", () => {
      expect(canonicalToolName("kone_spawn_batch")).toBe("kone_spawn_batch");
      expect(canonicalToolName("kone__kone_spawn_batch")).toBe("kone_spawn_batch");
      expect(canonicalToolName("mcp__kone__kone_spawn_batch")).toBe("kone_spawn_batch");
      expect(canonicalToolName("kone_kone_spawn_batch")).toBe("kone_spawn_batch");
      expect(canonicalToolName("  KONE__KONE_SPAWN_BATCH  ")).toBe("kone_spawn_batch");
    });

    test("leaves plain and foreign-MCP names alone", () => {
      expect(canonicalToolName("read_file")).toBe("read_file");
      expect(canonicalToolName("mcp__github__fetch_pr")).toBe("mcp__github__fetch_pr");
      expect(canonicalToolName(undefined)).toBe("");
      expect(canonicalToolName("   ")).toBe("");
    });
  });

  describe("toolPhrase", () => {
    test("formats command execution with command and with fallback", () => {
      const withCmd: RuntimeItem = {
        itemId: "item-1",
        kind: "tool_call",
        status: "completed",
        name: "run_command",
        text: "bun test",
      };
      expect(toolPhrase(withCmd)).toEqual({
        before: "Ran ",
        target: { kind: "mono", text: "bun test" },
        after: undefined,
      });

      const withoutCmd: RuntimeItem = {
        itemId: "item-2",
        kind: "tool_call",
        status: "completed",
        name: "run_command",
        text: "run_command",
      };
      expect(toolPhrase(withoutCmd)).toEqual({
        before: "Ran a command",
      });

      const inProgressWithoutCmd: RuntimeItem = {
        itemId: "item-3",
        kind: "tool_call",
        status: "in-progress",
        name: "run_command",
        text: "",
      };
      expect(toolPhrase(inProgressWithoutCmd)).toEqual({
        before: "Running a command",
      });
    });

    test("formats file operations with paths and fallbacks", () => {
      const readItem: RuntimeItem = {
        itemId: "item-1",
        kind: "tool_call",
        status: "completed",
        name: "view_file",
        text: "/Users/user/kone/src/index.ts",
      };
      expect(toolPhrase(readItem)).toEqual({
        before: "Read ",
        target: { kind: "file", path: "/Users/user/kone/src/index.ts" },
        after: undefined,
      });

      const readFallback: RuntimeItem = {
        itemId: "item-2",
        kind: "tool_call",
        status: "completed",
        name: "view_file",
        text: "view_file",
      };
      expect(toolPhrase(readFallback)).toEqual({
        before: "Read a file",
      });

      const writeItem: RuntimeItem = {
        itemId: "item-3",
        kind: "tool_call",
        status: "completed",
        name: "write_to_file",
        text: "src/new.ts",
      };
      expect(toolPhrase(writeItem)).toEqual({
        before: "Wrote ",
        target: { kind: "file", path: "src/new.ts" },
        after: undefined,
      });

      const editItem: RuntimeItem = {
        itemId: "item-4",
        kind: "tool_call",
        status: "completed",
        name: "replace_file_content",
        text: "src/existing.ts",
      };
      expect(toolPhrase(editItem)).toEqual({
        before: "Edited ",
        target: { kind: "file", path: "src/existing.ts" },
        after: undefined,
      });
    });

    test("formats Antigravity agent tools", () => {
      const manageTask: RuntimeItem = {
        itemId: "item-1",
        kind: "tool_call",
        status: "completed",
        name: "manage_task",
        text: "kill task-19",
      };
      expect(toolPhrase(manageTask)).toEqual({
        before: "Task — kill task-19",
      });

      const scheduleTask: RuntimeItem = {
        itemId: "item-2",
        kind: "tool_call",
        status: "completed",
        name: "schedule",
        text: "Health check",
      };
      expect(toolPhrase(scheduleTask)).toEqual({
        before: "Scheduled Health check",
      });

      const subagentTask: RuntimeItem = {
        itemId: "item-3",
        kind: "tool_call",
        status: "completed",
        name: "invoke_subagent",
        text: "Codebase Researcher",
      };
      expect(toolPhrase(subagentTask)).toEqual({
        before: "Ran subagent — Codebase Researcher",
      });
    });

    test("phrases kone_spawn_batch once, never kone kone", () => {
      const texts = ["", 'kone_spawn_batch: {"items": []}', 'mcp__kone__kone_spawn_batch: []'];
      for (const text of texts) {
        const item: RuntimeItem = {
          itemId: "item-1",
          kind: "tool_call",
          status: "in-progress",
          name: canonicalToolName("mcp__kone__kone_spawn_batch"),
          text,
        };
        expect(toolPhrase(item)).toEqual({ before: "Running kone spawn batch" });
      }
    });

    test("phrases a kone:-stamped spawn batch detail without repeating kone", () => {
      const item: RuntimeItem = {
        itemId: "item-1",
        kind: "tool_call",
        status: "in-progress",
        name: "kone_spawn_batch",
        text: "kone: dispatching 3 workers",
      };
      expect(toolPhrase(item)).toEqual({
        before: "Running kone spawn batch on dispatching 3 workers",
      });
    });
  });

  describe("toolMeta", () => {
    test("recognizes standard and Antigravity tools", () => {
      expect(toolMeta("run_command").label).toBe("Run");
      expect(toolMeta("view_file").label).toBe("Read");
      expect(toolMeta("write_to_file").label).toBe("Write");
      expect(toolMeta("replace_file_content").label).toBe("Edit");
      expect(toolMeta("manage_task").label).toBe("Task");
      expect(toolMeta("schedule").label).toBe("Schedule");
      expect(toolMeta("invoke_subagent").label).toBe("Subagent");
      expect(toolMeta("generate_image").label).toBe("Generate image");
    });

    test("labels a canonical kone tool once, and keeps foreign MCP labels", () => {
      expect(toolMeta(canonicalToolName("kone__kone_spawn_batch")).label).toBe("Kone Spawn Batch");
      expect(toolMeta(canonicalToolName("mcp__kone__kone_spawn_batch")).label).toBe(
        "Kone Spawn Batch",
      );
      expect(toolMeta("mcp__github__fetch_pr").label).toBe("Fetch Pr");
    });
  });
});
