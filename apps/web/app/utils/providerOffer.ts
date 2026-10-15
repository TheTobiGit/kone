import type { ProviderKind } from "~/types/desktop";

// The providers kone offers: the four it supports well, in the order surfaces
// list them. Every other ProviderKind keeps its adapter, catalog and maintenance
// code in the tree, but nothing user-facing may surface one — no picker rail,
// deck, chart, limits card or boot restore iterates a provider outside this set.
// Putting one back on offer is this list plus whatever it genuinely needs.
export const OFFERED_PROVIDERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
] as const satisfies readonly ProviderKind[];

export type OfferedProvider = (typeof OFFERED_PROVIDERS)[number];

/** Whether kone offers this provider to the user. Takes a bare string so a value
 *  read back from storage or off the wire can be tested without an assertion,
 *  and narrows to the offered union so a caller can rely on the result. */
export function isProviderOffered(provider: string): provider is OfferedProvider {
  return OFFERED_PROVIDERS.some((offered) => offered === provider);
}
