import { beforeEach, describe, expect, test } from "bun:test";

import {
  insertPreset,
  mintPresetId,
  patchPreset,
  presetRows,
  removePreset,
} from "./presetStore";
import type { AgentModelRef } from "~/types/desktop";

// No bridge outside the app, so these exercise the dev-fallback path: the rows
// *are* the store here. Putting them back is the whole reset.
beforeEach(() => {
  presetRows.value = [];
});

const haiku: AgentModelRef = { provider: "claudeAgent", model: "haiku", label: "Haiku" };
const gpt: AgentModelRef = { provider: "codex", model: "gpt-5", label: "GPT-5" };

describe("preset sub-agents store", () => {
  test("a fresh store holds nothing", () => {
    expect(presetRows.value).toEqual([]);
  });

  test("a created preset keeps its name, instructions and model", async () => {
    const row = await insertPreset({
      name: "Explorer",
      instructions: "Read only.",
      model: haiku,
    });
    expect(row).not.toBeNull();
    expect(row).toMatchObject({ name: "Explorer", instructions: "Read only." });
    expect(row!.model).toEqual(haiku);
    expect(presetRows.value).toHaveLength(1);
  });

  test("a created preset keeps the one model it names", async () => {
    const row = await insertPreset({ name: "Pinned", model: gpt });
    expect(row!.model).toEqual(gpt);
  });

  test("no model is null, not undefined", async () => {
    const row = await insertPreset({ name: "Loose" });
    expect(row!.model).toBeNull();
    const nulled = await insertPreset({ name: "AlsoLoose", model: null });
    expect(nulled!.model).toBeNull();
  });

  test("a nameless preset is refused", async () => {
    expect(await insertPreset({ name: "" })).toBeNull();
    expect(await insertPreset({ name: "   " })).toBeNull();
    expect(presetRows.value).toHaveLength(0);
  });

  test("presets keep the order they were created in", async () => {
    await insertPreset({ name: "First" });
    await insertPreset({ name: "Second" });
    await insertPreset({ name: "Third" });
    expect(presetRows.value.map((p) => p.name)).toEqual(["First", "Second", "Third"]);
  });

  test("an edit changes only the fields it names", async () => {
    const row = await insertPreset({ name: "Explorer", instructions: "Read only.", model: haiku });
    const edited = await patchPreset(row!.presetId, { instructions: "Read and map." });
    expect(edited).toMatchObject({ name: "Explorer", instructions: "Read and map." });
    expect(edited!.model).toEqual(haiku);
  });

  test("an edit can't blank the name", async () => {
    const row = await insertPreset({ name: "Explorer" });
    expect(await patchPreset(row!.presetId, { name: "" })).toBeNull();
    // The stored name stands.
    expect(presetRows.value[0]!.name).toBe("Explorer");
  });

  test("the model can be cleared to none", async () => {
    const row = await insertPreset({ name: "Explorer", model: haiku });
    const edited = await patchPreset(row!.presetId, { model: null });
    expect(edited!.model).toBeNull();
  });

  test("clearing instructions with null stores null", async () => {
    const row = await insertPreset({ name: "Explorer", instructions: "Read only." });
    const edited = await patchPreset(row!.presetId, { instructions: null });
    expect(edited!.instructions).toBeNull();
  });

  test("editing a preset that's gone is a no-op that answers null", async () => {
    expect(await patchPreset("nobody", { name: "Ghost" })).toBeNull();
  });

  test("a preset can be deleted, and deleting it again reports nothing removed", async () => {
    const row = await insertPreset({ name: "Explorer" });
    expect(await removePreset(row!.presetId)).toBe(true);
    expect(presetRows.value).toHaveLength(0);
    expect(await removePreset(row!.presetId)).toBe(false);
  });

  test("minted ids are unique", () => {
    expect(mintPresetId()).not.toBe(mintPresetId());
  });
});
