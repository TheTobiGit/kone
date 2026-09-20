import { systemOne, readApiKey, MODEL, type Question, type State } from "./client.js";
import type { JevCandidate, JevRouteInput, JevRouteResult, JevStatus } from "./types.js";

/**
 * The routing decision: one question asked of the model, and the arithmetic
 * that turns its distribution into an agent id.
 *
 * The split matters. The model answers "whose job is this" — a thing it can be
 * calibrated about — and this file decides what to do with the numbers.
 * Folding the decision into the question would mean re-tuning a prompt every
 * time the bar moves, and would put a threshold somewhere nobody can read it.
 */

/**
 * The option standing for "nobody in particular".
 *
 * It has to be an option in the choice rather than something inferred from the
 * shape of the distribution. "This is ordinary work" is a positive answer the
 * model can be confident about, and it is the commonest outcome — reading it
 * off a low score instead would make the answer given most often the one with
 * the least evidence behind it.
 *
 * It is also the *only* thing that decides against a specialist. Asking
 * separately whether a request "needs" one reads as "is this hard", which is
 * almost always no: a general-purpose assistant can competently answer most of
 * what anybody types. That is not the question. The user assembled a team of
 * specialists; the question is whose job this is, and an option in the choice
 * is where that gets answered.
 */
const DEFAULT_OPTION = "default";

const DEFAULT_BRIEF =
  "No particular agent. The request doesn't belong to any of the agents above — it's general work, a follow-up, or a conversation, and whoever is already here should take it.";

/**
 * How far ahead of the default the winner has to be: twice as likely.
 *
 * A plain confidence floor was tried here and is wrong, because confidence
 * measures how peaked the *whole* distribution is. Two specialists splitting a
 * request evenly — a frontend engineer and a designer both at 0.45, the default
 * at 0.09 — score as unconfident, when in fact the one thing the model is sure
 * about is that this is not general work. Either specialist beats the default
 * there, so the margin is measured against the default alone and the tie
 * between the two is left as the coin flip it is.
 */
const DEFAULT_MARGIN = 2;

/** How much of the request the model reads. Long enough for a pasted stack
 *  trace or a paragraph of intent, short enough that a whole file pasted into
 *  the composer doesn't bury the sentence saying what to do with it. */
const REQUEST_LIMIT = 4000;

/** How much of an agent's standing orders describe it to the router. The
 *  opening of a brief says what the agent is for; the rest says how it behaves
 *  once chosen, which is not what is being decided here. */
const BRIEF_LIMIT = 600;

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** Candidates the choice can actually offer: real ids only, and never one
 *  colliding with the default's own key. */
function usable(candidates: JevCandidate[]): JevCandidate[] {
  return candidates.filter((c) => c.agentId !== "" && c.agentId !== DEFAULT_OPTION);
}

function criteriaFor(candidates: JevCandidate[]): Record<string, string> {
  const criteria: Record<string, string> = { [DEFAULT_OPTION]: DEFAULT_BRIEF };
  for (const candidate of candidates) {
    const role = candidate.role.trim();
    const brief = clip(candidate.brief, BRIEF_LIMIT);
    criteria[candidate.agentId] = role ? `${candidate.name} — ${role}. ${brief}` : `${candidate.name}. ${brief}`;
  }
  return criteria;
}

/**
 * One question, not two.
 *
 * The wording asks whose job the request is, not whether it is hard enough to
 * deserve one — a team exists to be used, and the default is for work that
 * belongs to nobody on it rather than for work that happens to be easy.
 */
function questionsFor(candidates: JevCandidate[]): Record<string, Question> {
  return {
    agent: {
      type: "choice",
      instructions:
        "A developer typed this request into a coding assistant that has the team below available. Whose job is this? Pick the agent whose described area the request falls in, even when a generalist could also answer it. Pick 'default' only when the request falls in nobody's area — general work, a follow-up, or ordinary conversation.",
      criteria: criteriaFor(candidates),
    },
  };
}

/** Everything the decision is made on, as one object. Structured rather than
 *  flattened into a sentence: the request and the project it was typed in are
 *  different kinds of evidence, and gluing them together invites the model to
 *  read the project name as part of what was asked. */
function stateFor(input: JevRouteInput): State {
  const state: State = { request: clip(input.request, REQUEST_LIMIT) };
  const project = input.project?.trim();
  if (project) state.project = project;
  return state;
}

/** Nothing to route to, nothing configured, or nothing asked — each lands on
 *  the default partner with a reason on it. */
function fallback(outcome: JevRouteResult["outcome"], detail?: string): JevRouteResult {
  const result: JevRouteResult = {
    agentId: null,
    outcome,
    confidence: 0,
    probabilities: {},
  };
  if (detail !== undefined) result.detail = detail;
  return result;
}

export function jevStatus(): JevStatus {
  return { configured: readApiKey() !== null, model: MODEL };
}

/**
 * Decide who answers. Never throws: every failure is a decision to use the
 * default partner, because the user is holding a send and a thrown error would
 * turn a routing hiccup into a message that never went out.
 */
export async function route(input: JevRouteInput): Promise<JevRouteResult> {
  const candidates = usable(input.candidates);
  if (candidates.length === 0) return fallback("no-match");
  if (input.request.trim() === "") return fallback("no-match");
  if (readApiKey() === null) return fallback("unavailable", "TYPESAFE_API_KEY is not set");

  let answers: Awaited<ReturnType<typeof systemOne>>["answers"];
  try {
    ({ answers } = await systemOne(stateFor(input), questionsFor(candidates)));
  } catch (err) {
    console.warn("[jev] routing failed, falling back to the default partner:", err);
    return fallback("failed", err instanceof Error ? err.message : String(err));
  }

  const agent = answers.agent;
  if (!agent || agent.type !== "choice") {
    return fallback("failed", "no choice came back for the routing question");
  }

  const decided: JevRouteResult = {
    agentId: null,
    outcome: "no-match",
    confidence: agent.confidence,
    probabilities: agent.probabilities,
  };

  if (agent.choice === DEFAULT_OPTION) return decided;

  // A choice naming somebody who is not on the list is the one answer that
  // cannot be honoured — settling a thread on an unknown id would leave it
  // owned by nobody. Read as a miss rather than an error.
  const picked = candidates.find((c) => c.agentId === agent.choice);
  if (!picked) return { ...decided, outcome: "unsure" };

  // The winner beat the default at the top of the distribution; the margin
  // asks by how much. A specialist barely ahead of "nobody in particular" is
  // the one case worth declining, because the thread is settled write-once and
  // the default handles the request competently either way.
  const share = agent.probabilities[picked.agentId] ?? 0;
  const defaultShare = agent.probabilities[DEFAULT_OPTION] ?? 0;
  if (share < defaultShare * DEFAULT_MARGIN) return { ...decided, outcome: "unsure" };

  return { ...decided, agentId: picked.agentId, outcome: "routed" };
}
