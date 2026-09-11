import { describe, expect, test } from "bun:test";

import { LSP_ACTIONS } from "./types.js";
import type { LspAction } from "./types.js";

describe("lsp action contract", () => {
  test("exposes exactly the six read-only actions", () => {
    expect([...LSP_ACTIONS]).toEqual([
      "definition",
      "references",
      "hover",
      "symbols",
      "diagnostics",
      "rename",
    ]);
  });

  test("action names assign to the union", () => {
    const action: LspAction = "references";
    expect(LSP_ACTIONS.includes(action)).toBe(true);
  });
});
