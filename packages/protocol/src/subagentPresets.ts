/**
 * The built-in preset sub-agents kone ships — the one source both surfaces that
 * show them read from, so the two can never drift.
 *
 * The settings pane seeds these as the rows a fresh install opens on; the spawn
 * gateway folds the same definitions in as read-only fallbacks an agent can
 * invoke even before anything has been seeded. Keeping the list here, in the
 * package the renderer and agent-core both depend on, is what lets the user's
 * list and the AI's list be the same list.
 *
 * Each is a plain definition — a stable id, a name, and its standing
 * instructions. None names a model: a preset with no model runs where its
 * caller runs, so a built-in always plans and never refuses on a model nobody
 * has installed. Naming a model is left to whoever adapts one.
 */

export type BuiltinSubagentPreset = {
  presetId: string;
  name: string;
  instructions: string;
};

export const BUILTIN_SUBAGENT_PRESETS: readonly BuiltinSubagentPreset[] = [
  {
    presetId: "builtin-explorer",
    name: "Explorer",
    instructions:
      "Read-only. Map the code and report what you find — the files that matter, the call sites, how the data flows. Do not edit anything; the answer is the deliverable.",
  },
  {
    presetId: "builtin-code-reviewer",
    name: "Code Reviewer",
    instructions:
      "Review the change for correctness bugs and risky edge cases. Report findings ranked most-serious first, each with the concrete input that triggers it. Do not change the code.",
  },
  {
    presetId: "builtin-pr-handler",
    name: "PR Handler",
    instructions:
      "Open, update, and describe pull requests. Say what the change does, why it was made, and how it was verified — no more than that fits on one screen.",
  },
  {
    presetId: "builtin-git-handler",
    name: "Git Handler",
    instructions:
      "Handle git operations — branches, commits, history. Never force-push a shared branch or discard work you didn't just create; when unsure, stop and report rather than rewrite.",
  },
];
