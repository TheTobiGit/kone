import { describe, expect, test } from "bun:test";

import { toolActivityLabel } from "../app/lib/tool-labels";
import type { ToolActivity } from "../app/types/conversation";

function activity(overrides: Partial<ToolActivity>): ToolActivity {
  return {
    id: "1",
    name: "Tool",
    status: "completed",
    paths: [],
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("toolActivityLabel", () => {
  test("read: labels with the file basename", () => {
    expect(
      toolActivityLabel(
        activity({
          name: "Read",
          kind: "read",
          paths: ["apps/web/app/lib/model-catalog.ts"],
        }),
      ),
    ).toBe("Read model-catalog.ts");
  });

  test("write: labels as Edited by default", () => {
    expect(
      toolActivityLabel(
        activity({
          name: "Edit",
          kind: "write",
          paths: ["apps/web/app/pages/index.vue"],
        }),
      ),
    ).toBe("Edited index.vue");
  });

  test("write: labels as Created when the name implies creation", () => {
    expect(
      toolActivityLabel(
        activity({
          name: "Write",
          kind: "write",
          paths: ["apps/web/app/lib/new-file.ts"],
        }),
      ),
    ).toBe("Created new-file.ts");
  });

  test("write: labels as Created when the input summary implies creation", () => {
    expect(
      toolActivityLabel(
        activity({
          name: "Apply",
          kind: "write",
          inputSummary: "create a new file",
          paths: ["apps/web/app/lib/config.ts"],
        }),
      ),
    ).toBe("Created config.ts");
  });

  test("search: quotes and truncates the pattern", () => {
    expect(
      toolActivityLabel(
        activity({
          name: "Grep",
          kind: "search",
          inputSummary: "useDroidBridge",
        }),
      ),
    ).toBe('Searched "useDroidBridge"');

    const longPattern = "a".repeat(60);
    const label = toolActivityLabel(
      activity({ name: "Grep", kind: "search", inputSummary: longPattern }),
    );
    expect(label.startsWith('Searched "')).toBe(true);
    expect(label.length).toBeLessThanOrEqual('Searched "'.length + 40 + 1);
    expect(label).toContain("…");
  });

  test("execute: labels with the command, truncated", () => {
    expect(
      toolActivityLabel(
        activity({
          name: "Bash",
          kind: "execute",
          command: "bun run check-types",
        }),
      ),
    ).toBe("Ran bun run check-types");

    const longCommand = `bun run ${"x".repeat(60)}`;
    const label = toolActivityLabel(
      activity({ name: "Bash", kind: "execute", command: longCommand }),
    );
    expect(label.startsWith("Ran ")).toBe(true);
    expect(label.length).toBeLessThanOrEqual("Ran ".length + 48);
    expect(label).toContain("…");
  });

  test("execute: falls back to inputSummary when command is missing", () => {
    expect(
      toolActivityLabel(
        activity({ name: "Bash", kind: "execute", inputSummary: "ls -la" }),
      ),
    ).toBe("Ran ls -la");
  });

  test("network: labels with the URL hostname", () => {
    expect(
      toolActivityLabel(
        activity({
          name: "Fetch",
          kind: "network",
          inputSummary: "https://nxui.geoql.in/docs?tab=1",
        }),
      ),
    ).toBe("Fetched nxui.geoql.in");
  });

  test("network: falls back to the raw text when the URL cannot be parsed", () => {
    expect(
      toolActivityLabel(
        activity({ name: "Fetch", kind: "network", inputSummary: "not-a-url" }),
      ),
    ).toBe("Fetched not-a-url");
  });

  test("mcp: falls back to the raw name", () => {
    expect(
      toolActivityLabel(
        activity({ name: "notion.search", kind: "mcp", inputSummary: "query" }),
      ),
    ).toBe("notion.search");
  });

  test("unknown kind falls back to the raw name", () => {
    expect(toolActivityLabel(activity({ name: "CustomTool" }))).toBe(
      "CustomTool",
    );
  });

  test("falls back to 'Tool' when nothing usable is present", () => {
    expect(toolActivityLabel(activity({ name: "" }))).toBe("Tool");
  });

  test("read: falls back to the raw name when no path is present", () => {
    expect(
      toolActivityLabel(activity({ name: "Read", kind: "read", paths: [] })),
    ).toBe("Read");
  });
});
