import { describe, expect, test } from "bun:test";

import { rememberSideChatSource } from "~/composables/sideChats";
import { agentIdentity } from "./agentIdentity";
import { KONE, settleThreadAgent } from "./agents";

let minted = 0;
function threadId(): string {
  minted += 1;
  return `test-thread-${minted}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("agentIdentity", () => {
  test("anonymous or null seed returns ANONYMOUS", () => {
    expect(agentIdentity(null).name).toBe("kone");
    expect(agentIdentity("").name).toBe("kone");
    expect(agentIdentity(undefined).name).toBe("kone");
  });

  test("a thread bound to a named agent returns the agent's name and svg", () => {
    const main = threadId();
    settleThreadAgent(main, KONE.id);
    const id = agentIdentity(main);
    expect(id.name).toBe(KONE.name);
    expect(id.svg).toContain("<svg");
  });

  test("a side chat of a named agent thread inherits the named agent identity", () => {
    const main = threadId();
    const side = threadId();
    settleThreadAgent(main, KONE.id);
    rememberSideChatSource(side, main);
    const sideId = agentIdentity(side);
    expect(sideId.name).toBe(KONE.name);
    expect(sideId.svg).toContain("<svg");
  });

  test("a guest thread generates a deterministic guest name and svg", () => {
    const main = threadId();
    settleThreadAgent(main, null);
    const guest1 = agentIdentity(main);
    const guest2 = agentIdentity(main);
    expect(guest1.name).toBeTruthy();
    expect(guest1.svg).toContain("<svg");
    expect(guest1.name).toBe(guest2.name);
    expect(guest1.svg).toBe(guest2.svg);
  });

  test("a side chat of a guest thread carries the exact same guest name and face as the main chat", () => {
    const main = threadId();
    const side = threadId();
    settleThreadAgent(main, null);
    rememberSideChatSource(side, main);

    const mainIdentity = agentIdentity(main);
    const sideIdentity = agentIdentity(side);

    expect(sideIdentity.name).toBe(mainIdentity.name);
    expect(sideIdentity.svg).toBe(mainIdentity.svg);
    expect(sideIdentity.seed).toBe(mainIdentity.seed);
  });
});
