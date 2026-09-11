import type { IdIcon } from "@hugeicons/core-free-icons";

import type { AgentModelRef } from "~/types/desktop";
import type { BrandKey } from "~/utils/modelCatalog";

// One icon type for every detail surface. Each Hugeicons export shares the
// same declared shape, so naming one of them types them all — and the tab and
// table contracts below stay concrete instead of falling back to `unknown`.
export type DetailIcon = typeof IdIcon;

// A prose paragraph with its `**lead.**` opener pulled out. The lead is set
// apart by colour rather than weight — the app font ships a single weight
// here, so bold renders as regular.
export interface DetailDirective {
  lead: string;
  body: string;
}

// A prose field split into paragraphs, each opening `**lead**` lifted out.
// A paragraph with no opener reads as plain prose.
export function toDirectives(text: string | null | undefined): DetailDirective[] {
  if (!text) return [];
  return text
    .split(/\n{2,}/)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((paragraph) => {
      const match = /^\*\*(.+?)\*\*\s*([\s\S]*)$/.exec(paragraph);
      if (!match) return { lead: "", body: paragraph };
      return { lead: (match[1] ?? "").trim(), body: (match[2] ?? "").trim() };
    });
}

// A pinned model plus its fallbacks as one chain line, `head → tail`. Null
// when nothing is pinned — the caller names what that means (`Inherits the
// thread`, `Inherits the caller`), since each surface inherits from someone
// different.
export function formatModelChain(
  model: AgentModelRef | null | undefined,
  fallbacks: readonly AgentModelRef[] | null | undefined,
): string | null {
  if (!model) return null;
  const head = model.label || model.model;
  const tail = (fallbacks ?? []).map((f) => f.label || f.model);
  return tail.length > 0 ? `${head} → ${tail.join(" → ")}` : head;
}

// Logomarks for a skill's Origin row. Shared skills live everywhere, so they
// wear every harness mark; an origin without a mark falls through to the dot.
export const ORIGIN_TO_BRAND: Record<string, BrandKey> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  factory: "droid",
};

export const AGENTS_BRANDS: BrandKey[] = ["codex", "cursor", "opencode", "droid", "antigravity"];

export function brandsForOrigin(origin: string): BrandKey[] {
  if (origin === "agents") return AGENTS_BRANDS;
  const brand = ORIGIN_TO_BRAND[origin];
  return brand ? [brand] : ["generic"];
}

export const ORIGIN_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  factory: "Factory",
  agents: "Shared",
};

// Display name for a skill origin. Unknown origins read back as themselves —
// the scan types `origin` as a plain string so a new CLI root can't break the
// contract, and the UI must not blank on one it hasn't met yet.
export function originLabel(origin: string): string {
  return ORIGIN_LABEL[origin] ?? origin;
}

// One row of the detail card table. Plain rows carry `text` (plus an optional
// muted `aside` suffix and brand marks ahead of it); `tags` renders a wrapping
// tag list instead; `emptyText` is the quiet fallback when there is nothing to
// show. A `value-<id>` slot on the table overrides the cell wholesale for the
// rows whose value is richer than text (the agent's bot chip).
export interface DetailTableRow {
  id: string;
  label: string;
  icon?: DetailIcon;
  text?: string;
  aside?: string;
  emptyText?: string;
  brands?: BrandKey[];
  tags?: string[];
  mono?: boolean;
  wrap?: boolean;
}
