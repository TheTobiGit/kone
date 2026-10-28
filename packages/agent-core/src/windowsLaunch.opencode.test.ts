import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { agentCoreModuleUrl, launchFixtures, runLaunchScript } from "./testing/win32Launch.js";
import { escapeCmdCommand } from "./windowsLaunch.js";

const fixtures = launchFixtures();

afterEach(fixtures.cleanup);

// The OpenCode adapter's version probe (adapters/OpenCodeAdapter.ts discover).
// The recorder answers 0.0.1, which is below the supported minimum, so
// discovery stops there instead of moving on to the model inventory (a
// long-lived `opencode serve`, spawned through its own path).

const BINARY = "opencode";
const ADAPTER = agentCoreModuleUrl("adapters/OpenCodeAdapter.ts");

describe("OpenCode adapter launch", () => {
  test("discover() probes --version through cmd.exe", async () => {
    const fixture = fixtures.create();
    fixture.installNpmSiblings(BINARY);
    const run = await runLaunchScript({
      fixture,
      windows: true,
      body: `
        const { OpenCodeAdapter } = await import(${JSON.stringify(ADAPTER)});
        await new OpenCodeAdapter(() => {}).discover();
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
        const { OpenCodeAdapter } = await import(${JSON.stringify(ADAPTER)});
        await new OpenCodeAdapter(() => {}).discover();
      `,
    });
    expect(run.stderr).toBe("");
    expect(run.records).toEqual([["--version"]]);
  }, 15_000);
});
