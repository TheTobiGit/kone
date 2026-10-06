import { describe, expect, test } from "bun:test";
import type { UserInputAnswers } from "./types.js";
import { joinAnswerValues } from "./postTurnAnswers.js";

function ipcAnswers(json: string): UserInputAnswers {
  return JSON.parse(json);
}

describe("joinAnswerValues", () => {
  test("joins arrays with the comma separator and passes singles through", () => {
    expect(joinAnswerValues(["X", "Y"])).toBe("X, Y");
    expect(joinAnswerValues("Solo")).toBe("Solo");
    expect(joinAnswerValues(null)).toBe("");
    expect(joinAnswerValues(undefined)).toBe("");
  });

  test("coerces numbers and drops non-text picks", () => {
    expect(joinAnswerValues(ipcAnswers('{"v": 42}').v)).toBe("42");
    expect(joinAnswerValues(ipcAnswers('{"v": false}').v)).toBe("");
    expect(joinAnswerValues(ipcAnswers('{"v": ["X", 7, null, true, "  "]}').v)).toBe("X, 7");
  });
});
