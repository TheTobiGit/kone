import type { DeckReadout } from "~/components/provider/ProviderDeckLimits.vue";
import type { ProviderKind, ProviderMaintenance, ProviderStatus } from "~/types/desktop";
import type { BrandKey } from "~/utils/modelCatalog";
import { PROVIDER_BRAND } from "~/utils/modelPicker";

export type ProviderPaneMeta = {
  label: string;
  vendor: string;
  brand: BrandKey;
  grad: string;
  binary: string | null;
  defaultHome: string;
  docs: { href: string; label: string } | null;
};

export type SpineTone = "problem" | "attention" | "update";
export type SpineSignal = { tone: SpineTone; label: string };

export type ProviderPaneRow = {
  provider: ProviderKind;
  meta: ProviderPaneMeta;
  status: ProviderStatus | null;
  upkeep: ProviderMaintenance | null;
  enabled: boolean;
  shownInPicker: boolean;
  signal: SpineSignal | null;
  limits: DeckReadout;
};

export type HeroAction =
  | { kind: "update"; label: string }
  | { kind: "signin"; label: string }
  | { kind: "docs"; label: string; href: string }
  | { kind: "toggle"; label: string }
  | { kind: "busy" | "idle"; label: string };

export const PROVIDER_META = {
  codex: {
    label: "Codex",
    vendor: "OpenAI",
    brand: PROVIDER_BRAND.codex,
    grad: "linear-gradient(152deg, #14b98d 0%, #0c8a68 100%)",
    binary: "codex",
    defaultHome: "~/.codex",
    docs: { href: "https://platform.openai.com/usage", label: "OpenAI usage" },
  },
  claudeAgent: {
    label: "Claude",
    vendor: "Anthropic",
    brand: PROVIDER_BRAND.claudeAgent,
    grad: "linear-gradient(152deg, #e79269 0%, #cf6238 100%)",
    binary: null,
    defaultHome: "~/.claude",
    docs: {
      href: "https://docs.anthropic.com/en/docs/about-claude/models#rate-limits",
      label: "Anthropic limits",
    },
  },
  cursor: {
    label: "Cursor",
    vendor: "Cursor",
    brand: PROVIDER_BRAND.cursor,
    grad: "linear-gradient(152deg, #4c4c55 0%, #191920 100%)",
    binary: "cursor-agent",
    defaultHome: "~/.cursor",
    docs: { href: "https://cursor.com/dashboard", label: "Cursor dashboard" },
  },
  opencode: {
    label: "OpenCode",
    vendor: "OpenCode",
    brand: PROVIDER_BRAND.opencode,
    grad: "linear-gradient(152deg, #4a4642 0%, #201d1d 100%)",
    binary: "opencode",
    defaultHome: "~/.config/opencode",
    docs: { href: "https://opencode.ai/docs", label: "OpenCode docs" },
  },
  droid: {
    label: "Factory Droid",
    vendor: "Factory",
    brand: PROVIDER_BRAND.droid,
    grad: "linear-gradient(152deg, #52525b 0%, #27272a 100%)",
    binary: "droid",
    defaultHome: "~/.factory",
    docs: null,
  },
  antigravity: {
    label: "Antigravity",
    vendor: "Google",
    brand: PROVIDER_BRAND.antigravity,
    grad: "linear-gradient(152deg, #6ea8fe 0%, #4285f4 100%)",
    binary: "agy",
    defaultHome: "~/.gemini/antigravity-cli",
    docs: { href: "https://antigravity.google", label: "Antigravity" },
  },
  cline: {
    label: "Cline",
    vendor: "Cline",
    brand: PROVIDER_BRAND.cline,
    grad: "linear-gradient(152deg, #bd8bfc 0%, #9f58fa 100%)",
    binary: "cline",
    defaultHome: "~/.cline",
    docs: { href: "https://cline.bot", label: "Cline docs" },
  },
} satisfies Record<ProviderKind, ProviderPaneMeta>;

export const INSTALL_SOURCE_LABEL = {
  npm: "npm (global)",
  bun: "bun (global)",
  pnpm: "pnpm (global)",
  homebrew: "Homebrew",
  native: "the CLI's own channel",
  bundled: "bundled with kone",
  unknown: "unrecognised",
} satisfies Record<string, string>;

export function hasUpdate(status: ProviderStatus | null, m: ProviderMaintenance | null): boolean {
  return Boolean(m?.standing === "behind" && m.latestKnowable && status?.available);
}
