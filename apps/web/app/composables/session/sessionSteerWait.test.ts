import { describe, expect, test } from "bun:test";
import { nextTick, ref } from "vue";
import type { StepWait } from "~/types/desktop";
import type { AssistantBlock, ThreadBlock } from "~/composables/agentTypes";
import { useSessionSteerWait, type SteerWaitBridge } from "./sessionSteerWait";

const wait = (over: Partial<StepWait> = {}): StepWait => ({
  id: "w-1",
  turnId: "turn-1",
  from: "user",
  tool: { name: "bash", text: "bun test" },
  since: 0,
  ...over,
});

function running(turnId: string): AssistantBlock {
  return { id: turnId, role: "assistant", turnId, items: [], state: "running", at: 0 };
}

function harness(bridge: SteerWaitBridge | null) {
  const blocks = ref<ThreadBlock[]>([running("turn-1")]);
  const error = ref<string | null>(null);
  const unit = useSessionSteerWait({ threadId: ref("t-1"), blocks, error, bridge: () => bridge });
  return { unit, blocks, error };
}

describe("the steer wait", () => {
  test("a wait whose turn is running is offered", () => {
    const { unit } = harness(null);
    unit.offer(wait());
    expect(unit.steerWait.value?.id).toBe("w-1");
  });

  // Review finding 4: the reply can come back after the turn it waited on
  // ended, which already cleared the pill.
  test("a reply that comes back after its turn ended raises nothing", async () => {
    const { unit, blocks } = harness(null);
    blocks.value = [{ ...running("turn-1"), state: "interrupted" }];
    await nextTick();
    unit.offer(wait());
    expect(unit.steerWait.value).toBeNull();
  });

  test("it goes with the turn", async () => {
    const { unit, blocks } = harness(null);
    unit.offer(wait());
    blocks.value = [{ ...running("turn-1"), state: "interrupted" }];
    await nextTick();
    expect(unit.steerWait.value).toBeNull();
  });

  // Re-review finding 2: the thread stays busy when the next turn starts at
  // once — the steer the cut was for — so busy alone never clears the pill.
  test("it goes when its turn ends and the next starts at once", async () => {
    const { unit, blocks } = harness(null);
    unit.offer(wait());
    blocks.value = [{ ...running("turn-1"), state: "interrupted" }, running("turn-2")];
    await nextTick();
    expect(unit.steerWait.value).toBeNull();
  });

  test("Interrupt now names the wait on screen, and the pill goes once the turn is ending", async () => {
    const calls: [string, string][] = [];
    const { unit } = harness({
      interruptStepWaitNow: async (threadId, waitId) => {
        calls.push([threadId, waitId]);
        return true;
      },
    });
    unit.offer(wait());
    await unit.interruptNow();
    expect(calls).toEqual([["t-1", "w-1"]]);
    expect(unit.steerWait.value).toBeNull();
  });

  // Review finding 4: refused while parked, the wait is still armed, so the
  // offer stays.
  test("a refused Interrupt now keeps the pill", async () => {
    const { unit } = harness({ interruptStepWaitNow: async () => false });
    unit.offer(wait());
    await unit.interruptNow();
    expect(unit.steerWait.value?.id).toBe("w-1");
  });

  test("a failed one keeps the pill and says why", async () => {
    const { unit, error } = harness({
      interruptStepWaitNow: async () => {
        throw new Error("gone");
      },
    });
    unit.offer(wait());
    await unit.interruptNow();
    expect(unit.steerWait.value?.id).toBe("w-1");
    expect(error.value).toContain("gone");
  });
});
