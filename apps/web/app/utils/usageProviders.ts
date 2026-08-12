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

export const PROVIDER_LABEL: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  opencode: "OpenCode",
  cursor: "Cursor",
  droid: "Factory Droid",
  antigravity: "Antigravity",
};

/** Brand colours for chart bands and progress bars. */
export const PROVIDER_COLOR: Record<ProviderKind, string> = {
  codex: "#e6e6e6",
  claudeAgent: "#d97757",
  opencode: "#6366f1",
  cursor: "#a1a1aa",
  droid: "#22c55e",
  antigravity: "#4285f4",
};

export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_ORDER as readonly string[]).includes(value);
}
