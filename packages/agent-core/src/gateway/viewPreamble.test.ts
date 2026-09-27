import { describe, expect, test } from "bun:test";
import type { ViewSnapshot } from "@kone/protocol/view-context";
import { createViewPreamble, withViewBlock } from "./viewPreamble.js";

function view(query: string): ViewSnapshot {
  return {
    version: 1,
    at: 0,
    layers: [{ surface: "search", query }],
    assistantOpen: true,
    selection: null,
  };
}

describe("createViewPreamble", () => {
  test("describes the screen in front of an assistant turn, and nothing for anyone else", () => {
    const preamble = createViewPreamble({
      readView: () => view("flaky test"),
      isAssistantThread: (id) => id === "assistant",
    });
    const block = preamble.blockFor("assistant");
    expect(block).toStartWith("<kone_view>\n");
    expect(block).toContain('searching "flaky test"');
    expect(block).toEndWith("</kone_view>");
    expect(preamble.blockFor("worker")).toBeNull();
  });

  test("says nothing before the renderer has described the screen", () => {
    const preamble = createViewPreamble({ readView: () => null, isAssistantThread: () => true });
    expect(preamble.blockFor("assistant")).toBeNull();
  });

  test("points back to the last description while the screen is unchanged", () => {
    let current = view("a");
    let clock = 1_000;
    const preamble = createViewPreamble({
      readView: () => current,
      isAssistantThread: () => true,
      now: () => clock,
    });
    expect(preamble.blockFor("t")).toContain('searching "a"');
    clock += 5_000;
    // A fresh snapshot of the same screen: only the clock moved.
    current = { ...view("a"), at: clock };
    expect(preamble.blockFor("t")).toBe(
      "<kone_view>The screen is unchanged since the user's previous message.</kone_view>",
    );
    current = view("b");
    expect(preamble.blockFor("t")).toContain('searching "b"');
  });

  test("describes an unchanged screen in full again after a quiet spell, or after forget", () => {
    let clock = 0;
    const preamble = createViewPreamble({
      readView: () => view("a"),
      isAssistantThread: () => true,
      now: () => clock,
    });
    preamble.blockFor("t");
    clock += 16 * 60 * 1000;
    expect(preamble.blockFor("t")).toContain('searching "a"');
    preamble.forget("t");
    expect(preamble.blockFor("t")).toContain('searching "a"');
  });

  test("keeps each thread's memory apart", () => {
    const preamble = createViewPreamble({ readView: () => view("a"), isAssistantThread: () => true });
    preamble.blockFor("one");
    expect(preamble.blockFor("two")).toContain('searching "a"');
  });
});

describe("withViewBlock", () => {
  test("puts the block ahead of the user's words", () => {
    expect(withViewBlock("hi", "<kone_view>x</kone_view>")).toBe("<kone_view>x</kone_view>\n\nhi");
  });

  test("leaves the input alone with no block, and stands alone on an attachment-only turn", () => {
    expect(withViewBlock("hi", null)).toBe("hi");
    expect(withViewBlock("", "<kone_view>x</kone_view>")).toBe("<kone_view>x</kone_view>");
  });
});
