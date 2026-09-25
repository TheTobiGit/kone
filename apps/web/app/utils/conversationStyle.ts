// How a conversation looks — who sits where, and what ties a request to its
// reply. Separate from ResponseDisplay (utils/responseDisplay), which decides
// how much of a turn is on screen: a style is the layout the turn is drawn in,
// and every style draws the same parts in the same order.
//
// One style for every surface. The reader picks the look of a conversation,
// not a look per place they read it — the studio, the inbox and the assistant
// all speak the same way.
//
//   · kone        — the request in a bubble on the right, the reply on the left,
//                   a hairline elbow carrying the eye from one to the other.
//   · kone-quiet  — the same, without the elbow.
//
// Every other style is its own design, not a variation on kone — its own
// faces, type, surfaces and spacing, and its own place for the time and the
// actions (which sit in the message's head line on hover instead of holding
// a row open under it):
//
//   · timeline    — both sides on the left, faces down one rail, a hairline
//                   running from your face to the reply's.
//   · thread      — Slack: flat rows under rounded-square faces, bold names,
//                   the reply indented under an arrow out of the request.
//   · chat        — WhatsApp: green bubbles on the right, white on the left,
//                   tails, the time and read ticks in the bubble's corner.
//   · channel     — Discord: big round faces, coloured names, "Today at …",
//                   and a reply that opens with the line it answers.
//   · prompt      — a terminal: the request as a command, the reply as its
//                   output hung off a rule, all in the monospace.

export type ConversationStyle = "kone" | "kone-quiet" | "timeline" | "thread" | "chat" | "channel" | "prompt";

export type ConversationStyleOption = {
  id: ConversationStyle;
  label: string;
  /** One sentence on what the reader will see — the tile's tooltip and
   *  accessible name. */
  description: string;
};

export const CONVERSATION_STYLES: readonly ConversationStyleOption[] = [
  {
    id: "kone",
    label: "Kone",
    description: "Your request in a bubble on the right, the reply on the left, joined by a hairline.",
  },
  {
    id: "kone-quiet",
    label: "Kone Quiet",
    description: "Kone without the hairline — just the bubble and the reply.",
  },
  {
    id: "timeline",
    label: "Timeline",
    description: "Both sides on the left, faces down one rail joining each request to its reply.",
  },
  {
    id: "thread",
    label: "Thread",
    description: "Like Slack: flat rows, the reply indented under an arrow from the request.",
  },
  {
    id: "chat",
    label: "Chat",
    description: "Like WhatsApp: tailed bubbles, the time and read ticks in the corner.",
  },
  {
    id: "channel",
    label: "Channel",
    description: "Like Discord: big faces, coloured names, replies that quote what they answer.",
  },
  {
    id: "prompt",
    label: "Prompt",
    description: "A terminal: your request as a command, the reply as its output.",
  },
];

export const DEFAULT_CONVERSATION_STYLE: ConversationStyle = "kone";

export function isConversationStyle(value: unknown): value is ConversationStyle {
  return CONVERSATION_STYLES.some((s) => s.id === value);
}

/** One row per style: every layout decision the thread makes about a style,
 *  in one table instead of scattered `style === …` switches. A projection of
 *  this row (face size, whose head shows, where the time sits) is all any
 *  single switch site ever needed — see STYLE_SPECS. */
export type StyleSpec = {
  /** The face a speaker is drawn with; 0 draws none — the chat names its
   *  speaker in the bubble, the prompt in its output's gutter. */
  face: number;
  /** The request wears your face, name and time, like a reply. */
  youHead: boolean;
  /** The request sits on the left, like the reply. */
  youLeft: boolean;
  /** A turn's actions float over it on hover rather than holding a row open
   *  under it. */
  floatActs: boolean;
  /** The time a reply wears in its head: none (the footer carries it, or the
   *  bubble's corner does), the bare clock, or Discord's "Today at 11:55 AM". */
  headStamp: "none" | "clock" | "day-at-clock";
  /** The request carries its time in the bubble's corner (the chat's ticks
   *  ride with it; the prompt's right-hand clock is the same corner). */
  bubbleStamp: boolean;
  /** Where a floating request's own actions sit (only read when
   *  `floatActs`): at the far end of the line that already heads it (`head` —
   *  the name and time), at the end of its own command line (`inline` — the
   *  prompt, which has no head), or beside the bubble (`side` — the chat).
   *  `foot` is kone's hover row under the bubble. */
  userActs: "head" | "inline" | "side" | "foot";
  /** A reply's actions come up beside its bubble rather than in its head —
   *  the chat, whose name line sits inside the bubble. */
  sideActs: boolean;
  /** The chat's corner ticks: sent, delivered, read. Only the chat. */
  ticks: boolean;
  /** The reply opens with the line it answers. Only the channel. */
  replyRef: boolean;
};

export const STYLE_SPECS = {
  kone: {
    face: 26,
    youHead: false,
    youLeft: false,
    floatActs: false,
    headStamp: "none",
    bubbleStamp: false,
    userActs: "foot",
    ticks: false,
    sideActs: false,
    replyRef: false,
  },
  "kone-quiet": {
    face: 26,
    youHead: false,
    youLeft: false,
    floatActs: false,
    headStamp: "none",
    bubbleStamp: false,
    userActs: "foot",
    ticks: false,
    sideActs: false,
    replyRef: false,
  },
  timeline: {
    face: 28,
    youHead: true,
    youLeft: true,
    floatActs: true,
    headStamp: "clock",
    bubbleStamp: false,
    userActs: "head",
    ticks: false,
    sideActs: false,
    replyRef: false,
  },
  thread: {
    face: 28,
    youHead: true,
    youLeft: true,
    floatActs: true,
    headStamp: "clock",
    bubbleStamp: false,
    userActs: "head",
    ticks: false,
    sideActs: false,
    replyRef: false,
  },
  chat: {
    face: 0,
    youHead: false,
    youLeft: false,
    floatActs: true,
    headStamp: "none",
    bubbleStamp: true,
    userActs: "side",
    ticks: true,
    sideActs: true,
    replyRef: false,
  },
  channel: {
    face: 38,
    youHead: true,
    youLeft: true,
    floatActs: true,
    headStamp: "day-at-clock",
    bubbleStamp: false,
    userActs: "head",
    ticks: false,
    sideActs: false,
    replyRef: true,
  },
  prompt: {
    face: 0,
    youHead: false,
    youLeft: true,
    floatActs: true,
    headStamp: "clock",
    bubbleStamp: true,
    userActs: "inline",
    ticks: false,
    sideActs: false,
    replyRef: false,
  },
} satisfies Record<ConversationStyle, StyleSpec>;

/** Styles that sit the request on the left, like the reply. */
export function requestOnLeft(style: ConversationStyle): boolean {
  return STYLE_SPECS[style].youLeft;
}

/** Styles that head the request with your face, name and time. */
export function requestHasHeader(style: ConversationStyle): boolean {
  return STYLE_SPECS[style].youHead;
}
