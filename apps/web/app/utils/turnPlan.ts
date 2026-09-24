// What one assistant turn puts on screen, under the reader's choices.
//
// A turn is an ordered list of parts (renderGroups): batches of steps (thinking
// and tool calls), text, and spawn lines. The reader's ResponseDisplay decides
// which of those show, and when — this turns the two into a plan the thread
// renders as-is. Kept pure and apart from the component so every combination of
// choices can be pinned down in tests, and so the real thread and the settings
// page's preview can't disagree: both render through this.
//
// A turn reads by its `live` choices while it runs and by its `done` choices
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
import {
  activityFoldFor,
  type ActivityFold,
  type DoneTools,
  type LiveTools,
  type ResponseDisplay,
  type UpdatesDisplay,
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

type Filter = { tools: LiveTools | DoneTools; updates: UpdatesDisplay };

/** Where the reply starts: just past the turn's last batch of work. */
function replyStartOf(groups: RenderGroup[]): number {
  let i = groups.length;
  while (i > 0 && groups[i - 1]!.kind !== "steps") i--;
  return i;
}

/** Adjacent batches read as one — they become adjacent when whatever stood
 *  between them isn't shown. The first batch's key holds, so the batch keeps
 *  its identity as later steps join it. */
function mergeSteps<G extends RenderGroup>(groups: G[]): G[] {
  const out: G[] = [];
  for (const g of groups) {
    const last = out[out.length - 1];
    if (g.kind === "steps" && last?.kind === "steps") {
      // SAFETY: both are steps groups, and a steps group with more segments is
      // still a steps group.
      out[out.length - 1] = { ...last, segments: [...last.segments, ...g.segments] } as G;
    } else out.push(g);
  }
  return out;
}

/** What the reader's filter leaves out of this turn — whether its toggle has
 *  anything to open onto. */
function holdsBack(groups: RenderGroup[], replyStart: number, filter: Filter, running: boolean): boolean {
  return groups.some((g, i) => {
    if (g.kind === "steps") return filter.tools === "hidden";
    if (g.kind === "text") return filter.updates === "hide" && (running || i < replyStart);
    return false;
  });
}

/** The turn in the open, in arrival order, with whatever the filter hides left
 *  out. An update is text before the reply — and while the turn runs, nothing
 *  is the reply yet. */
function shownGroups(groups: RenderGroup[], replyStart: number, filter: Filter, running: boolean): RenderGroup[] {
  return mergeSteps(
    groups.filter((g, i) => {
      if (g.kind === "steps") return filter.tools !== "hidden";
      if (g.kind === "text") return filter.updates === "show" || (!running && i >= replyStart);
      return true;
    }),
  );
}

export function planTurn(block: AssistantBlock, display: ResponseDisplay, manual?: boolean): TurnPlan {
  return block.state === "running" ? planLive(block, display, manual) : planDone(block, display, manual);
}

function planLive(block: AssistantBlock, display: ResponseDisplay, manual?: boolean): TurnPlan {
  const all = renderGroups(block);
  const { live } = display;

  // Read whole, the message being written waits until it's written.
  const tail = all[all.length - 1];
  if (live.text === "whole" && tail?.kind === "text" && segStreaming(tail.seg)) all.pop();

  const replyStart = replyStartOf(all);
  const held = holdsBack(all, replyStart, live, true);
  // Opened by hand, nothing is held back: hidden steps show as they would
  // folding as they go, and every update shows.
  const filter: Filter = manual
    ? { tools: live.tools === "hidden" ? "fold-as-it-goes" : live.tools, updates: "show" }
    : live;
  const shown = shownGroups(all, replyStart, filter, true);
  const base = {
    fold: null,
    foldOpen: false,
    activity: activityFoldFor(filter.tools),
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
  const { done } = display;
  const replyStart = replyStartOf(all);
  const work = all.slice(0, replyStart);
  const reply = all.slice(replyStart);
  const hasWork = work.some((g) => g.kind !== "spawn");
  const activity = activityFoldFor(done.tools);

  // Everything hidden reads as the fold, closed, so opening it by hand unfolds
  // in place. Pressed, the fold is what the toggle opens and closes.
  if (manual !== undefined || (done.tools === "hidden" && done.updates === "hide")) {
    const fold: WorkGroup[] = [];
    const spawns: RenderGroup[] = [];
    for (const g of work) {
      if (g.kind === "spawn") spawns.push(g);
      else fold.push(g);
    }
    // A turn with no reply to leave open shows its work rather than nothing.
    const foldOpen = manual ?? !reply.some((g) => g.kind === "text");
    return {
      fold: mergeSteps(fold),
      foldOpen,
      inline: [...spawns, ...reply],
      live: null,
      status: false,
      activity,
      toggle: fold.length ? { open: foldOpen } : null,
    };
  }

  const held = holdsBack(all, replyStart, done, false);
  return {
    fold: null,
    foldOpen: false,
    inline: shownGroups(all, replyStart, done, false),
    live: null,
    status: false,
    activity,
    // Something held back reads closed, so a press opens onto it; nothing held
    // back reads open, so a press folds the turn to its reply.
    toggle: hasWork ? { open: !held } : null,
  };
}
