// A contractor's identity, as its session is told it.
//
// A teammate's persona comes from the roster; a contractor has no roster row,
// so its name and standing instructions come from the terms it was contracted
// under. Its role leads the instructions, the way a teammate's role reads
// first in the roster.

import type { ContractTerms } from "@kone/protocol/contract";
import type { AgentPersona } from "./types.js";

export function contractPersona(terms: ContractTerms): AgentPersona {
  return {
    name: terms.name,
    instructions: `Your role: ${terms.role}. You were contracted for one job and leave when it is done.\n\n${terms.instructions}`,
  };
}
