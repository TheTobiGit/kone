import { beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import { initTestRepo } from "@kone/git-core/testRepo.js";
import { dropCheckpoint, listCheckpoints } from "@kone/git-core/checkpoint.js";
import type {
  ProviderAdapter,
  QueuedTurnStore,
  SendTurnInput,
  TurnStartResult,
} from "./types.js";
import type { TurnCheckpointRecord } from "./conversationStoreTypes.js";
import type { ThreadWorkspace } from "./threadWorkspace.js";

// Turn checkpoints at the service layer: capture on the sendTurn path (real
// git snapshots in a throwaway repo), idempotent per turn, never failing the
// turn, plus revert through the same seam. No module is mocked except the
// Electron-only sqlite import — the same hermetic pattern agentService.test.ts
// uses — and adapters plus the checkpoint slice are injected fakes, so no CLI
// is ever spawned and no real database is opened.

setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-agent-checkpoints-test-")));

mock.module("./sqlite.js", () => ({
  DatabaseSync: Database,
}));

type EmitEvent = (event: import("./types.js").RuntimeEvent) => void;

class CheckpointFakeAdapter {
  static turnId = "checkpoint-turn-1";
  /** Every emit closure a fake captured at construction — the test drives the
   *  merged event stream through the last one, exactly like a provider would. */
  static emits: EmitEvent[] = [];
  constructor(
    public emit: EmitEvent,
    readonly provider = "codex",
  ) {
    CheckpointFakeAdapter.emits.push(emit);
  }
  async startSession(): Promise<Record<string, never>> {
    return {};
  }
  async stopSession(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    return { threadId: input.threadId, turnId: CheckpointFakeAdapter.turnId };
  }
}

/** In-memory stand-in for the store's turn-checkpoint slice, mirroring the
 *  real repo contract: first record wins, prune keeps the newest rows. */
class FakeCheckpointStore {
  rows = new Map<string, TurnCheckpointRecord>();
  constructor(
    private readonly projectPath: string,
    private readonly explode = false,
  ) {}

  private key(threadId: string, turnId: string): string {
    return `${threadId}::${turnId}`;
  }

  threadProjectPath(_threadId: string): string | null {
    if (this.explode) throw new Error("store exploded");
    return this.projectPath;
  }

  threadWorkspace(_threadId: string): ThreadWorkspace | null {
    if (this.explode) throw new Error("store exploded");
    return { envMode: "local", worktreePath: null, requestedBranch: null };
  }

  recordTurnCheckpoint(input: {
    threadId: string;
    turnId: string;
    checkpointId: string;
    ref: string;
    createdAt?: number;
  }): boolean {
    if (this.explode) throw new Error("store exploded");
    const key = this.key(input.threadId, input.turnId);
    if (this.rows.has(key)) return false;
    this.rows.set(key, {
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointId: input.checkpointId,
      ref: input.ref,
      createdAt: input.createdAt ?? Date.now(),
    });
    return true;
  }

  getTurnCheckpoint(threadId: string, turnId: string): TurnCheckpointRecord | null {
    if (this.explode) throw new Error("store exploded");
    return this.rows.get(this.key(threadId, turnId)) ?? null;
  }

  listTurnCheckpoints(threadId: string): TurnCheckpointRecord[] {
    if (this.explode) throw new Error("store exploded");
    return [...this.rows.values()]
      .filter((r) => r.threadId === threadId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  pruneTurnCheckpoints(threadId: string, keep: number): TurnCheckpointRecord[] {
    if (this.explode) throw new Error("store exploded");
    const mine = this.listTurnCheckpoints(threadId);
    if (mine.length <= keep) return [];
    const evicted = mine.slice(0, mine.length - keep);
    for (const row of evicted) this.rows.delete(this.key(row.threadId, row.turnId));
    return evicted;
  }
}

type AgentServiceType = import("./AgentService.js").AgentService;
let AgentServiceCtor: typeof import("./AgentService.js").AgentService;

function buildService(checkpointStore: FakeCheckpointStore): AgentServiceType {
  const queueStub = {
    enqueueQueuedTurn: async () => true,
    claimNextQueuedTurn: async () => null,
  };
  return new AgentServiceCtor({
    // SAFETY: the service only reads the queue slice on the busy/promotion
    // paths, which these tests never take — the two stubbed methods cover
    // the drain the session start triggers.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    store: queueStub as unknown as QueuedTurnStore,
    // SAFETY: FakeCheckpointStore implements the checkpoint slice the service
    // reads (paths, workspace, and the record/get/list/prune methods).
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    checkpointStore: checkpointStore as unknown as NonNullable<
      import("./AgentService.js").AgentServiceOptions["checkpointStore"]
    >,
    // SAFETY: the checkpoint fake adapter covers startSession/sendTurn, the
    // only adapter surface these tests reach.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    adapters: (emit) => [new CheckpointFakeAdapter(emit)] as unknown as ProviderAdapter[],
  });
}

/** The emit closure of the most recently built service's fake adapter. */
function lastEmit(): EmitEvent {
  const emit = CheckpointFakeAdapter.emits[CheckpointFakeAdapter.emits.length - 1];
  if (!emit) throw new Error("no fake adapter emit captured");
  return emit;
}

beforeAll(async () => {
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
});

describe("AgentService turn checkpoints", () => {
  test("sendTurn captures a checkpoint and records (thread, turn) → ref", async () => {
    const repo = await initTestRepo("kone-checkpoint-capture-");
    writeFileSync(path.join(repo, "note.txt"), "v1\n");
    const checkpoints = new FakeCheckpointStore(repo);
    const service = buildService(checkpoints);
    try {
      await service.startSession({ threadId: "t-capture", provider: "codex", cwd: repo });
      const result = await service.sendTurn({ threadId: "t-capture", input: "hi" });
      expect(result.turnId).toBe("checkpoint-turn-1");
      const row = checkpoints.getTurnCheckpoint("t-capture", result.turnId);
      expect(row).not.toBeNull();
      expect(row?.ref).toBe(`refs/kone/checkpoints/${row?.checkpointId}`);
      expect(await listCheckpoints(repo)).toHaveLength(1);
      expect(service.listTurnCheckpoints("t-capture")).toHaveLength(1);
    } finally {
      await service.stopAll();
    }
  });

  test("a second capture for the same turn keeps the first snapshot", async () => {
    const repo = await initTestRepo("kone-checkpoint-idem-");
    writeFileSync(path.join(repo, "note.txt"), "v1\n");
    const checkpoints = new FakeCheckpointStore(repo);
    const service = buildService(checkpoints);
    try {
      await service.startSession({ threadId: "t-idem", provider: "codex", cwd: repo });
      const first = await service.sendTurn({ threadId: "t-idem", input: "one" });
      const firstRow = checkpoints.getTurnCheckpoint("t-idem", first.turnId);
      expect(firstRow).not.toBeNull();
      // The agent modified the tree after the first capture; a second capture
      // for the same turn id must not clobber the pre-turn snapshot.
      writeFileSync(path.join(repo, "note.txt"), "v2-after-agent\n");
      const second = await service.sendTurn({ threadId: "t-idem", input: "two" });
      expect(second.turnId).toBe(first.turnId);
      expect(checkpoints.getTurnCheckpoint("t-idem", second.turnId)?.checkpointId).toBe(
        firstRow?.checkpointId,
      );
      expect(await listCheckpoints(repo)).toHaveLength(1);
    } finally {
      await service.stopAll();
    }
  });

  test("a store failure degrades to no checkpoint without failing the turn", async () => {
    const repo = await initTestRepo("kone-checkpoint-fail-");
    const checkpoints = new FakeCheckpointStore(repo, true);
    const service = buildService(checkpoints);
    try {
      await service.startSession({ threadId: "t-fail", provider: "codex", cwd: repo });
      const result = await service.sendTurn({ threadId: "t-fail", input: "hi" });
      expect(result.turnId).toBe("checkpoint-turn-1");
      expect(service.listTurnCheckpoints("t-fail")).toEqual([]);
    } finally {
      await service.stopAll();
    }
  });

  test("a non-repo project path degrades to no checkpoint", async () => {
    const plain = mkdtempSync(path.join(tmpdir(), "kone-checkpoint-plain-"));
    const checkpoints = new FakeCheckpointStore(plain);
    const service = buildService(checkpoints);
    try {
      await service.startSession({ threadId: "t-plain", provider: "codex", cwd: plain });
      const result = await service.sendTurn({ threadId: "t-plain", input: "hi" });
      expect(result.turnId).toBe("checkpoint-turn-1");
      expect(checkpoints.getTurnCheckpoint("t-plain", result.turnId)).toBeNull();
    } finally {
      await service.stopAll();
    }
  });

  test("an unforced revert refuses with the exact file lists, then force restores", async () => {
    const repo = await initTestRepo("kone-checkpoint-revert-");
    writeFileSync(path.join(repo, "note.txt"), "v1\n");
    const checkpoints = new FakeCheckpointStore(repo);
    const service = buildService(checkpoints);
    try {
      await service.startSession({ threadId: "t-revert", provider: "codex", cwd: repo });
      const result = await service.sendTurn({ threadId: "t-revert", input: "hi" });
      writeFileSync(path.join(repo, "note.txt"), "v2-after-agent\n");
      writeFileSync(path.join(repo, "added-by-agent.txt"), "new\n");
      // No force: refuse rather than clobber, naming exactly what would change.
      const refused = await service.revertToTurnCheckpoint("t-revert", result.turnId);
      expect(refused).toEqual({
        ok: false,
        reason: "dirty",
        wouldWrite: ["note.txt"],
        wouldDelete: ["added-by-agent.txt"],
      });
      // The refusal changed nothing.
      expect(readFileSync(path.join(repo, "note.txt"), "utf8")).toBe("v2-after-agent\n");
      expect(existsSync(path.join(repo, "added-by-agent.txt"))).toBe(true);
      // The preview agrees with the refusal, without changing anything either.
      expect(await service.previewTurnCheckpoint("t-revert", result.turnId)).toEqual({
        ok: true,
        wouldWrite: ["note.txt"],
        wouldDelete: ["added-by-agent.txt"],
      });
      // Forced: the full-tree restore removes the turn's new files and brings
      // back what it overwrote.
      const reverted = await service.revertToTurnCheckpoint("t-revert", result.turnId, true);
      expect(reverted).toEqual({ ok: true });
      expect(readFileSync(path.join(repo, "note.txt"), "utf8")).toBe("v1\n");
      expect(existsSync(path.join(repo, "added-by-agent.txt"))).toBe(false);
      // Repeatable: a second restore previews empty and still succeeds.
      expect(await service.previewTurnCheckpoint("t-revert", result.turnId)).toEqual({
        ok: true,
        wouldWrite: [],
        wouldDelete: [],
      });
      expect(await service.revertToTurnCheckpoint("t-revert", result.turnId)).toEqual({
        ok: true,
      });
      // The transcript is untouched — restoring files never truncates turns.
      expect(service.listTurnCheckpoints("t-revert")).toHaveLength(1);
    } finally {
      await service.stopAll();
    }
  });

  test("preview answers missing for an unknown turn", async () => {
    const repo = await initTestRepo("kone-checkpoint-preview-missing-");
    const checkpoints = new FakeCheckpointStore(repo);
    const service = buildService(checkpoints);
    try {
      await service.startSession({ threadId: "t-pv", provider: "codex", cwd: repo });
      expect(await service.previewTurnCheckpoint("t-pv", "nope")).toEqual({
        ok: false,
        reason: "missing",
      });
    } finally {
      await service.stopAll();
    }
  });

  test("revert answers checkpoint-gone when the git object is gone", async () => {
    const repo = await initTestRepo("kone-checkpoint-gone-");
    writeFileSync(path.join(repo, "note.txt"), "v1\n");
    const checkpoints = new FakeCheckpointStore(repo);
    const service = buildService(checkpoints);
    try {
      await service.startSession({ threadId: "t-gone", provider: "codex", cwd: repo });
      const result = await service.sendTurn({ threadId: "t-gone", input: "hi" });
      const row = checkpoints.getTurnCheckpoint("t-gone", result.turnId);
      expect(row).not.toBeNull();
      // The row survives but the ref is pruned out from under it — a re-clone
      // or an aggressive gc leaves exactly this shape behind.
      expect(await dropCheckpoint(repo, row?.checkpointId ?? "")).toBe(true);
      expect(await service.previewTurnCheckpoint("t-gone", result.turnId)).toEqual({
        ok: false,
        reason: "checkpoint-gone",
        detail: row?.ref,
      });
      expect(await service.revertToTurnCheckpoint("t-gone", result.turnId, true)).toEqual({
        ok: false,
        reason: "checkpoint-gone",
        detail: row?.ref,
      });
    } finally {
      await service.stopAll();
    }
  });

  test("revert answers no-workdir when the workspace directory is gone", async () => {
    const repo = await initTestRepo("kone-checkpoint-moved-");
    writeFileSync(path.join(repo, "note.txt"), "v1\n");
    const checkpoints = new FakeCheckpointStore(repo);
    const service = buildService(checkpoints);
    try {
      await service.startSession({ threadId: "t-moved", provider: "codex", cwd: repo });
      const result = await service.sendTurn({ threadId: "t-moved", input: "hi" });
      // The worktree the store names was removed from disk out from under it.
      rmSync(repo, { recursive: true, force: true });
      expect(await service.previewTurnCheckpoint("t-moved", result.turnId)).toEqual({
        ok: false,
        reason: "no-workdir",
        detail: repo,
      });
      expect(await service.revertToTurnCheckpoint("t-moved", result.turnId, true)).toEqual({
        ok: false,
        reason: "no-workdir",
        detail: repo,
      });
    } finally {
      await service.stopAll();
    }
  });

  test("revert answers missing for an unknown turn and busy for a live one", async () => {
    const repo = await initTestRepo("kone-checkpoint-reasons-");
    const checkpoints = new FakeCheckpointStore(repo);
    const service = buildService(checkpoints);
    try {
      await service.startSession({ threadId: "t-reasons", provider: "codex", cwd: repo });
      expect(await service.revertToTurnCheckpoint("t-reasons", "nope")).toEqual({
        ok: false,
        reason: "missing",
      });
      // Drive the merged stream the way an adapter would: turn.started marks
      // the thread busy, so a revert under it must refuse, not corrupt it.
      const emit = lastEmit();
      emit({
        type: "turn.started",
        threadId: "t-reasons",
        provider: "codex",
        at: Date.now(),
        source: "kone.store",
        turnId: "live-turn",
      });
      expect(await service.revertToTurnCheckpoint("t-reasons", "live-turn")).toEqual({
        ok: false,
        reason: "busy",
      });
      emit({
        type: "turn.completed",
        threadId: "t-reasons",
        provider: "codex",
        at: Date.now(),
        source: "kone.store",
        turnId: "live-turn",
      });
    } finally {
      await service.stopAll();
    }
  });

  test("concurrent reverts for one thread both settle", async () => {
    const repo = await initTestRepo("kone-checkpoint-serial-");
    writeFileSync(path.join(repo, "note.txt"), "v1\n");
    const checkpoints = new FakeCheckpointStore(repo);
    const service = buildService(checkpoints);
    try {
      await service.startSession({ threadId: "t-serial", provider: "codex", cwd: repo });
      const result = await service.sendTurn({ threadId: "t-serial", input: "hi" });
      const [a, b] = await Promise.all([
        service.revertToTurnCheckpoint("t-serial", result.turnId, true),
        service.revertToTurnCheckpoint("t-serial", result.turnId, true),
      ]);
      expect(a).toEqual({ ok: true });
      expect(b).toEqual({ ok: true });
    } finally {
      await service.stopAll();
    }
  });
});
