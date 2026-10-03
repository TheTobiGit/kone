import { beforeEach, describe, expect, test } from "bun:test";

import { createAgent, KONE } from "./agents";
import { agentRows, threadBindings } from "./agentStore";
import { isSpeakingSender, messageSpeaker } from "./messageSpeaker";

const BOT = { form: "pebble", color: "teal", expression: "curious" } as const;

beforeEach(async () => {
  agentRows.value = [];
  threadBindings.value = {};
  await createAgent({ id: "maya", name: "Maya", bot: BOT });
});

describe("who is talking on a message the user did not write", () => {
  test("an agent speaks as itself, and its name opens its thread", () => {
    const speaker = messageSpeaker({
      kind: "agent",
      threadId: "t-maya",
      agentId: "maya",
      name: "Maya (then)",
      relationship: "delegate",
      messageKind: "question",
    });
    expect(speaker.name).toBe("Maya");
    expect(speaker.agent?.id).toBe("maya");
    expect(speaker.opens).toBe("t-maya");
    expect(speaker.relation).toBe("your delegate");
    expect(speaker.purpose).toBe("question");
    expect(speaker.about).toBeUndefined();
  });

  // The courier is never the author: it speaks as kone, the agent whose work
  // it carries is named in the tag, and the name opens that agent's thread —
  // where the result can be followed up.
  test("the courier speaks as kone, about the agent whose work it carries", () => {
    const speaker = messageSpeaker({
      kind: "courier",
      messageKind: "report",
      about: { threadId: "t-maya", agentId: "maya", name: "Maya", relationship: "delegate" },
    });
    expect(speaker.name).toBe(KONE.name);
    expect(speaker.agent?.id).toBe(KONE.id);
    expect(speaker.opens).toBe("t-maya");
    expect(speaker.relation).toBe("your delegate Maya");
    expect(speaker.purpose).toBe("report");
    expect(speaker.about?.agent?.id).toBe("maya");
  });

  test("a worker the courier reports on has no roster entry, and keeps its snapshot name", () => {
    const speaker = messageSpeaker({
      kind: "courier",
      messageKind: "report",
      about: { threadId: "t-worker", name: "Rook", relationship: "child" },
    });
    expect(speaker.relation).toBe("your worker Rook");
    expect(speaker.about?.agent).toBeUndefined();
  });

  test("a courier message about nobody in particular opens nothing", () => {
    const speaker = messageSpeaker({ kind: "courier" });
    expect(speaker.name).toBe(KONE.name);
    expect(speaker.opens).toBeNull();
    expect(speaker.purpose).toBeNull();
  });

  // What decides the agent's side of the thread, and the reply lead-in's
  // attribution: both agents and the courier, never the user or a notice.
  test("agents and the courier take the agent's side; the user and kone's notices don't", () => {
    expect(isSpeakingSender({ kind: "agent" })).toBe(true);
    expect(isSpeakingSender({ kind: "courier" })).toBe(true);
    expect(isSpeakingSender({ kind: "system" })).toBe(false);
    expect(isSpeakingSender({ kind: "user" })).toBe(false);
    expect(isSpeakingSender(undefined)).toBe(false);
  });
});
