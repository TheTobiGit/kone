import { z } from "zod";

/**
 * The one call this module makes: a batch of typed questions over a piece of
 * state, answered with probabilities rather than prose.
 *
 * Written against the HTTP endpoint rather than a vendor client on purpose. The
 * payload is one POST with two questions in it, the answers are decoded here
 * anyway, and main-process dependencies cost bundle and audit surface for the
 * life of the app — a client library would earn its place at a dozen call
 * sites, not at one.
 */

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** The floating tag, not a pinned version: a routing decision is cheap to get
 *  wrong and cheap to redo, so tracking the current model beats freezing a
 *  choice nobody will revisit. */
export const MODEL = "jev-latest";

/** Attempts in total, not retries after the first. Three is the point where a
 *  rate limit that is going to clear has cleared; past that the user is waiting
 *  on a picker, and falling back to the default partner is faster than being
 *  right. */
const ATTEMPTS = 3;
const BACKOFF_MS = 400;
/** One attempt's ceiling. Not the budget — see DEADLINE_MS. */
const TIMEOUT_MS = 6000;

/** The whole call's ceiling, retries and backoff included.
 *
 *  The per-attempt timeout is not a budget: three attempts plus their backoff
 *  reach 19.2s, and the user is holding a send for all of it. That is the
 *  number they experience, so that is the number to state. Past this the
 *  default partner answers — being right is worth a moment, not twenty
 *  seconds of a composer that looks broken. */
const DEADLINE_MS = 7000;

/** Statuses worth trying again: a rate limit and an overloaded service are both
 *  "not now" rather than "not ever". Every other failure is ours to fix and
 *  retrying it only doubles the wait. */
const RETRYABLE = new Set([429, 529]);

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type NoulQuestion = {
  type: "noul";
  instructions: string;
};

export type Question = ChoiceQuestion | NoulQuestion;

/** What the questions are asked about. A flat map of named fields rather than
 *  a free-form value: the fields are what the model sees as separate pieces of
 *  evidence, and a caller that could pass anything would sooner or later pass
 *  a blob whose shape the model has to guess at. */
export type State = Record<string, string>;

const choiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});

const noulAnswer = z.object({
  type: z.literal("noul"),
  noul: z.number(),
});

/** An answer shape this build doesn't know is dropped rather than failing the
 *  whole response: the questions are independent, so one unreadable answer
 *  should cost only the decision it was for. */
const answer = z.union([choiceAnswer, noulAnswer]).nullable().catch(null);

const systemOneResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), answer),
});

export type ChoiceAnswer = z.infer<typeof choiceAnswer>;
export type NoulAnswer = z.infer<typeof noulAnswer>;
export type SystemOneResponse = z.infer<typeof systemOneResponse>;

/** Thrown for every failure below, so one catch at the call site can turn any
 *  of them into the same fallback instead of leaking fetch's error zoo. */
export class JevRequestError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "JevRequestError";
    this.status = status;
  }
}

/** The key, or null when nothing configured one. Read per call rather than
 *  cached at import: the app outlives a key rotation, and a value captured at
 *  boot would keep a dead key alive until restart. */
export function readApiKey(): string | null {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  return key ? key : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask a batch of questions about one piece of state.
 *
 * Every question in the batch is answered independently and in parallel at the
 * far end, which is why the router asks both of its questions here rather than
 * making two calls it would then have to keep in step.
 */
export async function systemOne(
  state: State,
  questions: Record<string, Question>,
): Promise<SystemOneResponse> {
  const key = readApiKey();
  if (!key) throw new JevRequestError("TYPESAFE_API_KEY is not set");

  // One deadline over the whole loop, so the wait the user sits through is
  // bounded whatever the attempts do. Each attempt gets the smaller of its own
  // timeout and what is left, and the loop stops once nothing is left rather
  // than starting an attempt that cannot finish inside the budget.
  const deadline = Date.now() + DEADLINE_MS;
  let last: JevRequestError | undefined;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = BACKOFF_MS * 2 ** (attempt - 1);

      if (Date.now() + backoff >= deadline) break;
      await sleep(backoff);
    }

    const left = deadline - Date.now();

    if (left <= 0) break;

    try {
      return await once(key, state, questions, Math.min(TIMEOUT_MS, left));
    } catch (err) {
      const failure =
        err instanceof JevRequestError ? err : new JevRequestError(String(err));
      if (failure.status !== undefined && !RETRYABLE.has(failure.status)) throw failure;
      last = failure;
    }
  }

  throw last ?? new JevRequestError("routing timed out");
}

async function once(
  key: string,
  state: State,
  questions: Record<string, Question>,
  timeoutMs: number,
): Promise<SystemOneResponse> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state, model: MODEL, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new JevRequestError(`routing request failed (${response.status})`, response.status);
  }

  const decoded = systemOneResponse.safeParse(await response.json());
  if (!decoded.success) throw new JevRequestError("routing response was not readable");
  return decoded.data;
}
