import { describe, expect, test } from "bun:test";

import { columnComposerDockState } from "./columnComposerDock";

describe("the column composer's dock report", () => {
  test("reports the floor it needs while the composer is on screen", () => {
    expect(
      columnComposerDockState({ asking: false, open: true, height: 240, clear: 280 }),
    ).toEqual({ open: true, height: 240, clear: 280 });
    expect(
      columnComposerDockState({ asking: false, open: false, height: 0, clear: 40 }),
    ).toEqual({ open: false, height: 0, clear: 40 });
  });

  test("hands the spot to the ask while one is parked", () => {
    // The ask card takes the composer's place, so the corner docks have to come
    // back; the composer itself stays mounted and keeps its state.
    expect(
      columnComposerDockState({ asking: true, open: true, height: 240, clear: 280 }),
    ).toBeNull();
  });
});
