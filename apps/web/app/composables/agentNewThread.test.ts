import { describe, expect, test } from "bun:test";
import { useAgent } from "./useAgent";

// Which session a "new thread" lands in.
//
// The registry is shared by every surface that has a project open, and it keeps
// at most one blank thread so the board's ⌘N cannot stack empty columns. That
// sharing is what a surface off the board must not inherit: the blank it would
// be handed belongs to a pane it cannot see, and the first turn would appear
// there instead of where it was written.

let seq = 0;
function registry() {
  // A unique cwd per test — the registry is keyed by project path, so this is
  // what makes each one a fresh project with a fresh boot session.
  return useAgent({ provider: "codex", cwd: `/tmp/kone-new-thread-${seq++}`, rehydrate: false });
}

describe("claiming a thread", () => {
  test("newThread reuses the registry's blank rather than stacking another", async () => {
    const agent = registry();
    const boot = agent.sessions.value[0]!;

    await agent.newThread();

    expect(agent.sessions.value).toHaveLength(1);
    expect(agent.activeKey.value).toBe(boot.key);
  });

  test("newDetachedThread takes a session of its own, blank or not", () => {
    const agent = registry();
    const boot = agent.sessions.value[0]!;

    const claimed = agent.newDetachedThread();

    expect(claimed).not.toBe(boot.key);
    expect(agent.sessions.value).toHaveLength(2);
    expect(agent.activeKey.value).toBe(claimed);
    // Its own thread from birth, so a surface can put the id on a row before
    // anything has answered.
    const session = agent.sessions.value.find((s) => s.key === claimed)!;
    expect(session.threadId.value).not.toBe(boot.threadId.value);
  });

  test("two detached claims never collide", () => {
    const agent = registry();
    const first = agent.newDetachedThread();
    const second = agent.newDetachedThread();
    expect(first).not.toBe(second);
  });
});
