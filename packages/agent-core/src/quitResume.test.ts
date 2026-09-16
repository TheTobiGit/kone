import { describe, expect, test } from "bun:test";
import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_QUIT_RESUME_PROMPT,
  buildQuitResumeRecord,
  claimQuitResumeRecord,
  persistQuitResumeRecord,
  prepareQuitResume,
  readQuitResumeRecord,
  resumeQuitInterruptedChats,
  type QuitResumeAssistantTurn,
  type QuitResumeRecord,
  type QuitResumeThreadSnapshot,
} from "./quitResume.js";

const RECORDED_AT = 1_750_000_000_000;
const BEFORE = RECORDED_AT - 60_000;
const AFTER = RECORDED_AT + 30_000;

function freshRecordPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "kone-quit-resume-test-")), "quit-resume.json");
}

function assistantTurn(
  turnId: string,
  state: "running" | "completed" | "failed" | "interrupted",
  at: number,
  endedAt: number | null,
): QuitResumeAssistantTurn {
  return { turnId, state, at, endedAt };
}

function snapshot(threadId: string, overrides: Partial<QuitResumeThreadSnapshot> = {}): QuitResumeThreadSnapshot {
  return {
    threadId,
    missing: overrides.missing ?? false,
    archived: overrides.archived ?? false,
    busy: overrides.busy ?? false,
    turns: overrides.turns ?? [],
  };
}

function recordWith(
  entries: Array<{ threadId: string; turnId: string | null }>,
  recordId = "record-1",
): QuitResumeRecord {
  return {
    version: 1,
    recordId,
    recordedAt: RECORDED_AT,
    continuationPrompt: DEFAULT_QUIT_RESUME_PROMPT,
    threads: entries.map((entry) => ({ threadId: entry.threadId, turnId: entry.turnId })),
  };
}

/** The live side prepare talks to, with interrupt attempts recorded. */
class FakeQuitter {
  readonly interrupted: string[] = [];
  constructor(private readonly flights: Array<{ threadId: string; turnId: string | null }>) {}
  inFlightTurns(): Array<{ threadId: string; turnId: string | null }> {
    return this.flights;
  }
  async interruptTurn(threadId: string): Promise<void> {
    this.interrupted.push(threadId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("buildQuitResumeRecord", () => {
  test("collapses duplicates, keeps order, and caps the file", () => {
    const inFlight = [
      { threadId: "a", turnId: "a-turn" },
      { threadId: "connecting", turnId: null },
      { threadId: "a", turnId: "a-turn" },
      { threadId: "b", turnId: "b-turn" },
    ];
    const record = buildQuitResumeRecord({
      inFlight,
      recordId: "record-1",
      now: RECORDED_AT,
      continuationPrompt: DEFAULT_QUIT_RESUME_PROMPT,
    });
    expect(record).toEqual({
      version: 1,
      recordId: "record-1",
      recordedAt: RECORDED_AT,
      continuationPrompt: DEFAULT_QUIT_RESUME_PROMPT,
      threads: [
        { threadId: "a", turnId: "a-turn" },
        { threadId: "connecting", turnId: null },
        { threadId: "b", turnId: "b-turn" },
      ],
    });
  });
});

describe("quit resume record file", () => {
  test("persists, reads, and clears; missing reads as absent, corrupt as invalid", () => {
    const recordPath = freshRecordPath();
    expect(readQuitResumeRecord(recordPath)).toEqual({ kind: "absent" });
    const record = recordWith([{ threadId: "a", turnId: "a-turn" }]);
    persistQuitResumeRecord(recordPath, record);
    expect(readQuitResumeRecord(recordPath)).toEqual({ kind: "record", record });
    writeFileSync(recordPath, "{ not json");
    expect(readQuitResumeRecord(recordPath)).toEqual({ kind: "invalid" });
    writeFileSync(recordPath, "   \n");
    expect(readQuitResumeRecord(recordPath)).toEqual({ kind: "invalid" });
  });

  test("a failed write rejects before any interrupt is attempted", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-quit-resume-test-"));
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    const quitter = new FakeQuitter([{ threadId: "a", turnId: "a-turn" }]);
    let rejected = false;
    try {
      await prepareQuitResume({
        quitter,
        recordPath: path.join(blocker, "quit-resume.json"),
        recordId: "record-1",
        now: RECORDED_AT,
        abandonAfterMs: 10,
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(quitter.interrupted).toEqual([]);
  });

  test("prepare with nothing in flight writes no record", async () => {
    const recordPath = freshRecordPath();
    const result = await prepareQuitResume({
      quitter: new FakeQuitter([]),
      recordPath,
      recordId: "record-1",
      now: RECORDED_AT,
      abandonAfterMs: 10,
    });
    expect(result.recordedThreadIds).toEqual([]);
    expect(fs.existsSync(recordPath)).toBe(false);
  });
});

describe("resume with no record", () => {
  test("one existence check and no work", async () => {
    const recordPath = freshRecordPath();
    let snapshots = 0;
    let dispatches = 0;
    const claimed = claimQuitResumeRecord(recordPath);
    expect(claimed).toEqual({ kind: "absent" });
    const result = await resumeQuitInterruptedChats({
      claimed,
      readSnapshot: () => {
        snapshots += 1;
        return null;
      },
      dispatchResumeTurn: () => {
        dispatches += 1;
        return Promise.resolve();
      },
    });
    expect(result).toEqual({ resumed: [], skipped: [] });
    expect(snapshots).toBe(0);
    expect(dispatches).toBe(0);
  });

  test("an unreadable record resumes nothing", async () => {
    const recordPath = freshRecordPath();
    writeFileSync(recordPath, "{ not json");
    const claimed = claimQuitResumeRecord(recordPath);
    expect(claimed).toEqual({ kind: "invalid" });
    let snapshots = 0;
    const result = await resumeQuitInterruptedChats({
      claimed,
      readSnapshot: () => {
        snapshots += 1;
        return null;
      },
      dispatchResumeTurn: () => Promise.resolve(),
    });
    expect(result).toEqual({ resumed: [], skipped: [] });
    expect(snapshots).toBe(0);
  });
});

describe("resume filtering", () => {
  test("threads that moved on are filtered; the rest resume with the recorded prompt", async () => {
    const record = recordWith([
      { threadId: "steady", turnId: "steady-turn" },
      { threadId: "superseded", turnId: "superseded-turn" },
      { threadId: "connecting", turnId: null },
      { threadId: "answered", turnId: "answered-turn" },
      { threadId: "gone", turnId: "gone-turn" },
      { threadId: "archived", turnId: "archived-turn" },
      { threadId: "running", turnId: "running-turn" },
      { threadId: "stolen", turnId: "stolen-turn" },
    ]);
    const snapshots = new Map<string, QuitResumeThreadSnapshot>([
      [
        "steady",
        snapshot("steady", {
          turns: [assistantTurn("steady-turn", "interrupted", BEFORE, AFTER)],
        }),
      ],
      [
        // A later turn replaced the recorded one and was itself interrupted:
        // still where the quit left it.
        "superseded",
        snapshot("superseded", {
          turns: [
            assistantTurn("superseded-turn", "interrupted", BEFORE, BEFORE),
            assistantTurn("superseded-turn-2", "interrupted", AFTER, null),
          ],
        }),
      ],
      [
        // Still connecting at quit; the earlier turn had settled long before.
        "connecting",
        snapshot("connecting", {
          turns: [assistantTurn("connecting-old", "completed", BEFORE, BEFORE)],
        }),
      ],
      [
        "answered",
        snapshot("answered", {
          turns: [assistantTurn("answered-turn", "completed", BEFORE, AFTER)],
        }),
      ],
      [
        "archived",
        snapshot("archived", {
          archived: true,
          turns: [assistantTurn("archived-turn", "interrupted", BEFORE, AFTER)],
        }),
      ],
      [
        "running",
        snapshot("running", {
          busy: true,
          turns: [assistantTurn("running-turn", "running", BEFORE, null)],
        }),
      ],
      [
        "stolen",
        snapshot("stolen", {
          turns: [assistantTurn("stolen-turn", "interrupted", BEFORE, AFTER)],
        }),
      ],
    ]);
    const dispatched: Array<{ threadId: string; prompt: string }> = [];
    // "stolen" reads clean at plan time, then a client turn lands on it before
    // its dispatch — the re-check must filter it.
    let stolenReads = 0;
    const result = await resumeQuitInterruptedChats({
      claimed: { kind: "record", record },
      readSnapshot: (threadId) => {
        if (threadId === "stolen") {
          stolenReads += 1;
          if (stolenReads > 1) {
            return snapshot("stolen", {
              busy: true,
              turns: [assistantTurn("stolen-turn", "running", BEFORE, null)],
            });
          }
        }
        return snapshots.get(threadId) ?? null;
      },
      dispatchResumeTurn: (threadId, prompt) => {
        dispatched.push({ threadId, prompt });
        return Promise.resolve();
      },
    });
    expect(result.resumed).toEqual(["steady", "superseded", "connecting"]);
    expect(result.skipped).toEqual([
      { threadId: "answered", reason: "turn-completed" },
      { threadId: "gone", reason: "thread-missing" },
      { threadId: "archived", reason: "thread-archived" },
      { threadId: "running", reason: "turn-in-flight" },
      { threadId: "stolen", reason: "turn-in-flight" },
    ]);
    expect(dispatched).toEqual([
      { threadId: "steady", prompt: DEFAULT_QUIT_RESUME_PROMPT },
      { threadId: "superseded", prompt: DEFAULT_QUIT_RESUME_PROMPT },
      { threadId: "connecting", prompt: DEFAULT_QUIT_RESUME_PROMPT },
    ]);
  });

  test("a dispatch failure skips one thread without stopping the rest", async () => {
    const record = recordWith([
      { threadId: "a", turnId: "a-turn" },
      { threadId: "b", turnId: "b-turn" },
    ]);
    const resumed: string[] = [];
    const result = await resumeQuitInterruptedChats({
      claimed: { kind: "record", record },
      readSnapshot: (threadId) =>
        snapshot(threadId, {
          turns: [assistantTurn(`${threadId}-turn`, "interrupted", BEFORE, AFTER)],
        }),
      dispatchResumeTurn: (threadId) => {
        if (threadId === "a") return Promise.reject(new Error("session gone"));
        resumed.push(threadId);
        return Promise.resolve();
      },
    });
    expect(result.resumed).toEqual(["b"]);
    expect(result.skipped).toEqual([{ threadId: "a", reason: "dispatch-failed" }]);
    expect(resumed).toEqual(["b"]);
  });
});

describe("abandon sweep", () => {
  test("a cancelled quit's record is removed while the process lives on", async () => {
    const recordPath = freshRecordPath();
    const quitter = new FakeQuitter([
      { threadId: "a", turnId: "a-turn" },
      { threadId: "b", turnId: null },
    ]);
    const prepared = await prepareQuitResume({
      quitter,
      recordPath,
      recordId: "record-1",
      now: RECORDED_AT,
      abandonAfterMs: 20,
    });
    expect(prepared.recordedThreadIds).toEqual(["a", "b"]);
    expect(prepared.recordedAt).toBe(RECORDED_AT);
    const persisted = readQuitResumeRecord(recordPath);
    expect(persisted).toEqual({
      kind: "record",
      record: {
        version: 1,
        recordId: "record-1",
        recordedAt: RECORDED_AT,
        continuationPrompt: DEFAULT_QUIT_RESUME_PROMPT,
        threads: [
          { threadId: "a", turnId: "a-turn" },
          { threadId: "b", turnId: null },
        ],
      },
    });
    // Interrupts are detached: a beat later both were requested.
    await sleep(50);
    expect(quitter.interrupted).toEqual(["a", "b"]);
    // Still alive well after the abandon delay → the quit was cancelled.
    await sleep(150);
    expect(readQuitResumeRecord(recordPath)).toEqual({ kind: "absent" });
  });

  test("the sweep never removes a newer quit's record", async () => {
    const recordPath = freshRecordPath();
    const quitter = new FakeQuitter([{ threadId: "a", turnId: "a-turn" }]);
    await prepareQuitResume({
      quitter,
      recordPath,
      recordId: "record-1",
      now: RECORDED_AT,
      abandonAfterMs: 60,
    });
    persistQuitResumeRecord(recordPath, recordWith([{ threadId: "b", turnId: "b-turn" }], "record-2"));
    await sleep(150);
    const current = readQuitResumeRecord(recordPath);
    expect(current.kind).toBe("record");
    if (current.kind === "record") {
      expect(current.record.threads).toEqual([{ threadId: "b", turnId: "b-turn" }]);
    }
  });
});

describe("claim", () => {
  test("a crash between rename and delete loses the resume rather than doubling it", () => {
    const recordPath = freshRecordPath();
    persistQuitResumeRecord(recordPath, recordWith([{ threadId: "a", turnId: "a-turn" }]));
    // Simulate the crash: the claimant renamed the file, then died before the
    // delete. The stranded sibling must never read as a fresh record.
    const stranded = `${recordPath}.999.simulated-crash.claimed`;
    fs.renameSync(recordPath, stranded);
    expect(fs.existsSync(recordPath)).toBe(false);
    expect(claimQuitResumeRecord(recordPath)).toEqual({ kind: "absent" });
    expect(fs.existsSync(stranded)).toBe(true);
  });

  test("a claim consumes exactly once", () => {
    const recordPath = freshRecordPath();
    expect(claimQuitResumeRecord(recordPath)).toEqual({ kind: "absent" });
    const record = recordWith([{ threadId: "a", turnId: "a-turn" }]);
    persistQuitResumeRecord(recordPath, record);
    expect(claimQuitResumeRecord(recordPath)).toEqual({ kind: "record", record });
    expect(fs.existsSync(recordPath)).toBe(false);
    expect(claimQuitResumeRecord(recordPath)).toEqual({ kind: "absent" });
  });
});
