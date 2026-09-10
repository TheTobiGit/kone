import { describe, expect, test } from "bun:test";

import type { UserInputAnswers, UserInputQuestion } from "./types.js";
import { formatPostTurnAskFollowUp, joinAnswerValues } from "./postTurnAnswers.js";

function question(
  id: string,
  text: string,
  options: string[] = [],
  multiSelect = false,
): UserInputQuestion {
  return {
    id,
    header: "Question",
    question: text,
    options: options.map((label) => ({ label })),
    multiSelect,
  };
}

/** Answers decoded off the IPC wire. JSON.parse keeps the runtime-wild values
 *  a typed literal could never carry (numbers, booleans, objects), so the
 *  totality cases below exercise what the backend actually receives. */
function ipcAnswers(json: string): UserInputAnswers {
  return JSON.parse(json);
}

describe("formatPostTurnAskFollowUp", () => {
  test("quotes one answered question with its pick", () => {
    const text = formatPostTurnAskFollowUp(
      [question("ask-0-0", "What next?", ["Explore", "Build"])],
      { "ask-0-0": "Build" },
    );
    expect(text).toBe("My answers to your questions:\n\n**What next?**\nBuild");
  });

  test("joins multi-select picks and skips unanswered questions", () => {
    const text = formatPostTurnAskFollowUp(
      [
        question("a", "First?", ["X", "Y"], true),
        question("b", "Second?"),
      ],
      { a: ["X", "Y"], b: "  " },
    );
    expect(text).toBe("My answers to your questions:\n\n**First?**\nX, Y");
  });

  test("a dismissal sends no turn", () => {
    expect(formatPostTurnAskFollowUp([question("a", "First?")], {})).toBeUndefined();
    expect(formatPostTurnAskFollowUp([question("a", "First?")], { a: null })).toBeUndefined();
    expect(formatPostTurnAskFollowUp([question("a", "First?")], ipcAnswers('{"a": false}'))).toBeUndefined();
    expect(formatPostTurnAskFollowUp([], { a: "x" })).toBeUndefined();
  });

  test("coerces numbers and drops booleans instead of throwing", () => {
    const text = formatPostTurnAskFollowUp(
      [question("n", "How many?"), question("b", "Sure?"), question("s", "Name?")],
      ipcAnswers('{"n": 42, "b": true, "s": "Ada"}'),
    );
    expect(text).toBe("My answers to your questions:\n\n**How many?**\n42\n\n**Name?**\nAda");
  });

  test("mixed arrays keep only usable picks", () => {
    const text = formatPostTurnAskFollowUp(
      [question("a", "Pick?", ["X", "Y"], true)],
      ipcAnswers('{"a": ["X", 7, null, true, "  ", {"label": "Z"}, ["nested"]]}'),
    );
    expect(text).toBe("My answers to your questions:\n\n**Pick?**\nX, 7");
  });
});

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
