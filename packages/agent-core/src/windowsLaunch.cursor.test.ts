import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { agentCoreModuleUrl, launchFixtures, runLaunchScript } from "./testing/win32Launch.js";
import { escapeCmdCommand } from "./windowsLaunch.js";

const fixtures = launchFixtures();

afterEach(fixtures.cleanup);

// Cursor's discovery runs two probes (adapters/CursorAdapter.ts discover):
// `cursor-agent --version`, then `cursor-agent status`.

const BINARY = "cursor-agent";
const ADAPTER = agentCoreModuleUrl("adapters/CursorAdapter.ts");

describe("Cursor adapter launch", () => {
  test("discover() probes --version and status through cmd.exe", async () => {
    const fixture = fixtures.create();
    fixture.installNpmSiblings(BINARY);
    const run = await runLaunchScript({
      fixture,
      windows: true,
      body: `
        const { CursorAdapter } = await import(${JSON.stringify(ADAPTER)});
        await new CursorAdapter(() => {}).discover();
      `,
    });
    const shim = path.join(fixture.binDir, `${BINARY}.cmd`);
    const wrapper = escapeCmdCommand(shim);
    expect(run.stderr).toBe("");
    expect(run.records).toEqual([
      ["/d", "/s", "/c", `"${wrapper} ^^^"--version^^^""`],
      ["/d", "/s", "/c", `"${wrapper} ^^^"status^^^""`],
    ]);
  }, 15_000);

  test("off Windows the same probes spawn the bare name", async () => {
    const fixture = fixtures.create();
    fixture.installExecutable(BINARY);
    const run = await runLaunchScript({
      fixture,
      windows: false,
      body: `
        const { CursorAdapter } = await import(${JSON.stringify(ADAPTER)});
        await new CursorAdapter(() => {}).discover();
      `,
    });
    expect(run.stderr).toBe("");
    expect(run.records).toEqual([["--version"], ["status"]]);
  }, 15_000);
});
