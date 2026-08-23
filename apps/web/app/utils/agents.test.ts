import { beforeEach, describe, expect, test } from "bun:test";
import { ref } from "vue";

import { rememberSideChatSource } from "~/composables/useSideChats";
import {
  addAgentToProject,
  agentById,
  agentForThread,
  agentPersonaForThread,
  agentRoster,
  carryThreadAgent,
  createAgent,
  deleteAgent,
  duplicateAgent,
  hydrateRoster,
  isOnProjectTeam,
  KONE,
  projectTeam,
  removeAgentFromProject,
  renameAgent,
  selectAgent,
  selectedAgent,
  settleThreadAgent,
  updateAgent,
} from "./agents";
import {
  agentRows,
  applyRosterSnapshot,
  GUEST_BINDING,
  projectTeams,
  selectedAgentId,
  sendable,
  threadBindings,
} from "./agentStore";

// The roster's state lives in module-scope refs, so it outlives a single test.
// The rows are the store here — there is no bridge outside the app — so putting
// them back is the reset, and it is the one place anything outside
// `agentStore` writes them.
//
// Thread bindings are write-once by design and have no reset, so every test
// mints its own ids — which is also closer to the real thing, where a thread id
// is never reused.
let minted = 0;
function threadId(): string {
  minted += 1;
  return `thread-${minted}`;
}

/** The stored row behind an agent — the only place the null-vs-`[]` capability
 *  distinction is visible, since a resolved agent always reads concrete lists. */
function rowFor(id: string) {
  return agentRows.value.find((row) => row.agentId === id)!;
}

beforeEach(() => {
  agentRows.value = [];
  threadBindings.value = {};
  projectTeams.value = {};
  selectAgent(null);
});

describe("the roster", () => {
  test("ships with kone and nobody else", () => {
    expect(agentRoster().map((agent) => agent.id)).toEqual([KONE.id]);
    expect(agentById(KONE.id)?.name).toBe(KONE.name);
  });

  test("nobody is picked for you — a fresh app sends work to a guest", () => {
    expect(selectedAgent()).toBeUndefined();
  });

  test("an id that isn't in the roster resolves to nobody rather than a stub", () => {
    expect(agentById("nobody")).toBeUndefined();
    expect(agentById(null)).toBeUndefined();
    expect(agentById(undefined)).toBeUndefined();
  });

  // The pre-hydrate path and the stored one have to agree, or the roster would
  // reshuffle itself a moment after every launch.
  test("hydrating gives every built-in a row and changes nothing on screen", async () => {
    const before = agentRoster();
    await hydrateRoster();
    expect(agentRows.value.map((row) => row.agentId)).toEqual([KONE.id]);
    expect(agentRoster()).toEqual(before);
  });

  // The failure this guards: rows-only resolution would show only the agents
  // that happen to have rows, so making one agent would hide every built-in
  // nobody has touched yet.
  test("a made agent doesn't hide a built-in with no row of its own", async () => {
    const made = await createAgent({ name: "Ada" });
    expect(agentRoster().map((agent) => agent.id)).toEqual([KONE.id, made!.id]);
  });

  // A row is a delta, not a copy: only the field that was edited is the row's,
  // and the rest still comes from the build.
  test("an edited field is the row's and the rest is still the preset's", async () => {
    await updateAgent(KONE.id, { role: "Pair" });
    const agent = agentById(KONE.id);
    expect(agent?.role).toBe("Pair");
    expect(agent?.name).toBe(KONE.name);
    expect(agent?.instructions).toBe(KONE.instructions);
  });

  // Emptying a field is a decision, and a different one from never touching it.
  test("a field cleared to empty stays empty rather than reverting", async () => {
    await updateAgent(KONE.id, { instructions: "" });
    expect(agentById(KONE.id)?.instructions).toBeUndefined();
    await updateAgent(KONE.id, { instructions: null });
    expect(agentById(KONE.id)?.instructions).toBe(KONE.instructions);
  });
});

describe("who worked a thread", () => {
  test("a thread handed to an agent reports that agent", () => {
    const id = threadId();
    settleThreadAgent(id, KONE.id);
    expect(agentForThread(id)?.id).toBe(KONE.id);
  });

  test("who a thread was handed to is settled once and never revised", () => {
    const id = threadId();
    settleThreadAgent(id, KONE.id);
    settleThreadAgent(id, null);
    expect(agentForThread(id)?.id).toBe(KONE.id);
  });

  // Running as a guest is a decision like any other, and recording it is what
  // stops a guest conversation being claimed by an agent picked afterwards.
  test("a thread that started as a guest stays a guest", () => {
    const id = threadId();
    settleThreadAgent(id, null);
    settleThreadAgent(id, KONE.id);
    expect(agentForThread(id)).toBeUndefined();
  });

  test("an unstarted thread has nobody, and picking an agent doesn't give it one", () => {
    const id = threadId();
    expect(agentForThread(id)).toBeUndefined();
    selectAgent(KONE.id);
    expect(agentForThread(id)).toBeUndefined();
  });

  test("changing who you work with leaves settled threads alone", () => {
    const guestThread = threadId();
    settleThreadAgent(guestThread, null);
    selectAgent(KONE.id);
    expect(selectedAgent()?.id).toBe(KONE.id);
    expect(agentForThread(guestThread)).toBeUndefined();
  });

  test("an agent nobody ships is refused rather than recorded", () => {
    const id = threadId();
    settleThreadAgent(id, "nobody");
    expect(agentForThread(id)).toBeUndefined();
    // Refused, not settled: the thread is still open to a real agent.
    settleThreadAgent(id, KONE.id);
    expect(agentForThread(id)?.id).toBe(KONE.id);

    selectAgent("nobody");
    expect(selectedAgent()).toBeUndefined();
  });

  // The distinction the whole record rests on: a guest thread is written down
  // as a guest, and an unstarted one is written down as nothing.
  test("a guest thread is recorded, not left blank", () => {
    const guestThread = threadId();
    const unstarted = threadId();
    settleThreadAgent(guestThread, null);
    expect(threadBindings.value[guestThread]).toBe("");
    expect(threadBindings.value[unstarted]).toBeUndefined();
  });

  test("a thread with no id is nobody's, and settling one is a no-op", () => {
    expect(agentForThread(null)).toBeUndefined();
    expect(agentForThread(undefined)).toBeUndefined();
    expect(() => settleThreadAgent(null, KONE.id)).not.toThrow();
    expect(() => settleThreadAgent(undefined, KONE.id)).not.toThrow();
  });
});

describe("what the provider session is told", () => {
  test("kone's thread carries its name and instructions", () => {
    const id = threadId();
    settleThreadAgent(id, KONE.id);
    const persona = agentPersonaForThread(id);
    expect(persona).toEqual({
      name: KONE.name,
      instructions: KONE.instructions,
    });
    // These two and no more: the face, role and roster order are drawer-only,
    // so a third key here would mean a layer leaked across the boundary.
    expect(Object.keys(persona!).sort()).toEqual(["instructions", "name"]);
  });

  test("an agent with no instructions carries just its name", async () => {
    const made = await createAgent({ name: "Ada" });
    const id = threadId();
    settleThreadAgent(id, made!.id);
    const persona = agentPersonaForThread(id);
    expect(persona).toEqual({ name: "Ada" });
    // Instructions are absent, not empty — the send path never sees the key.
    expect(Object.keys(persona!).sort()).toEqual(["name"]);
  });

  test("a guest's thread carries nothing — the session runs as it always did", () => {
    const id = threadId();
    settleThreadAgent(id, null);
    expect(agentPersonaForThread(id)).toBeUndefined();
    expect(agentPersonaForThread(threadId())).toBeUndefined();
    expect(agentPersonaForThread(null)).toBeUndefined();
    expect(agentPersonaForThread(undefined)).toBeUndefined();
  });

  // Read from the roster on the way out, not snapshotted when the thread
  // settled: what the user sees in the drawer is what the agent gets told.
  test("a rename reaches a thread that already settled on that agent", async () => {
    const id = threadId();
    settleThreadAgent(id, KONE.id);
    await renameAgent(KONE.id, "Maya");
    expect(agentPersonaForThread(id)?.name).toBe("Maya");
  });

  test("picking somebody else points the next thread at them, not this one", () => {
    const id = threadId();
    settleThreadAgent(id, null);
    selectAgent(KONE.id);
    expect(agentPersonaForThread(id)).toBeUndefined();
  });
});

describe("a thread reborn under a new id", () => {
  test("the same work continuing keeps the same agent", () => {
    const from = threadId();
    const to = threadId();
    settleThreadAgent(from, KONE.id);
    carryThreadAgent(from, to);
    expect(agentForThread(to)?.id).toBe(KONE.id);
  });

  // The one that would go wrong quietly: a guest thread restarted must come
  // back a guest, not inherit whoever the composer happens to point at by then.
  test("a guest comes back a guest", () => {
    const from = threadId();
    const to = threadId();
    settleThreadAgent(from, null);
    selectAgent(KONE.id);
    carryThreadAgent(from, to);
    expect(agentForThread(to)).toBeUndefined();
    // And it is settled, not merely unclaimed.
    settleThreadAgent(to, KONE.id);
    expect(agentForThread(to)).toBeUndefined();
  });

  test("nothing to carry from a thread that never started", () => {
    const from = threadId();
    const to = threadId();
    carryThreadAgent(from, to);
    settleThreadAgent(to, KONE.id);
    expect(agentForThread(to)?.id).toBe(KONE.id);
  });

  test("a thread that already settled keeps what it settled on", () => {
    const from = threadId();
    const to = threadId();
    settleThreadAgent(from, KONE.id);
    settleThreadAgent(to, null);
    carryThreadAgent(from, to);
    expect(agentForThread(to)).toBeUndefined();
  });

  test("a missing id at either end is a no-op", () => {
    const from = threadId();
    settleThreadAgent(from, KONE.id);
    expect(() => carryThreadAgent(from, null)).not.toThrow();
    expect(() => carryThreadAgent(null, threadId())).not.toThrow();
    expect(() => carryThreadAgent(undefined, undefined)).not.toThrow();
  });
});

describe("a side chat forked from a thread", () => {
  test("inherits the named agent from the source thread", () => {
    const main = threadId();
    const side = threadId();
    settleThreadAgent(main, KONE.id);
    rememberSideChatSource(side, main);
    expect(agentForThread(side)?.id).toBe(KONE.id);
    expect(agentPersonaForThread(side)?.name).toBe(KONE.name);
  });

  test("carrying the thread agent explicitly also resolves the named agent", () => {
    const main = threadId();
    const side = threadId();
    settleThreadAgent(main, KONE.id);
    rememberSideChatSource(side, main);
    carryThreadAgent(main, side);
    expect(agentForThread(side)?.id).toBe(KONE.id);
    expect(agentPersonaForThread(side)?.name).toBe(KONE.name);
  });

  test("inherits a guest binding when the source was a guest", () => {
    const main = threadId();
    const side = threadId();
    settleThreadAgent(main, null);
    rememberSideChatSource(side, main);
    carryThreadAgent(main, side);
    expect(agentForThread(side)).toBeUndefined();
    expect(agentPersonaForThread(side)).toBeUndefined();
  });
});

describe("renaming an agent", () => {
  test("the new name is what the roster reports", async () => {
    await renameAgent(KONE.id, "Maya");
    expect(agentById(KONE.id)?.name).toBe("Maya");
  });

  test("clearing the name gives back the one they shipped with", async () => {
    await renameAgent(KONE.id, "Maya");
    await renameAgent(KONE.id, "");
    expect(agentById(KONE.id)?.name).toBe(KONE.name);

    await renameAgent(KONE.id, "   ");
    expect(agentById(KONE.id)?.name).toBe(KONE.name);

    await renameAgent(KONE.id, KONE.name);
    expect(agentById(KONE.id)?.name).toBe(KONE.name);
  });

  test("surrounding space is not part of a name", async () => {
    await renameAgent(KONE.id, "  Maya  ");
    expect(agentById(KONE.id)?.name).toBe("Maya");
  });

  // The ceiling is the store's, so a name that fits in a row is the same name
  // everywhere it is read.
  test("a name has a length a row can hold", async () => {
    await renameAgent(KONE.id, "M".repeat(200));
    expect(agentById(KONE.id)?.name.length).toBe(64);
  });

  test("renaming somebody who isn't in the roster changes nothing", async () => {
    await renameAgent("nobody", "Maya");
    expect(agentById(KONE.id)?.name).toBe(KONE.name);
    expect(agentById("nobody")).toBeUndefined();
  });

  // A user-made agent has no preset behind it, so an empty name is not a
  // rename — it would leave them with nothing to be called.
  test("a user-made agent cannot be left nameless", async () => {
    const made = await createAgent({ name: "Ada" });
    await renameAgent(made!.id, "");
    expect(agentById(made!.id)?.name).toBe("Ada");
  });
});

describe("an agent you made yourself", () => {
  test("arrives at the end of the roster with what you gave it", async () => {
    await hydrateRoster();
    const made = await createAgent({
      name: "Ada",
      role: "Reviewer",
      instructions: "Exacting.",
    });
    expect(made?.name).toBe("Ada");
    expect(made?.role).toBe("Reviewer");
    expect(made?.instructions).toBe("Exacting.");
    expect(agentRoster().map((agent) => agent.id)).toEqual([KONE.id, made!.id]);
  });

  test("a name is the one thing it can't do without", async () => {
    expect(await createAgent({ name: "   " })).toBeUndefined();
    expect(agentRoster().some((agent) => agent.name === "")).toBe(false);
  });

  test("it can be handed a thread like anybody else", async () => {
    const made = await createAgent({ name: "Ada", instructions: "Be brief." });
    const id = threadId();
    settleThreadAgent(id, made!.id);
    expect(agentPersonaForThread(id)).toEqual({ name: "Ada", instructions: "Be brief." });
  });
});

describe("an agent who leaves the roster", () => {
  test("is gone from everywhere you could pick them", async () => {
    await hydrateRoster();
    expect(await deleteAgent(KONE.id)).toBe(true);
    expect(agentRoster()).toEqual([]);
    expect(agentById(KONE.id)).toBeUndefined();

    selectAgent(KONE.id);
    expect(selectedAgent()).toBeUndefined();
    // And a thread starting now can't be settled on them either.
    const id = threadId();
    settleThreadAgent(id, KONE.id);
    expect(agentForThread(id)).toBeUndefined();
  });

  // The point of keeping the row: a transcript records who did the work, so
  // deleting an agent cannot rewrite the conversations they already had.
  test("still names the threads they worked", async () => {
    await hydrateRoster();
    const id = threadId();
    settleThreadAgent(id, KONE.id);
    await deleteAgent(KONE.id);
    expect(agentForThread(id)?.name).toBe(KONE.name);
    expect(agentPersonaForThread(id)?.name).toBe(KONE.name);
  });

  test("the selection doesn't point at them afterwards", async () => {
    await hydrateRoster();
    selectAgent(KONE.id);
    await deleteAgent(KONE.id);
    expect(selectedAgent()).toBeUndefined();
    // Cleared where it is kept, not merely unresolvable on the way out.
    expect(selectedAgentId.value).toBeNull();
  });

  test("a built-in stays dismissed rather than coming back on hydrate", async () => {
    await hydrateRoster();
    await deleteAgent(KONE.id);
    await hydrateRoster();
    expect(agentRoster()).toEqual([]);
  });

  test("leaving twice, or leaving when you were never here, is a no", async () => {
    await hydrateRoster();
    expect(await deleteAgent(KONE.id)).toBe(true);
    expect(await deleteAgent(KONE.id)).toBe(false);
    expect(await deleteAgent("nobody")).toBe(false);
  });

  test("a departed agent cannot be edited back into the roster", async () => {
    await hydrateRoster();
    await deleteAgent(KONE.id);
    expect(await renameAgent(KONE.id, "Maya")).toBeUndefined();
    expect(agentById(KONE.id)).toBeUndefined();
  });
});

describe("forking an agent", () => {
  test("the copy reads like the original and sits straight below it", async () => {
    await hydrateRoster();
    const copy = await duplicateAgent(KONE.id, "kone copy");
    expect(copy?.name).toBe("kone copy");
    // A fork keeps no inheritance, so the preset's words are copied onto it.
    expect(copy?.instructions).toBe(KONE.instructions);
    expect(copy?.role).toBe(KONE.role);
    expect(agentRoster().map((agent) => agent.id)).toEqual([KONE.id, copy!.id]);
  });

  test("an edit to the original doesn't reach the copy", async () => {
    await hydrateRoster();
    const copy = await duplicateAgent(KONE.id, "kone copy");
    await updateAgent(KONE.id, { instructions: "Something else." });
    expect(agentById(copy!.id)?.instructions).toBe(KONE.instructions);
  });

  test("with no name given, the copy carries the original's", async () => {
    await hydrateRoster();
    const copy = await duplicateAgent(KONE.id);
    expect(copy?.name).toBe(KONE.name);
    expect(copy?.id).not.toBe(KONE.id);
  });

  test("there is nothing to fork in somebody who isn't here", async () => {
    await hydrateRoster();
    expect(await duplicateAgent("nobody")).toBeUndefined();
    await deleteAgent(KONE.id);
    expect(await duplicateAgent(KONE.id)).toBeUndefined();
  });
});

describe("an agent's capabilities", () => {
  // Resolved capabilities are always concrete, never gaps: the presets ship
  // none, so an unedited built-in reads with no skills and no model pinned.
  test("an unedited built-in resolves to empties, not gaps", () => {
    const kone = agentById(KONE.id)!;
    expect(kone.capabilities.skills).toEqual([]);
    expect(kone.capabilities.model).toBeNull();
  });

  test("a new agent keeps the capabilities it was made with", async () => {
    const made = await createAgent({
      name: "Ada",
      model: { provider: "codex", model: "gpt-5", label: "GPT-5" },
      skills: [{ path: "/s/a.md", name: "A", origin: "project" }],
    });
    expect(made?.capabilities.model).toEqual({ provider: "codex", model: "gpt-5", label: "GPT-5" });
    expect(made?.capabilities.skills).toEqual([{ path: "/s/a.md", name: "A", origin: "project" }]);
  });

  test("a new agent silent about its capabilities runs anywhere", async () => {
    const made = await createAgent({ name: "Ada" });
    expect(made?.capabilities.model).toBeNull();
    expect(made?.capabilities.skills).toEqual([]);
  });

  // A pinned model is a stored answer on the row; null is the absence that hands
  // the field back to the preset. Only the row shows the difference — both read
  // as `null` on a built-in whose preset names no model.
  test("a pinned model is a stored answer; null hands the field back", async () => {
    await updateAgent(KONE.id, { model: { provider: "codex", model: "gpt-5" } });
    expect(rowFor(KONE.id).model).toEqual({ provider: "codex", model: "gpt-5" });

    await updateAgent(KONE.id, { model: null });
    expect(rowFor(KONE.id).model).toBeNull();
  });

  test("a capability left out of an edit is left alone", async () => {
    await updateAgent(KONE.id, {
      model: { provider: "codex", model: "gpt-5" },
      skills: [{ path: "/s/a.md", name: "A", origin: "project" }],
    });
    await updateAgent(KONE.id, { skills: [{ path: "/s/b.md", name: "B", origin: "project" }] });
    const kone = agentById(KONE.id)!;
    expect(kone.capabilities.skills).toEqual([{ path: "/s/b.md", name: "B", origin: "project" }]);
    expect(kone.capabilities.model).toEqual({ provider: "codex", model: "gpt-5" });
  });

  // A fork keeps no inheritance, so a built-in's capabilities are copied onto
  // the row rather than left to resolve against a preset it no longer overlays.
  test("a fork carries the capabilities the source reads as", async () => {
    await hydrateRoster();
    await updateAgent(KONE.id, { model: { provider: "codex", model: "gpt-5" } });
    const copy = await duplicateAgent(KONE.id, "kone copy");
    expect(copy?.capabilities.model).toEqual({ provider: "codex", model: "gpt-5" });
  });
});

describe("an agent's policies", () => {
  // Resolved policies are always concrete lists: the presets ship none, so an
  // unedited built-in resolves to empty lists — it forbids nothing.
  test("an unedited built-in resolves to empty lists, not gaps", () => {
    const kone = agentById(KONE.id)!;
    expect(kone.policies.deniedCommands).toEqual([]);
    expect(kone.policies.deniedPaths).toEqual([]);
  });

  test("a new agent keeps the policies it was made with", async () => {
    const made = await createAgent({
      name: "Ada",
      policies: { deniedCommands: ["rm -rf"], deniedPaths: [".env"] },
    });
    expect(made?.policies.deniedCommands).toEqual(["rm -rf"]);
    expect(made?.policies.deniedPaths).toEqual([".env"]);
  });

  test("a new agent silent about its policies forbids nothing", async () => {
    const made = await createAgent({ name: "Ada" });
    expect(made?.policies.deniedCommands).toEqual([]);
    expect(made?.policies.deniedPaths).toEqual([]);
  });

  // An empty-lists object is a stored answer; null hands the field back to the
  // preset. Both resolve to `[]` on a built-in that ships no policies, so only
  // the row shows the difference.
  test("an empty-lists object is a stored answer; null hands the field back", async () => {
    await updateAgent(KONE.id, { policies: { deniedCommands: ["rm"], deniedPaths: [] } });
    expect(rowFor(KONE.id).policies).toEqual({ deniedCommands: ["rm"], deniedPaths: [] });

    await updateAgent(KONE.id, { policies: { deniedCommands: [], deniedPaths: [] } });
    expect(rowFor(KONE.id).policies).toEqual({ deniedCommands: [], deniedPaths: [] });

    await updateAgent(KONE.id, { policies: null });
    expect(rowFor(KONE.id).policies).toBeNull();
  });

  test("a fork carries the policies the source reads as", async () => {
    await hydrateRoster();
    await updateAgent(KONE.id, {
      policies: { deniedCommands: ["git push"], deniedPaths: ["secrets"] },
    });
    const copy = await duplicateAgent(KONE.id, "kone copy");
    expect(copy?.policies.deniedCommands).toEqual(["git push"]);
    expect(copy?.policies.deniedPaths).toEqual(["secrets"]);
  });

  test("a blank policy entry is dropped", async () => {
    const made = await createAgent({
      name: "Ada",
      policies: { deniedCommands: ["", "rm -rf"], deniedPaths: ["   "] },
    });
    expect(made?.policies.deniedCommands).toEqual(["rm -rf"]);
    expect(made?.policies.deniedPaths).toEqual([]);
  });
});

describe("how an agent looks", () => {
  const PICTURE = { source: "generated", src: "data:image/jpeg;base64,AAAA" } as const;
  const BOT = { form: "pebble", color: "teal", expression: "curious" } as const;

  test("kone ships with a picture of itself and a bot", () => {
    const kone = agentById(KONE.id)!;
    expect(kone.avatar).toEqual(KONE.avatar!);
    expect(kone.bot).toEqual(KONE.bot!);
  });

  // Neither field falls back to a default: an agent with no picture is
  // identified by its drawn face, and one with no bot has none.
  test("a new agent has neither unless it was given one", async () => {
    const made = await createAgent({ name: "Ada" });
    expect(made?.avatar).toBeNull();
    expect(made?.bot).toBeNull();
  });

  test("a new agent keeps the appearance it was made with", async () => {
    const made = await createAgent({ name: "Ada", avatar: PICTURE, bot: BOT });
    expect(made?.avatar).toEqual(PICTURE);
    expect(made?.bot).toEqual(BOT);
  });

  test("an edit sets it, and null hands the field back to the preset", async () => {
    await updateAgent(KONE.id, { avatar: PICTURE, bot: BOT });
    expect(agentById(KONE.id)?.avatar).toEqual(PICTURE);
    expect(agentById(KONE.id)?.bot).toEqual(BOT);

    await updateAgent(KONE.id, { avatar: null, bot: null });
    expect(agentById(KONE.id)?.avatar).toEqual(KONE.avatar!);
    expect(agentById(KONE.id)?.bot).toEqual(KONE.bot!);
  });

  // A bot stored by a build that offered a shape this one dropped still draws:
  // the catalogue answers an id it doesn't know with its default.
  test("a bot naming something this build no longer ships still resolves", async () => {
    const made = await createAgent({
      name: "Ada",
      // Deliberately not real ids — this is a bot from another build.
      bot: { form: "trefoil", color: "chartreuse", expression: "smug" } as never,
    });
    expect(made?.bot).toEqual({ form: "circle", color: "ink", expression: "neutral" });
  });

  // Where a picture came from is carried as it was stored, so reopening the
  // picker lands the maker on the source they used. All four are equally real
  // rows; nothing downstream reads the source to draw one.
  test("every source a picture can come from round-trips", async () => {
    for (const source of ["generated", "upload", "dicebear", "shipped"] as const) {
      const made = await createAgent({
        name: `Ada ${source}`,
        avatar: { source, src: "data:image/jpeg;base64,AAAA" },
      });
      expect(made?.avatar?.source).toBe(source);
    }
  });

  // A row written by a build that named a source this one dropped still draws:
  // the picture is the bytes, and the source is only a hint for the picker.
  test("a picture naming an unknown source reads as generated", async () => {
    const made = await createAgent({
      name: "Ada",
      avatar: { source: "daguerreotype", src: "data:image/jpeg;base64,AAAA" } as never,
    });
    expect(made?.avatar).toEqual({ source: "generated", src: "data:image/jpeg;base64,AAAA" });
  });

  // An empty picture is no picture, not a picture that paints nothing.
  test("a picture with no bytes is dropped", async () => {
    const made = await createAgent({ name: "Ada", avatar: { source: "upload", src: "  " } });
    expect(made?.avatar).toBeNull();
  });

  test("a fork carries the appearance the source reads as", async () => {
    await hydrateRoster();
    await updateAgent(KONE.id, { bot: BOT });
    const copy = await duplicateAgent(KONE.id, "kone copy");
    // The row's own bot, and the preset's picture the row never overrode.
    expect(copy?.bot).toEqual(BOT);
    expect(copy?.avatar).toEqual(KONE.avatar!);
  });
});

// What the store hands back at window open. Only reachable through the desktop
// bridge in the app, so these drive the reconciliation directly — it is where
// the two halves of the roster agree, and getting it wrong is how a mirror grows
// forever or a conversation loses its name.
describe("the store's answer arriving", () => {
  function row(agentId: string, presetId: string | null, name: string | null) {
    const now = Date.now();
    return {
      agentId,
      presetId,
      name,
      role: null,
      instructions: null,
      faceBody: null,
      faceInk: null,
      skills: null,
      model: null,
      policies: null,
      avatar: null,
      bot: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
  }

  test("the bindings it names are what the roster holds", () => {
    applyRosterSnapshot({
      agents: [row(KONE.id, KONE.id, null)],
      bindings: [
        { threadId: "thread-a", agentId: KONE.id },
        { threadId: "thread-b", agentId: null },
      ],
      selectedAgentId: KONE.id,
    });

    expect(threadBindings.value["thread-a"]).toBe(KONE.id);
    // A NULL on the way in is a guest on the way out, in the renderer's spelling.
    expect(threadBindings.value["thread-b"]).toBe(GUEST_BINDING);
    expect(selectedAgentId.value).toBe(KONE.id);
  });

  test("a binding for a thread that no longer exists is dropped", () => {
    threadBindings.value = { "thread-gone": KONE.id, "thread-kept": KONE.id };

    applyRosterSnapshot({
      agents: [row(KONE.id, KONE.id, null)],
      bindings: [{ threadId: "thread-kept", agentId: KONE.id }],
      selectedAgentId: null,
    });

    // Deleting a thread takes its binding with it, so the mirror shrinks with
    // the history rather than keeping every thread id ever opened.
    expect(threadBindings.value["thread-gone"]).toBeUndefined();
    expect(threadBindings.value["thread-kept"]).toBe(KONE.id);
  });

  test("a store that couldn't open is not mistaken for an empty roster", async () => {
    await hydrateRoster();
    const made = await createAgent({ name: "Ama" });
    threadBindings.value = { "thread-a": KONE.id };

    // No agents at all, not even the presets it was asked to ensure — nothing
    // answered, so the cache is all there is and it has to survive.
    applyRosterSnapshot({ agents: [], bindings: [], selectedAgentId: null });

    expect(agentById(made?.id)?.name).toBe("Ama");
    expect(threadBindings.value["thread-a"]).toBe(KONE.id);
  });
});

describe("project teams", () => {
  const PROJECT = "/tmp/demo";

  test("a fresh project's team is empty — nobody is on it until added", () => {
    expect(projectTeam(PROJECT)).toEqual([]);
    expect(isOnProjectTeam(PROJECT, KONE.id)).toBe(false);
  });

  test("an agent added is on the team, and members hold their add order", async () => {
    const made = await createAgent({ name: "Ada" });
    expect(await addAgentToProject(PROJECT, made!.id)).toBe(true);
    await addAgentToProject(PROJECT, KONE.id);
    expect(projectTeam(PROJECT).map((agent) => agent.id)).toEqual([made!.id, KONE.id]);
    expect(isOnProjectTeam(PROJECT, KONE.id)).toBe(true);
  });

  test("adding the same agent twice keeps one membership", async () => {
    await addAgentToProject(PROJECT, KONE.id);
    await addAgentToProject(PROJECT, KONE.id);
    expect(projectTeam(PROJECT).map((agent) => agent.id)).toEqual([KONE.id]);
  });

  test("membership is per project — an agent can be on many, off others", async () => {
    const other = "/tmp/other";
    const made = await createAgent({ name: "Ada" });
    await addAgentToProject(PROJECT, KONE.id);
    await addAgentToProject(PROJECT, made!.id);
    await addAgentToProject(other, KONE.id);
    await removeAgentFromProject(PROJECT, KONE.id);
    expect(projectTeam(PROJECT).map((agent) => agent.id)).toEqual([made!.id]);
    expect(isOnProjectTeam(other, KONE.id)).toBe(true);
  });

  test("an agent who leaves the roster drops out of a team and can't be re-added", async () => {
    const made = await createAgent({ name: "Temp" });
    expect(made).toBeDefined();
    const id = made!.id;
    expect(await addAgentToProject(PROJECT, id)).toBe(true);
    expect(projectTeam(PROJECT).map((agent) => agent.id)).toEqual([id]);

    await deleteAgent(id);
    // The membership row survives a delete, but a departed agent is never handed
    // work, so the resolved team drops them.
    expect(projectTeam(PROJECT)).toEqual([]);
    expect(await addAgentToProject("/tmp/elsewhere", id)).toBe(false);
  });

  test("a nonexistent agent can't be staffed onto a team", async () => {
    expect(await addAgentToProject(PROJECT, "ghost")).toBe(false);
    expect(projectTeam(PROJECT)).toEqual([]);
  });
});

// What a pane collects lives in refs, and a ref holding an object hands out a
// reactive proxy — which the bridge's serializer refuses outright, with nothing
// but "an object could not be cloned" to show for a create. So every payload
// leaving the renderer goes through this first.
describe("what crosses the bridge", () => {
  test("a reactive draft is refused by the serializer as it stands", () => {
    const draft = ref({ avatar: { source: "generated", src: "data:image/jpeg;base64,AAAA" } });
    expect(() => structuredClone(draft.value)).toThrow();
  });

  test("and goes through unchanged once it has been made sendable", () => {
    const draft = ref({
      name: "Ada",
      avatar: { source: "generated", src: "data:image/jpeg;base64,AAAA" },
      bot: { form: "droplet", color: "ink", expression: "curious" },
      // Nested and reactive, which is why an unwrapped top level is not enough.
      policies: { deniedCommands: ["rm -rf"], deniedPaths: [] },
      model: null,
    });
    const payload = sendable(draft.value);
    expect(() => structuredClone(payload)).not.toThrow();
    expect(payload).toEqual({
      name: "Ada",
      avatar: { source: "generated", src: "data:image/jpeg;base64,AAAA" },
      bot: { form: "droplet", color: "ink", expression: "curious" },
      policies: { deniedCommands: ["rm -rf"], deniedPaths: [] },
      model: null,
    });
  });
});
