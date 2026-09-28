import { computed } from "vue";
import { PROVIDER_COLORS } from "~/utils/usageProviders";
import type { ProviderKind } from "~/types/desktop";

/** Reactive provider identity colours for the active appearance.
 *
 *  The single place chart bands, share bars and legend dots read their
 *  colour from — `PROVIDER_COLORS` holds the per-scheme tables, this picks
 *  the row the interface is actually painting. Components bind
 *  `providerColors[provider]` (auto-unwrapped in templates) so a light/dark
 *  swap repaints every usage surface with no further code. */
export function useProviderColors() {
  const { scheme } = useTheme();
  return computed<Record<ProviderKind, string>>(() => PROVIDER_COLORS[scheme.value]);
}
