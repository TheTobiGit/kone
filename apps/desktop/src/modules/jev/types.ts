/**
 * Jev — the router that picks who answers, before anybody answers.
 *
 * Not a persona and not a provider session: it is one decision, made once, over
 * a request the user has just typed. It never writes, never reads the project,
 * and never appears in a transcript. Its whole output is an agent id, so the
 * types here are deliberately small — a wider result would invite callers to
 * treat a classifier as an assistant.
 */

/**
 * One agent the router may hand the request to.
 *
 * `brief` is what the decision is actually made on; the name and role are along
 * for it because a short label often carries more of what an agent is for than
 * a paragraph does. Built by the renderer, which is the only side that knows
 * the roster.
 */
export type JevCandidate = {
  agentId: string;
  name: string;
  role: string;
  brief: string;
};

/**
 * What the router is asked. `request` is the message as typed — not a summary:
 * the wording is the signal, and anything that rewrote it first would be making
 * the decision this call exists to make.
 */
export type JevRouteInput = {
  request: string;
  candidates: JevCandidate[];
  /** The project the request was typed in, when there is one. Names carry
   *  domain — a request that reads as ambiguous alone often doesn't next to
   *  the repository it was typed against. */
  project?: string;
};

/**
 * Why the router landed where it did. Every value other than `routed` resolves
 * to the default partner, and each is a different reason to have declined:
 *
 * - `no-match` — the request is in nobody on the team's area.
 * - `unsure` — somebody won, but barely ahead of nobody at all.
 * - `unavailable` — no API key configured. Routing was never attempted.
 * - `failed` — the call was attempted and did not come back.
 *
 * Kept distinct because the surface says different things about each, and
 * because collapsing them would hide a broken key behind "nothing matched".
 */
export type JevRouteOutcome = "routed" | "no-match" | "unsure" | "unavailable" | "failed";

/** Where a request is going, and how firmly. `agentId` is null for the default
 *  partner — a real answer, not an absence. */
export type JevRouteResult = {
  agentId: string | null;
  outcome: JevRouteOutcome;
  /** 0–1, how peaked the choice was. Zero when no choice was made.
   *
   *  Reported, never gated on: two specialists splitting a request evenly
   *  score as unconfident while being certain it is not general work. The
   *  margin against the default is what decides — see `route`. */
  confidence: number;
  /** The full distribution over candidates, keyed by agent id, plus the
   *  default's own share. Carried so a surface can explain a near-miss. */
  probabilities: Record<string, number>;
  /** Why it failed, for `unavailable` and `failed` only. */
  detail?: string;
};

/** Whether routing can run at all, for a surface that has to offer or hide it. */
export type JevStatus = {
  configured: boolean;
  model: string;
};
