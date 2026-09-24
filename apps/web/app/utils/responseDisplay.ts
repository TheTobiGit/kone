// How an agent's turn reads — the reader's taste, per place they read it.
//
// A turn is always the same thing underneath: an ordered list of thinking, tool
// calls and text. The reader decides how much of it is on screen, and when, and
// can decide differently for each surface a conversation appears on — the
// studio (where you work alongside the agent), the inbox (where you hear back)
// and the assistant (kone's own conversation). Going to one, you get the read you
// set for it.
//
// Each surface's read has two halves, because a turn has two lives:
//
//   While it works —
//     · tool calls: "expanded" (every step stays open), "fold-as-it-goes" (a
//       batch is open while it runs and folds as the agent moves on), "folded"
//       (each batch is its strip from the first step), or "hidden" (one line
//       says what the agent is doing).
//     · updates: what the agent says along the way — shown, or held back.
//     · text: words streamed in as they arrive, or each message shown whole
//       once it's written.
//
//   When it's done —
//     · tool calls: "expanded", "folded", or "hidden" behind the turn's toggle.
//     · updates: shown, or folded away with the work.
//     The final reply always shows — the one constant.
//
// utils/turnPlan turns any of these into what a turn shows. Whatever a choice
// hides stays one press away on the turn's own toggle: these set where a turn
// starts, never what the reader can reach.

export type LiveTools = "expanded" | "fold-as-it-goes" | "folded" | "hidden";
export type DoneTools = "expanded" | "folded" | "hidden";
export type UpdatesDisplay = "show" | "hide";
export type TextReveal = "stream" | "whole";

export type ResponseDisplay = {
  live: { tools: LiveTools; updates: UpdatesDisplay; text: TextReveal };
  done: { tools: DoneTools; updates: UpdatesDisplay };
};

export type ConversationSurface = "studio" | "inbox" | "assistant";

export const SURFACES: readonly { id: ConversationSurface; label: string }[] = [
  { id: "studio", label: "Studio" },
  { id: "inbox", label: "Inbox" },
  { id: "assistant", label: "Assistant" },
];

/** A thumbnail of one option — see components/settings/ConversationGlyph. */
export type ResponseGlyph =
  | `tools-${LiveTools}`
  | "done-hidden"
  | `updates-${UpdatesDisplay}`
  | `text-${TextReveal}`;

export type ResponseOption<T extends string> = {
  id: T;
  label: string;
  /** One sentence on what the reader will see — for the option's tooltip and
   *  its accessible name. */
  description: string;
  glyph: ResponseGlyph;
};

export const LIVE_TOOL_OPTIONS: readonly ResponseOption<LiveTools>[] = [
  {
    id: "expanded",
    label: "Expanded",
    description: "Every step stays open, so you can follow all of it.",
    glyph: "tools-expanded",
  },
  {
    id: "fold-as-it-goes",
    label: "Fold as it goes",
    description: "Steps are open while they run, then fold as the agent moves on.",
    glyph: "tools-fold-as-it-goes",
  },
  {
    id: "folded",
    label: "Folded",
    description: "Steps sit folded from the start. Open one when you want it.",
    glyph: "tools-folded",
  },
  {
    id: "hidden",
    label: "Hidden",
    description: "A single line says what the agent is doing.",
    glyph: "tools-hidden",
  },
];

export const DONE_TOOL_OPTIONS: readonly ResponseOption<DoneTools>[] = [
  {
    id: "expanded",
    label: "Expanded",
    description: "Every step stays open.",
    glyph: "tools-expanded",
  },
  {
    id: "folded",
    label: "Folded",
    description: "Each batch folds into its strip.",
    glyph: "tools-folded",
  },
  {
    id: "hidden",
    label: "Hidden",
    description: "The work tucks behind the turn's toggle.",
    glyph: "done-hidden",
  },
];

export const UPDATES_OPTIONS: readonly ResponseOption<UpdatesDisplay>[] = [
  {
    id: "show",
    label: "Show",
    description: "What the agent says along the way.",
    glyph: "updates-show",
  },
  {
    id: "hide",
    label: "Hide",
    description: "Only the final reply.",
    glyph: "updates-hide",
  },
];

export const TEXT_OPTIONS: readonly ResponseOption<TextReveal>[] = [
  {
    id: "stream",
    label: "Stream",
    description: "Words arrive as the agent writes them.",
    glyph: "text-stream",
  },
  {
    id: "whole",
    label: "Whole",
    description: "Each message appears once it's written.",
    glyph: "text-whole",
  },
];

/** The studio is where you work alongside the agent, so it shows the work as it
 *  happens and folds it to the reply when done. The inbox and the assistant are
 *  where you hear back, so they start quiet: a line while it works, then the
 *  reply. */
export const DEFAULT_DISPLAYS: Record<ConversationSurface, ResponseDisplay> = {
  studio: {
    live: { tools: "fold-as-it-goes", updates: "show", text: "stream" },
    done: { tools: "hidden", updates: "hide" },
  },
  inbox: {
    live: { tools: "hidden", updates: "hide", text: "stream" },
    done: { tools: "hidden", updates: "hide" },
  },
  assistant: {
    live: { tools: "hidden", updates: "hide", text: "stream" },
    done: { tools: "hidden", updates: "hide" },
  },
};

/** How a batch of steps holds itself: always open, open only while it's the
 *  live batch, or never open until asked. */
export type ActivityFold = "open" | "auto" | "closed";

export function activityFoldFor(tools: LiveTools | DoneTools): ActivityFold {
  if (tools === "expanded") return "open";
  if (tools === "folded") return "closed";
  return "auto";
}
