import { describe, expect, it } from "bun:test";
import type { ModelPreference } from "~/types/desktop";
import { createModelPreferenceStore, type ModelPreferencesBridge } from "./useModelPreferences";

const route = (kind: string, model = true): ModelPreference => ({
  kind,
  label: kind,
  hint: "",
  model: model ? { provider: "claudeAgent", model: "opus" } : null,
  effort: null,
  enabled: model,
});

/** A promise the test settles by hand. */
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const kinds = (list: readonly ModelPreference[]) => list.map((p) => p.kind);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createModelPreferenceStore", () => {
  it("does not write until the store has been read", async () => {
    const read = gate<ModelPreference[]>();
    const saved: ModelPreference[][] = [];
    const store = createModelPreferenceStore(() => ({
      modelPreferences: () => read.promise,
      saveModelPreferences: async ({ preferences }) => {
        saved.push(preferences);
        return preferences;
      },
    }));

    const done = store.mutate((list) => [...list, route("mine")]);
    await tick();
    expect(saved).toEqual([]);

    read.resolve([route("custom")]);
    expect(await done).toBe("saved");
    // The write was built on what the store held, not on the starting set.
    expect(kinds(saved[0]!)).toEqual(["custom", "mine"]);
    expect(kinds(store.preferences.value)).toEqual(["custom", "mine"]);
  });

  it("reads again after a failed read, and writes nothing meanwhile", async () => {
    let reads = 0;
    const saved: ModelPreference[][] = [];
    const store = createModelPreferenceStore(() => ({
      modelPreferences: async () => {
        reads++;
        if (reads === 1) throw new Error("store down");
        return [route("custom")];
      },
      saveModelPreferences: async ({ preferences }) => {
        saved.push(preferences);
        return preferences;
      },
    }));

    await expect(store.hydrate()).rejects.toThrow();
    expect(await store.mutate((list) => [...list, route("a")])).toBe("saved");
    expect(reads).toBe(2);
    expect(kinds(saved[0]!)).toEqual(["custom", "a"]);
  });

  it("fails an edit, and leaves the list alone, when the store cannot be read", async () => {
    const store = createModelPreferenceStore(() => ({
      modelPreferences: async () => {
        throw new Error("store down");
      },
      saveModelPreferences: async () => {
        throw new Error("never reached");
      },
    }));
    const before = kinds(store.preferences.value);
    expect(await store.mutate(() => [route("a")])).toBe("failed");
    expect(kinds(store.preferences.value)).toEqual(before);
  });

  it("derives each edit from the latest list, so a slow earlier answer cannot undo a later edit", async () => {
    const acks: Array<ReturnType<typeof gate<ModelPreference[] | null>>> = [];
    const store = createModelPreferenceStore(() => ({
      modelPreferences: async () => [route("a"), route("b"), route("c"), route("d")],
      saveModelPreferences: ({ preferences }) => {
        const ack = gate<ModelPreference[] | null>();
        acks.push(ack);
        return ack.promise.then(() => preferences);
      },
    }));
    await store.hydrate();

    const remove = (kind: string) => store.mutate((list) => list.filter((p) => p.kind !== kind));
    const first = remove("a");
    const second = remove("b");
    const third = remove("c");

    // Every click shows at once, before any acknowledgement.
    expect(kinds(store.preferences.value)).toEqual(["d"]);

    await tick();
    acks[0]!.resolve(null);
    await first;
    // The later clicks are still on screen, not reverted to the first's snapshot.
    expect(kinds(store.preferences.value)).toEqual(["d"]);

    await tick();
    acks[1]!.resolve(null);
    await second;
    await tick();
    acks[2]!.resolve(null);
    await third;
    expect(kinds(store.preferences.value)).toEqual(["d"]);
  });

  it("rolls back only the edit the store refused", async () => {
    const answers = [true, false, true];
    let call = 0;
    const store = createModelPreferenceStore(() => ({
      modelPreferences: async () => [route("a"), route("b"), route("c")],
      saveModelPreferences: async ({ preferences }) => (answers[call++] ? preferences : null),
    }));
    await store.hydrate();

    const remove = (kind: string) => store.mutate((list) => list.filter((p) => p.kind !== kind));
    const outcomes = await Promise.all([remove("a"), remove("b"), remove("c")]);

    expect(outcomes).toEqual(["saved", "failed", "saved"]);
    expect(kinds(store.preferences.value)).toEqual(["b"]);
  });

  it("skips an edit that has nothing to change without writing", async () => {
    let writes = 0;
    const store = createModelPreferenceStore(() => ({
      modelPreferences: async () => [route("a")],
      saveModelPreferences: async ({ preferences }) => {
        writes++;
        return preferences;
      },
    }));
    expect(await store.mutate(() => null)).toBe("skipped");
    expect(writes).toBe(0);
  });

  it("keeps the local list on its own when there is no bridge", async () => {
    const store = createModelPreferenceStore(() => undefined);
    await store.hydrate();
    expect(await store.mutate(() => [route("a")])).toBe("saved");
    expect(kinds(store.preferences.value)).toEqual(["a"]);
  });
});

// Keeps the bridge type honest against the store's two calls.
const _typecheck: ModelPreferencesBridge = {
  modelPreferences: async () => [],
  saveModelPreferences: async ({ preferences }) => preferences,
};
void _typecheck;
