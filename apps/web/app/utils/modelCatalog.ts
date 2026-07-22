// Turn a provider's flat list of raw model ids into a picker-ready catalog:
// one entry per model *family*, each carrying the real reasoning efforts that
// family supports.
//
// The wrinkle this solves: some providers bake the effort into the id itself.
// Antigravity's `agy models` emits `gemini-3.5-flash-low`, `-medium`, `-high`
// as three separate ids — but to the user that's ONE model (Gemini 3.5 Flash)
// with three effort settings. So we group by the family core and collect the
// baked suffixes as selectable efforts. The id we send to the backend is always
// the exact raw id the CLI listed (`gemini-3.5-flash-medium`), reconstructed
// from family + chosen effort.
//
// It generalises: a future provider whose models DON'T bake effort in will list
// one id per family with no effort suffix — that family gets a single "base"
// effort, and the separate `tier` we still emit lets such a provider drive an
// `--effort`-style flag instead. Either way the UI is identical: a model picker
// plus, when there's more than one, an effort picker.

import type { ModelDescriptor } from "~/types/desktop";

export type BrandKey =
  | "gemini"
  | "claude"
  | "gpt"
  | "factory"
  | "grok"
  | "cursor"
  | "codex"
  | "antigravity"
  | "deepseek"
  | "zai"
  | "moonshot"
  | "minimax"
  | "nvidia"
  | "generic";

/** The reasoning-effort tiers we recognise as baked-in id suffixes. Ordered
 *  from lightest to heaviest so a family's efforts sort naturally. Mirrors the
 *  id (nothing to choose); `thinking` = a dedicated thinking variant. */
export type EffortTier = "base" | "low" | "medium" | "high" | "thinking";

export type EffortMeta = { label: string; hue: string; hint: string; brains: number; glow: boolean };

export const EFFORT_META: Record<EffortTier, EffortMeta> = {
  base: { label: "Standard", hue: "#71717a", hint: "no effort dial", brains: 2, glow: false },
  low: { label: "Low", hue: "#0ea5e9", hint: "light reasoning", brains: 1, glow: false },
  medium: { label: "Medium", hue: "#10b981", hint: "balanced", brains: 2, glow: false },
  high: { label: "High", hue: "#6366f1", hint: "deeper reasoning", brains: 3, glow: false },
  thinking: { label: "Thinking", hue: "#8b5cf6", hint: "extended thinking", brains: 3, glow: true },
};

const EFFORT_ORDER: EffortTier[] = ["low", "medium", "high", "thinking", "base"];

export type Effort = {
  /** The exact raw model id to send to the backend (e.g. gemini-3.5-flash-medium). */
  id: string;
  tier: EffortTier;
  label: string;
  hue: string;
  hint: string;
  brains: number;
  glow: boolean;
};

export type ModelOption = {
  /** Family core, unique within the catalog (e.g. "gemini-3.5-flash"). */
  key: string;
  label: string;
  brand: BrandKey;
  vendor: string;
  efforts: Effort[];
  /** Index into `efforts` chosen when the family is first selected. */
  defaultEffortIndex: number;
};

// Known families → clean display name (longest, most specific prefix first).
const FAMILIES: Array<[RegExp, string]> = [
  [/^gemini-3\.6-flash/, "Gemini 3.6 Flash"],
  [/^gemini-3\.5-flash/, "Gemini 3.5 Flash"],
  [/^gemini-3\.1-pro/, "Gemini 3.1 Pro"],
  [/^gemini-/, "Gemini"],
  [/^claude-opus-4-6/, "Claude Opus 4.6"],
  [/^claude-sonnet-4-6/, "Claude Sonnet 4.6"],
  [/^claude-opus/, "Claude Opus"],
  [/^claude-sonnet/, "Claude Sonnet"],
  [/^claude-/, "Claude"],
  [/^gpt-oss-120b/, "GPT-OSS 120B"],
  [/^gpt-oss/, "GPT-OSS"],
  [/^gpt-/, "GPT"],
];

function brandOf(core: string): { brand: BrandKey; vendor: string } {
  if (core.startsWith("gemini")) return { brand: "gemini", vendor: "Google" };
  if (core.startsWith("claude")) return { brand: "claude", vendor: "Anthropic" };
  if (core.startsWith("gpt")) return { brand: "gpt", vendor: "OpenAI" };
  return { brand: "generic", vendor: "" };
}

function familyLabel(core: string): string {
  const hit = FAMILIES.find(([re]) => re.test(core));
  if (hit) return hit[1];
  return core
    .split("-")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Peel a trailing effort tier off a raw id → { core, tier }. Ids with no
 *  recognised suffix are their own core with a `base` tier. */
function splitEffort(id: string): { core: string; tier: EffortTier } {
  const m = id.match(/^(.*)-(low|medium|high|thinking)$/i);
  if (m) return { core: m[1]!, tier: m[2]!.toLowerCase() as EffortTier };
  return { core: id, tier: "base" };
}

/** Group a provider's raw model list into family options with real efforts. */
export function buildModelCatalog(models: ModelDescriptor[]): ModelOption[] {
  const byCore = new Map<string, Effort[]>();
  const order: string[] = [];

  for (const m of models) {
    const { core, tier } = splitEffort(m.id);
    if (!byCore.has(core)) {
      byCore.set(core, []);
      order.push(core);
    }
    const meta = EFFORT_META[tier];
    byCore.get(core)!.push({
      id: m.id,
      tier,
      label: meta.label,
      hue: meta.hue,
      hint: meta.hint,
      brains: meta.brains,
      glow: meta.glow,
    });
  }

  return order.map((core) => {
    const efforts = byCore
      .get(core)!
      .sort((a, b) => EFFORT_ORDER.indexOf(a.tier) - EFFORT_ORDER.indexOf(b.tier));
    // Prefer medium as the resting effort, else the middle of the ladder.
    const mediumIdx = efforts.findIndex((e) => e.tier === "medium");
    const defaultEffortIndex = mediumIdx >= 0 ? mediumIdx : Math.floor((efforts.length - 1) / 2);
    const { brand, vendor } = brandOf(core);
    return { key: core, label: familyLabel(core), brand, vendor, efforts, defaultEffortIndex };
  });
}

/** The family that owns a given raw model id (or the first family as a fallback). */
export function familyForId(catalog: ModelOption[], id: string | undefined): ModelOption | undefined {
  if (!id) return catalog[0];
  return catalog.find((o) => o.efforts.some((e) => e.id === id)) ?? catalog[0];
}

/** The effort within a family that a raw id selects (or the family default). */
export function effortForId(option: ModelOption | undefined, id: string | undefined): Effort | undefined {
  if (!option) return undefined;
  return option.efforts.find((e) => e.id === id) ?? option.efforts[option.defaultEffortIndex];
}

/** Does this family expose a real effort choice (more than one), so the effort
 *  picker is worth showing? A lone `base`/`thinking` model has nothing to pick. */
export function hasEffortChoice(option: ModelOption | undefined): boolean {
  return (option?.efforts.length ?? 0) > 1;
}
