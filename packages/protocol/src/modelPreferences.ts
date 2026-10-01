/**
 * Model routing: the model and reasoning effort the user wants a category of
 * work to run on when an agent starts a thread for it and nobody named a model.
 *
 * A preset or a teammate carries its own model chain, and a user who names a
 * model for a piece of work has already answered the question. What is left is
 * the thread an agent starts on its own judgement — a briefed worker, a
 * contracted agent, a teammate that inherits — which otherwise runs wherever
 * its caller runs. A preference lets the user say "quick fixes go to a small
 * fast model, reviews to a deep one" once, and every agent reads it.
 *
 * Each preference is a kind of work: a stable slug the agent passes as `kind`,
 * a label the user reads, and a hint that tells the agent when the kind
 * applies. A short set of suggested kinds ships as a starting point — the user
 * renames, removes and adds their own. A kind with no model is dormant: kept so
 * the user can finish it, but never offered to an agent, so a suggestion costs
 * nothing until the user routes it.
 *
 * Shared by the store (which seeds the suggestions and normalizes what it
 * reads) and the renderer (which draws them before the bridge answers), so the
 * two can never disagree about the starting set or a slug.
 */

export type ModelPreferenceKind = {
  /** The slug an agent passes as `kind`. Stable across renames of the label. */
  kind: string;
  label: string;
  /** When this kind applies, in words the agent reads to decide. */
  hint: string;
};

export const DEFAULT_MODEL_PREFERENCE_KINDS: readonly ModelPreferenceKind[] = [
  {
    kind: "quick-fix",
    label: "Quick fixes",
    hint: "A small, well-understood change: a typo, a rename, a one-line bug, a config tweak.",
  },
  {
    kind: "code-review",
    label: "Code review",
    hint: "Reading a change or a piece of code for bugs, risks and style, without writing it.",
  },
  {
    kind: "frontend",
    label: "Frontend work",
    hint: "UI work: components, styling, layout and state, from a small tweak to a new screen.",
  },
  {
    kind: "refactor",
    label: "Refactoring",
    hint: "Restructuring code across files without changing what it does.",
  },
  {
    kind: "debugging",
    label: "Debugging",
    hint: "Tracking down why something fails: reproducing it, reading logs, finding the root cause.",
  },
  {
    kind: "tests",
    label: "Writing tests",
    hint: "Adding or fixing tests, and running them to check a change holds.",
  },
  {
    kind: "git",
    label: "Git and PRs",
    hint: "Commits, branches, resolving conflicts, and writing commit and pull request messages.",
  },
  {
    kind: "second-opinion",
    label: "Second opinion",
    hint: "An independent take on a problem or a plan, meant to differ from your own thinking.",
  },
];

export const MODEL_PREFERENCE_KIND_MAX = 48;
export const MODEL_PREFERENCE_LABEL_MAX = 60;
export const MODEL_PREFERENCE_HINT_MAX = 300;
export const MODEL_PREFERENCE_LIST_MAX = 32;

/** A kind's slug from whatever the user or an agent typed: lower-case words
 *  joined by single hyphens, so "Big Frontend" and "big_frontend" name the same
 *  kind. Empty when nothing usable is left. */
export function modelPreferenceKindKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MODEL_PREFERENCE_KIND_MAX)
    .replace(/^-+|-+$/g, "");
}
