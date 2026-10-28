import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { agentCoreModuleUrl, launchFixtures, runLaunchScript } from "./testing/win32Launch.js";
import { escapeCmdCommand } from "./windowsLaunch.js";

const fixtures = launchFixtures();

afterEach(fixtures.cleanup);

// Codex discovery starts with `codex --version` through spawn.ts's probeResult
// (adapters/CodexAdapter.ts discover). On Windows that has to become the npm
// shim's cmd.exe wrapper; off Windows it stays the bare name.

const BINARY = "codex";
const ADAPTER = agentCoreModuleUrl("adapters/CodexAdapter.ts");

describe("Codex adapter launch", () => {
  test("discover() probes --version through cmd.exe", async () => {
    const fixture = fixtures.create();
    fixture.installNpmSiblings(BINARY);
    const run = await runLaunchScript({
      fixture,
      windows: true,
      body: `
        const { CodexAdapter } = await import(${JSON.stringify(ADAPTER)});
        await new CodexAdapter(() => {}).discover();
      `,
    });
    const shim = path.join(fixture.binDir, `${BINARY}.cmd`);
    expect(run.stderr).toBe("");
    expect(run.records).toEqual([
      ["/d", "/s", "/c", `"${escapeCmdCommand(shim)} ^^^"--version^^^""`],
    ]);
  }, 15_000);

  test("off Windows the same probe spawns the bare name", async () => {
    const fixture = fixtures.create();
    fixture.installExecutable(BINARY);
    const run = await runLaunchScript({
      fixture,
      windows: false,
      body: `
        const { CodexAdapter } = await import(${JSON.stringify(ADAPTER)});
        await new CodexAdapter(() => {}).discover();
      `,
    });
    expect(run.stderr).toBe("");
    expect(run.records).toEqual([["--version"]]);
  }, 15_000);
});
