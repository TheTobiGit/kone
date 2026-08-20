import { beforeEach, describe, expect, test } from "bun:test";

import {
  agentById,
  agentForThread,
  agentPersonaForThread,
  agentRoster,
  carryThreadAgent,
  GIDEON,
  KONE,
  renameAgent,
  selectAgent,
  selectedAgent,
  settleThreadAgent,
} from "./agents";

// The roster's state lives in module-scope refs, so it outlives a single test.
// Selection and renames are put back by hand below; thread bindings are
// write-once by design and have no reset, so every test mints its own ids —
// which is also closer to the real thing, where a thread id is never reused.
let minted = 0;
function threadId(): string {
  minted += 1;
  return `thread-${minted}`;
}

beforeEach(() => {
  selectAgent(null);
  renameAgent(KONE.id, "");
});

describe("the roster", () => {
  test("ships with kone at the head and gideon beside it", () => {
    expect(agentRoster().map((agent) => agent.id)).toEqual([KONE.id, GIDEON.id]);
    expect(agentById(KONE.id)?.name).toBe(KONE.name);
    expect(agentById(GIDEON.id)?.name).toBe(GIDEON.name);
  });

  test("nobody is picked for you — a fresh app sends work to a guest", () => {
    expect(selectedAgent()).toBeUndefined();
  });

  test("an id that isn't in the roster resolves to nobody rather than a stub", () => {
    expect(agentById("nobody")).toBeUndefined();
    expect(agentById(null)).toBeUndefined();
    expect(agentById(undefined)).toBeUndefined();
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

  test("a thread with no id is nobody's, and settling one is a no-op", () => {
    expect(agentForThread(null)).toBeUndefined();
    expect(agentForThread(undefined)).toBeUndefined();
    expect(() => settleThreadAgent(null, KONE.id)).not.toThrow();
    expect(() => settleThreadAgent(undefined, KONE.id)).not.toThrow();
  });
});

describe("what the provider session is told", () => {
  test("kone's thread carries its name, personality and instructions", () => {
    const id = threadId();
    settleThreadAgent(id, KONE.id);
    const persona = agentPersonaForThread(id);
    expect(persona).toEqual({
      name: KONE.name,
      personality: KONE.personality,
      instructions: KONE.instructions,
    });
    // These three and no more: the face, role and roster order are drawer-only,
    // so a fourth key here would mean a layer leaked across the boundary.
    expect(Object.keys(persona!).sort()).toEqual(["instructions", "name", "personality"]);
  });

  test("an agent with a personality but no instructions carries just those two", () => {
    const id = threadId();
    settleThreadAgent(id, GIDEON.id);
    const persona = agentPersonaForThread(id);
    expect(persona).toEqual({ name: GIDEON.name, personality: GIDEON.personality });
    // Instructions are absent, not empty — the send path never sees the key.
    expect(Object.keys(persona!).sort()).toEqual(["name", "personality"]);
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
  test("a rename reaches a thread that already settled on that agent", () => {
    const id = threadId();
    settleThreadAgent(id, KONE.id);
    renameAgent(KONE.id, "Maya");
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

describe("renaming an agent", () => {
  test("the new name is what the roster reports", () => {
    renameAgent(KONE.id, "Maya");
    expect(agentById(KONE.id)?.name).toBe("Maya");
  });

  test("clearing the name gives back the one they shipped with", () => {
    renameAgent(KONE.id, "Maya");
    renameAgent(KONE.id, "");
    expect(agentById(KONE.id)?.name).toBe(KONE.name);

    renameAgent(KONE.id, "   ");
    expect(agentById(KONE.id)?.name).toBe(KONE.name);

    renameAgent(KONE.id, KONE.name);
    expect(agentById(KONE.id)?.name).toBe(KONE.name);
  });

  test("surrounding space is not part of a name", () => {
    renameAgent(KONE.id, "  Maya  ");
    expect(agentById(KONE.id)?.name).toBe("Maya");
  });

  test("a name has a length the roster can lay out", () => {
    renameAgent(KONE.id, "M".repeat(60));
    expect(agentById(KONE.id)?.name.length).toBe(24);
  });

  test("renaming somebody who isn't in the roster changes nothing", () => {
    renameAgent("nobody", "Maya");
    expect(agentById(KONE.id)?.name).toBe(KONE.name);
    expect(agentById("nobody")).toBeUndefined();
  });
});
