import { describe, expect, test } from "bun:test";

import { handOffCaret, type CaretPane } from "./caretHandoff";

type FakePane = CaretPane & { released: number; taken: number };

/** A CaretPane that records whether it was released and taken, told up front
 *  whether it holds the caret and whether its card is open. */
function pane(input: { holds: boolean; open: boolean }): FakePane {
  const self: FakePane = {
    released: 0,
    taken: 0,
    releaseCaret(): boolean {
      if (!input.holds) return false;
      self.released += 1;
      return true;
    },
    takeCaret(): void {
      if (!input.open) return;
      self.taken += 1;
    },
  };
  return self;
}

describe("handOffCaret", () => {
  test("a keyboard move carries the caret from the losing column to an open one", () => {
    const losing = pane({ holds: true, open: true });
    const gaining = pane({ holds: false, open: true });

    expect(handOffCaret(losing, gaining)).toBe(true);
    expect(losing.released).toBe(1);
    expect(gaining.taken).toBe(1);
  });

  test("a closed target stays closed: the caret is released but not taken", () => {
    const losing = pane({ holds: true, open: true });
    const gaining = pane({ holds: false, open: false });

    expect(handOffCaret(losing, gaining)).toBe(true);
    expect(losing.released).toBe(1);
    expect(gaining.taken).toBe(0);
  });

  test("a click already moved the caret, so the losing column releases nothing", () => {
    const losing = pane({ holds: false, open: true });
    const gaining = pane({ holds: true, open: true });

    expect(handOffCaret(losing, gaining)).toBe(false);
    expect(losing.released).toBe(0);
    expect(gaining.taken).toBe(0);
  });

  test("a move around a non-composer pane hands nothing over", () => {
    const losing = pane({ holds: true, open: true });

    expect(handOffCaret(losing, null)).toBe(true);
    expect(losing.released).toBe(1);
  });

  test("the first focus (no previous column) hands nothing over", () => {
    const gaining = pane({ holds: false, open: true });

    expect(handOffCaret(null, gaining)).toBe(false);
    expect(gaining.taken).toBe(0);
  });
});
