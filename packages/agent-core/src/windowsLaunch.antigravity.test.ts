import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { agentCoreModuleUrl, launchFixtures, runLaunchScript } from "./testing/win32Launch.js";
import { escapeCmdCommand } from "./windowsLaunch.js";

const fixtures = launchFixtures();

afterEach(fixtures.cleanup);

// The Antigravity ACP adapter's sign-in probe (adapters/AntigravityAcpAdapter.ts
// discover): `agy models` through probeResult. The ACP server itself is
// injected, so nothing here needs a managed runtime — the launch under test is
// the CLI probe that decides whether the server's login is usable.

const BINARY = "agy";
const ADAPTER = agentCoreModuleUrl("adapters/AntigravityAcpAdapter.ts");

/** The resolved ACP server the adapter would otherwise have to find on disk. */
const RESOLVED_SERVER = `{ executablePath: "/nonexistent/agy_acp_server.par", harnessPath: "/nonexistent/harness", source: "override" }`;

describe("Antigravity ACP adapter launch", () => {
  test("discover() probes models through cmd.exe", async () => {
    const fixture = fixtures.create();
    fixture.installNpmSiblings(BINARY);
    const run = await runLaunchScript({
      fixture,
      windows: true,
      body: `
        const { AntigravityAcpAdapter } = await import(${JSON.stringify(ADAPTER)});
        const adapter = new AntigravityAcpAdapter(() => {}, { resolveBinary: () => (${RESOLVED_SERVER}) });
        await adapter.discover();
      `,
    });
    const shim = path.join(fixture.binDir, `${BINARY}.cmd`);
    expect(run.stderr).toBe("");
    expect(run.records).toEqual([
      ["/d", "/s", "/c", `"${escapeCmdCommand(shim)} ^^^"models^^^""`],
    ]);
  }, 15_000);

  test("off Windows the same probe spawns the bare name", async () => {
    const fixture = fixtures.create();
    fixture.installExecutable(BINARY);
    const run = await runLaunchScript({
      fixture,
      windows: false,
      body: `
        const { AntigravityAcpAdapter } = await import(${JSON.stringify(ADAPTER)});
        const adapter = new AntigravityAcpAdapter(() => {}, { resolveBinary: () => (${RESOLVED_SERVER}) });
        await adapter.discover();
      `,
    });
    expect(run.stderr).toBe("");
    expect(run.records).toEqual([["models"]]);
  }, 15_000);
});
