import type { ProviderKind } from "~/types/desktop";

/** Series and table order — matches how the chart layers providers. */
export const PROVIDER_ORDER: readonly ProviderKind[] = [
  "codex",
  "claudeAgent",
  "opencode",
  "cursor",
  "droid",
  "antigravity",
];

export const PROVIDER_LABEL = {
  codex: "Codex",
  claudeAgent: "Claude",
  opencode: "OpenCode",
  cursor: "Cursor",
  droid: "Factory Droid",
  antigravity: "Antigravity",
} satisfies Record<ProviderKind, string>;

/** Brand colours for chart bands and progress bars. */
export const PROVIDER_COLOR = {
  codex: "#e6e6e6",
  claudeAgent: "#d97757",
  opencode: "#6366f1",
  cursor: "#a1a1aa",
  droid: "#22c55e",
  antigravity: "#4285f4",
} satisfies Record<ProviderKind, string>;

export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_ORDER as readonly string[]).includes(value);
}
