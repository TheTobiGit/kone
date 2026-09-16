import { describe, expect, test } from "bun:test";
import { ref } from "vue";
import {
  checkpointFailureMessage,
  useTurnCheckpoints,
  type CheckpointBridge,
} from "./useTurnCheckpoints";
import type {
  PreviewTurnCheckpointResult,
  RevertTurnCheckpointResult,
  TurnCheckpointRecord,
} from "~/types/desktop";

function record(turnId: string, createdAt: number): TurnCheckpointRecord {
  return {
    threadId: "t-1",
    turnId,
    checkpointId: `ck-${turnId}`,
    ref: `refs/kone/checkpoints/ck-${turnId}`,
    createdAt,
  };
}

describe("useTurnCheckpoints — seeding", () => {
  test("seeds oldest-first and finds a turn's checkpoint", async () => {
    const threadId = ref("t-1");
    const bridge: CheckpointBridge = {
      turnCheckpoints: async () => [record("turn-b", 200), record("turn-a", 100)],
    };
    const unit = useTurnCheckpoints({ threadId, bridge: () => bridge });
    unit.seedCheckpoints();
    await Promise.resolve();
    await Promise.resolve();
    expect(unit.checkpoints.value.map((c) => c.turnId)).toEqual(["turn-a", "turn-b"]);
    expect(unit.checkpointForTurn("turn-b")?.checkpointId).toBe("ck-turn-b");
    expect(unit.checkpointForTurn("nope")).toBeNull();
  });

  test("a failed seed leaves the list as it is", async () => {
    const threadId = ref("t-1");
    const bridge: CheckpointBridge = {
      turnCheckpoints: async () => {
        throw new Error("store exploded");
      },
    };
    const unit = useTurnCheckpoints({ threadId, bridge: () => bridge });
    unit.seedCheckpoints();
    await Promise.resolve();
    await Promise.resolve();
    expect(unit.checkpoints.value).toEqual([]);
  });
});

describe("useTurnCheckpoints — preview and revert", () => {
  test("delegates to the bridge with the session's thread id", async () => {
    const threadId = ref("t-9");
    const seen: string[] = [];
    const previewResult: PreviewTurnCheckpointResult = {
      ok: true,
      wouldWrite: ["a.ts"],
      wouldDelete: [],
    };
    const revertResult: RevertTurnCheckpointResult = { ok: true };
    const bridge: CheckpointBridge = {
      turnCheckpoints: async () => [],
      previewTurnCheckpoint: async (tid: string, turn: string) => {
        seen.push(`${tid}/${turn}`);
        return previewResult;
      },
      revertTurnCheckpoint: async (tid: string, turn: string, force?: boolean) => {
        seen.push(`${tid}/${turn}:${force === true ? "force" : "soft"}`);
        return revertResult;
      },
    };
    const unit = useTurnCheckpoints({ threadId, bridge: () => bridge });
    expect(await unit.previewCheckpoint("turn-1")).toBe(previewResult);
    expect(await unit.revertCheckpoint("turn-1", true)).toBe(revertResult);
    expect(seen).toEqual(["t-9/turn-1", "t-9/turn-1:force"]);
  });

  test("answers null when the bridge has no checkpoint surface", async () => {
    const threadId = ref("t-1");
    const bridge: CheckpointBridge = {};
    const unit = useTurnCheckpoints({ threadId, bridge: () => bridge });
    expect(await unit.previewCheckpoint("turn-1")).toBeNull();
    expect(await unit.revertCheckpoint("turn-1")).toBeNull();
  });
});

describe("checkpointFailureMessage", () => {
  test("phrases every reason without leaking internals", () => {
    expect(checkpointFailureMessage({ ok: false, reason: "missing" })).toContain("No checkpoint");
    expect(checkpointFailureMessage({ ok: false, reason: "busy" })).toContain("still running");
    expect(
      checkpointFailureMessage({ ok: false, reason: "no-workdir", detail: "/gone/dir" }),
    ).toContain("/gone/dir");
    expect(checkpointFailureMessage({ ok: false, reason: "no-workdir" })).toContain(
      "can't be found",
    );
    expect(checkpointFailureMessage({ ok: false, reason: "checkpoint-gone" })).toContain(
      "gone",
    );
    expect(
      checkpointFailureMessage({
        ok: false,
        reason: "dirty",
        wouldWrite: ["a"],
        wouldDelete: [],
      }),
    ).toContain("overwrite");
    expect(checkpointFailureMessage({ ok: false, reason: "failed" })).toBe("Restore failed.");
    expect(
      checkpointFailureMessage({ ok: false, reason: "failed", detail: "git says no" }),
    ).toContain("git says no");
  });
});
