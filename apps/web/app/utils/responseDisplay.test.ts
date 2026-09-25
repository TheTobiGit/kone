import { describe, expect, test } from "bun:test";
import { DEFAULT_DISPLAYS, readDisplays } from "./responseDisplay";

describe("readDisplays", () => {
  test("nothing stored reads the defaults", () => {
    expect(readDisplays(null)).toEqual(DEFAULT_DISPLAYS);
  });

  test("a read stored nested, the old way, carries over", () => {
    const read = readDisplays({
      inbox: { live: { tools: "expanded", updates: "show", text: "whole" }, done: { tools: "folded" } },
    });
    expect(read.inbox).toEqual({ ...DEFAULT_DISPLAYS.inbox, liveTools: "expanded", liveUpdates: "show", liveText: "whole", doneTools: "folded" });
    expect(read.studio).toEqual(DEFAULT_DISPLAYS.studio);
  });

  test("a value that names no option reads its default", () => {
    const read = readDisplays({ studio: { liveTools: "sideways", doneTools: "expanded" } });
    expect(read.studio).toEqual({ ...DEFAULT_DISPLAYS.studio, doneTools: "expanded" });
  });

  test("done tools can't take a live-only option", () => {
    expect(readDisplays({ studio: { doneTools: "fold-as-it-goes" } }).studio.doneTools).toBe("hidden");
  });
});
