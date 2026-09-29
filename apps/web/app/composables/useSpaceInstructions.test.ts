import { describe, expect, test } from "bun:test";
import { nextTick, ref } from "vue";
import { createDevBridge } from "~/lib/devBridge";
import { installDevBridge } from "~/utils/desktopBridge";
import { useSpaceInstructions } from "./useSpaceInstructions";

describe("useSpaceInstructions", () => {
  test("detects AGENTS.md and CLAUDE.md when present", async () => {
    const files: Record<string, string> = {
      "AGENTS.md": "# AGENTS.md\n\n## Overview\nTest instructions\n\n## Rules\nBe good\n",
      "CLAUDE.md": "# CLAUDE.md\n\nRun `bun test` to verify\n",
    };

    const mockFs = {
      home: async () => "/home",
      listDir: async () => ({ path: "/", name: "root", parent: null, repo: false, entries: [] }),
      listProjectDir: async () => ({ dir: "", entries: [], truncated: false }),
      readProjectFile: async (_root: string, rel: string) => {
        if (files[rel]) {
          return {
            text: files[rel],
            binary: false,
            truncated: false,
            size: files[rel]!.length,
          };
        }
        throw new Error("File not found");
      },
      writeProjectFile: async (_root: string, rel: string, content: string) => {
        files[rel] = content;
      },
    };

    const bridge = createDevBridge();
    bridge.fs = mockFs;
    installDevBridge(bridge);

    const path = ref("/my-project");
    const visible = ref(true);

    const inst = useSpaceInstructions(path, visible);

    // Initial load happens on watcher tick
    await inst.refresh();
    await nextTick();

    expect(inst.agents.value.detected).toBe(true);
    expect(inst.agents.value.path).toBe("AGENTS.md");
    expect(inst.agents.value.sections.length).toBe(3);
    expect(inst.agents.value.sections[1]?.title).toBe("Overview");

    expect(inst.claude.value.detected).toBe(true);
    expect(inst.claude.value.path).toBe("CLAUDE.md");
    expect(inst.claude.value.commands).toContain("bun test");
  });

  test("flags missing files when not present and allows creation", async () => {
    const files: Record<string, string> = {};

    const mockFs = {
      home: async () => "/home",
      listDir: async () => ({ path: "/", name: "root", parent: null, repo: false, entries: [] }),
      listProjectDir: async () => ({ dir: "", entries: [], truncated: false }),
      readProjectFile: async (_root: string, rel: string) => {
        if (files[rel]) {
          return {
            text: files[rel],
            binary: false,
            truncated: false,
            size: files[rel]!.length,
          };
        }
        throw new Error("File not found");
      },
      writeProjectFile: async (_root: string, rel: string, content: string) => {
        files[rel] = content;
      },
    };

    const bridge = createDevBridge();
    bridge.fs = mockFs;
    installDevBridge(bridge);

    const path = ref("/empty-project");
    const visible = ref(true);

    const inst = useSpaceInstructions(path, visible);

    await inst.refresh();
    await nextTick();

    expect(inst.agents.value.detected).toBe(false);
    expect(inst.claude.value.detected).toBe(false);

    // Create AGENTS.md
    await inst.createAgentsMd();
    await nextTick();

    expect(inst.agents.value.detected).toBe(true);
    expect(inst.agents.value.path).toBe("AGENTS.md");

    // Create CLAUDE.md
    await inst.createClaudeMd();
    await nextTick();

    expect(inst.claude.value.detected).toBe(true);
    expect(inst.claude.value.path).toBe("CLAUDE.md");
  });
});
