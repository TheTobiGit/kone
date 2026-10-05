import type { RuntimeItemKind, SpawnedThreadStatus } from "./types.js";

// What a recipient is doing, as a sender sees it before deciding whether a
// message is worth sending, and whether it should disturb. Pure: every fact
// comes in as data, so the ladder is the same wherever it is read.

/** How an urgent message reaches a running turn: into it, on a provider that
 *  steers; after its current step, through kone steer, on one that cannot but
 *  keeps a finished tool call across a cancel; or when the turn ends, on one
 *  that would lose that work (docs/agent-delivery-design.md §7). */
export type UrgentLanding = "steer" | "after-step" | "turn-end";

/** One thread's live state, as the agent service holds it. */
export interface ThreadRuntime {
  /** A provider session backs the thread. */
  live: boolean;
  /** Its session is being started right now. */
  starting: boolean;
  /** A turn is running, or on its way to the provider. */
  busy: boolean;
  turnStartedAt: number | null;
  /** What it is parked on, if anything; an approval outranks a question. */
  parked: "approval" | "user-input" | null;
  parkedSince: number | null;
  compacting: boolean;
  /** Whether its provider takes a message into a running turn. Null when no
   *  session says which provider it runs on. */
  steers: boolean | null;
  /** How an urgent message reaches its running turn. Null when no session
   *  says which provider it runs on; absent reads from `steers`. */
  urgent?: UrgentLanding | null;
  /** The tool call it is in the middle of: the newest one open. */
  activeTool: { name: string; text: string; startedAt: number } | null;
  /** Between tool calls, what its turn is on: the newest open item that is
   *  not a tool call. Null when none is open, or nothing said. */
  step?: Exclude<RuntimeItemKind, "tool_call"> | null;
  lastActivityAt: number | null;
}

export type RecipientStateKind =
  | "working"
  | "idle"
  | "waiting-on-user"
  | "waiting-on-agent"
  | "starting"
  | "compacting"
  | "closed"
  | "ended";

export interface RecipientState {
  state: RecipientStateKind;
  /** When it entered this state, when known. */
  since: number | null;
  /** What it is doing: the tool call it is in, what it is parked on, the
   *  agents it waits for, or how its work ended. */
  activity: string | null;
  /** Whether a message can go into its running turn; null when unknown. */
  steers: boolean | null;
  /** How an urgent message reaches its running turn; null when unknown. */
  urgent: UrgentLanding | null;
  /** It is in the middle of a tool call. */
  inTool: boolean;
  /** The agents it is parked waiting on. */
  waitingOn: string[];
  /** How a hand-off's work ended, for `ended`. */
  ended: "completed" | "failed" | "interrupted" | "stillborn" | null;
  unseen: number;
  oldestUnseenAt: number | null;
}

export interface RecipientStateInput {
  runtime: ThreadRuntime | null;
  /** The hand-off status, for a thread some agent handed work to. */
  spawned?: SpawnedThreadStatus | null;
  /** Threads it is parked waiting on (agent_message wait, agent_wait). */
  waitingOn?: { threadIds: string[]; since: number } | null;
  /** Whether its provider steers, for a thread with no live session. */
  providerSteers?: boolean | null;
  unseen: number;
  oldestUnseenAt: number | null;
}

const ENDED: ReadonlySet<SpawnedThreadStatus> = new Set(["completed", "failed", "interrupted", "stillborn"]);

/** A tool call in a line: its name and, when short enough to help, its target. */
function describeTool(tool: NonNullable<ThreadRuntime["activeTool"]>): string {
  const target = tool.text.trim().split("\n")[0] ?? "";
  if (!target) return tool.name;
  return `${tool.name}: ${target.length > 80 ? `${target.slice(0, 77)}...` : target}`;
}

const STEP = {
  reasoning_text: "thinking",
  assistant_text: "writing a reply",
  plan_text: "updating its plan",
} satisfies Record<Exclude<RuntimeItemKind, "tool_call">, string>;

/**
 * The ladder, first match wins. Parked on the user outranks everything: nothing
 * lands until the user acts. A wait on another agent happens inside a running
 * turn, so it is read before "working". A thread with no session is either a
 * hand-off whose work is over, or simply closed.
 */
export function recipientState(input: RecipientStateInput): RecipientState {
  const rt = input.runtime;
  const steers = rt?.steers ?? input.providerSteers ?? null;
  const urgent: UrgentLanding | null = rt?.urgent ?? (steers === null ? null : steers ? "steer" : "turn-end");
  const base = {
    steers,
    urgent,
    inTool: rt?.activeTool != null,
    waitingOn: input.waitingOn?.threadIds ?? [],
    ended: null,
    unseen: input.unseen,
    oldestUnseenAt: input.oldestUnseenAt,
  };
  if (rt?.parked) {
    return {
      ...base,
      state: "waiting-on-user",
      since: rt.parkedSince,
      activity: rt.parked === "approval" ? "waiting on the user's approval" : "waiting on the user's answer",
    };
  }
  if (rt?.compacting) return { ...base, state: "compacting", since: null, activity: null };
  if (rt?.starting) return { ...base, state: "starting", since: null, activity: null };
  if (rt?.live && input.waitingOn && input.waitingOn.threadIds.length > 0) {
    return {
      ...base,
      state: "waiting-on-agent",
      since: input.waitingOn.since,
      activity: `waiting on ${input.waitingOn.threadIds.join(", ")}`,
    };
  }
  if (rt?.live && rt.busy) {
    return {
      ...base,
      state: "working",
      since: rt.turnStartedAt,
      activity: rt.activeTool ? describeTool(rt.activeTool) : rt.step ? STEP[rt.step] : null,
    };
  }
  if (rt?.live) return { ...base, state: "idle", since: rt.lastActivityAt, activity: null };
  if (input.spawned && ENDED.has(input.spawned)) {
    // SAFETY: ENDED holds exactly the four statuses `ended` names.
    const ended = input.spawned as RecipientState["ended"];
    return { ...base, state: "ended", ended, since: null, activity: `its work ${input.spawned === "stillborn" ? "never started" : input.spawned}` };
  }
  return { ...base, state: "closed", since: null, activity: null };
}

/** "4 min", "35 s", "2 h": how long, for a sender reading a roster. */
export function formatSince(since: number | null, now: number): string | null {
  if (since === null) return null;
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

const URGENT_LANDS = {
  steer: "urgent goes into this one",
  "after-step": "urgent waits for its current step, then interrupts this turn",
  "turn-end": "urgent waits for this turn to end: its provider loses work if interrupted",
} satisfies Record<UrgentLanding, string>;

/** One roster line's state, as the sender reads it: what it is doing, and
 *  what a message to it would do. */
export function describeRecipientState(state: RecipientState, now: number): string {
  const since = formatSince(state.since, now);
  const forHow = since ? ` (${since})` : "";
  switch (state.state) {
    case "working": {
      const on = state.activity ? `: ${state.activity}` : "";
      const lands = `a message that rings takes its next turn; ${URGENT_LANDS[state.urgent ?? (state.steers === false ? "turn-end" : "steer")]}`;
      return `working${forHow}${on}; ${lands}`;
    }
    case "idle":
      return `idle${since ? ` for ${since}` : ""}; a message that rings wakes it, a note waits for its next turn`;
    case "waiting-on-user":
      return `${state.activity ?? "waiting on the user"}${forHow}; a message waits until the user answers`;
    case "waiting-on-agent":
      return `${state.activity ?? "waiting on another agent"}${forHow}`;
    case "starting":
      return "starting; it takes messages shortly";
    case "compacting":
      return "compacting its context; it takes messages shortly";
    case "closed":
      return "session closed; a message that rings brings it back up, a note waits until it runs again";
    case "ended":
      return `${state.activity ?? "its work is over"}; messages to it are refused — follow up on it instead`;
  }
}
