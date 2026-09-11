import { describe, expect, test } from "bun:test";
import { AiChipIcon } from "@hugeicons/core-free-icons";
import {
  buildMentionItems,
  createMentionKindResolver,
  dedupeMentionProjects,
  detectFileMentionTrigger,
  detectSlashCommandTrigger,
  detectToken,
  filterSlashCommandItems,
  formatFileMention,
  parseLeadingSlashCommand,
  replaceComposerTextRange,
  slashCommandTitle,
  splitComposerMentionSegments,
} from "./composerMentions";

describe("detectFileMentionTrigger", () => {
  test("finds an active project-file token", () => {
    expect(detectFileMentionTrigger("Inspect @apps/web", "Inspect @apps/web".length)).toEqual({
      query: "apps/web",
      rangeStart: 8,
      rangeEnd: "Inspect @apps/web".length,
    });
  });

  test("does not treat an email address as a file token", () => {
    expect(detectFileMentionTrigger("email me@example.com", "email me@example.com".length)).toBeNull();
  });

  test("supports an empty trigger after whitespace", () => {
    expect(detectFileMentionTrigger("Inspect @", "Inspect @".length)?.query).toBe("");
  });
});

describe("detectSlashCommandTrigger", () => {
  test("finds a leading slash token", () => {
    expect(detectSlashCommandTrigger("/model", "/model".length)).toEqual({
      query: "model",
      rangeStart: 0,
      rangeEnd: "/model".length,
    });
  });

  test("supports a bare slash after whitespace", () => {
    expect(detectSlashCommandTrigger("Review this /", "Review this /".length)?.query).toBe("");
  });

  test("does not treat paths as commands", () => {
    expect(detectSlashCommandTrigger("src/a/b", "src/a/b".length)).toBeNull();
  });

  test("does not treat urls or comment slashes as commands", () => {
    expect(detectSlashCommandTrigger("see https://x.io", "see https://x.io".length)).toBeNull();
    expect(detectSlashCommandTrigger("// comment", "// comment".length)).toBeNull();
  });

  test("ends the token at a space", () => {
    expect(detectSlashCommandTrigger("/model ", "/model ".length)).toBeNull();
  });

  test("finds a leading compact token", () => {
    expect(detectSlashCommandTrigger("/compact", "/compact".length)).toEqual({
      query: "compact",
      rangeStart: 0,
      rangeEnd: "/compact".length,
    });
  });

  test("the trigger ends at the space, so a focus needs the draft parse", () => {
    expect(detectSlashCommandTrigger("/compact Focus on API", "/compact Focus on API".length)).toBeNull();
  });
});

describe("detectToken", () => {
  test("finds an @ token with its marker", () => {
    expect(detectToken("Inspect @apps/web", "Inspect @apps/web".length, ["@", "/"])).toEqual({
      marker: "@",
      query: "apps/web",
      rangeStart: 8,
      rangeEnd: "Inspect @apps/web".length,
    });
  });

  test("finds a / token with its marker", () => {
    expect(detectToken("/model", "/model".length, ["@", "/"])).toEqual({
      marker: "/",
      query: "model",
      rangeStart: 0,
      rangeEnd: "/model".length,
    });
  });

  test("only listens for the requested markers", () => {
    expect(detectToken("/model", "/model".length, ["@"])).toBeNull();
    expect(detectToken("Inspect @a", "Inspect @a".length, ["/"])).toBeNull();
  });

  test("rejects // comments and paths by the shared slash rule", () => {
    expect(detectToken("// comment", "// comment".length, ["/"])).toBeNull();
    expect(detectToken("see https://x.io", "see https://x.io".length, ["/"])).toBeNull();
  });

  test("rejects tokens that do not start after whitespace", () => {
    expect(detectToken("email me@example.com", "email me@example.com".length, ["@"])).toBeNull();
  });
});

describe("slashCommandTitle", () => {
  test("derives the label from the name", () => {
    expect(slashCommandTitle("agent")).toBe("/agent");
  });
});

describe("parseLeadingSlashCommand", () => {
  test("reads a bare compact command with empty focus", () => {
    expect(parseLeadingSlashCommand("/compact")).toEqual({ name: "compact", focus: "" });
  });

  test("reads trailing prose as the compact focus", () => {
    expect(parseLeadingSlashCommand("/compact Focus on API")).toEqual({
      name: "compact",
      focus: "Focus on API",
    });
  });

  test("reads the model command", () => {
    expect(parseLeadingSlashCommand("/model")).toEqual({ name: "model", focus: "" });
  });

  test("reads the agent command", () => {
    expect(parseLeadingSlashCommand("/agent")).toEqual({ name: "agent", focus: "" });
  });

  test("reads the branch command", () => {
    expect(parseLeadingSlashCommand("/branch")).toEqual({ name: "branch", focus: "" });
  });

  test("reads the new command", () => {
    expect(parseLeadingSlashCommand("/new")).toEqual({ name: "new", focus: "" });
  });

  test("reads trailing prose as the new focus", () => {
    expect(parseLeadingSlashCommand("/new Start over")).toEqual({
      name: "new",
      focus: "Start over",
    });
  });

  test("passes unknown names through for the provider", () => {
    expect(parseLeadingSlashCommand("/unknown x")).toEqual({ name: "unknown", focus: "x" });
  });

  test("ignores a slash that does not lead the draft", () => {
    expect(parseLeadingSlashCommand("hello /model")).toBeNull();
  });
});

describe("filterSlashCommandItems", () => {
  const items = [{ name: "model", description: "Open model picker", icon: AiChipIcon }];

  test("offers everything on an empty query", () => {
    expect(filterSlashCommandItems(items, "")).toEqual(items);
  });

  test("prefix-matches case-insensitively", () => {
    expect(filterSlashCommandItems(items, "M")).toEqual(items);
    expect(filterSlashCommandItems(items, "xyz")).toEqual([]);
  });
});
describe("formatFileMention", () => {
  test("keeps simple paths compact", () => {
    expect(formatFileMention("src/App.vue")).toBe("@src/App.vue");
  });

  test("quotes paths containing spaces", () => {
    expect(formatFileMention("docs/My File.md")).toBe('@"docs/My File.md"');
  });
});

test("replaces a trigger and returns the next cursor", () => {
  expect(replaceComposerTextRange("read @src ", 5, 10, "@src/App.vue ")).toEqual({
    text: "read @src/App.vue ",
    cursor: 18,
  });
});

describe("splitComposerMentionSegments", () => {  test("formats completed path tokens while leaving surrounding text intact", () => {
    expect(splitComposerMentionSegments("Read @src/App.vue before editing")).toEqual([
      { type: "text", text: "Read " },
      { type: "mention", path: "src/App.vue", source: "@src/App.vue" },
      { type: "text", text: " before editing" },
    ]);
  });

  test("keeps an incomplete trailing token as text", () => {
    expect(splitComposerMentionSegments("Read @src/App.vue")).toEqual([
      { type: "text", text: "Read @src/App.vue" },
    ]);
  });

  test("decodes quoted paths", () => {
    expect(splitComposerMentionSegments('Read @"docs/My File.md" now')).toEqual([
      { type: "text", text: "Read " },
      { type: "mention", path: "docs/My File.md", source: '@"docs/My File.md"' },
      { type: "text", text: " now" },
    ]);
  });

  test("still collects a quoted mention whose path is at the length cap", () => {
    const path = `${"a".repeat(508)}.tsx`;
    expect(splitComposerMentionSegments(`read @"${path}" now`)).toEqual([
      { type: "text", text: "read " },
      { type: "mention", path, source: `@"${path}"` },
      { type: "text", text: " now" },
    ]);
  });

  test("leaves a quoted mention past the cap as plain text", () => {
    const path = `${"a".repeat(509)}.tsx`;
    expect(splitComposerMentionSegments(`read @"${path}" now`)).toEqual([
      { type: "text", text: `read @"${path}" now` },
    ]);
  });

  test("stays fast on unterminated quoted mentions", () => {
    // Unbounded, each `@"` fragment with no closing quote rescanned the rest
    // of the text from its start: quadratic on this input.
    const started = performance.now();
    expect(splitComposerMentionSegments(" @\"aaa".repeat(20_000))).toEqual([
      { type: "text", text: " @\"aaa".repeat(20_000) },
    ]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("unified mention list", () => {
  test("builds projects-first, files-second in one array", () => {
    const items = buildMentionItems(
      [{ path: "/b", name: "b" }],
      [
        { path: "/b/a.ts", name: "a.ts", parent: "src" },
        { path: "/b/c.ts", name: "c.ts", parent: "src" },
      ],
    );
    expect(items.map((i) => [i.kind, i.path])).toEqual([
      ["project", "/b"],
      ["file", "/b/a.ts"],
      ["file", "/b/c.ts"],
    ]);
    expect(items[0]).toMatchObject({ name: "b", detail: "/b" });
    expect(items[1]).toMatchObject({ name: "a.ts", detail: "src" });
  });

  test("dedupes projects by path, first wins", () => {
    expect(
      dedupeMentionProjects([
        { path: "/a", name: "a" },
        { path: "/b", name: "b" },
        { path: "/a", name: "a-dup" },
      ]),
    ).toEqual([
      { path: "/a", name: "a" },
      { path: "/b", name: "b" },
    ]);
  });

  test("resolves restored chip kinds from the project set", () => {
    const resolve = createMentionKindResolver([{ path: "/a", name: "a" }]);
    expect(resolve("/a")).toBe("project");
    expect(resolve("/a/file.ts")).toBe("file");
  });
});
