import { describe, expect, test } from "bun:test";

import { renderScope } from "./renderScope.js";

const never = new Promise<never>(() => {});

describe("renderScope", () => {
  test("passes work through that finishes inside the deadline", async () => {
    const scope = renderScope(1_000, undefined, "late");
    try {
      expect(await scope.run(Promise.resolve(7))).toBe(7);
      await scope.wait(1);
    } finally {
      scope.dispose();
    }
  });

  test("stops any step still running when the deadline passes", async () => {
    const scope = renderScope(20, undefined, "late");
    try {
      await scope.run(Promise.resolve());
      await expect(scope.run(never)).rejects.toThrow("late");
      await expect(scope.wait(10_000)).rejects.toThrow("late");
    } finally {
      scope.dispose();
    }
  });

  test("stops the step in flight the moment the caller aborts", async () => {
    const controller = new AbortController();
    const scope = renderScope(10_000, controller.signal, "late");
    try {
      const pending = scope.run(never);
      controller.abort(new Error("cancelled"));
      await expect(pending).rejects.toThrow("cancelled");
    } finally {
      scope.dispose();
    }
  });

  test("starts stopped when the caller has already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const scope = renderScope(10_000, controller.signal, "late");
    try {
      await expect(scope.run(Promise.resolve(1))).rejects.toThrow("cancelled");
    } finally {
      scope.dispose();
    }
  });
});
