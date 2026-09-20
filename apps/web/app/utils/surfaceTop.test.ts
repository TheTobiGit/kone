import { describe, expect, test } from "bun:test";
import { resolveTop, type SurfaceSnapshot } from "./surfaceTop";

const NOTHING: SurfaceSnapshot = {
  launcherModal: false,
  intentMenu: false,
  assistant: false,
  bench: false,
  inbox: false,
  studio: false,
  settings: false,
};

function open(...names: (keyof SurfaceSnapshot)[]): SurfaceSnapshot {
  const snapshot = { ...NOTHING };

  for (const name of names) snapshot[name] = true;

  return snapshot;
}

describe("resolveTop", () => {
  test("nothing open is the stage", () => {
    expect(resolveTop(NOTHING)).toBe("stage");
  });

  test("each surface wins alone", () => {
    expect(resolveTop(open("launcherModal"))).toBe("launcher-modal");
    expect(resolveTop(open("intentMenu"))).toBe("intent-menu");
    expect(resolveTop(open("assistant"))).toBe("assistant");
    expect(resolveTop(open("settings"))).toBe("settings");
    expect(resolveTop(open("bench"))).toBe("bench");
    expect(resolveTop(open("inbox"))).toBe("inbox");
    expect(resolveTop(open("studio"))).toBe("studio");
  });

  // The drawer is modal: the stage is inert and the veil covers the portals
  // while it is open, so a portal underneath can be seen but not used. The
  // surface that answers keys has to be the one the user can actually reach.
  test("the settings drawer outranks every portal underneath it", () => {
    expect(resolveTop(open("settings", "studio"))).toBe("settings");
    expect(resolveTop(open("settings", "inbox"))).toBe("settings");
    expect(resolveTop(open("settings", "bench"))).toBe("settings");
    expect(resolveTop(open("settings", "studio", "inbox", "bench"))).toBe("settings");
  });

  // Tier 4 is fixed over the whole viewport rather than inside the stage, so it
  // is not covered by the drawer's veil and still owns keys over it.
  test("the fixed overlays still outrank the drawer", () => {
    expect(resolveTop(open("settings", "assistant"))).toBe("assistant");
    expect(resolveTop(open("settings", "intentMenu"))).toBe("intent-menu");
    expect(resolveTop(open("settings", "launcherModal"))).toBe("launcher-modal");
  });

  test("portals keep the painting order among themselves", () => {
    expect(resolveTop(open("studio", "inbox"))).toBe("inbox");
    expect(resolveTop(open("studio", "bench"))).toBe("bench");
    expect(resolveTop(open("inbox", "bench"))).toBe("bench");
    expect(resolveTop(open("studio", "inbox", "bench"))).toBe("bench");
  });

  test("the launcher modal answers before the menu, and the menu before the card", () => {
    expect(resolveTop(open("launcherModal", "intentMenu", "assistant"))).toBe("launcher-modal");
    expect(resolveTop(open("intentMenu", "assistant"))).toBe("intent-menu");
  });
});
