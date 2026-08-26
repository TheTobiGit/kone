import { describe, expect, it } from "bun:test";
import { withFileMutationQueue } from "./fileMutationQueue.js";

describe("withFileMutationQueue", () => {
  it("serializes concurrent operations targeting the same file", async () => {
    const events: string[] = [];
    const targetFile = "/tmp/test-queue-target.txt";

    const { promise: op1Started, resolve: markOp1Started } = Promise.withResolvers<void>();
    const { promise: allowOp1Finish, resolve: finishOp1 } = Promise.withResolvers<void>();

    const op1 = withFileMutationQueue(targetFile, async () => {
      events.push("op1:start");
      markOp1Started();
      await allowOp1Finish;
      events.push("op1:end");
      return "res1";
    });

    // Wait until op1 has acquired the queue and started
    await op1Started;

    const op2 = withFileMutationQueue(targetFile, async () => {
      events.push("op2:start");
      events.push("op2:end");
      return "res2";
    });

    // op2 must NOT have started while op1 is blocked
    expect(events).toEqual(["op1:start"]);

    // Allow op1 to finish
    finishOp1();

    const [res1, res2] = await Promise.all([op1, op2]);
    expect(res1).toBe("res1");
    expect(res2).toBe("res2");
    expect(events).toEqual(["op1:start", "op1:end", "op2:start", "op2:end"]);
  });

  it("runs operations targeting different files in parallel", async () => {
    const events: string[] = [];
    const fileA = "/tmp/test-file-a.txt";
    const fileB = "/tmp/test-file-b.txt";

    const { promise: opAStarted, resolve: markOpAStarted } = Promise.withResolvers<void>();
    const { promise: opBStarted, resolve: markOpBStarted } = Promise.withResolvers<void>();
    const { promise: allowBothFinish, resolve: finishBoth } = Promise.withResolvers<void>();

    const opA = withFileMutationQueue(fileA, async () => {
      events.push("opA:start");
      markOpAStarted();
      await allowBothFinish;
      events.push("opA:end");
      return "resA";
    });

    const opB = withFileMutationQueue(fileB, async () => {
      events.push("opB:start");
      markOpBStarted();
      await allowBothFinish;
      events.push("opB:end");
      return "resB";
    });

    // Both operations should start concurrently without waiting for each other
    await Promise.all([opAStarted, opBStarted]);
    expect(events).toContain("opA:start");
    expect(events).toContain("opB:start");

    finishBoth();
    const [resA, resB] = await Promise.all([opA, opB]);
    expect(resA).toBe("resA");
    expect(resB).toBe("resB");
    expect(events).toContain("opA:end");
    expect(events).toContain("opB:end");
  });

  it("cleans up queue properly after rejected operations so subsequent operations proceed", async () => {
    const targetFile = "/tmp/test-queue-error.txt";
    const events: string[] = [];

    const opFail = withFileMutationQueue(targetFile, async () => {
      events.push("fail:run");
      throw new Error("intentional mutation failure");
    });

    await expect(opFail).rejects.toThrow("intentional mutation failure");

    const opSuccess = withFileMutationQueue(targetFile, async () => {
      events.push("success:run");
      return "recovered";
    });

    const result = await opSuccess;
    expect(result).toBe("recovered");
    expect(events).toEqual(["fail:run", "success:run"]);
  });

  it("serializes operations for a path that does not exist yet", async () => {
    const events: string[] = [];
    const missingFile = `/tmp/kone-missing-queue-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;

    const { promise: op1Started, resolve: markOp1Started } = Promise.withResolvers<void>();
    const { promise: allowOp1Finish, resolve: finishOp1 } = Promise.withResolvers<void>();

    const op1 = withFileMutationQueue(missingFile, async () => {
      events.push("op1:start");
      markOp1Started();
      await allowOp1Finish;
      events.push("op1:end");
      return "created";
    });

    await op1Started;

    const op2 = withFileMutationQueue(missingFile, async () => {
      events.push("op2:start");
      events.push("op2:end");
      return "updated";
    });

    expect(events).toEqual(["op1:start"]);
    finishOp1();

    const [res1, res2] = await Promise.all([op1, op2]);
    expect(res1).toBe("created");
    expect(res2).toBe("updated");
    expect(events).toEqual(["op1:start", "op1:end", "op2:start", "op2:end"]);
  });
});
