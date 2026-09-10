import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";

class DatabaseSyncShim {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly
      ? new Database(filePath, { readonly: true })
      : new Database(filePath);
  }
  prepare(sql: string) {
    return this.db.prepare(sql);
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  close() {
    this.db.close();
  }
}
mock.module("node:sqlite", () => ({ DatabaseSync: DatabaseSyncShim }));
mock.module("./sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

import {
  ANTGRAVITY_BINARY,
  parseAntigravityVersion,
  resolveAntigravityBinary,
} from "./antigravityHome.js";
import {
  antigravityTurnOutcome,
  parseAntigravityCliModelLabel,
  parseAntigravityModelLines,
  resolveAntigravityCliModelLabel,
  summarizeAntigravityTool,
} from "./adapters/AntigravityPrintAdapter.js";
import {
  collectPostTurnQuestions,
  isPrintAskQuestion,
  parsePrintAskQuestions,
} from "./antigravityPrintQuestions.js";

// Pure unit tests for the print adapter's CLI-output parsers: no CLI spawn,
// no adapter turns. Each helper is the same one the adapter runs live, and
// the shapes it asserts were captured from the real CLI's output.

describe("Antigravity CLI model translation", () => {
  test("collapses CLI model/effort labels into base models with effort ladders", () => {
    expect(
      parseAntigravityModelLines(`
Gemini 3.5 Flash (Medium)
Gemini 3.5 Flash (High)
Gemini 3.5 Flash (Low)
Gemini 3.1 Pro (Low)
Gemini 3.1 Pro (High)
Claude Sonnet 4.6 (Thinking)
Claude Opus 4.6 (Thinking)
GPT-OSS 120B (Medium)
`),
    ).toEqual([
      {
        id: "Gemini 3.5 Flash",
        label: "Gemini 3.5 Flash",
        contextWindowTokens: 1_000_000,
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "Gemini 3.1 Pro",
        label: "Gemini 3.1 Pro",
        contextWindowTokens: 1_000_000,
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
      },
      {
        id: "Claude Sonnet 4.6",
        label: "Claude Sonnet 4.6",
        contextWindowTokens: 200_000,
        reasoningEfforts: ["thinking"],
        defaultReasoningEffort: "thinking",
      },
      {
        id: "Claude Opus 4.6",
        label: "Claude Opus 4.6",
        contextWindowTokens: 200_000,
        reasoningEfforts: ["thinking"],
        defaultReasoningEffort: "thinking",
      },
      {
        id: "GPT-OSS 120B",
        label: "GPT-OSS 120B",
        contextWindowTokens: 128_000,
        reasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  test("collapses tab-separated slug/label rows from newer agy models output", () => {
    expect(
      parseAntigravityModelLines(`
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)
gemini-3.6-flash-low\tGemini 3.6 Flash (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`),
    ).toEqual([
      {
        id: "Gemini 3.6 Flash",
        label: "Gemini 3.6 Flash",
        contextWindowTokens: 1_000_000,
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "Gemini 3.1 Pro",
        label: "Gemini 3.1 Pro",
        contextWindowTokens: 1_000_000,
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
      },
      {
        id: "Claude Sonnet 4.6",
        label: "Claude Sonnet 4.6",
        contextWindowTokens: 200_000,
        reasoningEfforts: ["thinking"],
        defaultReasoningEffort: "thinking",
      },
    ]);
  });

  test("rebuilds the exact CLI model label only at dispatch", () => {
    expect(parseAntigravityCliModelLabel("Gemini 3.5 Flash (High)")).toEqual({
      model: "Gemini 3.5 Flash",
      effort: "high",
    });
    expect(parseAntigravityCliModelLabel("gemini-3.6-flash-high\tGemini 3.6 Flash (High)")).toEqual({
      model: "Gemini 3.6 Flash",
      effort: "high",
    });
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash")).toBe("Gemini 3.5 Flash (Medium)");
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash", { reasoningEffort: "high" })).toBe(
      "Gemini 3.5 Flash (High)",
    );
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash (Low)")).toBe("Gemini 3.5 Flash (Low)");
    expect(resolveAntigravityCliModelLabel("gemini-3.6-flash-high\tGemini 3.6 Flash (High)")).toBe(
      "Gemini 3.6 Flash (High)",
    );
  });

  test("accepts bullet-prefixed model output", () => {
    expect(parseAntigravityCliModelLabel("* Gemini 3.5 Flash (High)")).toEqual({
      model: "Gemini 3.5 Flash",
      effort: "high",
    });
    expect(parseAntigravityCliModelLabel("• Claude Sonnet 4.6 (Thinking)")).toEqual({
      model: "Claude Sonnet 4.6",
      effort: "thinking",
    });
  });

  test("discovers future CLI models without requiring a static catalog update", () => {
    expect(
      parseAntigravityModelLines(`
Gemini 4 Pro (Low)
Gemini 4 Pro (Ultra)
Claude Sonnet 5 (Thinking)
`),
    ).toEqual([
      {
        id: "Gemini 4 Pro",
        label: "Gemini 4 Pro",
        contextWindowTokens: 1_000_000,
        reasoningEfforts: ["low", "ultra"],
        defaultReasoningEffort: "low",
      },
      {
        id: "Claude Sonnet 5",
        label: "Claude Sonnet 5",
        contextWindowTokens: 200_000,
        reasoningEfforts: ["thinking"],
        defaultReasoningEffort: "thinking",
      },
    ]);
  });

  test("dispatches a discovered model with its discovered default effort", () => {
    expect(resolveAntigravityCliModelLabel("Gemini 4 Pro", undefined, "low")).toBe(
      "Gemini 4 Pro (Low)",
    );
  });
});

describe("Antigravity install detection", () => {
  test("falls back to `agy` for a blank override, keeps a real path", () => {
    expect(resolveAntigravityBinary(undefined)).toBe(ANTGRAVITY_BINARY);
    expect(resolveAntigravityBinary("  ")).toBe(ANTGRAVITY_BINARY);
    expect(resolveAntigravityBinary("/opt/homebrew/bin/agy")).toBe("/opt/homebrew/bin/agy");
  });

  test("reads the bare semver from --version output", () => {
    expect(parseAntigravityVersion("1.0.12\n")).toBe("1.0.12");
    expect(parseAntigravityVersion("agy 1.0.12 (build 2026-07-01)\n")).toBe("1.0.12");
  });
});

describe("antigravityTurnOutcome", () => {
  const outcome = (over: Partial<Parameters<typeof antigravityTurnOutcome>[0]>) =>
    antigravityTurnOutcome({
      interrupted: false,
      agentStopped: false,
      code: 0,
      signal: null,
      ...over,
    });

  test("a clean exit completes the turn", () => {
    expect(outcome({})).toBe("completed");
  });

  test("a non-zero exit with no Stop behind it fails the turn", () => {
    expect(outcome({ code: 1 })).toBe("failed");
    expect(outcome({ code: null })).toBe("failed");
  });

  test("a signalled exit with no Stop behind it reads as interrupted", () => {
    expect(outcome({ code: null, signal: "SIGKILL" })).toBe("interrupted");
  });

  test("the user's interrupt wins over everything", () => {
    expect(outcome({ interrupted: true, agentStopped: true, code: 1 })).toBe("interrupted");
  });

  // The regression: a turn that leaves a background subagent running keeps
  // print mode waiting, the Stop-hook teardown kills it, and the CLI exits
  // non-zero after printing its wait timeout. The turn still completed.
  test("a non-zero exit after the Stop hook completes the turn", () => {
    expect(outcome({ agentStopped: true, code: 1 })).toBe("completed");
  });

  test("the teardown escalating to SIGKILL still completes the turn", () => {
    expect(outcome({ agentStopped: true, code: null, signal: "SIGKILL" })).toBe("completed");
  });
});

describe("print-mode tool-arg recovery", () => {
  test("summarizeAntigravityTool extracts human-readable target text and details", () => {
    expect(summarizeAntigravityTool("run_command", { CommandLine: "bun test" })).toEqual({
      text: "bun test",
      detail: '{\n  "CommandLine": "bun test"\n}',
    });
    expect(
      summarizeAntigravityTool("view_file", { AbsolutePath: "/path/to/file.ts", toolAction: "Viewing file" }),
    ).toEqual({
      text: "/path/to/file.ts",
      detail: '{\n  "AbsolutePath": "/path/to/file.ts",\n  "toolAction": "Viewing file"\n}',
    });
    expect(
      summarizeAntigravityTool("write_to_file", { TargetFile: "/path/to/file.ts" }),
    ).toEqual({
      text: "/path/to/file.ts",
      detail: '{\n  "TargetFile": "/path/to/file.ts"\n}',
    });
    expect(
      summarizeAntigravityTool("replace_file_content", { TargetFile: "/path/to/file.ts" }),
    ).toEqual({
      text: "/path/to/file.ts",
      detail: '{\n  "TargetFile": "/path/to/file.ts"\n}',
    });
    expect(
      summarizeAntigravityTool("manage_task", { Action: "kill", TaskId: "task-19" }),
    ).toEqual({
      text: "kill task-19",
      detail: '{\n  "Action": "kill",\n  "TaskId": "task-19"\n}',
    });
    expect(
      summarizeAntigravityTool("grep_search", { Query: "antigravity" }),
    ).toEqual({
      text: "antigravity",
      detail: '{\n  "Query": "antigravity"\n}',
    });
    expect(
      summarizeAntigravityTool("find_by_name", { Pattern: "*.ts" }),
    ).toEqual({
      text: "*.ts",
      detail: '{\n  "Pattern": "*.ts"\n}',
    });
    expect(summarizeAntigravityTool("run_command", {})).toEqual({ text: "" });
    expect(summarizeAntigravityTool("run_command", undefined)).toEqual({ text: "" });
    // When text matches tool name, it returns empty string
    expect(summarizeAntigravityTool("run_command", { command: "run_command" })).toEqual({
      text: "",
      detail: '{\n  "command": "run_command"\n}',
    });
  });
});

describe("print-mode ask recovery", () => {
  test("recognizes only the ask_question tool, case-insensitively", () => {
    expect(isPrintAskQuestion("ask_question")).toBe(true);
    expect(isPrintAskQuestion(" Ask_Question ")).toBe(true);
    expect(isPrintAskQuestion("run_command")).toBe(false);
    expect(isPrintAskQuestion(undefined)).toBe(false);
  });

  test("parses the CLI's ask args into modal questions", () => {
    expect(
      parsePrintAskQuestions(
        {
          questions: [
            {
              is_multi_select: false,
              options: ["Continue exploring the codebase", "Start building a new feature"],
              question: "What would you like to work on next?",
            },
          ],
          toolAction: "Asking user a question",
          toolSummary: "Prompting user for next steps",
        },
        "ask-0",
      ),
    ).toEqual([
      {
        id: "ask-0-0",
        header: "Question",
        question: "What would you like to work on next?",
        options: [{ label: "Continue exploring the codebase" }, { label: "Start building a new feature" }],
        multiSelect: false,
      },
    ]);
  });

  test("reads multi-select flags, headers and structured options", () => {
    expect(
      parsePrintAskQuestions(
        {
          questions: [
            {
              header: "Pick",
              multiple: true,
              options: [{ label: "A", description: "first" }, { name: "B" }],
              question: "Choose?",
            },
            { question: "Free text?", options: [] },
          ],
        },
        "ask-1",
      ),
    ).toEqual([
      {
        id: "ask-1-0",
        header: "Pick",
        question: "Choose?",
        options: [{ label: "A", description: "first" }, { label: "B" }],
        multiSelect: true,
      },
      {
        id: "ask-1-1",
        header: "Question",
        question: "Free text?",
        options: [],
        multiSelect: false,
      },
    ]);
  });

  test("drops shapes with no askable question", () => {
    expect(parsePrintAskQuestions(undefined, "ask-0")).toEqual([]);
    expect(parsePrintAskQuestions({ toolAction: "x" }, "ask-0")).toEqual([]);
    expect(parsePrintAskQuestions({ questions: "nope" }, "ask-0")).toEqual([]);
    expect(parsePrintAskQuestions({ questions: [{ options: ["A"] }] }, "ask-0")).toEqual([]);
  });
});

describe("collectPostTurnQuestions", () => {
  test("keeps option text containing separators distinct", () => {
    // A joined-string key would collapse "A|B" and ["A", "B"]; the structured
    // key keeps them as two questions.
    const questions = collectPostTurnQuestions([
      { args: { questions: [{ question: "Pick?", options: ["A|B"] }] } },
      { args: { questions: [{ question: "Pick?", options: ["A", "B"] }] } },
    ]);
    expect(questions.length).toBe(2);
    expect(questions[0]?.options).toEqual([{ label: "A|B" }]);
    expect(questions[1]?.options).toEqual([{ label: "A" }, { label: "B" }]);
  });

  test("treats header, descriptions and multi-select as content", () => {
    const questions = collectPostTurnQuestions([
      { args: { questions: [{ question: "Pick?", options: [{ label: "A", description: "first" }] }] } },
      {
        args: {
          questions: [{ header: "Other", question: "Pick?", options: [{ label: "A", description: "first" }] }],
        },
      },
      { args: { questions: [{ question: "Pick?", options: [{ label: "A", description: "second" }] }] } },
      { args: { questions: [{ question: "Pick?", multiple: true, options: ["A"] }] } },
      { args: { questions: [{ question: "Pick?", options: ["A"] }] } },
    ]);
    expect(questions.length).toBe(5);
  });

  test("collapses repeats keeping first-seen order", () => {
    const questions = collectPostTurnQuestions([
      { args: { questions: [{ question: "First?" }, { question: "Second?" }] } },
      { args: { questions: [{ question: "Second?" }, { question: "Third?" }] } },
    ]);
    expect(questions.map((question) => question.question)).toEqual(["First?", "Second?", "Third?"]);
    expect(questions.map((question) => question.id)).toEqual(["ask-0-0", "ask-0-1", "ask-1-1"]);
  });
});
