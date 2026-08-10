import { describe, expect, test } from "bun:test";
import {
  detectFileMentionTrigger,
  formatFileMention,
  replaceComposerTextRange,
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

describe("splitComposerMentionSegments", () => {
  test("formats completed path tokens while leaving surrounding text intact", () => {
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
