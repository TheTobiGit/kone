import { describe, expect, test } from "bun:test";

import { inboxKindLabel, inboxStampAt, inboxStateLabel } from "./inboxEntry";

describe("inbox entry labels", () => {
  test("every kind has a name", () => {
    expect(inboxKindLabel("pushback")).toBe("Pushback");
    expect(inboxKindLabel("answer")).toBe("Answer");
  });

  test("a waiting message says whether it rings or rides the next turn", () => {
    expect(inboxStateLabel({ state: "unseen", rings: true, seenVia: null })).toBe("Waiting");
    expect(inboxStateLabel({ state: "unseen", rings: false, seenVia: null })).toBe("Next turn");
    expect(inboxStateLabel({ state: "handing", rings: true, seenVia: null })).toBe("Handing over");
  });

  test("a seen message says how", () => {
    expect(inboxStateLabel({ state: "seen", rings: true, seenVia: "turn" })).toBe("Seen");
    expect(inboxStateLabel({ state: "seen", rings: true, seenVia: "inbox" })).toBe("Read");
    expect(inboxStateLabel({ state: "seen", rings: true, seenVia: "wait" })).toBe("Answered a wait");
    expect(inboxStateLabel({ state: "retracted", rings: true, seenVia: null })).toBe("Taken back");
  });

  test("the stamp counts from when it was seen, else when it arrived", () => {
    expect(inboxStampAt({ createdAt: 1, seenAt: null })).toBe(1);
    expect(inboxStampAt({ createdAt: 1, seenAt: 5 })).toBe(5);
  });
});
