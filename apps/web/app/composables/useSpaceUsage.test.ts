import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { nextTick, ref } from "vue";
import type { UsageRange } from "~/types/desktop";
import { useSpaceUsage } from "./useSpaceUsage";

// The board reads through its injected source: a stand-in whose reads the test
// holds open or releases by hand, so the order of "read started", "project
// changed" and "read finished" is the test's.

type Read = { promise: Promise<void>; finish: () => void };
function deferred(): Read {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

function setup() {
  const loads: Read[] = [];
  const asked: { ranges: readonly UsageRange[]; revalidate: boolean | undefined }[] = [];
  const stub = {
    ensureRanges: (ranges: readonly UsageRange[], options?: { revalidate?: boolean }) => {
      asked.push({ ranges, revalidate: options?.revalidate });
      const read = deferred();
      loads.push(read);
      return read.promise;
    },
    usageFor: () => null,
  };

  const path = ref("/a");
  const visible = ref(true);
  const usage = useSpaceUsage(
    () => path.value,
    () => visible.value,
    stub,
  );
  return { path, visible, usage, loads, asked };
}

/** Let the read behind `loads[i]` run to its end. */
async function finish(loads: Read[], i: number): Promise<void> {
  loads[i]!.finish();
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
}

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  // onMounted has no component to hang on here; Vue says so and skips it. The
  // watchers under test don't need it.
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("useSpaceUsage", () => {
  test("a read is one pass over every window, shortest first, re-reading cached ones", async () => {
    const { path, asked } = setup();
    // onMounted has no component here, so a project change on screen stands in
    // for the arrival: it reads at once.
    path.value = "/b";
    await nextTick();
    expect(asked).toEqual([{ ranges: ["1d", "7d", "30d", "all"], revalidate: true }]);
  });

  test("a project change on screen starts over: shimmer, then a fresh read", async () => {
    const { path, usage, loads } = setup();
    path.value = "/b";
    await nextTick();
    expect(loads).toHaveLength(1);
    expect(usage.settled.value).toBe(false);

    await finish(loads, 0);
    expect(usage.settled.value).toBe(true);

    path.value = "/c";
    await nextTick();
    expect(usage.settled.value).toBe(false);
    expect(loads).toHaveLength(2);
  });

  test("a project change while the tab is hidden waits for the next arrival", async () => {
    const { path, visible, usage, loads } = setup();
    // A first arrival reads and is done, so the revisit gap is running.
    visible.value = false;
    await nextTick();
    visible.value = true;
    await nextTick();
    await finish(loads, 0);
    expect(loads).toHaveLength(1);
    expect(usage.settled.value).toBe(true);

    visible.value = false;
    await nextTick();
    path.value = "/b";
    await nextTick();
    expect(loads).toHaveLength(1);
    expect(usage.settled.value).toBe(false);

    // No 30 second wait: the old project's last read says nothing about this one.
    visible.value = true;
    await nextTick();
    expect(loads).toHaveLength(2);
  });

  test("a read the project change overtook cannot settle the board", async () => {
    const { path, usage, loads } = setup();
    path.value = "/b";
    await nextTick();
    path.value = "/c";
    await nextTick();
    expect(loads).toHaveLength(2);

    await finish(loads, 0);
    expect(usage.settled.value).toBe(false);

    await finish(loads, 1);
    expect(usage.settled.value).toBe(true);
  });
});
