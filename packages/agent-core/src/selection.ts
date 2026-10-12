import { z } from "zod";

import { ProviderKindSchema } from "./types.js";
import type { InteractionMode, ProviderKind, StoredThreadMeta } from "./types.js";

// A thread's pick, and the memory that fills in the parts a pick left open.
//
// A queued follow-up carries the selection current when it was queued: the
// provider plus the picker knobs. It is what lets a provider switch ride
// delivery order (a row whose provider differs from the thread's current owner
// is handed in before it runs) while a same-provider knob change simply rides
// the turn that carries it.

/** One turn's target: the provider it runs on and the picker knobs that ride
 *  with it. `provider` is required — an unspecified provider is the thread's
 *  current owner, which callers resolve before building this. */
export type TurnSelection = {
  provider: ProviderKind;
  model?: string;
  effort?: string;
  serviceTier?: string;
  contextWindow?: string;
  mode?: InteractionMode;
};

/** The knob half of a selection: the axes the picker commits one at a time and
 *  that `model_selection_json` stores. Kept apart from `provider`/`model`
 *  because these are what the remembered-options table keys its values on. */
export type SelectionKnobs = {
  effort?: string;
  serviceTier?: string;
  contextWindow?: string;
  mode?: InteractionMode;
};

const InteractionModeSchema = z.enum(["ask", "accept-edits", "full-access"]);

/** Wire shape of a stored selection: the pick blocks the store holds as JSON
 *  (the thread's pending pick and a queued row's provider blob). Optional
 *  fields stay optional — an absent knob means "not named here", not an empty
 *  one. */
export const TurnSelectionSchema = z.object({
  provider: ProviderKindSchema,
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  serviceTier: z.string().min(1).optional(),
  contextWindow: z.string().min(1).optional(),
  mode: InteractionModeSchema.optional(),
});

/** Decode a stored selection, treating malformed JSON as absent rather than
 *  throwing on a hand-edited row. */
export function parseTurnSelection(json: string | null | undefined): TurnSelection | null {
  if (!json) return null;
  try {
    const parsed = TurnSelectionSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The column value for a selection: JSON, or null when there is none. */
export function serializeTurnSelection(selection: TurnSelection): string {
  return JSON.stringify(selection);
}

/** The knobs a thread currently holds, from its stored selection. */
export function selectionKnobs(meta: StoredThreadMeta | null | undefined): SelectionKnobs {
  const out: SelectionKnobs = {};
  const selection = meta?.selection;
  if (selection?.effort) out.effort = selection.effort;
  if (selection?.serviceTier) out.serviceTier = selection.serviceTier;
  if (selection?.contextWindow) out.contextWindow = selection.contextWindow;
  if (selection?.mode) out.mode = selection.mode;
  return out;
}

/** Whether two selections name the same provider and model — the axis a
 *  hand-in is defined on. A knob difference is not a hand-in: the adapters
 *  apply model and config options on the turn that carries them. */
export function sameProviderModel(
  a: Pick<TurnSelection, "provider" | "model">,
  b: Pick<TurnSelection, "provider" | "model">,
): boolean {
  return a.provider === b.provider && (a.model ?? "") === (b.model ?? "");
}

/** Whether two knob sets hold the same values, treating an absent field as
 *  "unset" rather than a distinct empty string. */
export function knobsEqual(a: SelectionKnobs, b: SelectionKnobs): boolean {
  return (
    (a.effort ?? "") === (b.effort ?? "") &&
    (a.serviceTier ?? "") === (b.serviceTier ?? "") &&
    (a.contextWindow ?? "") === (b.contextWindow ?? "") &&
    (a.mode ?? "") === (b.mode ?? "")
  );
}

/**
 * Fill a selection's knobs in the order a returning pick reads them: an
 * explicit pick on the row, then the knobs remembered for that provider+model,
 * then the thread's current knobs, then nothing (the provider's own default).
 *
 * The remembered layer is the whole point: a pick that names only the model
 * restores the effort that model last ran with, not the effort of whatever
 * provider ran in between. The thread's current knobs are the weakest named
 * layer, so returning to a model whose knobs were never recorded still keeps
 * the thread where it is rather than dropping to a provider default.
 */
export function resolveSelectionKnobs(input: {
  explicit?: SelectionKnobs | null;
  remembered?: SelectionKnobs | null;
  current?: SelectionKnobs | null;
}): SelectionKnobs {
  const layers = [input.explicit, input.remembered, input.current];
  const pick = <K extends keyof SelectionKnobs>(key: K): SelectionKnobs[K] => {
    for (const layer of layers) {
      const value = layer?.[key];
      if (value) return value;
    }
    return undefined;
  };
  const out: SelectionKnobs = {};
  const effort = pick("effort");
  if (effort) out.effort = effort;
  const serviceTier = pick("serviceTier");
  if (serviceTier) out.serviceTier = serviceTier;
  const contextWindow = pick("contextWindow");
  if (contextWindow) out.contextWindow = contextWindow;
  const mode = pick("mode");
  if (mode) out.mode = mode;
  return out;
}
