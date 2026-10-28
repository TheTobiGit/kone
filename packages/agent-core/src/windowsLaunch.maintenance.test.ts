import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveProviderMaintenance, runProviderUpdate } from "./providerMaintenance.js";
import { createLaunchFixture, recordingSpawn } from "./testing/win32Launch.js";
import { escapeCmdArgument, escapeCmdCommand } from "./windowsLaunch.js";

// Provider updates run the package manager the CLI was installed with. On
// Windows that manager is npm's `npm.cmd` shim, which plain spawn cannot start
// (EINVAL) and does not find from the bare name (libuv only completes
// .com/.exe), so the update has to be launched through the shared Windows
// resolution. The spawn is recorded rather than run, so the assertions are
// exact about the command and the options child_process receives.
//
// The install layout is npm's: an extensionless `cline` shim under
// node_modules/.bin (which is also what tells maintenance the channel is npm),
// with the `npm` shim — `npm`, `npm.cmd`, `npm.ps1` — installed beside it. The
// detection walk runs on the host platform (a `:`-separated PATH) while the
// launch resolves for Windows (a `;`-separated PATH); one directory holding no
// separator at all is the only PATH both read the same way, which is why both
// fixtures point PATH at a single install directory.

const fixture = createLaunchFixture();

afterAll(() => {
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

/** npm's global bin directory for this fixture: the channel detection sees
 *  node_modules/.bin, and the update's `npm` is found there too. */
const binDir = path.join(fixture.root, "node_modules", ".bin");

/** Write one file of the npm layout, with an explicit mode (a Windows `.cmd`
 *  is not executable as a program; a POSIX shim is). */
function install(name: string, contents: string, mode: number): void {
  const target = path.join(binDir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  fs.chmodSync(target, mode);
}

install("cline", "#!/bin/sh\n", 0o755);
install("cline.cmd", "@echo off\r\n", 0o644);
install("cline.ps1", "# not launchable\n", 0o644);
install("npm", "#!/bin/sh\n", 0o755);
install("npm.cmd", "@echo off\r\n", 0o644);
install("npm.ps1", "# not launchable\n", 0o644);

/** The fixture's environment with PATH narrowed to the install directory. */
function env(): NodeJS.ProcessEnv {
  return { ...fixture.env({ windows: true }), PATH: binDir };
}

describe("runProviderUpdate Windows launch", () => {
  test("an npm-installed provider updates through npm.cmd in cmd.exe", async () => {
    const { calls, spawn } = recordingSpawn();
    const updateEnv = env();

    const result = await runProviderUpdate({
      provider: "cline",
      env: updateEnv,
      launch: { platform: "win32", spawn },
    });

    const npmCmd = path.join(binDir, "npm.cmd");
    expect(result.outcome).toBe("succeeded");
    expect(calls).toEqual([
      {
        file: fixture.comspec,
        args: [
          "/d",
          "/s",
          "/c",
          `"${escapeCmdCommand(npmCmd)} ${escapeCmdArgument("install", true)} ${escapeCmdArgument("-g", true)} ${escapeCmdArgument("cline@latest", true)}"`,
        ],
        options: {
          // Updates are machine-wide: the home directory, never a repository.
          cwd: os.homedir(),
          // The owning install directory comes first on a `;`-separated PATH,
          // so the npm that answers is the one this install belongs to.
          env: { ...updateEnv, PATH: [binDir, binDir].join(";") },
          windowsHide: true,
          // A Windows host gets no process group of its own.
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsVerbatimArguments: true,
        },
      },
    ]);
  });

  test("the command pane still shows the npm command it always did", async () => {
    const maintenance = await resolveProviderMaintenance({
      provider: "cline",
      env: env(),
      checkLatest: false,
    });
    expect(maintenance.installSource).toBe("npm");
    expect(maintenance.updateCommand).toBe("npm install -g cline@latest");
  });

  test("off Windows the update spawns npm exactly as before", async () => {
    const { calls, spawn } = recordingSpawn();
    const updateEnv = env();

    const result = await runProviderUpdate({
      provider: "cline",
      env: updateEnv,
      launch: { platform: "linux", spawn },
    });

    expect(result.outcome).toBe("succeeded");
    expect(calls).toEqual([
      {
        file: "npm",
        args: ["install", "-g", "cline@latest"],
        options: {
          cwd: os.homedir(),
          env: { ...updateEnv, PATH: [binDir, binDir].join(":") },
          windowsHide: true,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      },
    ]);
  });
});
