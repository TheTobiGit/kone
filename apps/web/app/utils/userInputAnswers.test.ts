import { describe, expect, test } from "bun:test";

import type { UserInputQuestion } from "~/types/desktop";
import { buildUserInputAnswers, emptyUserInputDraft, userInputAnswer } from "./userInputAnswers";

const single: UserInputQuestion = { id: "q0", header: "Color", question: "Which color?", options: [{ label: "Blue" }, { label: "Green" }] };
const multi: UserInputQuestion = { ...single, id: "q1", question: "Which extras?", multiSelect: true };
const free: UserInputQuestion = { id: "q2", header: "Notes", question: "Anything else?", options: [] };

const draft = (patch: Partial<ReturnType<typeof emptyUserInputDraft>>) => ({ ...emptyUserInputDraft(), ...patch });

describe("userInputAnswer", () => {
  test("single-select sends the picked label", () => {
    expect(userInputAnswer(single, draft({ picks: ["Green"] }))).toBe("Green");
  });

  test("single-select with write-your-own sends the typed value instead", () => {
    expect(userInputAnswer(single, draft({ other: true, text: "  Teal " }))).toBe("Teal");
    expect(userInputAnswer(single, draft({ other: true, text: "  " }))).toBeNull();
  });

  test("multi-select sends every pick, plus a typed value once", () => {
    expect(userInputAnswer(multi, draft({ picks: ["Blue", "Green"] }))).toEqual(["Blue", "Green"]);
    expect(userInputAnswer(multi, draft({ picks: ["Blue"], other: true, text: "Teal" }))).toEqual(["Blue", "Teal"]);
    expect(userInputAnswer(multi, draft({ picks: ["Blue"], other: true, text: "Blue" }))).toEqual(["Blue"]);
    expect(userInputAnswer(multi, draft({ other: true, text: "Teal" }))).toEqual(["Teal"]);
    expect(userInputAnswer(multi, draft({ other: true }))).toBeNull();
  });

  test("a question without options sends its free text", () => {
    expect(userInputAnswer(free, draft({ text: " ship it " }))).toBe("ship it");
    expect(userInputAnswer(free, draft({}))).toBeNull();
  });
});

describe("buildUserInputAnswers", () => {
  test("keys every answer by question id once all are answered", () => {
    expect(buildUserInputAnswers([single, multi, free], {
      q0: draft({ picks: ["Blue"] }),
      q1: draft({ picks: ["Green"], other: true, text: "Teal" }),
      q2: draft({ text: "no" }),
    })).toEqual({ q0: "Blue", q1: ["Green", "Teal"], q2: "no" });
  });

  test("holds back while any question is unanswered", () => {
    expect(buildUserInputAnswers([single, free], { q0: draft({ picks: ["Blue"] }) })).toBeNull();
  });
});
