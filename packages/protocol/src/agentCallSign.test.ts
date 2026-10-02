import { describe, expect, test } from "bun:test";

import { AGENT_CALL_SIGNS, callSignFor, callSignHash, rootConversationId } from "./agentCallSign.js";

describe("callSignFor", () => {
  test("rolls the name the renderer has always shown for a thread id", () => {
    // Observed in the app before the roll moved here: these ids already wear
    // these names, and moving the code must not rename them.
    expect(callSignFor("76d80d25-f1b3-4763-89dc-c65432c7bf63")).toBe("Crest");
    expect(callSignFor("04e9ab63-d71f-49a4-8803-b6e9e5b7b9eb")).toBe("Yarrow");
  });

  test("is FNV-1a over the id, indexed into the list", () => {
    expect(callSignHash("")).toBe(0x811c9dc5);
    const seed = "thread-a";
    expect(callSignFor(seed)).toBe(AGENT_CALL_SIGNS[callSignHash(seed) % AGENT_CALL_SIGNS.length]!);
  });
});

describe("rootConversationId", () => {
  test("a side chat resolves to the thread it was forked from", () => {
    const sources = new Map([["side", "main"]]);
    expect(rootConversationId("side", (id) => sources.get(id))).toBe("main");
    expect(rootConversationId("main", (id) => sources.get(id))).toBe("main");
  });

  test("a cycle stops where it closes", () => {
    const sources = new Map([["a", "b"], ["b", "a"]]);
    expect(rootConversationId("a", (id) => sources.get(id))).toBe("a");
  });
});
