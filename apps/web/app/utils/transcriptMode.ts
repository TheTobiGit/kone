// How much of a turn a thread shows.
//
// A turn is always the same thing underneath — an ordered list of thinking, tool
// calls and text. What differs is how much of that the reader is asked to watch,
// and that is a property of *where* the thread is being read, not of the thread:
//
//   · "transcript" — the working read. Every part renders in arrival order while
//     the turn runs: step rows, thinking, narration, the reply as it streams. You
//     are over the agent's shoulder, and the work is the point.
//
//   · "reply" — the quiet read. The work stays out of sight; a running turn is one
//     line saying what the agent is doing right now, and when it settles the reply
//     takes that line's place. The work is still there behind the turn's fold for
//     anyone who wants it — it is closed, not thrown away.
//
// The studio reads threads the first way (you went there to work), the inbox the
// second (you went there to hear back).
export type TranscriptMode = "transcript" | "reply";

export const DEFAULT_TRANSCRIPT_MODE: TranscriptMode = "transcript";
