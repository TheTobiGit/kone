import { describe, expect, test } from "bun:test";

import { renderScreenText } from "./screenText.js";

describe("renderScreenText", () => {
  test("reads what the screen shows, not the bytes that drew it", async () => {
    const history =
      "$ bun run build\r\n" +
      "\x1b[32mbuilding\x1b[0m\r\n" +
      // A progress bar redrawn in place: only its last frame is on screen.
      "[#   ] 25%\r[##  ] 50%\r[####] 100%\r\n" +
      "\x1b[31merror:\x1b[0m cannot find module 'x'\r\n" +
      "$ ";
    const lines = await renderScreenText(history, 80, 24, 50);
    expect(lines).toEqual([
      "$ bun run build",
      "building",
      "[####] 100%",
      "error: cannot find module 'x'",
      "$",
    ]);
  });

  test("keeps only the last lines asked for", async () => {
    const history = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\r\n");
    const lines = await renderScreenText(history, 80, 10, 3);
    expect(lines).toEqual(["line 27", "line 28", "line 29"]);
  });

  test("joins a row the terminal wrapped back into one line", async () => {
    const long = "x".repeat(50);
    const lines = await renderScreenText(`${long}\r\n$ `, 20, 5, 10);
    expect(lines[0]).toBe(long);
  });
});
