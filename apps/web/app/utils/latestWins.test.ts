import { describe, expect, test } from "bun:test";
import { createLatestWinsRun, createSectionSerializer } from "./latestWins";

// Focused tests for the serialized latest-wins git-refresh queue (adopted
// queued follow-up per runner/section, joins only while queued, and results
// that always reflect the newest request.

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createLatestWinsRun", () => {
  test("coalesces concurrent calls into one follow-up run", async () => {
    const calls: number[] = [];
    const gates: Array<() => void> = [];
    const fn = () =>
      new Promise<number>((resolve) => {
        calls.push(calls.length + 1);
        gates.push(() => resolve(calls.length));
      });
    const { run } = createLatestWinsRun(fn);

    const p1 = run();
    await tick();
    expect(calls).toEqual([1]);
    const p2 = run(); // arrives while reads are in flight → queues a follow-up
    const p3 = run(); // arrives while the follow-up is still queued → joins it

    gates[0]!();
    await tick();
    // Exactly one follow-up: 3 calls → 2 runs, latest-wins.
    expect(calls).toEqual([1, 2]);
    expect(await p1).toBe(1);
    gates[1]!();
    expect(await p2).toBe(2);
    expect(await p3).toBe(2);
    expect(calls).toEqual([1, 2]);
  });

  test("a call after the follow-up's reads began queues another run", async () => {
    const calls: number[] = [];
    const gates: Array<() => void> = [];
    const fn = () =>
      new Promise<number>((resolve) => {
        calls.push(calls.length + 1);
        gates.push(() => resolve(calls.length));
      });
    const { run } = createLatestWinsRun(fn);

    const p1 = run();
    await tick();
    const p2 = run(); // queued follow-up
    gates[0]!();
    await tick(); // follow-up's reads have begun
    const p3 = run(); // may predate p2's reads → another fresh run behind it

    gates[1]!();
    await tick();
    expect(calls).toEqual([1, 2, 3]);
    gates[2]!();
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
    expect(await p3).toBe(3);
  });

  test("a failing run clears the slot; the next call starts fresh", async () => {
    let fail = true;
    const fn = () => (fail ? Promise.reject(new Error("boom")) : Promise.resolve("ok"));
    const { run } = createLatestWinsRun(fn);

    await expect(run()).rejects.toThrow("boom");
    fail = false;
    await expect(run()).resolves.toBe("ok");
  });
});

describe("createSectionSerializer", () => {
  test("same key joins the in-flight read instead of re-running", async () => {
    const runs: string[] = [];
    const gates: Array<() => void> = [];
    const make = (label: string) => () =>
      new Promise<void>((resolve) => {
        runs.push(label);
        gates.push(() => resolve());
      });
    const { schedule } = createSectionSerializer();

    const p1 = schedule("prs:open", make("open"));
    await tick();
    const p2 = schedule("prs:open", make("open-again"));
    gates[0]!();
    await p1;
    await p2;
    expect(runs).toEqual(["open"]);
  });

  test("a different key supersedes and serializes so results land in order", async () => {
    const runs: string[] = [];
    const gates: Array<() => void> = [];
    const make = (label: string) => () =>
      new Promise<void>((resolve) => {
        runs.push(label);
        gates.push(() => resolve());
      });
    const { schedule } = createSectionSerializer();

    const pOpen = schedule("prs:open", make("open"));
    await tick();
    const pAll = schedule("prs:all", make("all"));
    expect(runs).toEqual(["open"]); // "all" is queued, not started

    gates[0]!();
    await pOpen;
    await tick();
    expect(runs).toEqual(["open", "all"]); // older write lands before newer
    gates[1]!();
    await pAll;
  });

  test("a third request skips the superseded queued read (latest-wins)", async () => {
    const runs: string[] = [];
    const gates: Array<() => void> = [];
    const make = (label: string) => () =>
      new Promise<void>((resolve) => {
        runs.push(label);
        gates.push(() => resolve());
      });
    const { schedule } = createSectionSerializer();

    const pOpen = schedule("prs:open", make("open"));
    await tick();
    const pAll = schedule("prs:all", make("all")); // supersedes "open", queued
    const pOpen2 = schedule("prs:open", make("open-2")); // supersedes "all"

    gates[0]!();
    await pOpen;
    await tick();
    // "all" was superseded while still queued — only the newest read runs.
    expect(runs).toEqual(["open", "open-2"]);
    gates[1]!();
    await pOpen2;
    await pAll; // the superseded queued read resolves without having run
    expect(runs).toEqual(["open", "open-2"]);
  });

  test("different sections run concurrently", async () => {
    const runs: string[] = [];
    const gates: Array<() => void> = [];
    const make = (label: string) => () =>
      new Promise<void>((resolve) => {
        runs.push(label);
        gates.push(() => resolve());
      });
    const { schedule } = createSectionSerializer();

    const pA = schedule("commits", make("commits"));
    await tick();
    const pB = schedule("branches", make("branches"));
    expect(runs).toEqual(["commits", "branches"]);
    gates[0]!();
    gates[1]!();
    await pA;
    await pB;
  });
});
