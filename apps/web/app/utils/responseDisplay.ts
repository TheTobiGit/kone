// How an agent's turn reads — the reader's taste, per place they read it.
//
// A turn is always the same thing underneath: an ordered list of thinking, tool
// calls and text. The reader decides how much of it is on screen, and when, and
// can decide differently for each surface a conversation appears on — the
// studio (where you work alongside the agent), the inbox (where you hear back)
// and the assistant (kone's own conversation). Going to one, you get the read you
// set for it.
//
// Each surface's read is five choices in two halves, because a turn has two
// lives:
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

/** One surface's read: five choices, three while the turn works and two once
 *  it's done. */
export type ResponseDisplay = {
  liveTools: LiveTools;
  liveUpdates: UpdatesDisplay;
  liveText: TextReveal;
  doneTools: DoneTools;
  doneUpdates: UpdatesDisplay;
};

export type ResponseChoice = keyof ResponseDisplay;

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

/** One option of one choice — the option knows which choice it answers, so
 *  picking it is a complete instruction. */
export type ChoiceOptionOf<K extends ResponseChoice> = ResponseOption<ResponseDisplay[K]> & { choice: K };
export type ChoiceOption = { [K in ResponseChoice]: ChoiceOptionOf<K> }[ResponseChoice];
/** A choice and the option picked for it. */
export type ResponsePick = { [K in ResponseChoice]: { choice: K; id: ResponseDisplay[K] } }[ResponseChoice];

function optionsFor<K extends ResponseChoice>(
  choice: K,
  options: readonly ResponseOption<ResponseDisplay[K]>[],
): readonly ChoiceOptionOf<K>[] {
  return options.map((o) => ({ ...o, choice }));
}

const UPDATES_OPTIONS: readonly ResponseOption<UpdatesDisplay>[] = [
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

/** Every choice's options, in the order they're offered. */
export const RESPONSE_OPTIONS = {
  liveTools: optionsFor("liveTools", [
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
  ]),
  liveUpdates: optionsFor("liveUpdates", UPDATES_OPTIONS),
  liveText: optionsFor("liveText", [
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
  ]),
  doneTools: optionsFor("doneTools", [
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
  ]),
  doneUpdates: optionsFor("doneUpdates", UPDATES_OPTIONS),
};

export const RESPONSE_CHOICES: readonly ResponseChoice[] = [
  "liveTools",
  "liveUpdates",
  "liveText",
  "doneTools",
  "doneUpdates",
];

/** The studio is where you work alongside the agent, so it shows the work as it
 *  happens and folds it to the reply when done. The inbox and the assistant are
 *  where you hear back, so they start quiet: a line while it works, then the
 *  reply. */
export const DEFAULT_DISPLAYS = {
  studio: {
    liveTools: "fold-as-it-goes",
    liveUpdates: "show",
    liveText: "stream",
    doneTools: "hidden",
    doneUpdates: "hide",
  },
  inbox: {
    liveTools: "hidden",
    liveUpdates: "hide",
    liveText: "stream",
    doneTools: "hidden",
    doneUpdates: "hide",
  },
  assistant: {
    liveTools: "hidden",
    liveUpdates: "hide",
    liveText: "stream",
    doneTools: "hidden",
    doneUpdates: "hide",
  },
} satisfies Record<ConversationSurface, ResponseDisplay>;

/** The read with one choice changed. */
export function withChoice(display: ResponseDisplay, pick: ResponsePick): ResponseDisplay {
  return { ...display, [pick.choice]: pick.id };
}

export function sameDisplay(a: ResponseDisplay, b: ResponseDisplay): boolean {
  return RESPONSE_CHOICES.every((c) => a[c] === b[c]);
}

/** How a batch of steps holds itself: always open, open only while it's the
 *  live batch, or never open until asked. */
export type ActivityFold = "open" | "auto" | "closed";

// ── reading a stored read ─────────────────────────────────────────────────────
// Whatever storage hands back is checked choice by choice, so a stored value
// that no longer names an option reads its default rather than nothing. Reads
// stored before the choices were flat — `{ live: {…}, done: {…} }` — carry over.

type StoredPhase = { tools?: string; updates?: string; text?: string };
/** A surface's read as storage may hold it: flat, nested the old way, or
 *  missing choices added since. */
export type StoredDisplay = Partial<Record<ResponseChoice, string>> & { live?: StoredPhase; done?: StoredPhase };
export type StoredDisplays = Partial<Record<ConversationSurface, StoredDisplay>>;
export type ResponseDisplays = { studio: ResponseDisplay; inbox: ResponseDisplay; assistant: ResponseDisplay };

function isOption<K extends ResponseChoice>(choice: K, value: string | undefined): value is ResponseDisplay[K] {
  return RESPONSE_OPTIONS[choice].some((o) => o.id === value);
}

function readChoice<K extends ResponseChoice>(
  choice: K,
  flat: string | undefined,
  nested: string | undefined,
  fallback: ResponseDisplay[K],
): ResponseDisplay[K] {
  if (isOption(choice, flat)) return flat;
  return isOption(choice, nested) ? nested : fallback;
}

function readDisplay(stored: StoredDisplay | undefined, fallback: ResponseDisplay): ResponseDisplay {
  const s = stored ?? {};
  return {
    liveTools: readChoice("liveTools", s.liveTools, s.live?.tools, fallback.liveTools),
    liveUpdates: readChoice("liveUpdates", s.liveUpdates, s.live?.updates, fallback.liveUpdates),
    liveText: readChoice("liveText", s.liveText, s.live?.text, fallback.liveText),
    doneTools: readChoice("doneTools", s.doneTools, s.done?.tools, fallback.doneTools),
    doneUpdates: readChoice("doneUpdates", s.doneUpdates, s.done?.updates, fallback.doneUpdates),
  };
}

/** Every surface's read from what storage holds, defaults filling any gap. */
export function readDisplays(stored: StoredDisplays | null | undefined): ResponseDisplays {
  return {
    studio: readDisplay(stored?.studio, DEFAULT_DISPLAYS.studio),
    inbox: readDisplay(stored?.inbox, DEFAULT_DISPLAYS.inbox),
    assistant: readDisplay(stored?.assistant, DEFAULT_DISPLAYS.assistant),
  };
}
