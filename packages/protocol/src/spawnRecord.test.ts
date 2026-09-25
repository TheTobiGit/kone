import { describe, expect, it } from "bun:test";
import { formatSpawnResult, isSpawnToolName, parseSpawnRecords, spawnWhy, type SpawnRecord } from "./spawnRecord";

const record: SpawnRecord = { threadId: "child-1", title: "Fix tests", provider: "codex", why: "it's slow" };

describe("spawn results", () => {
  it("round-trips every thread a result recorded, in order", () => {
    const second: SpawnRecord = { ...record, threadId: "child-2", agent: "Ada", agentId: "agent-ada" };
    const text = formatSpawnResult({ spawns: [record, second], summary: "Spawned 2 threads." });
    expect(parseSpawnRecords(text)).toEqual([record, second]);
  });

  it("still reads the bare single record an earlier build wrote", () => {
    const text = JSON.stringify({ ...record, summary: 'Spawned "Fix tests".' });
    expect(parseSpawnRecords(text)).toEqual([record]);
  });

  it("records nothing for a refusal sentence, an empty envelope or no text", () => {
    expect(parseSpawnRecords("1 spawn failed: item 0: No preset.")).toEqual([]);
    expect(parseSpawnRecords(formatSpawnResult({ spawns: [], summary: "none" }))).toEqual([]);
    expect(parseSpawnRecords(undefined)).toEqual([]);
  });
});

describe("spawnWhy", () => {
  it("keeps the clause after because, without the model's own because or full stop", () => {
    expect(spawnWhy("  Because the suite is slow. ")).toBe("the suite is slow");
    expect(spawnWhy("the suite is slow")).toBe("the suite is slow");
  });

  it("is null when no reason is left", () => {
    expect(spawnWhy(undefined)).toBeNull();
    expect(spawnWhy("  . ")).toBeNull();
  });
});

describe("isSpawnToolName", () => {
  it("names only the tools that open threads", () => {
    expect(isSpawnToolName("kone_spawn_batch")).toBe(true);
    expect(isSpawnToolName("kone_continue_thread")).toBe(false);
  });
});
