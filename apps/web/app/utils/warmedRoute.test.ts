import { describe, expect, test } from "bun:test";

import { createWarmedRoute } from "~/utils/warmedRoute";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A route call that records what it was asked and answers with it, so a test
 *  can tell one warmed answer from another. */
function recorder(context = () => "ctx", stillWanted?: (request: string) => boolean) {
  const asked: string[] = [];
  const warmed = createWarmedRoute<string>({
    route: (request) => {
      asked.push(request);
      return Promise.resolve(`answer:${request}`);
    },
    context,
    debounceMs: 10,
    stillWanted,
  });
  return { asked, warmed };
}

describe("createWarmedRoute", () => {
  test("does not ask until the debounce elapses", async () => {
    const { asked, warmed } = recorder();
    warmed.warm("write the migration");
    expect(asked).toEqual([]);
    await tick(20);
    expect(asked).toEqual(["write the migration"]);
  });

  test("steady typing asks once, for the last thing typed", async () => {
    const { asked, warmed } = recorder();
    for (const draft of ["write", "write the", "write the migration"]) {
      warmed.warm(draft);
      await tick(3);
    }
    await tick(20);
    expect(asked).toEqual(["write the migration"]);
  });

  test("take answers the same request and consumes it", async () => {
    const { warmed } = recorder();
    warmed.warm("write the migration");
    await tick(20);
    await expect(warmed.take("write the migration")).resolves.toBe("answer:write the migration");
    expect(warmed.take("write the migration")).toBeNull();
  });

  test("take refuses a different request", async () => {
    const { warmed } = recorder();
    warmed.warm("write the migration");
    await tick(20);
    expect(warmed.take("revert the migration")).toBeNull();
  });

  test("take refuses an answer worked out under a different context", async () => {
    let context = "team-a";
    const { warmed } = recorder(() => context);
    warmed.warm("write the migration");
    await tick(20);
    context = "team-b";
    expect(warmed.take("write the migration")).toBeNull();
  });

  test("a superseded draft never lands on the answer typed back to", async () => {
    // Type A, let it warm. Type B, then delete back to A inside the debounce:
    // B's ask is about a question nobody is asking any more, and must not
    // replace the answer A already has.
    const { asked, warmed } = recorder();
    warmed.warm("write the migration");
    await tick(20);
    warmed.warm("revert the migration");
    await tick(3);
    warmed.warm("write the migration");
    await tick(20);
    expect(asked).toEqual(["write the migration"]);
    await expect(warmed.take("write the migration")).resolves.toBe("answer:write the migration");
  });

  test("a request already answered is not asked again", async () => {
    const { asked, warmed } = recorder();
    warmed.warm("write the migration");
    await tick(20);
    warmed.warm("write the migration");
    await tick(20);
    expect(asked).toEqual(["write the migration"]);
  });

  test("stillWanted refusal spends no call", async () => {
    let wanted = true;
    const { asked, warmed } = recorder(() => "ctx", () => wanted);
    warmed.warm("write the migration");
    wanted = false;
    await tick(20);
    expect(asked).toEqual([]);
    expect(warmed.take("write the migration")).toBeNull();
  });

  test("clear drops both the pending ask and the held answer", async () => {
    const { asked, warmed } = recorder();
    warmed.warm("write the migration");
    await tick(20);
    warmed.warm("revert the migration");
    warmed.clear();
    await tick(20);
    expect(asked).toEqual(["write the migration"]);
    expect(warmed.take("write the migration")).toBeNull();
  });

  test("take cancels a pending ask, so a send never leaves one behind", async () => {
    const { asked, warmed } = recorder();
    warmed.warm("write the migration");
    expect(warmed.take("write the migration")).toBeNull();
    await tick(20);
    expect(asked).toEqual([]);
  });
});
