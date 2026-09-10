import { describe, expect, test } from "bun:test";

import type { UserInputJsonValue } from "./userInputQuestions.js";
import { normalizeUserInputQuestions, readUserInputText } from "./userInputQuestions.js";

// Drift guards for the two migrated call sites whose parsers are not
// exported: each mirror below replays its call site's id/multi-select scheme
// through the shared walk with that CLI's payload shapes, so a change to the
// walk that breaks one CLI's questions fails here rather than silently.

// Codex keys answers by the entry's own id (entries without one are dropped
// below — with no id there is no key to file the answer under) and has no
// per-question multi-select flag.
function codexQuestions(params: { questions?: UserInputJsonValue }) {
  return normalizeUserInputQuestions(params.questions, {
    idFor: (entry) => readUserInputText(entry.id) ?? "",
    isMultiSelect: (_entry) => false,
  }).filter((question) => question.id.length > 0);
}

// opencode keys answers by a positional slug id and spells multi-select
// `multiple`.
function openCodeQuestions(payload: { questions?: UserInputJsonValue }) {
  return normalizeUserInputQuestions(payload.questions, {
    idFor: (entry, _question, index) =>
      `question-${index}-${String(entry.header ?? "question").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    isMultiSelect: (entry) => entry.multiple === true,
  });
}

describe("codex-shaped entries through the shared normalizer", () => {
  test("keys answers by the entry's own id and drops entries without one", () => {
    const questions = codexQuestions({
      questions: [
        { id: "q1", question: "Proceed?", options: [{ label: "Yes" }] },
        { question: "No id, no key" },
        { id: "  ", question: "Blank id, no key" },
      ],
    });
    expect(questions.map((question) => question.id)).toEqual(["q1"]);
    expect(questions[0]).toMatchObject({
      header: "Question",
      question: "Proceed?",
      options: [{ label: "Yes" }],
      multiSelect: false,
    });
  });

  test("normalizes plain-string options and stays single-select", () => {
    // Codex only ever sends label/description objects; the shared walk also
    // accepts plain strings, and multi-select spellings from other CLIs must
    // not leak into the Codex scheme.
    const questions = codexQuestions({
      questions: [
        {
          id: "q1",
          question: "Pick?",
          multiple: true,
          multiSelect: true,
          options: ["B", { label: "A", description: "first" }, { name: "C" }],
        },
      ],
    });
    expect(questions[0]?.options).toEqual([
      { label: "B" },
      { label: "A", description: "first" },
      { label: "C" },
    ]);
    expect(questions[0]?.multiSelect).toBe(false);
  });
});

describe("opencode-shaped entries through the shared normalizer", () => {
  test("builds positional slug ids and reads the multiple flag", () => {
    const questions = openCodeQuestions({
      questions: [
        { header: "Pick one", question: "Color?", multiple: true, options: ["Red"] },
        { question: "No header falls back to the question slug" },
      ],
    });
    expect(questions.map((question) => question.id)).toEqual([
      "question-0-pick-one",
      "question-1-question",
    ]);
    expect(questions.map((question) => question.multiSelect)).toEqual([true, false]);
  });

  test("drops entries without question text and options without a label", () => {
    const questions = openCodeQuestions({
      questions: [
        { header: "Empty", options: ["A"] },
        { header: "Pick", question: "Choose?", options: ["", { description: "no label" }, "A"] },
      ],
    });
    expect(questions.length).toBe(1);
    expect(questions[0]?.options).toEqual([{ label: "A" }]);
  });
});
