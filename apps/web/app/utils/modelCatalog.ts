// Turn a provider's flat list of raw model ids into a picker-ready catalog:
// one entry per model *family*, each carrying the real reasoning efforts that
// family supports.
//
// Two ways a family ends up with more than one effort:
//   1. The provider bakes the effort into the id itself — three separate ids
//      that are really "one model, three settings" (this is how Antigravity's
//      `agy models` worked; no live provider does this anymore, but the code
//      stays generic in case a future one does). We group those by family core
//      and collect the baked suffixes as selectable efforts, and the id we
//      send to the backend is the exact raw id the CLI listed, reconstructed
//      from family + chosen effort.
//   2. The provider exposes reasoning effort as a *separate turn parameter*,
//      not part of the model id (Codex: `model/list` returns bare ids like
//      `gpt-5.6-terra` with no suffix, plus each model's own real
//      `supportedReasoningEfforts`/`defaultReasoningEffort` — this varies per
//      model, e.g. gpt-5.6-terra offers low/medium/high/xhigh/max/ultra with
//      no `minimal`). We build the ladder from that real per-model data —
//      never a fixed guess — same `modelId` (the bare id) for every rung,
//      `tier` carrying which one is picked so the adapter can map it to its
//      own effort flag.
// Either way the UI is identical: a model picker plus, when there's more than
// one, an effort picker. `Effort.id` is a unique key for the picker; the id
// actually sent to the backend as `--model`/turn param is always `modelId`.

import type { ModelDescriptor, ProviderKind } from "~/types/desktop";

export type BrandKey =
  | "gemini"
  | "claude"
  | "gpt"
  | "codex"
  | "cursor"
  | "grok"
  | "opencode"
  | "deepseek"
  | "qwen"
  | "kimi"
  | "minimax"
  | "xiaomi"
  | "nvidia"
  | "zai"
  | "droid"
  | "antigravity"
  | "generic";

/** Provider kinds that are *harnesses* — a house of upstream providers, so one
 *  provider's catalog spans many real vendors (opencode → deepseek, openai,
 *  qwen, …; cursor re-sells claude, gpt, gemini, grok, kimi plus its own
 *  `composer-*` family; antigravity re-sells Gemini, Claude and GPT-OSS). For
 *  these, a model row shows the harness's own mark with the model's true vendor
 *  badge on its corner, instead of the vendor mark alone. */
export const HARNESS_PROVIDERS: ReadonlySet<ProviderKind> = new Set([
  "opencode",
  "cursor",
  "antigravity",
]);

/** The reasoning-effort tiers we know how to style, whether baked into an id
 *  suffix or reported live by a provider's real `supportedReasoningEfforts`.
 *  Ordered from lightest to heaviest so a family's efforts sort naturally.
 *  effort concept at all (nothing to choose); `thinking` = a dedicated
 *  thinking variant (baked-suffix providers only). A model reporting a tier
 *  outside this set (a provider adding a new rung) still renders — see
 *  `effortMeta()`'s fallback below — it just won't have bespoke styling yet. */
export type EffortTier =
  | "base"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "thinking";

export type EffortMeta = { label: string; hue: string; hint: string; brains: number; glow: boolean };

export const EFFORT_META = {
  base: { label: "Standard", hue: "#71717a", hint: "no effort dial", brains: 2, glow: false },
  none: { label: "None", hue: "#a1a1aa", hint: "no reasoning", brains: 1, glow: false },
  minimal: { label: "Minimal", hue: "#71717a", hint: "fastest, least reasoning", brains: 1, glow: false },
  low: { label: "Low", hue: "#0ea5e9", hint: "light reasoning", brains: 1, glow: false },
  medium: { label: "Medium", hue: "#10b981", hint: "balanced", brains: 2, glow: false },
  high: { label: "High", hue: "#6366f1", hint: "deeper reasoning", brains: 3, glow: false },
  xhigh: { label: "Extra High", hue: "#a855f7", hint: "extra-deep reasoning", brains: 4, glow: false },
  max: { label: "Max", hue: "#d946ef", hint: "maximum reasoning", brains: 4, glow: true },
  ultra: { label: "Ultra", hue: "#ec4899", hint: "heaviest reasoning available", brains: 5, glow: true },
  thinking: { label: "Thinking", hue: "#8b5cf6", hint: "extended thinking", brains: 3, glow: true },
} satisfies Record<EffortTier, EffortMeta>;

const EFFORT_ORDER: EffortTier[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "thinking",
  "base",
];

/** Meta for a tier, tolerant of a provider reporting a rung we don't have
 *  bespoke styling for yet — falls back to `medium`'s look rather than
 *  throwing, so an unrecognised real value still renders sensibly. */
function effortMeta(tier: EffortTier): EffortMeta {
  return EFFORT_META[tier] ?? EFFORT_META.medium;
}

export type Effort = {
  /** Unique key within the family, for picker bookkeeping (:key, comparisons
   *  against a pending selection). NOT what gets sent to the backend. */
  id: string;
  /** The exact model id to send to the backend (e.g. `--model`/turn param). */
  modelId: string;
  tier: EffortTier;
  label: string;
  hue: string;
  hint: string;
  brains: number;
  glow: boolean;
};

/** One installed provider's catalog as the model picker consumes it — a rail
 *  entry plus its built families. Lives here (not in the .vue) so both the
 *  picker and its host can share the type. */
export type PickerProvider = {
  id: ProviderKind;
  label: string;
  /** Rail subtitle, e.g. "OpenAI · 4 models". */
  sub: string;
  brand: BrandKey;
  ready: boolean;
  models: ModelOption[];
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
  /** This family's real "fast" service tier (Codex's `serviceTiers`/deprecated
   *  `additionalSpeedTiers`), when it has one — most models don't. A boolean
   *  toggle in the UI; the `id` is what actually goes on the turn. */
  fastTier?: { id: string; label: string };
  /** True when the provider's catalog names this model's `fast` tier as its
   *  DEFAULT service tier (`ModelDescriptor.defaultServiceTier`) — the toggle
   *  should start on rather than off when the family is first selected. */
  fastDefault?: boolean;
  /** This family's context-window choices (Claude's 200k/1m auto-compact
   *  window), when it has more than a single fixed window. A small cycle in the
   *  UI; the chosen `id` rides each turn as `contextWindow`. */
  contextWindows?: { id: string; label: string; tokens: number; isDefault?: boolean }[];
};

/** Which vendor actually *made* a model, keyed off its bare id. Ordered: the
 *  first match wins, so put anchored families ahead of loose tokens. A vendor
 *  we can name but have no logomark for still gets its name (brand `generic`
 *  renders the calm dot) — better an honest dot than the wrong mark. */
const MODEL_VENDORS: [RegExp, BrandKey, string][] = [
  // Cursor's own in-house family. Re-sold vendors (claude/gpt/gemini/…) match
  // further down, so only `composer-*` and the auto/default aliases land here.
  [/^composer-/, "cursor", "Cursor"],
  [/^(default|auto)$/, "cursor", "Cursor"],
  [/^claude/, "claude", "Anthropic"],
  [/^(gemini|gemma)/, "gemini", "Google"],
  [/^(gpt|o3|o4)/, "gpt", "OpenAI"],
  [/deepseek/, "deepseek", "DeepSeek"],
  [/qwen/, "qwen", "Alibaba"],
  [/kimi/, "kimi", "Moonshot AI"],
  [/glm/, "zai", "Z.ai"],
  [/minimax/, "minimax", "MiniMax"],
  [/mimo/, "xiaomi", "Xiaomi"],
  [/nemotron/, "nvidia", "NVIDIA"],
  [/grok/, "grok", "xAI"],
];

/** Fallback for a model id that names no vendor we know — the gateway it came
 *  through is the next best signal. */
const GATEWAY_VENDORS: [RegExp, BrandKey, string][] = [
  [/^anthropic/, "claude", "Anthropic"],
  [/^(google|vertex)/, "gemini", "Google"],
  [/^(openai|azure)/, "gpt", "OpenAI"],
  [/^deepseek/, "deepseek", "DeepSeek"],
  [/^(alibaba|qwen|dashscope)/, "qwen", "Alibaba"],
  [/^moonshot/, "kimi", "Moonshot AI"],
  [/^(zai|zhipu)/, "zai", "Z.ai"],
  [/^minimax/, "minimax", "MiniMax"],
  [/^cerebras/, "generic", "Cerebras"],
  [/^(xai|grok)/, "grok", "xAI"],
  // Last: the harness gateways themselves. Only reached when neither the model id
  // nor a named upstream matched, i.e. it really is a harness-native model.
  [/^opencode/, "opencode", "OpenCode"],
  [/^cursor/, "cursor", "Cursor"],
  [/^agy/, "antigravity", "Antigravity"],
];

/** The logomark and vendor name for a catalog entry.
 *
 *  Codex and Claude are single-vendor, so their bare ids (`gpt-5.6-terra`,
 *  `claude-sonnet-4-5`) answer this directly. OpenCode is different: it's a
 *  *house of providers*, and its ids are `gateway/model` — `opencode-go/deepseek-v4-flash`
 *  is DeepSeek's model merely served through OpenCode. Branding the whole
 *  catalog "OpenCode" would erase every real vendor, so the model id is asked
 *  first and the gateway is only a fallback. The OpenCode mark itself is for
 *  the provider (the rail, the picker's provider row) and for models OpenCode
 *  actually originates. */
function brandOf(core: string): Pick<ModelOption, "brand" | "vendor"> {
  const slash = core.indexOf("/");
  const gateway = slash > 0 ? core.slice(0, slash).toLowerCase() : "";
  // Cursor's ids carry a bracketed turn-parameter suffix
  // (`claude-opus-5[thinking=true,effort=high]`) that is not part of the model
  // name — peel it so it never defeats vendor matching.
  const model = (slash > 0 ? core.slice(slash + 1) : core)
    .replace(/\[[^\]]*\]$/u, "")
    .toLowerCase();
  for (const [re, brand, vendor] of MODEL_VENDORS) if (re.test(model)) return { brand, vendor };
  for (const [re, brand, vendor] of GATEWAY_VENDORS) if (re.test(gateway)) return { brand, vendor };
  return { brand: "generic", vendor: "" };
}

/** The logomark a running session/thread should show. For a harness provider
 *  (opencode) that's the model's *true* vendor resolved from its id — an
 *  opencode thread on DeepSeek shows DeepSeek — falling back to the provider's
 *  own mark (`providerBrand`) when the model names no vendor we know. For a
 *  single-vendor provider it's just that provider's mark. So every session
 *  surface — strip headers, recent rows, away pills — shares one rule. */
export function sessionBrand(
  provider: ProviderKind,
  providerBrand: BrandKey,
  modelId: string | undefined,
): BrandKey {
  if (modelId && HARNESS_PROVIDERS.has(provider)) {
    const { brand } = brandOf(modelId);
    if (brand !== "generic") return brand;
  }
  return providerBrand;
}

// A few ids whose Title-Case would read wrong — kept short and honest.
const MODEL_ACRONYMS: Record<string, string> = { gpt: "GPT", glm: "GLM", ai: "AI" };

/** Turn a bare model id into a human name when we have no catalog `label` for
 *  it — e.g. a subagent's `claude-sonnet-5` → "Claude Sonnet 5", `claude-haiku-4-5`
 *  → "Claude Haiku 4.5". Drops a trailing date stamp and a `gateway/` prefix,
 *  Title-Cases the words, and joins adjacent version numbers with a dot. */
function prettifyModelId(core: string): string {
  const slash = core.lastIndexOf("/");
  const bare = (slash >= 0 ? core.slice(slash + 1) : core).replace(/-?\d{6,}$/, "");
  const out: string[] = [];
  for (const raw of bare.split(/[-_]/).filter(Boolean)) {
    const token = raw.toLowerCase();
    if (/^\d+$/.test(token)) {
      const prev = out[out.length - 1];
      if (prev && /^[\d.]+$/.test(prev)) out[out.length - 1] = `${prev}.${token}`;
      else out.push(token);
    } else {
      out.push(MODEL_ACRONYMS[token] ?? token.charAt(0).toUpperCase() + token.slice(1));
    }
  }
  return out.join(" ") || core;
}

/** A resolved model identity: the logomark brand to show and the display name
 *  to render for a raw model id outside any built catalog. */
export type ModelDescription = {
  brand: BrandKey;
  name: string;
};

/** The logomark brand + display name for a raw model id, independent of any live
 *  catalog — for surfaces that hold an id but not the built family (e.g. a nested
 *  subagent's `model`). Prefers a real catalog label when one is passed. */
export function describeModelId(
  id: string | undefined,
  catalog?: ModelOption[],
): ModelDescription {
  if (!id) return { brand: "generic", name: "Default model" };
  const fam = catalog ? familyForId(catalog, id) : undefined;
  const { core } = splitEffort(id);
  const { brand } = brandOf(core);
  return { brand: fam?.brand ?? brand, name: fam?.label ?? prettifyModelId(core) };
}

/** A raw model id peeled into its family core and its trailing effort tier. */
type EffortSplit = {
  core: string;
  tier: EffortTier;
};

/** Peel a trailing effort tier off a raw id → { core, tier }. Ids with no
 *  recognised suffix are their own core with a `base` tier. */
function splitEffort(id: string): EffortSplit {
  // Defensive: a non-string (or missing) id must never throw — it degrades to
  // its own core with no effort axis, and the caller can skip it if it wants.
  const m = String(id ?? "").match(/^(.*)-(none|minimal|low|medium|high|xhigh|max|ultra|thinking)$/i);
  if (m) return { core: m[1]!, tier: m[2]!.toLowerCase() as EffortTier };
  return { core: String(id ?? ""), tier: "base" };
}

function toEffort(id: string, modelId: string, tier: EffortTier): Effort {
  const meta = effortMeta(tier);
  return { id, modelId, tier, label: meta.label, hue: meta.hue, hint: meta.hint, brains: meta.brains, glow: meta.glow };
}

// ── raw provider model-table parsing ─────────────────────────────────────────
// Some CLIs print their catalog as a plain text table rather than JSON —
// Antigravity's `agy models` rows are `slug<TAB>Display Label (Effort)`, and
// instead of passing the `slug\tlabel` blob through as an invalid model id.
// kone's live model-list calls live in the desktop adapters, which parse
// structured JSON today; this is the defensive parser those adapters (or any
// future text-format provider) should run raw table output through. It is
// deliberately total: malformed rows are skipped, never thrown on.

export type ParsedModelRow = { id: string; label: string };

/** Header words a first line may use to name its columns. Only recognized when
 *  EVERY cell of the first non-blank line is one, so a real model actually
 *  named e.g. `model` still parses. */
const MODEL_TSV_HEADER_CELLS = new Set([
  "id",
  "model",
  "model id",
  "slug",
  "name",
  "label",
  "display name",
  "model name",
]);

/** Parse a provider's plain-text model table into (id, label) rows.
 *
 *  Defensive by design:
 *  - CRLF or LF line endings, and stray ANSI colour codes, are tolerated.
 *  - A row is `slug<TAB>label` (Antigravity `agy models` style); a lone column
 *    means the id is its own label. Cells are trimmed, so extra whitespace
 *    around the tab is harmless.
 *  - A leading header row is skipped when every cell is a known header word;
 *    headerless output parses fine either way.
 *  - Malformed rows (blank id, blank line) are skipped — never thrown on, and
 *    never emitted as garbage entries. */
export function parseModelTsvRows(text: string): ParsedModelRow[] {
  const rows: ParsedModelRow[] = [];
  const lines = String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split("\t").map((c) => c.trim());
    // A header row is only ever the first non-blank line, and only when every
    // cell is a known header word.
    if (
      rows.length === 0 &&
      cells.length > 0 &&
      cells.every((c) => MODEL_TSV_HEADER_CELLS.has(c.toLowerCase()))
    ) {
      continue;
    }
    const id = (cells[0] ?? "").trim();
    if (!id) continue; // malformed row — nothing to key a family on
    const label = (cells[1] ?? "").trim();
    rows.push({ id, label: label || id });
  }
  return rows;
}

/** Group a provider's raw model list into family options with real efforts. */
export function buildModelCatalog(models: ModelDescriptor[]): ModelOption[] {
  const byCore = new Map<
    string,
    {
      label: string;
      efforts: Effort[];
      defaultReasoningEffort?: string;
      defaultServiceTier?: string;
      serviceTiers?: ModelDescriptor["serviceTiers"];
      contextWindows?: ModelDescriptor["contextWindows"];
    }
  >();
  const order: string[] = [];

  for (const m of models) {
    // A malformed descriptor — blank id, or a non-string sneaking over IPC —
    // can't key a family: skip it rather than emitting a garbage entry or
    // throwing inside splitEffort.
    if (!m || typeof m.id !== "string" || !m.id.trim()) continue;
    const { core, tier } = splitEffort(m.id);
    if (!byCore.has(core)) {
      // The id's own label (e.g. Codex's real `displayName`) IS the family
      // name — no need to re-derive one from the id.
      byCore.set(core, {
        // A blank label degrades to the prettified id — the adapters already
        // default label→id at their end; this is the same fallback one layer up.
        label: (m.label ?? "").trim() || prettifyModelId(core),
        efforts: [],
        defaultReasoningEffort: m.defaultReasoningEffort,
        defaultServiceTier: m.defaultServiceTier,
        serviceTiers: m.serviceTiers,
        contextWindows: m.contextWindows,
      });
      order.push(core);
    }
    const bucket = byCore.get(core)!.efforts;
    if (tier !== "base") {
      // A literal baked suffix — respect it verbatim.
      bucket.push(toEffort(m.id, m.id, tier));
    } else if (m.reasoningEfforts?.length) {
      // No baked suffix: this id is a bare family model. Build its ladder from
      // the real per-model efforts the provider reported — a flag-based
      // provider (Codex) sends the tier as a separate turn param, not folded
      // into the model id, and which rungs exist varies model to model.
      for (const rung of m.reasoningEfforts) bucket.push(toEffort(`${m.id}::${rung}`, m.id, rung as EffortTier));
    } else {
      // No reasoning-effort axis reported at all for this model.
      bucket.push(toEffort(m.id, m.id, "base"));
    }
  }

  return order.map((core) => {
    const {
      label,
      efforts: bucketEfforts,
      defaultReasoningEffort,
      defaultServiceTier,
      serviceTiers,
      contextWindows,
    } = byCore.get(core)!;
    const efforts = bucketEfforts.sort((a, b) => EFFORT_ORDER.indexOf(a.tier) - EFFORT_ORDER.indexOf(b.tier));
    // Prefer the provider's own default, else medium, else the middle rung.
    const providerDefaultIdx = defaultReasoningEffort
      ? efforts.findIndex((e) => e.tier === defaultReasoningEffort)
      : -1;
    const mediumIdx = efforts.findIndex((e) => e.tier === "medium");
    const defaultEffortIndex =
      providerDefaultIdx >= 0 ? providerDefaultIdx : mediumIdx >= 0 ? mediumIdx : Math.floor((efforts.length - 1) / 2);
    const { brand, vendor } = brandOf(core);
    // "Fast" is the only speed tier any real Codex model has offered so far —
    // surface it as a plain on/off toggle rather than a full tier picker.
    const fastEntry = serviceTiers?.find((t) => t.id.toLowerCase() === "fast");
    const fastTier = fastEntry ? { id: fastEntry.id, label: fastEntry.label } : undefined;
    // The provider's catalog default tier (Codex `defaultServiceTier`) pre-sets
    // the toggle — a model whose default is "fast" opens with fast mode on.
    const fastDefault = fastTier !== undefined && defaultServiceTier?.toLowerCase() === "fast";
    const option: ModelOption = {
      key: core,
      label,
      brand,
      vendor,
      efforts,
      defaultEffortIndex,
    };
    if (fastTier) {
      option.fastTier = fastTier;
      if (fastDefault) option.fastDefault = true;
    }
    if (contextWindows && contextWindows.length > 1) option.contextWindows = contextWindows;
    return option;
  });
}

/** The family that owns a given raw model id (or the first family as a fallback). */
export function familyForId(catalog: ModelOption[], id: string | undefined): ModelOption | undefined {
  if (!id) return catalog[0];
  return catalog.find((o) => o.efforts.some((e) => e.modelId === id)) ?? catalog[0];
}

/** The effort within a family matching a known reasoning tier (or the family
 *  default). Disambiguates correctly even when a synthetic ladder's rungs all
 *  share one `modelId` — the tier is the only thing that tells them apart. */
export function effortForTier(option: ModelOption | undefined, tier: EffortTier | undefined): Effort | undefined {
  if (!option) return undefined;
  return option.efforts.find((e) => e.tier === tier) ?? option.efforts[option.defaultEffortIndex];
}

/** Does this family expose a real effort choice (more than one), so the effort
 *  picker is worth showing? A lone `base`/`thinking` model has nothing to pick. */
export function hasEffortChoice(option: ModelOption | undefined): boolean {
  return (option?.efforts.length ?? 0) > 1;
}
