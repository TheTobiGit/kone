// What one assistant turn puts on screen, under the reader's choices.
//
// A turn is an ordered list of parts (renderGroups): batches of steps (thinking
// and tool calls), text, and spawn lines. The reader's ResponseDisplay decides
// which of those show, and when — this turns the two into a plan the thread
// renders as-is. Kept pure and apart from the component so every combination of
// choices can be pinned down in tests, and so the real thread and the settings
// page's preview can't disagree: both render through this.
//
// A turn reads by its `live…` choices while it runs and by its `done…` choices
// once it settles. The rules, in the order they bite:
//
//   · Read whole, a message still being written isn't shown until it's done.
//   · The final reply always shows once the turn is over — the one constant.
//     It's the text after the turn's last batch of work.
//   · Otherwise the turn reads in arrival order: its steps unless tool calls
//     are hidden, the updates between them unless those are hidden, spawn lines
//     (things it *said*) always.
//   · While it runs, the live batch carries the working orb — or, with tool
//     calls hidden, one status line says what the agent is doing.
//   · Done with its work and updates both hidden, the turn folds down to its
//     reply behind "Worked for…".
//
// The reader's choices only set where a turn starts. The turn's own toggle (the
// agent's name in its speaker line) takes it from there, by hand: `manual` is
// that toggle's state, undefined until it's pressed. Open shows the whole turn —
// hidden work and updates included — and closed folds it down to the reply.
// Nothing a choice hides is ever out of reach.

import type { AssistantBlock } from "~/composables/useAgent";
import {
  renderGroups,
  segStreaming,
  type RenderGroup,
  type Segment,
  type WorkGroup,
} from "~/utils/conversationSegments";
import type {
  ActivityFold,
  DoneTools,
  LiveTools,
  ResponseDisplay,
  UpdatesDisplay,
} from "~/utils/responseDisplay";

export type TurnPlan = {
  /** Folded behind "Worked for…". Null when the turn doesn't fold. */
  fold: WorkGroup[] | null;
  /** Whether that fold reads open. */
  foldOpen: boolean;
  /** Everything shown in the open, in order. */
  inline: RenderGroup[];
  /** The live batch at the tail — its steps, or none yet for a bare working orb.
   *  Null when no orb shows. */
  live: Segment[] | null;
  /** One line saying what the agent is doing, in place of its steps. */
  status: boolean;
  /** How the turn's batches hold themselves. */
  activity: ActivityFold;
  /** The turn's own toggle, and whether it reads open — or null when there is
   *  nothing for it to show or fold. */
  toggle: { open: boolean } | null;
};

type Tools = LiveTools | DoneTools;
type Filter = { tools: Tools; updates: UpdatesDisplay };
type Partition = { shown: RenderGroup[]; held: boolean };

/** How batches hold themselves once they show. Hidden steps only ever show
 *  opened by hand, and then they read as they would folding as they go. */
function activityFor(tools: Tools): ActivityFold {
  if (tools === "expanded") return "open";
  if (tools === "folded") return "closed";
  return "auto";
}

/** Where the reply starts: past the turn's last batch of work. Only text is
 *  ever reply or update — a spawn line stands in the open wherever it falls,
 *  so which side of this it lands on changes nothing. */
function replyStartOf(groups: RenderGroup[]): number {
  return groups.findLastIndex((g) => g.kind === "steps") + 1;
}

/** Add a group, joining it to a batch just before it. Adjacent batches read as
 *  one — renderGroups hands each segment over as its own, and whatever stood
 *  between two may not be shown. The first batch's key holds, so the batch keeps
 *  its identity as later steps join it. */
function append<G extends RenderGroup>(out: G[], g: G): void {
  const last = out[out.length - 1];
  if (g.kind === "steps" && last?.kind === "steps") {
    // SAFETY: both are steps groups, and a steps group with more segments is
    // still a steps group.
    out[out.length - 1] = { ...last, segments: [...last.segments, ...g.segments] } as G;
  } else out.push(g);
}

/** One pass over the turn: what stands in the open, in arrival order, and
 *  whether the filter held anything back. An update is text before the reply —
 *  and while the turn runs, nothing is the reply yet. */
function partition(groups: RenderGroup[], filter: Filter, running: boolean): Partition {
  const replyStart = replyStartOf(groups);
  const shown: RenderGroup[] = [];
  let held = false;
  groups.forEach((g, i) => {
    const show =
      g.kind === "steps"
        ? filter.tools !== "hidden"
        : g.kind === "text"
          ? filter.updates === "show" || (!running && i >= replyStart)
          : true;
    if (show) append(shown, g);
    else held = true;
  });
  return { shown, held };
}

export function planTurn(block: AssistantBlock, display: ResponseDisplay, manual?: boolean): TurnPlan {
  return block.state === "running" ? planLive(block, display, manual) : planDone(block, display, manual);
}

function planLive(block: AssistantBlock, display: ResponseDisplay, manual?: boolean): TurnPlan {
  const all = renderGroups(block);

  // Read whole, the message being written waits until it's written.
  const tail = all[all.length - 1];
  if (display.liveText === "whole" && tail?.kind === "text" && segStreaming(tail.seg)) all.pop();

  // Opened by hand, nothing is held back: hidden steps show as they would
  // folding as they go, and every update shows.
  const filter: Filter = manual
    ? { tools: display.liveTools === "hidden" ? "fold-as-it-goes" : display.liveTools, updates: "show" }
    : { tools: display.liveTools, updates: display.liveUpdates };
  const { shown, held } = partition(all, filter, true);
  const base = {
    fold: null,
    foldOpen: false,
    activity: activityFor(filter.tools),
    toggle: held || manual ? { open: manual === true } : null,
  };

  if (filter.tools === "hidden") return { ...base, inline: shown, live: null, status: true };
  // The orb rides the live batch; with text streaming at the tail the words are
  // the sign of life instead.
  const last = shown[shown.length - 1];
  if (last?.kind === "steps") return { ...base, inline: shown.slice(0, -1), live: last.segments, status: false };
  if (last?.kind === "text") return { ...base, inline: shown, live: null, status: false };
  return { ...base, inline: shown, live: [], status: false };
}

function planDone(block: AssistantBlock, display: ResponseDisplay, manual?: boolean): TurnPlan {
  const all = renderGroups(block);
  const filter: Filter = { tools: display.doneTools, updates: display.doneUpdates };
  const activity = activityFor(filter.tools);

  // Everything hidden reads as the fold, closed, so opening it by hand unfolds
  // in place. Pressed, the fold is what the toggle opens and closes.
  if (manual !== undefined || (filter.tools === "hidden" && filter.updates === "hide")) {
    const replyStart = replyStartOf(all);
    const fold: WorkGroup[] = [];
    const inline: RenderGroup[] = [];
    all.forEach((g, i) => {
      if (g.kind === "spawn" || i >= replyStart) inline.push(g);
      else append(fold, g);
    });
    // A turn with no reply to leave open shows its work rather than nothing.
    const foldOpen = manual ?? !inline.some((g) => g.kind === "text");
    return {
      fold,
      foldOpen,
      inline,
      live: null,
      status: false,
      activity,
      toggle: fold.length ? { open: foldOpen } : null,
    };
  }

  const { shown, held } = partition(all, filter, false);
  const hasWork = all.some((g) => g.kind === "steps");
  return {
    fold: null,
    foldOpen: false,
    inline: shown,
    live: null,
    status: false,
    activity,
    // Something held back reads closed, so a press opens onto it; nothing held
    // back reads open, so a press folds the turn to its reply.
    toggle: hasWork ? { open: !held } : null,
  };
}
