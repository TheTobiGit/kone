import { describe, expect, it } from "bun:test";
import type { HandInRecord } from "~/types/desktop";
import { collapseHandInMarks, deriveHandInMarks, handInMarkLabel } from "~/utils/handInMarkers";

function record(over: Partial<HandInRecord>): HandInRecord {
  const base: HandInRecord = {
    threadId: "t1",
    fromProvider: "antigravity",
    toProvider: "claudeAgent",
    at: 1_000,
  };
  return { ...base, ...over };
}

describe("deriveHandInMarks", () => {
  it("names both ends by model when the models are known", () => {
    const [mark] = deriveHandInMarks([
      record({ fromModel: "gemini-3.7-flash", toModel: "claude-sonnet-5" }),
    ]);
    expect(mark?.from.label).toBe("Gemini 3.7 Flash");
    expect(mark?.to.label).toBe("Claude Sonnet 5");
  });

  it("falls back to the provider when a side never ran a named model", () => {
    const [mark] = deriveHandInMarks([record({ toModel: "claude-sonnet-5" })]);
    expect(mark?.from.label.length).toBeGreaterThan(0);
    expect(mark?.from.label).not.toBe("");
  });

  it("falls back to the provider label when the model id names no model", () => {
    // Cursor's model id is literally `default`: it carries no information, so
    // the marker reads "Cursor" rather than "Default".
    const [mark] = deriveHandInMarks([
      record({
        fromProvider: "cursor",
        fromModel: "default",
        toProvider: "cursor",
        toModel: "default",
      }),
    ]);
    expect(mark?.from.label).toBe("Cursor");
    expect(mark?.to.label).toBe("Cursor");
    expect(mark?.from.brand).toBe("cursor");
    expect(mark?.to.brand).toBe("cursor");
  });

  it("treats placeholder aliases case-insensitively and around whitespace", () => {
    const [mark] = deriveHandInMarks([
      record({
        fromProvider: "cursor",
        fromModel: " Default ",
        toProvider: "cursor",
        toModel: "auto",
      }),
    ]);
    expect(mark?.from.label).toBe("Cursor");
    expect(mark?.to.label).toBe("Cursor");
  });

  it("keeps the real model name whenever there is one", () => {
    const [mark] = deriveHandInMarks([
      record({
        fromProvider: "cursor",
        fromModel: "composer-2.5",
        toProvider: "claudeAgent",
        toModel: "claude-sonnet-5",
      }),
    ]);
    expect(mark?.from.label).toBe("Composer 2.5");
    expect(mark?.to.label).toBe("Claude Sonnet 5");
  });

  it("orders marks oldest-first whatever order they arrive in", () => {
    const marks = deriveHandInMarks([record({ at: 300 }), record({ at: 100 }), record({ at: 200 })]);
    expect(marks.map((m) => m.at)).toEqual([100, 200, 300]);
  });

  it("gives each mark a key distinct enough to render a list", () => {
    const marks = deriveHandInMarks([record({ at: 1 }), record({ at: 2 })]);
    expect(new Set(marks.map((m) => m.key)).size).toBe(2);
  });

  it("reads as one sentence naming where the thread went", () => {
    const [mark] = deriveHandInMarks([
      record({ fromModel: "gemini-3.7-flash", toModel: "claude-sonnet-5" }),
    ]);
    expect(mark && handInMarkLabel(mark)).toBe(
      "Continued by Claude Sonnet 5, from Gemini 3.7 Flash",
    );
  });
});

describe("collapseHandInMarks", () => {
  function m(at: number, from: string, to: string) {
    return {
      key: `k${at}`,
      at,
      from: { label: from, brand: "generic" as const },
      to: { label: to, brand: "generic" as const },
    };
  }

  it("leaves a single hand-in alone", () => {
    expect(collapseHandInMarks([m(1, "A", "B")])).toHaveLength(1);
  });

  it("reads two swaps before one turn as the change that turn saw", () => {
    const [only] = collapseHandInMarks([m(1, "A", "B"), m(2, "B", "C")]);
    expect(only?.from.label).toBe("A");
    expect(only?.to.label).toBe("C");
    expect(only?.at).toBe(2);
  });

  it("says nothing when the thread ended up back where it started", () => {
    expect(collapseHandInMarks([m(1, "A", "B"), m(2, "B", "A")])).toEqual([]);
  });
});
