import { describe, expect, test } from "bun:test";
import path from "node:path";

import { agentCoreModuleUrl, createLaunchFixture, runLaunchScript } from "./testing/win32Launch.js";
import { escapeCmdCommand } from "./windowsLaunch.js";

// Claude's version probe (adapters/ClaudeAdapter.ts probeVersion). Discovery
// also starts the Agent SDK handshake, which spawns through the SDK's own path
// rather than the shared helpers — so this scenario drives probeVersion itself,
// the one launch in this adapter that reaches probeResult, and leaves the
// handshake alone.

const BINARY = "claude";
const ADAPTER = agentCoreModuleUrl("adapters/ClaudeAdapter.ts");

describe("Claude adapter launch", () => {
  test("probeVersion() probes --version through cmd.exe", async () => {
    const fixture = createLaunchFixture();
    fixture.installNpmSiblings(BINARY);
    const run = await runLaunchScript({
      fixture,
      windows: true,
      body: `
        const { ClaudeAdapter } = await import(${JSON.stringify(ADAPTER)});
        await new ClaudeAdapter(() => {}).probeVersion();
      `,
    });
    const shim = path.join(fixture.binDir, `${BINARY}.cmd`);
    expect(run.stderr).toBe("");
    expect(run.records).toEqual([
      ["/d", "/s", "/c", `"${escapeCmdCommand(shim)} ^^^"--version^^^""`],
    ]);
  }, 15_000);

  test("off Windows the same probe spawns the discovered path", async () => {
    const fixture = createLaunchFixture();
    fixture.installExecutable(BINARY);
    const run = await runLaunchScript({
      fixture,
      windows: false,
      body: `
        const { ClaudeAdapter } = await import(${JSON.stringify(ADAPTER)});
        await new ClaudeAdapter(() => {}).probeVersion();
      `,
    });
    expect(run.stderr).toBe("");
    expect(run.records).toEqual([["--version"]]);
  }, 15_000);
});
