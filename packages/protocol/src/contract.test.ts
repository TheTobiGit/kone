import { describe, expect, test } from "bun:test";

import { encodeContractTerms, parseContractTerms, renderContractBrief, type ContractTerms } from "./contract.js";

const terms: ContractTerms = {
  name: "Frontend Auth",
  role: "Frontend auth specialist",
  instructions: "Keep components small and accessible.",
  scope: "The login and signup screens; not the API.",
  deliverable: "Working screens wired to the auth endpoints.",
  doneCriteria: "Both screens render and the auth tests pass.",
};

describe("contract terms", () => {
  test("round-trip through their column", () => {
    expect(parseContractTerms(encodeContractTerms(terms))).toEqual(terms);
  });

  test("anything that is not a whole contract reads as none", () => {
    expect(parseContractTerms(null)).toBeUndefined();
    expect(parseContractTerms("nope")).toBeUndefined();
    expect(parseContractTerms(JSON.stringify({ ...terms, deliverable: undefined }))).toBeUndefined();
  });

  test("the brief lays the job's terms under the task, and leaves the identity out", () => {
    const brief = renderContractBrief("Build the login screen.", terms);
    expect(brief.startsWith("Build the login screen.\n\nContract terms:")).toBe(true);
    expect(brief).toContain(`- Scope: ${terms.scope}`);
    expect(brief).toContain(`- Deliverable: ${terms.deliverable}`);
    expect(brief).toContain(`- Done when: ${terms.doneCriteria}`);
    expect(brief).not.toContain(terms.instructions);
  });
});
