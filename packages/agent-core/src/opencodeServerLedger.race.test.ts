import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenCodeServerPool } from "./opencodeServer.js";
import { setUserDataDir } from "./userDataDir.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("first startup reap must never kill a server spawned in this run", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "p9-reap-race-"));
  dirs.push(dir);
  setUserDataDir(dir);
  const binary = path.join(dir, "fake-opencode");
  writeFileSync(binary, "#!/bin/sh\necho 'opencode server listening on http://127.0.0.1:40123'\nexec /bin/sleep 30\n", { mode: 0o700 });
  const pool = new OpenCodeServerPool();
  const server = await pool.start({ cwd: dir, env: process.env, binary });
  try {
    await Bun.sleep(500);
    expect(server.child.exitCode).toBeNull();
    expect(server.child.signalCode).toBeNull();
  } finally {
    await server.dispose();
    await pool.dispose();
  }
});
