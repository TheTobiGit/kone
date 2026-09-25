// What a request ran with, and the one quiet line a change renders as.
// Derived from the per-request stamps the send path leaves on user blocks.
// Pure, so change detection is pinned by unit tests rather than by scrolling
// long threads.
//
// Model and effort are read together on purpose. They are stamped together,
// they are picked together (one visit to the picker commits both), and a turn
// that moves both moved once — so one line says so, rather than two rows
// stacking above the same request and reading as two separate decisions.
import {
  describeModelId,
  effortMeta,
  isPlaceholderModelId,
  type EffortMeta,
  type EffortTier,
  type ModelDescription,
  type ModelOption,
} from "~/utils/modelCatalog";
import type { ThreadBlock, UserBlock } from "~/composables/agentTypes";

/** The smallest exchange shape derivation reads — a stable key plus the
 *  blocks grouped under it (one request + its response). */
export type TurnSettingExchange = {
  key: string;
  blocks: ThreadBlock[];
};

/** One switch in what the thread runs with: whichever of the two axes moved,
 *  carrying the value the previous request ran with and the one the new
 *  request runs with. At least one leg is always present — an entry with
 *  neither is never recorded. Keyed by the exchange it precedes. */
export type TurnSettingChange = {
  /** The exchange key this change renders above. */
  key: string;
  effort?: { from: EffortTier; to: EffortTier };
  model?: { from: string; to: string };
};

/** Walk the exchanges oldest-first and mark every request whose stamps differ
 *  from the previous stamped request.
 *
 *  The two axes keep their own baselines, because they are stamped
 *  independently: a request can carry a tier and no model (the provider ran
 *  its own default), and stored history predating either stamp carries
 *  neither. An unstamped axis neither marks nor moves its baseline — the
 *  first stamped request after history sets it silently, so reopening an old
 *  thread never accuses it of a switch that happened off-screen.
 *
 *  A placeholder model stamp ("default") is the provider's own default spelled
 *  as an id rather than stated by omission, so it reads as unstamped for the
 *  same reason: naming it would render a model that points at nothing. */
export function deriveTurnSettingMarks(
  exchanges: readonly TurnSettingExchange[],
): Map<string, TurnSettingChange> {
  const marks = new Map<string, TurnSettingChange>();
  let effortBaseline: EffortTier | undefined;
  let modelBaseline: string | undefined;
  for (const ex of exchanges) {
    const request = ex.blocks.find((b): b is UserBlock => b.role === "user");
    if (!request) continue;
    const change: TurnSettingChange = { key: ex.key };
    const tier = request.effort;
    if (tier) {
      if (effortBaseline !== undefined && tier !== effortBaseline) {
        change.effort = { from: effortBaseline, to: tier };
      }
      effortBaseline = tier;
    }
    const model = request.model;
    if (model && !isPlaceholderModelId(model)) {
      if (modelBaseline !== undefined && model !== modelBaseline) {
        change.model = { from: modelBaseline, to: model };
      }
      modelBaseline = model;
    }
    if (change.effort || change.model) marks.set(ex.key, change);
  }
  return marks;
}

/** One end of the line: the model and the tier as that side ran them, each
 *  present only when its axis moved — a value that did not change is not what
 *  the line is about.
 *
 *  The single authority on what a leg *is*. The rendered marker and the
 *  accessible name both come through here, over the same catalog, so the name
 *  a screen reader hears is the name on screen — two resolvers would drift the
 *  moment a catalog entry is renamed. */
export type TurnSettingLeg = {
  model: ModelDescription | null;
  effort: EffortMeta | null;
};

export function turnSettingLeg(
  change: TurnSettingChange,
  side: "from" | "to",
  catalog?: ModelOption[],
): TurnSettingLeg {
  return {
    model: change.model ? describeModelId(change.model[side], catalog) : null,
    effort: change.effort ? effortMeta(change.effort[side]) : null,
  };
}

/** One quiet centered line, as a sentence — the marker's accessible name, and
 *  the vocabulary the picker itself uses, so the two never disagree about
 *  what a tier or a model is called. Takes the same catalog the marker renders
 *  with; without one, model ids read as their prettified selves. */
export function turnSettingChangeLabel(
  change: TurnSettingChange,
  catalog?: ModelOption[],
): string {
  const say = (side: "from" | "to"): string => {
    const { model, effort } = turnSettingLeg(change, side, catalog);
    return [model?.name, effort?.label].filter(Boolean).join(" · ");
  };
  // The line opens by naming the axes that actually moved, so it never implies
  // a change the legs don't show.
  const moved = change.model && change.effort ? "Model & effort" : change.model ? "Model" : "Reasoning effort";
  return `${moved} ${say("from")} → ${say("to")}`;
}

