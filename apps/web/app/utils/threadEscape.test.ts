import { describe, expect, test } from "bun:test";
import { createThreadEscapeStack } from "./threadEscape";

function keyEvent(key = "Escape", handled = false) {
  return {
    key,
    defaultPrevented: handled,
    stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
}

describe("thread Escape routing", () => {
  test("walks diff, rail, composer regardless of registration order", () => {
    const stack = createThreadEscapeStack();
    const open = { composer: true, rail: true, diff: true };
    const dismissed: string[] = [];
    for (const kind of ["composer", "diff", "rail"] as const) {
      stack.register(kind, () => open[kind], () => {
        open[kind] = false;
        dismissed.push(kind);
      });
    }
    for (let index = 0; index < 3; index++) {
      const event = keyEvent();
      expect(stack.handle(event)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(event.stopped).toBe(true);
      expect(dismissed).toHaveLength(index + 1);
    }
    expect(dismissed).toEqual(["diff", "rail", "composer"]);
    expect(stack.handle(keyEvent())).toBe(false);
  });

  test("leaves external pickers their press and keeps lower layers open", () => {
    const stack = createThreadEscapeStack();
    let dismissed = false;
    stack.register("rail", () => true, () => { dismissed = true; });
    const unregister = stack.register("picker", () => true, null);
    const event = keyEvent();
    expect(stack.handle(event)).toBe(false);
    expect(event.stopped).toBe(false);
    expect(dismissed).toBe(false);
    unregister();
    expect(stack.handle(keyEvent())).toBe(true);
  });

  test("internal picker takes precedence and already consumed keys do nothing", () => {
    const stack = createThreadEscapeStack();
    const dismissed: string[] = [];
    stack.register("diff", () => true, () => dismissed.push("diff"));
    stack.register("picker", () => true, () => dismissed.push("picker"));
    expect(stack.handle(keyEvent("Escape", true))).toBe(false);
    expect(stack.handle(keyEvent("Enter"))).toBe(false);
    expect(dismissed).toEqual([]);
    expect(stack.handle(keyEvent())).toBe(true);
    expect(dismissed).toEqual(["picker"]);
  });

  test("unmounted layers cannot consume a later press", () => {
    const stack = createThreadEscapeStack();
    const unregister = stack.register("diff", () => true, () => {});
    unregister();
    unregister();
    expect(stack.handle(keyEvent())).toBe(false);
  });
});
