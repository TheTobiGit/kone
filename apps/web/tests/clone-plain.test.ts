import { describe, expect, test } from "bun:test";
import { reactive, ref } from "vue";

import { clonePlain } from "../app/lib/utils";

describe("clonePlain", () => {
  test("deep-clones a reactive array that structuredClone rejects", () => {
    // Reproduces the runtime crash: structuredClone throws DataCloneError on
    // Vue reactive proxies ("[object Array] could not be cloned"), which is
    // what persisting/hydrating reactive turn state used to hit.
    const turns = reactive([
      { id: "a", tools: [] as unknown[], artifacts: [] as unknown[] },
      { id: "b", tools: [{ id: "t1", paths: ["x.ts"] }], artifacts: [] },
    ]);

    expect(() => structuredClone(turns)).toThrow();

    const cloned = clonePlain(turns);
    expect(cloned).toEqual([
      { id: "a", tools: [], artifacts: [] },
      { id: "b", tools: [{ id: "t1", paths: ["x.ts"] }], artifacts: [] },
    ]);
  });

  test("produces a detached, non-reactive copy", () => {
    const source = ref([{ id: "a", nested: { value: 1 } }]);
    const cloned = clonePlain(source.value);

    cloned[0]!.nested.value = 99;
    expect(source.value[0]!.nested.value).toBe(1);
  });
});
