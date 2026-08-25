import { describe, expect, test } from "bun:test";
import type { RuntimeItem } from "../types/desktop";
import {
  toolDetailFull,
  toolMeta,
  toolPhrase,
  toolPhraseParts,
  toolStatus,
  toolTarget,
  toolTargetRaw,
} from "./toolPresentation";

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
  });
});
