import { describe, expect, test } from "bun:test";

import { parseAskUserQuestions } from "./claudeAdapterHelpers.js";

describe("parseAskUserQuestions", () => {
  test("reads options under either the label or the name key", () => {
    // The shared walk accepts both keys; this locks the fallback in for
    // Claude payloads rather than leaving it covered only by print-mode tests.
    const questions = parseAskUserQuestions({
      questions: [{ question: "Choose?", options: [{ label: "A" }, { name: "B" }] }],
    });
    expect(questions[0]?.options).toEqual([{ label: "A" }, { label: "B" }]);
  });

  test("drops non-text option picks instead of labelling them", () => {
    // A primitive `false` used to surface as a choice labelled "false"; only
    // non-empty strings (and label/description objects) become choices now.
    const questions = parseAskUserQuestions({
      questions: [{ question: "Choose?", options: [false, 7, "  ", "A", { label: "B" }] }],
    });
    expect(questions[0]?.options).toEqual([{ label: "A" }, { label: "B" }]);
  });

  test("duplicate question texts share one by-text id", () => {
    // Answers are looked up by question text, so identical texts cannot be
    // told apart — both entries carry the same id by contract.
    const questions = parseAskUserQuestions({
      questions: [{ question: "Same?" }, { question: "Same?" }],
    });
    expect(questions.map((question) => question.id)).toEqual(["Same?", "Same?"]);
  });

  test("defaults the header and reads the multi-select flag", () => {
    const questions = parseAskUserQuestions({
      questions: [{ question: "A?", multiSelect: true }, { header: "Pick", question: "B?" }],
    });
    expect(questions).toEqual([
      { id: "A?", header: "Question", question: "A?", options: [], multiSelect: true },
      { id: "B?", header: "Pick", question: "B?", options: [], multiSelect: false },
    ]);
  });
});
