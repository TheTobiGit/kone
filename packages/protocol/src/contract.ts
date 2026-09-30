// A contract: the terms an agent writes when it brings in an agent that isn't
// on the team — a contractor, made up on the spot for one job.
//
// A teammate's identity lives on the roster, where the user put it. A
// contractor's has nowhere to live but the job, so the terms carry it: who the
// contractor is (name, role, standing instructions) and what the job is (the
// scope, what gets handed back, and how both sides know it is done). agent-core
// stores them on the contractor's thread; the renderer reads them to name the
// contractor, show what it was contracted for, and offer to hire it.

import { z } from "zod";

export const CONTRACT_TEXT_MAX_CHARS = 4000;

const ContractText = z.string().trim().min(1).max(CONTRACT_TEXT_MAX_CHARS);

export const ContractTermsSchema = z.object({
  /** What the contractor is called — what it answers under and the user sees. */
  name: z.string().trim().min(1).max(60),
  /** One line saying what it is for, e.g. "Frontend auth specialist". */
  role: z.string().trim().min(1).max(120),
  /** Its standing instructions: how it works, in the contracting agent's
   *  words. Sent to the contractor as its identity, not as part of the brief. */
  instructions: ContractText,
  /** What is and is not part of the job. */
  scope: ContractText,
  /** What the contractor hands back when it is done. */
  deliverable: ContractText,
  /** How both sides know the job is finished. */
  doneCriteria: ContractText,
});

export type ContractTerms = z.infer<typeof ContractTermsSchema>;

/** The terms a stored thread carries, or undefined when it is not a
 *  contractor's (or what is stored cannot be read as terms). */
export function parseContractTerms(json: string | null | undefined): ContractTerms | undefined {
  if (!json) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  const parsed = ContractTermsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function encodeContractTerms(terms: ContractTerms): string {
  return JSON.stringify(terms);
}

/** The job half of the terms as the contractor reads it, laid under the task
 *  in its brief. The identity half reaches it separately, as who it is. */
export function renderContractBrief(task: string, terms: ContractTerms): string {
  return [
    task.trim(),
    "",
    "Contract terms:",
    `- Scope: ${terms.scope}`,
    `- Deliverable: ${terms.deliverable}`,
    `- Done when: ${terms.doneCriteria}`,
  ].join("\n");
}
