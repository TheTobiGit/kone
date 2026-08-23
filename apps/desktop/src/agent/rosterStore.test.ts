import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";

import { Database } from "bun:sqlite";

// The store imports node:sqlite, an Electron-runtime built-in this bun can't
// load — stand it in for bun:sqlite, whose API surface (exec / prepare().get /
// run / all) matches the store's usage. The agent layer's state dir is pointed
// at a throwaway temp dir per test, and ConversationStore is imported
// *dynamically* below so the stub is in place first (static imports hoist above
// mock.module, defeating it) — the same pattern spawnStore.test.ts uses.
let testUserDataDir = "";
/** Point the agent layer at a fresh temp state dir (see userDataDir.ts). */
function useUserDataDir(dir: string): string {
  testUserDataDir = dir;
  setUserDataDir(dir);
  return dir;
}
useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-roster-store-")));

mock.module("./sqlite.js", () => ({
  DatabaseSync: Database,
}));

type ConversationStoreType = import("./ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

function freshStore(): ConversationStoreType {
  useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-roster-store-")));
  return new ConversationStoreCtor();
}

function rawDb(): Database {
  return new Database(path.join(testUserDataDir, "conversations.sqlite"));
}

beforeAll(async () => {
  const storeModule = await import("./ConversationStore.js");
  ConversationStoreCtor = storeModule.ConversationStore;
});

/** Two preset ids, in the order the renderer asks for them. The store holds no
 *  preset definitions of its own — it takes the renderer's word for which ids
 *  exist — so any two ids exercise the ordering the same way. */
const PRESETS = ["kone", "gideon"];

function seeded(): ConversationStoreType {
  const store = freshStore();
  store.ensurePresetAgents(PRESETS);
  return store;
}

describe("the shipped presets", () => {
  test("each gets a row, in the order the renderer asked for", () => {
    const roster = seeded().listAgents();
    expect(roster.map((agent) => agent.agentId)).toEqual(PRESETS);
    expect(roster.map((agent) => agent.presetId)).toEqual(PRESETS);
  });

  // The whole point of an overlay row: it stores nothing until the user edits
  // something, so a later build's improved wording still reaches them.
  test("a row nobody has edited carries no values of its own", () => {
    const kone = seeded().listAgents()[0]!;
    expect(kone.name).toBeNull();
    expect(kone.role).toBeNull();
    expect(kone.instructions).toBeNull();
    expect(kone.faceBody).toBeNull();
    expect(kone.faceInk).toBeNull();
    expect(kone.avatar).toBeNull();
    expect(kone.bot).toBeNull();
  });

  test("hydrating twice changes nothing", () => {
    const store = seeded();
    const before = store.listAgents();
    store.ensurePresetAgents(PRESETS);
    expect(store.listAgents()).toEqual(before);
  });

  test("an edit survives the next hydrate", () => {
    const store = seeded();
    store.updateAgent("kone", { name: "Maya" });
    store.ensurePresetAgents(PRESETS);
    expect(store.getAgent("kone")?.name).toBe("Maya");
  });

  test("a built-in shipped by a later build gets its row without a migration", () => {
    const store = seeded();
    store.ensurePresetAgents([...PRESETS, "ama"]);
    expect(store.listAgents().map((agent) => agent.agentId)).toEqual([...PRESETS, "ama"]);
  });

  // A dismissed built-in stays dismissed — otherwise every launch would hand it
  // back and the delete would read as a bug.
  test("hydrating never resurrects a built-in the user deleted", () => {
    const store = seeded();
    store.deleteAgent("gideon");
    store.ensurePresetAgents(PRESETS);
    expect(store.listAgents().map((agent) => agent.agentId)).toEqual(["kone"]);
  });

  test("nothing to ensure is not an error", () => {
    const store = freshStore();
    expect(() => store.ensurePresetAgents([])).not.toThrow();
    expect(store.listAgents()).toEqual([]);
  });
});

describe("editing an agent", () => {
  test("a field left out of the patch is left alone", () => {
    const store = seeded();
    store.updateAgent("kone", { name: "Maya", role: "Pair" });
    const updated = store.updateAgent("kone", { role: "Reviewer" });
    expect(updated?.name).toBe("Maya");
    expect(updated?.role).toBe("Reviewer");
  });

  // The distinction the schema exists to keep: null hands the field back to the
  // shipped preset, '' is the user saying it is blank on purpose.
  test("null hands a field back to the preset; an empty string blanks it", () => {
    const store = seeded();
    store.updateAgent("kone", { instructions: "Terse." });
    expect(store.updateAgent("kone", { instructions: null })?.instructions).toBeNull();

    store.updateAgent("kone", { instructions: "" });
    expect(store.getAgent("kone")?.instructions).toBe("");
  });

  test("surrounding space is not part of a stored field", () => {
    const store = seeded();
    expect(store.updateAgent("kone", { name: "  Maya  " })?.name).toBe("Maya");
  });

  test("a field longer than the row allows is clamped, not refused", () => {
    const store = seeded();
    const updated = store.updateAgent("kone", { instructions: "p".repeat(9000) });
    expect(updated?.instructions?.length).toBe(4000);
  });

  test("an empty patch is a read, not a write", () => {
    const store = seeded();
    const before = store.getAgent("kone");
    expect(store.updateAgent("kone", {})).toEqual(before);
    expect(store.getAgent("kone")?.updatedAt).toBe(before!.updatedAt);
  });

  test("editing somebody who isn't there reports it rather than inventing them", () => {
    const store = seeded();
    expect(store.updateAgent("nobody", { name: "Maya" })).toBeNull();
    expect(store.getAgent("nobody")).toBeNull();
  });

  test("an edit bumps updated_at and leaves created_at alone", () => {
    const store = seeded();
    const before = store.getAgent("kone")!;
    const after = store.updateAgent("kone", { name: "Maya" })!;
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });
});

describe("a user-made agent", () => {
  test("is created with its own values and no inheritance", () => {
    const store = seeded();
    const made = store.createAgent({
      agentId: "made-1",
      name: "Ama",
      role: "Reviewer",
      instructions: "Blunt.",
      faceBody: "var(--accent-3)",
      faceInk: "var(--accent-3-ink)",
    })!;
    expect(made.presetId).toBeNull();
    expect(made.name).toBe("Ama");
    expect(made.role).toBe("Reviewer");
    expect(made.instructions).toBe("Blunt.");
    expect(made.deletedAt).toBeNull();
  });

  test("lands at the end of the roster", () => {
    const store = seeded();
    store.createAgent({ agentId: "made-1", name: "Ama" });
    store.createAgent({ agentId: "made-2", name: "Kofi" });
    expect(store.listAgents().map((agent) => agent.agentId)).toEqual([
      ...PRESETS,
      "made-1",
      "made-2",
    ]);
  });

  test("gets an id of its own when the caller doesn't mint one", () => {
    const store = seeded();
    const made = store.createAgent({ name: "Ama" });
    expect(made?.agentId).toBeTruthy();
    expect(store.getAgent(made!.agentId)?.name).toBe("Ama");
  });

  // Nothing to inherit means the name is all there is; a nameless row would be
  // an agent with no way to refer to it.
  test("cannot be created nameless", () => {
    const store = seeded();
    expect(store.createAgent({ name: "" })).toBeNull();
    expect(store.createAgent({ name: "   " })).toBeNull();
    expect(store.listAgents().map((agent) => agent.agentId)).toEqual(PRESETS);
  });

  test("cannot have its name cleared to nothing", () => {
    const store = seeded();
    store.createAgent({ agentId: "made-1", name: "Ama" });
    expect(store.updateAgent("made-1", { name: null })).toBeNull();
    expect(store.getAgent("made-1")?.name).toBe("Ama");
  });
});

describe("leaving the roster", () => {
  test("a deleted agent drops out of the roster but keeps its row", () => {
    const store = seeded();
    store.createAgent({ agentId: "made-1", name: "Ama", instructions: "Blunt." });
    expect(store.deleteAgent("made-1")).toBe(true);
    expect(store.listAgents().map((agent) => agent.agentId)).toEqual(PRESETS);

    // The record of who worked a thread has to outlive the delete.
    const tombstone = store.getAgent("made-1");
    expect(tombstone?.name).toBe("Ama");
    expect(tombstone?.instructions).toBe("Blunt.");
    expect(tombstone?.deletedAt).toBeGreaterThan(0);
  });

  test("asking for the deleted ones back gets them, in roster order", () => {
    const store = seeded();
    store.deleteAgent("kone");
    expect(store.listAgents({ includeDeleted: true }).map((agent) => agent.agentId)).toEqual(
      PRESETS,
    );
  });

  test("deleting twice changes nothing the second time", () => {
    const store = seeded();
    expect(store.deleteAgent("kone")).toBe(true);
    expect(store.deleteAgent("kone")).toBe(false);
  });

  test("deleting somebody who was never there is not a delete", () => {
    expect(seeded().deleteAgent("nobody")).toBe(false);
  });

  // Editing a tombstone would be a way back into the roster through the side
  // door — the roster is what the user sees, so it has one entrance.
  test("a deleted agent cannot be edited", () => {
    const store = seeded();
    store.deleteAgent("kone");
    expect(store.updateAgent("kone", { name: "Maya" })).toBeNull();
    expect(store.getAgent("kone")?.name).toBeNull();
  });
});

describe("forking an agent", () => {
  test("a copy of a user-made agent carries its values and no inheritance", () => {
    const store = seeded();
    store.createAgent({
      agentId: "made-1",
      name: "Ama",
      role: "Reviewer",
      instructions: "Blunt.",
      faceBody: "var(--accent-3)",
    });
    const copy = store.duplicateAgent({ agentId: "made-1", newAgentId: "copy-1" })!;
    expect(copy.presetId).toBeNull();
    expect(copy.name).toBe("Ama");
    expect(copy.role).toBe("Reviewer");
    expect(copy.instructions).toBe("Blunt.");
    expect(copy.faceBody).toBe("var(--accent-3)");
  });

  // A fork keeps no inheritance, so what it copies is what the source reads as
  // — and only the renderer holds the shipped text to read it from.
  test("a copy of a built-in takes the caller's resolved values for the gaps", () => {
    const store = seeded();
    store.updateAgent("kone", { name: "Maya" });
    const copy = store.duplicateAgent({
      agentId: "kone",
      newAgentId: "copy-1",
      inherited: { name: "kone", role: "Agent assistant", instructions: "Calm." },
    })!;
    expect(copy.presetId).toBeNull();
    // The row's own value wins over what the preset would have said.
    expect(copy.name).toBe("Maya");
    expect(copy.role).toBe("Agent assistant");
    expect(copy.instructions).toBe("Calm.");
  });

  test("the copy is named by the caller when they want it renamed on the spot", () => {
    const store = seeded();
    store.createAgent({ agentId: "made-1", name: "Ama" });
    expect(store.duplicateAgent({ agentId: "made-1", name: "Ama copy" })?.name).toBe("Ama copy");
  });

  test("the copy sits straight after the agent it came from", () => {
    const store = seeded();
    store.createAgent({ agentId: "made-1", name: "Ama" });
    store.duplicateAgent({ agentId: "kone", newAgentId: "copy-1", inherited: { name: "kone" } });
    expect(store.listAgents().map((agent) => agent.agentId)).toEqual([
      "kone",
      "copy-1",
      "gideon",
      "made-1",
    ]);
  });

  test("a copy with nothing to name it is refused", () => {
    const store = seeded();
    expect(store.duplicateAgent({ agentId: "kone" })).toBeNull();
    expect(store.listAgents().map((agent) => agent.agentId)).toEqual(PRESETS);
  });

  test("there is nothing to fork from a deleted agent, or from nobody", () => {
    const store = seeded();
    store.deleteAgent("gideon");
    expect(store.duplicateAgent({ agentId: "gideon", name: "Copy" })).toBeNull();
    expect(store.duplicateAgent({ agentId: "nobody", name: "Copy" })).toBeNull();
  });
});

describe("an agent's capabilities", () => {
  // Null all round is the overlay's "inherit": an unedited row leans on the
  // preset for its skills and its model just as it does for its name.
  test("an unedited row inherits every capability", () => {
    const kone = seeded().listAgents()[0]!;
    expect(kone.skills).toBeNull();
    expect(kone.model).toBeNull();
  });

  test("a new agent keeps the capabilities it was made with", () => {
    const made = seeded().createAgent({
      name: "Ama",
      skills: [{ path: "/s/review.md", name: "Review", origin: "project" }],
      model: { provider: "claudeAgent", model: "sonnet", label: "Sonnet" },
    })!;
    expect(made.skills).toEqual([{ path: "/s/review.md", name: "Review", origin: "project" }]);
    expect(made.model).toEqual({ provider: "claudeAgent", model: "sonnet", label: "Sonnet" });
  });

  test("a new agent left silent about its capabilities inherits them", () => {
    const made = seeded().createAgent({ name: "Ama" })!;
    expect(made.skills).toBeNull();
    expect(made.model).toBeNull();
  });

  // A pinned model is a real answer stored on the row; null is the absence that
  // falls back to the preset. The overlay has to tell those apart.
  test("a pinned model is stored as an answer; null hands the field back", () => {
    const store = seeded();
    store.updateAgent("kone", { model: { provider: "codex", model: "gpt-5" } });
    expect(store.getAgent("kone")?.model).toEqual({ provider: "codex", model: "gpt-5" });
    expect(store.updateAgent("kone", { model: null })?.model).toBeNull();
  });

  test("a capability left out of a patch is left alone", () => {
    const store = seeded();
    store.updateAgent("kone", {
      skills: [{ path: "/s/a.md", name: "A", origin: "project" }],
      model: { provider: "codex", model: "gpt-5" },
    });
    const after = store.updateAgent("kone", {
      skills: [{ path: "/s/b.md", name: "B", origin: "project" }],
    })!;
    expect(after.skills).toEqual([{ path: "/s/b.md", name: "B", origin: "project" }]);
    expect(after.model).toEqual({ provider: "codex", model: "gpt-5" });
  });

  // A ref with nothing to identify it is not a ref: a skill needs a path and a
  // model needs an id, and an entry missing them is dropped rather than stored
  // for the reader to trip over.
  test("a malformed capability entry is dropped, not stored", () => {
    const made = seeded().createAgent({
      name: "Ama",
      skills: [
        { path: "", name: "Nameless", origin: "" },
        { path: "/s/ok.md", name: "Ok", origin: "project" },
      ],
      model: { provider: "codex", model: "" },
    })!;
    expect(made.skills).toEqual([{ path: "/s/ok.md", name: "Ok", origin: "project" }]);
    expect(made.model).toBeNull();
  });

  test("a model ref without a label comes back without one", () => {
    const made = seeded().createAgent({
      name: "Ama",
      model: { provider: "codex", model: "gpt-5" },
    })!;
    expect(made.model).toEqual({ provider: "codex", model: "gpt-5" });
    expect(made.model!.label).toBeUndefined();
  });

  // A fork keeps no inheritance, so a built-in's gaps are filled from the
  // resolved value the caller passes — but the row's own value still wins.
  test("a fork carries capabilities, the row's own winning over the preset's", () => {
    const store = seeded();
    store.updateAgent("kone", { model: { provider: "codex", model: "gpt-5" } });
    const copy = store.duplicateAgent({
      agentId: "kone",
      newAgentId: "copy-1",
      inherited: {
        name: "kone",
        model: { provider: "claudeAgent", model: "sonnet" },
      },
    })!;
    expect(copy.model).toEqual({ provider: "codex", model: "gpt-5" });
  });

  test("capabilities survive a round trip through the database", () => {
    const store = seeded();
    store.updateAgent("kone", {
      skills: [{ path: "/s/a.md", name: "A", origin: "project" }],
      model: { provider: "codex", model: "gpt-5", label: "GPT-5" },
    });
    store.close();

    const reopened = new ConversationStoreCtor();
    const kone = reopened.getAgent("kone")!;
    expect(kone.skills).toEqual([{ path: "/s/a.md", name: "A", origin: "project" }]);
    expect(kone.model).toEqual({ provider: "codex", model: "gpt-5", label: "GPT-5" });
  });
});

describe("how an agent looks", () => {
  const PICTURE = { source: "generated", src: "data:image/jpeg;base64,AAAA" };
  const BOT = { form: "pebble", color: "teal", expression: "curious" };

  test("an avatar and a bot are stored as answers; null hands each field back", () => {
    const store = seeded();
    store.updateAgent("kone", { avatar: PICTURE, bot: BOT });
    expect(store.getAgent("kone")!.avatar).toEqual(PICTURE);
    expect(store.getAgent("kone")!.bot).toEqual(BOT);

    store.updateAgent("kone", { avatar: null, bot: null });
    expect(store.getAgent("kone")!.avatar).toBeNull();
    expect(store.getAgent("kone")!.bot).toBeNull();
  });

  test("one left out of a patch is left alone", () => {
    const store = seeded();
    store.updateAgent("kone", { avatar: PICTURE, bot: BOT });
    store.updateAgent("kone", { bot: null });
    expect(store.getAgent("kone")!.avatar).toEqual(PICTURE);
    expect(store.getAgent("kone")!.bot).toBeNull();
  });

  test("a new agent keeps the appearance it was made with", () => {
    const made = seeded().createAgent({ name: "Ada", avatar: PICTURE, bot: BOT })!;
    expect(made.avatar).toEqual(PICTURE);
    expect(made.bot).toEqual(BOT);
  });

  // The store keeps no catalogue, so an id it has never heard of is stored and
  // handed back untouched — answering an unknown one with a default is the
  // renderer's job, and is what lets a bot outlive the build that made it.
  test("an unrecognised shape, colour or expression is kept, not corrected", () => {
    const odd = { form: "trefoil", color: "chartreuse", expression: "smug" };
    expect(seeded().createAgent({ name: "Ada", bot: odd })!.bot).toEqual(odd);
  });

  // Half an avatar draws nothing, so it is no avatar rather than a picture that
  // paints a blank where a face used to be.
  test("an avatar or bot missing a field is no avatar or bot at all", () => {
    const store = seeded();
    store.updateAgent("kone", {
      avatar: { source: "generated", src: "  " },
      bot: { form: "pebble", color: "", expression: "curious" },
    });
    expect(store.getAgent("kone")!.avatar).toBeNull();
    expect(store.getAgent("kone")!.bot).toBeNull();
  });

  test("a fork carries the appearance the source reads as", () => {
    const store = seeded();
    store.updateAgent("kone", { bot: BOT });
    const copy = store.duplicateAgent({
      agentId: "kone",
      newAgentId: "copy-1",
      inherited: { name: "kone", avatar: PICTURE, bot: { form: "circle", color: "ink", expression: "neutral" } },
    })!;
    // The row's own bot wins; the avatar it has none of comes from the preset.
    expect(copy.bot).toEqual(BOT);
    expect(copy.avatar).toEqual(PICTURE);
  });

  test("appearance survives a round trip through the database", () => {
    const store = seeded();
    store.updateAgent("kone", { avatar: PICTURE, bot: BOT });
    store.close();

    const reopened = new ConversationStoreCtor();
    expect(reopened.getAgent("kone")!.avatar).toEqual(PICTURE);
    expect(reopened.getAgent("kone")!.bot).toEqual(BOT);
  });

  // Bots saved before the form rename key their column JSON `shape`; the
  // normalizer maps it so an old row keeps its bot.
  test("a bot stored under the legacy `shape` key still reads back", async () => {
    const { parseAgentBot } = await import("./rosterRecord.js");
    expect(parseAgentBot('{"shape":"pebble","color":"teal","expression":"curious"}')).toEqual({
      form: "pebble",
      color: "teal",
      expression: "curious",
    });
  });

  // A generated face is carried by value, so the ceiling here is orders of
  // magnitude above every other field's — and still a ceiling.
  test("an avatar longer than the row allows is clamped, not refused", () => {
    const store = seeded();
    const huge = `data:image/jpeg;base64,${"A".repeat(600 * 1024)}`;
    store.updateAgent("kone", { avatar: { source: "generated", src: huge } });
    expect(store.getAgent("kone")!.avatar!.src.length).toBe(512 * 1024);
  });
});

describe("preset sub-agents", () => {
  test("a fresh store carries no presets", () => {
    expect(freshStore().listSubagentPresets()).toEqual([]);
  });

  test("a created preset keeps its name, instructions and model", () => {
    const made = freshStore().createSubagentPreset({
      name: "Explorer",
      instructions: "Read only. Report findings, change nothing.",
      model: { provider: "claudeAgent", model: "haiku", label: "Haiku" },
    })!;
    expect(made.name).toBe("Explorer");
    expect(made.instructions).toBe("Read only. Report findings, change nothing.");
    expect(made.model).toEqual({ provider: "claudeAgent", model: "haiku", label: "Haiku" });
  });

  // The chosen model is the preset's preference, and it round-trips as written.
  test("the model survives the database", () => {
    const store = freshStore();
    store.createSubagentPreset({
      presetId: "p1",
      name: "Explorer",
      model: { provider: "codex", model: "gpt-5" },
    });
    store.close();
    const reopened = new ConversationStoreCtor();
    expect(reopened.getSubagentPreset("p1")!.model).toEqual({ provider: "codex", model: "gpt-5" });
  });

  // There is no preset above this to inherit from, so a preset made with no
  // model is "no preference" — null, run where the caller runs.
  test("a preset with no model reads as null", () => {
    const made = freshStore().createSubagentPreset({ name: "Plain" })!;
    expect(made.model).toBeNull();
  });

  test("a preset must have a name", () => {
    expect(freshStore().createSubagentPreset({ name: "   " })).toBeNull();
  });

  test("presets come back in the order they were made", () => {
    const store = freshStore();
    store.createSubagentPreset({ name: "First" });
    store.createSubagentPreset({ name: "Second" });
    store.createSubagentPreset({ name: "Third" });
    expect(store.listSubagentPresets().map((p) => p.name)).toEqual(["First", "Second", "Third"]);
  });

  test("an edit changes only the fields it names", () => {
    const store = freshStore();
    const made = store.createSubagentPreset({
      name: "Explorer",
      instructions: "Original.",
      model: { provider: "codex", model: "gpt-5" },
    })!;
    const after = store.updateSubagentPreset(made.presetId, { instructions: "Revised." })!;
    expect(after.instructions).toBe("Revised.");
    expect(after.name).toBe("Explorer");
    expect(after.model).toEqual({ provider: "codex", model: "gpt-5" });
  });

  // The name is the one field an edit can't erase — a nameless preset is not a
  // preset — so a blanking patch is refused and the row is left as it was.
  test("an edit can't blank the name", () => {
    const store = freshStore();
    const made = store.createSubagentPreset({ name: "Explorer" })!;
    expect(store.updateSubagentPreset(made.presetId, { name: "  " })).toBeNull();
    expect(store.getSubagentPreset(made.presetId)!.name).toBe("Explorer");
  });

  test("clearing the model to null drops the preference", () => {
    const store = freshStore();
    const made = store.createSubagentPreset({
      name: "Explorer",
      model: { provider: "codex", model: "gpt-5" },
    })!;
    expect(store.updateSubagentPreset(made.presetId, { model: null })!.model).toBeNull();
  });

  test("editing a gone preset returns null", () => {
    expect(freshStore().updateSubagentPreset("nope", { name: "X" })).toBeNull();
  });

  // A preset holds no thread history, so a delete is a real delete — the row is
  // gone, and deleting it a second time simply changes nothing.
  test("a deleted preset is gone, and deleting it again is not a failure", () => {
    const store = freshStore();
    const made = store.createSubagentPreset({ name: "Explorer" })!;
    expect(store.deleteSubagentPreset(made.presetId)).toBe(true);
    expect(store.getSubagentPreset(made.presetId)).toBeNull();
    expect(store.listSubagentPresets()).toEqual([]);
    expect(store.deleteSubagentPreset(made.presetId)).toBe(false);
  });

  test("a malformed model is dropped, not stored", () => {
    const made = freshStore().createSubagentPreset({
      name: "Explorer",
      model: { provider: "codex", model: "" },
    })!;
    expect(made.model).toBeNull();
  });
});

describe("a project's team", () => {
  const project = "/tmp/kone-project";
  const other = "/tmp/other-project";

  test("starts empty, and holds who you add in the order you added them", () => {
    const store = seeded();
    expect(store.listProjectAgents(project)).toEqual([]);
    expect(store.addAgentToProject(project, "gideon")).toBe(true);
    expect(store.addAgentToProject(project, "kone")).toBe(true);
    expect(store.listProjectAgents(project).map((agent) => agent.agentId)).toEqual([
      "gideon",
      "kone",
    ]);
  });

  test("adding the same agent twice leaves one seat", () => {
    const store = seeded();
    store.addAgentToProject(project, "kone");
    expect(store.addAgentToProject(project, "kone")).toBe(true);
    expect(store.listProjectAgents(project)).toHaveLength(1);
  });

  test("an agent belongs to as many projects as you add them to", () => {
    const store = seeded();
    store.addAgentToProject(project, "kone");
    store.addAgentToProject(other, "kone");
    store.removeAgentFromProject(project, "kone");
    expect(store.listProjectAgents(project)).toEqual([]);
    expect(store.listProjectAgents(other).map((agent) => agent.agentId)).toEqual(["kone"]);
  });

  test("removing somebody who isn't on the team is a no-op", () => {
    const store = seeded();
    expect(() => store.removeAgentFromProject(project, "kone")).not.toThrow();
    expect(store.listProjectAgents(project)).toEqual([]);
  });

  // A team is people you can hand work to, so an id that resolves to nobody is
  // a no rather than a seat waiting for someone to fill it.
  test("nobody, and nobody deleted, can be put on a team", () => {
    const store = seeded();
    expect(store.addAgentToProject(project, "nobody")).toBe(false);
    store.deleteAgent("gideon");
    expect(store.addAgentToProject(project, "gideon")).toBe(false);
    expect(store.listProjectAgents(project)).toEqual([]);
  });

  // The join does the filtering, so no delete has to reach into anybody's
  // teams: the seats survive, ready for the agent to be restored into them.
  test("a deleted agent leaves every team without their seats being erased", () => {
    const store = seeded();
    store.addAgentToProject(project, "kone");
    store.deleteAgent("kone");
    expect(store.listProjectAgents(project)).toEqual([]);

    // SAFETY: the projection names one NOT NULL TEXT column of a table this
    // suite just created, so every row has exactly this shape.
    const rows = rawDb()
      .prepare(`SELECT agent_id FROM project_agents WHERE project_path = ?`)
      .all(project) as Array<{ agent_id: string }>;
    expect(rows.map((row) => row.agent_id)).toEqual(["kone"]);
  });
});

describe("who worked a thread", () => {
  test("a thread handed to an agent reports that agent", () => {
    const store = seeded();
    expect(store.bindThreadAgent("thread-1", "kone")).toEqual({
      threadId: "thread-1",
      agentId: "kone",
    });
    expect(store.getThreadAgent("thread-1")?.agentId).toBe("kone");
  });

  // A transcript records who did the work, so a later send cannot rewrite who
  // wrote the lines already above it.
  test("who a thread was handed to is settled once and never revised", () => {
    const store = seeded();
    store.bindThreadAgent("thread-1", "kone");
    expect(store.bindThreadAgent("thread-1", "gideon")?.agentId).toBe("kone");
    expect(store.getThreadAgent("thread-1")?.agentId).toBe("kone");
  });

  // Running as a guest is a decision like any other, and recording it is what
  // stops a guest conversation being claimed by an agent picked afterwards.
  test("a thread that ran as a guest is recorded as one, not left blank", () => {
    const store = seeded();
    expect(store.bindThreadAgent("thread-1", null)?.agentId).toBeNull();
    expect(store.bindThreadAgent("thread-1", "kone")?.agentId).toBeNull();
  });

  test("a thread nobody has started has no binding at all", () => {
    expect(seeded().getThreadAgent("thread-1")).toBeNull();
  });

  test("every binding comes back in the order they settled", () => {
    const store = seeded();
    store.bindThreadAgent("thread-1", "kone");
    store.bindThreadAgent("thread-2", null);
    store.bindThreadAgent("thread-3", "gideon");
    expect(store.listThreadAgents()).toEqual([
      { threadId: "thread-1", agentId: "kone" },
      { threadId: "thread-2", agentId: null },
      { threadId: "thread-3", agentId: "gideon" },
    ]);
  });

  // The binding settles on the send, which can be ahead of the thread's own
  // row, so it deliberately doesn't depend on one existing.
  test("a thread with no row of its own can still be bound", () => {
    const store = seeded();
    expect(store.bindThreadAgent("never-persisted", "kone")?.agentId).toBe("kone");
  });

  // The point of the tombstone: deleting an agent takes them out of the roster
  // without rewriting the conversations they already had.
  test("a departed agent still answers for the threads they worked", () => {
    const store = seeded();
    store.bindThreadAgent("thread-1", "gideon");
    store.deleteAgent("gideon");
    expect(store.getThreadAgent("thread-1")?.agentId).toBe("gideon");
    expect(store.getAgent("gideon")?.deletedAt).not.toBeNull();
  });

  test("a thread reborn under a new id keeps the same agent", () => {
    const store = seeded();
    store.bindThreadAgent("thread-1", "kone");
    expect(store.carryThreadAgent("thread-1", "thread-2")?.agentId).toBe("kone");
    expect(store.getThreadAgent("thread-2")?.agentId).toBe("kone");
  });

  // The one that would go wrong quietly: a guest thread restarted must come
  // back a guest rather than fall through to whoever is picked by then.
  test("a guest comes back a guest", () => {
    const store = seeded();
    store.bindThreadAgent("thread-1", null);
    expect(store.carryThreadAgent("thread-1", "thread-2")?.agentId).toBeNull();
    expect(store.bindThreadAgent("thread-2", "kone")?.agentId).toBeNull();
  });

  test("there is nothing to carry from a thread that never started", () => {
    const store = seeded();
    expect(store.carryThreadAgent("thread-1", "thread-2")).toBeNull();
    expect(store.getThreadAgent("thread-2")).toBeNull();
  });

  test("a thread that already settled keeps what it settled on", () => {
    const store = seeded();
    store.bindThreadAgent("thread-1", "kone");
    store.bindThreadAgent("thread-2", null);
    expect(store.carryThreadAgent("thread-1", "thread-2")?.agentId).toBeNull();
  });
});

describe("a thread that is deleted", () => {
  test("takes its binding with it", () => {
    const store = seeded();
    store.ensureThread({ threadId: "thread-1", projectPath: "/p", provider: "opencode" });
    store.bindThreadAgent("thread-1", "kone");

    expect(store.deleteThread("thread-1")).toEqual({ ok: true });

    // Not merely unreported: the row is gone, so listThreadAgents can't keep
    // naming a conversation that no longer exists.
    expect(store.getThreadAgent("thread-1")).toBeNull();
    expect(store.listThreadAgents()).toEqual([]);
  });

  test("leaves every other thread's binding alone", () => {
    const store = seeded();
    for (const threadId of ["thread-1", "thread-2"]) {
      store.ensureThread({ threadId, projectPath: "/p", provider: "opencode" });
    }
    store.bindThreadAgent("thread-1", "kone");
    store.bindThreadAgent("thread-2", "gideon");

    store.deleteThread("thread-1");

    expect(store.listThreadAgents()).toEqual([{ threadId: "thread-2", agentId: "gideon" }]);
  });

  test("a guest thread's binding goes too", () => {
    const store = seeded();
    store.ensureThread({ threadId: "thread-1", projectPath: "/p", provider: "opencode" });
    store.bindThreadAgent("thread-1", null);

    store.deleteThread("thread-1");

    expect(store.listThreadAgents()).toEqual([]);
  });

  test("deleting a parent clears the whole subtree's bindings", () => {
    const store = seeded();
    store.ensureThread({ threadId: "parent-1", projectPath: "/p", provider: "opencode" });
    store.writeSpawnedThread({
      threadId: "child-1",
      projectPath: "/p",
      provider: "opencode",
      createdAt: Date.now(),
      title: "Child",
      lineage: {
        parentThreadId: "parent-1",
        relationshipToParent: "subagent",
        rootThreadId: "parent-1",
      },
    });
    store.bindThreadAgent("parent-1", "kone");
    store.bindThreadAgent("child-1", "gideon");

    store.deleteThread("parent-1");

    expect(store.listThreadAgents()).toEqual([]);
  });

  test("the thread can be handed to somebody else if it comes back", () => {
    const store = seeded();
    store.ensureThread({ threadId: "thread-1", projectPath: "/p", provider: "opencode" });
    store.bindThreadAgent("thread-1", "kone");
    store.deleteThread("thread-1");

    // Write-once is a property of a *thread*, and that thread is gone. A new one
    // reusing the id is a new conversation, free to settle on anybody.
    store.ensureThread({ threadId: "thread-1", projectPath: "/p", provider: "opencode" });
    expect(store.bindThreadAgent("thread-1", "gideon")).toEqual({
      threadId: "thread-1",
      agentId: "gideon",
    });
  });
});

describe("who is up next", () => {
  test("nobody is picked until somebody picks", () => {
    expect(seeded().readSelectedAgent()).toBeNull();
  });

  test("the pick survives being read back", () => {
    const store = seeded();
    store.writeSelectedAgent("kone");
    expect(store.readSelectedAgent()).toBe("kone");
    store.writeSelectedAgent("gideon");
    expect(store.readSelectedAgent()).toBe("gideon");
  });

  test("picking a guest is a pick, and reads back as nobody", () => {
    const store = seeded();
    store.writeSelectedAgent("kone");
    store.writeSelectedAgent(null);
    expect(store.readSelectedAgent()).toBeNull();
  });

  // Nothing may be left pointing at a departed agent: the next turn would go to
  // nobody at all.
  test("an agent who leaves takes the selection with them", () => {
    const store = seeded();
    store.writeSelectedAgent("gideon");
    store.deleteAgent("gideon");
    expect(store.readSelectedAgent()).toBeNull();
  });

  test("somebody else leaving doesn't disturb the selection", () => {
    const store = seeded();
    store.writeSelectedAgent("kone");
    store.deleteAgent("gideon");
    expect(store.readSelectedAgent()).toBe("kone");
  });

  test("only one row can ever hold the answer", () => {
    const store = seeded();
    store.writeSelectedAgent("kone");
    store.writeSelectedAgent("gideon");
    // SAFETY: a COUNT(*) aggregate, which SQLite answers as one integer row
    // under the name asked for.
    const count = rawDb().prepare(`SELECT COUNT(*) AS n FROM roster_selection`).get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });
});

describe("the schema", () => {
  test("a fresh database reports v27 and carries the roster's tables", () => {
    seeded();
    const db = rawDb();
    // SAFETY: `PRAGMA user_version` always answers one row with one integer
    // under that name.
    const version = db.prepare(`PRAGMA user_version`).get() as { user_version: number };
    expect(version.user_version).toBe(27);
    // SAFETY: the projection names one column of a SQLite catalogue table, and
    // `sqlite_master.name` is TEXT.
    const named = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const tables = named.map((row) => row.name);
    expect(tables).toContain("agents");
    expect(tables).toContain("project_agents");
    expect(tables).toContain("thread_agents");
    expect(tables).toContain("roster_selection");
    expect(tables).toContain("subagent_presets");
  });

  test("a database from before the roster existed upgrades with its threads intact", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-roster-store-"));
    useUserDataDir(dir);
    const before = new ConversationStoreCtor();
    before.ensureThread({
      threadId: "thread-1",
      projectPath: "/tmp/kone-project",
      provider: "claudeAgent",
      at: Date.now(),
    });
    before.setTitle("thread-1", "Before the roster");
    before.close();

    // Rewind to v21 and drop what the two rungs create, so the ladder has to
    // run them both.
    const raw = rawDb();
    raw.exec(`DROP TABLE IF EXISTS agents`);
    raw.exec(`DROP TABLE IF EXISTS project_agents`);
    raw.exec(`DROP TABLE IF EXISTS thread_agents`);
    raw.exec(`DROP TABLE IF EXISTS roster_selection`);
    raw.exec(`PRAGMA user_version = 21`);
    raw.close();

    const after = new ConversationStoreCtor();
    after.ensurePresetAgents(PRESETS);
    expect(after.listAgents().map((agent) => agent.agentId)).toEqual(PRESETS);
    expect(after.bindThreadAgent("thread-1", "kone")?.agentId).toBe("kone");
    expect(after.getTitle("thread-1")).toBe("Before the roster");
  });
});
