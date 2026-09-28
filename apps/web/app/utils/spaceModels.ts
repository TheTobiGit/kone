import type { ProviderKind, UsageBySlice } from "~/types/desktop";
import { describeModelId, type BrandKey } from "~/utils/modelCatalog";
import { knownProviderRows } from "~/utils/usageProviders";

// The data behind the Space's Models card, kept apart from the component so it
// can be tested. One pipeline feeds the whole card: the report's model rows are
// ranked and folded into `ModelEntry`s — the top few models plus one "other"
// entry for the long tail — and the ring, the list and the hover focus are all
// read straight off that one list.

/** Models named on their own; the rest fold into one "other" entry. */
export const TOP_MODELS = 5;
export const OTHER_KEY = "__other__";
/** The pricing resolver's free-tier suffix ("…-free", "…:free"). */
const FREE_TIER = /[-:]free$/i;
/** Each further model from one agent keeps this much of the mix its
 *  predecessor had of the agent's colour, so up to TOP_MODELS from one agent
 *  each read as a step lighter. */
const TINT_DECAY = 0.68;
/** The long tail's ring slice: a wash, never mistaken for an agent's grey. */
const OTHER_FILL = "color-mix(in srgb, var(--ink) 10%, transparent)";

export type ModelEntry = {
  kind: "model";
  key: string;
  name: string;
  agent: string;
  brand: BrandKey;
  color: string;
  /** Model responses in the window — the ranking's measure. */
  responses: number;
  outputTokens: number;
  /** Of all counted responses, 0–1. */
  share: number;
  /** A free-tier model: the name drops its "Free" and a chip says it. */
  free: boolean;
};

export type OtherEntry = {
  kind: "other";
  key: typeof OTHER_KEY;
  name: string;
  /** How many models were folded in. */
  models: number;
  color: string;
  responses: number;
  share: number;
};

export type Entry = ModelEntry | OtherEntry;

export type RankedModels = {
  /** The top models, then the folded tail when there is one. */
  entries: Entry[];
  /** Responses across every counted model. */
  total: number;
  /** How many models were counted, folded or not. */
  count: number;
};

/** Rank the report's models by how often they answered and fold the tail.
 *
 *  "Used" is counted in responses: each time a model answered (one API call,
 *  one step of an agent loop). Every agent logs one record per response, so
 *  the count means the same thing across all of them, and it doesn't lean on
 *  cache re-reads (most of a long session's tokens), on price, or on whether a
 *  model was free. Output tokens break ties. A model takes its agent's colour;
 *  a second or third model from the same agent is a lighter tint of it. */
export function rankModels(
  models: readonly UsageBySlice[],
  colors: Record<ProviderKind, string>,
): RankedModels {
  const used = knownProviderRows(models, colors).filter(({ row }) => row.prompts > 0 && row.tokens > 0);
  used.sort((a, b) => b.row.prompts - a.row.prompts || (b.row.outputTokens ?? 0) - (a.row.outputTokens ?? 0));

  const total = used.reduce((sum, { row }) => sum + row.prompts, 0);
  const share = (responses: number) => (total > 0 ? responses / total : 0);

  const seen = new Map<ProviderKind, number>();
  const ranked = used.map(({ row: m, identity }): ModelEntry => {
    const nth = seen.get(identity.provider) ?? 0;
    seen.set(identity.provider, nth + 1);
    const tint = Math.round(100 * TINT_DECAY ** nth);
    const described = describeModelId(m.label);
    const name = described.name || m.label;
    const free = FREE_TIER.test(m.label);
    return {
      kind: "model",
      key: m.key,
      name: free ? name.replace(/\s+free$/i, "") : name,
      agent: identity.label,
      brand: described.brand === "generic" ? identity.brand : described.brand,
      color: nth === 0 ? identity.color : `color-mix(in srgb, ${identity.color} ${tint}%, var(--muted))`,
      responses: m.prompts,
      outputTokens: m.outputTokens ?? 0,
      share: share(m.prompts),
      free,
    };
  });

  const entries: Entry[] = ranked.slice(0, TOP_MODELS);
  const tail = ranked.slice(TOP_MODELS);
  if (tail.length) {
    const responses = tail.reduce((sum, m) => sum + m.responses, 0);
    entries.push({
      kind: "other",
      key: OTHER_KEY,
      name: "Other models",
      models: tail.length,
      color: OTHER_FILL,
      responses,
      share: share(responses),
    });
  }
  return { entries, total, count: ranked.length };
}

// ── the half-ring ────────────────────────────────────────────────────────────
// A 180° arc from left to right, cut into annular slices by share. Every slice
// keeps a sliver so a tiny model is still something to point at.

const CX = 120;
const CY = 118;
const R_OUT = 110;
const R_IN = 74;
const GAP_DEG = 2.2;
const MIN_DEG = 3;
/** The ring's centre as a CSS transform origin, for a slice that scales. */
export const RING_ORIGIN = `${CX}px ${CY}px`;

function point(r: number, deg: number): string {
  const rad = (deg * Math.PI) / 180;
  return `${(CX + r * Math.cos(rad)).toFixed(2)} ${(CY - r * Math.sin(rad)).toFixed(2)}`;
}

/** The slice from `a` down to `b` degrees (180 is the left end). No slice can
 *  pass 180° on a half-ring, so the arcs never need the large-arc flag. */
function slicePath(a: number, b: number): string {
  return [
    `M ${point(R_OUT, a)}`,
    `A ${R_OUT} ${R_OUT} 0 0 1 ${point(R_OUT, b)}`,
    `L ${point(R_IN, b)}`,
    `A ${R_IN} ${R_IN} 0 0 0 ${point(R_IN, a)}`,
    "Z",
  ].join(" ");
}

export type RingSlice = {
  key: string;
  color: string;
  d: string;
  /** Where the slice starts and ends, in degrees (180 is the left end). */
  from: number;
  to: number;
};

/** Lay `entries` around the ring, each slice sized by its share. The slivers'
 *  minimum can overfill the arc, so spans are scaled back to close it at
 *  exactly 0°. */
export function ringSlices(entries: readonly Pick<Entry, "key" | "share" | "color">[]): RingSlice[] {
  const parts = entries.filter((e) => e.share > 0);
  if (!parts.length) return [];

  const gaps = GAP_DEG * (parts.length - 1);
  const spans = parts.map((p) => Math.max(MIN_DEG, p.share * (180 - gaps)));
  const scale = (180 - gaps) / spans.reduce((a, b) => a + b, 0);
  let at = 180;
  return parts.map((p, i) => {
    const span = spans[i]! * scale;
    const slice = { key: p.key, color: p.color, d: slicePath(at, at - span), from: at, to: at - span };
    at -= span + GAP_DEG;
    return slice;
  });
}
