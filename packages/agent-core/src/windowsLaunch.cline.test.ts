import { describe, expect, test } from "bun:test";
import path from "node:path";

import { agentCoreModuleUrl, createLaunchFixture, runLaunchScript } from "./testing/win32Launch.js";
import { escapeCmdCommand } from "./windowsLaunch.js";

// Cline's discovery version probe (adapters/ClineAdapter.ts discover) goes
// through probeResult like every other provider's.

const BINARY = "cline";
const ADAPTER = agentCoreModuleUrl("adapters/ClineAdapter.ts");

describe("Cline adapter launch", () => {
  test("discover() probes --version through cmd.exe", async () => {
    const fixture = createLaunchFixture();
    fixture.installNpmSiblings(BINARY);
    const run = await runLaunchScript({
      fixture,
      windows: true,
      body: `
        const { ClineAdapter } = await import(${JSON.stringify(ADAPTER)});
        await new ClineAdapter(() => {}, async () => []).discover();
      `,
    });
    const shim = path.join(fixture.binDir, `${BINARY}.cmd`);
    expect(run.stderr).toBe("");
    expect(run.records).toEqual([
      ["/d", "/s", "/c", `"${escapeCmdCommand(shim)} ^^^"--version^^^""`],
    ]);
  }, 15_000);

  test("off Windows the same probe spawns the bare name", async () => {
    const fixture = createLaunchFixture();
    fixture.installExecutable(BINARY);
    const run = await runLaunchScript({
      fixture,
      windows: false,
      body: `
        const { ClineAdapter } = await import(${JSON.stringify(ADAPTER)});
        await new ClineAdapter(() => {}, async () => []).discover();
      `,
    });
    expect(run.stderr).toBe("");
    expect(run.records).toEqual([["--version"]]);
  }, 15_000);
});
