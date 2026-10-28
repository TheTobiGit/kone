import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { agentCoreModuleUrl, launchFixtures, runLaunchScript } from "./testing/win32Launch.js";
import { escapeCmdCommand } from "./windowsLaunch.js";

const fixtures = launchFixtures();

afterEach(fixtures.cleanup);

// Droid's discovery version probe (adapters/DroidAdapter.ts discover).

const BINARY = "droid";
const ADAPTER = agentCoreModuleUrl("adapters/DroidAdapter.ts");

describe("Droid adapter launch", () => {
  test("discover() probes --version through cmd.exe", async () => {
    const fixture = fixtures.create();
    fixture.installNpmSiblings(BINARY);
    const run = await runLaunchScript({
      fixture,
      windows: true,
      body: `
        const { DroidAdapter } = await import(${JSON.stringify(ADAPTER)});
        await new DroidAdapter(() => {}).discover();
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
        const { DroidAdapter } = await import(${JSON.stringify(ADAPTER)});
        await new DroidAdapter(() => {}).discover();
      `,
    });
    expect(run.stderr).toBe("");
    expect(run.records).toEqual([["--version"]]);
  }, 15_000);
});
