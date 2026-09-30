import type { ProviderKind } from "~/types/desktop";
import { SESSION_BRAND } from "~/types/session";
import type { ThemeScheme } from "~/theme/roles";
import type { BrandKey } from "~/utils/modelCatalog";

/** Series and table order — matches how the chart layers providers. */
export const PROVIDER_ORDER: readonly ProviderKind[] = [
  "codex",
  "claudeAgent",
  "opencode",
  "cursor",
  "droid",
  "antigravity",
  "cline",
];

export const PROVIDER_LABEL = {
  codex: "Codex",
  claudeAgent: "Claude",
  opencode: "OpenCode",
  cursor: "Cursor",
  droid: "Factory Droid",
  antigravity: "Antigravity",
  cline: "Cline",
} satisfies Record<ProviderKind, string>;

/** Brand colours for chart bands and progress bars, per appearance.
 *
 *  Four of the seven vendors are monochrome in real life (OpenAI, OpenCode,
 *  Cursor, Factory are all near-black on off-white), so fully brand-faithful
 *  colours would be four indistinguishable dark lines. Each entry below is
 *  anchored in the vendor's real brand token, tuned to stay legible on kone's
 *  grounds (light `#F6F5F3` / dark `#070708`) and separable from the others:
 *  - codex: OpenAI is pure black/white — near-black ink in light, white proxy
 *    in dark (openai.com/brand; the CLI's magenta "Codex" label is a TUI
 *    convention, not the product brand).
 *  - claudeAgent: Anthropic's official accent `#D97757`, both schemes.
 *  - opencode: the brand's own warm grays — `mute` in light, `ash` in dark
 *    (`#201D1D` ink on `#FDFCFC` cream; the brand ships no saturated accent,
 *    so the old indigo had to go).
 *  - cursor: the brand's single chromatic token, accent orange `#F54E00`
 *    (otherwise warm ink `#26251E` on `#F7F7F4`), both schemes.
 *  - droid: Factory's monochrome ladder — graphite in light, cool mid gray in
 *    dark (brand `#020202` on `#F5F5F5`; the old green had no brand basis).
 *  - antigravity: Google blue `#4285F4` (≈ Antigravity royal `#3186FF`),
 *    both schemes.
  *  - cline: the brand's purple `#9F58FA`, both schemes (its ink `#151516`
  *    would read as a fifth dark line). */
export const PROVIDER_COLORS = {
  light: {
    codex: "#1b1b1e",
    claudeAgent: "#d97757",
    opencode: "#646262",
    cursor: "#f54e00",
    droid: "#3f3f46",
    antigravity: "#4285f4",
    cline: "#9f58fa",
  },
  dark: {
    codex: "#e6e6e6",
    claudeAgent: "#d97757",
    opencode: "#9a9898",
    cursor: "#f54e00",
    droid: "#71717a",
    antigravity: "#4285f4",
    cline: "#9f58fa",
  },
} satisfies Record<ThemeScheme, Record<ProviderKind, string>>;

/** The provider a report row belongs to, or null for a key no kone provider
 *  owns (an older report, a model from an agent kone doesn't list). Report rows
 *  carry a bare string; this is where it becomes a `ProviderKind`. */
export function asProviderKind(value: string | undefined): ProviderKind | null {
  return PROVIDER_ORDER.find((provider) => provider === value) ?? null;
}

/** What every usage surface shows for one provider: its name, its vendor mark
 *  and its colour. */
export type ProviderIdentity = {
  provider: ProviderKind;
  label: string;
  brand: BrandKey;
  color: string;
};

/** A provider's identity, coloured from `colors` — the active appearance's row
 *  (see `useProviderColors`). */
export function providerIdentity(provider: ProviderKind, colors: Record<ProviderKind, string>): ProviderIdentity {
  return {
    provider,
    label: PROVIDER_LABEL[provider],
    brand: SESSION_BRAND[provider],
    color: colors[provider],
  };
}

/** The rows of a report that a kone provider owns, each paired with that
 *  provider's identity. Model, provider and day-by-provider rows all name their
 *  provider in `provider`, so this is the one way a surface turns them into
 *  something it can label, mark and colour; a row no kone provider owns is
 *  left out, on every surface alike.
 *
 *  The row and the identity stay side by side rather than merged: a model row's
 *  own `label` is its model id, and the provider's `label` would overwrite it. */
export function knownProviderRows<T extends { provider?: string }>(
  rows: readonly T[],
  colors: Record<ProviderKind, string>,
): { row: T; identity: ProviderIdentity }[] {
  return rows.flatMap((row) => {
    const provider = asProviderKind(row.provider);
    return provider ? [{ row, identity: providerIdentity(provider, colors) }] : [];
  });
}
