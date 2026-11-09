import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

test("project and Studio state survive a sidecar restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kone-rune-test-"));
  async function open() {
    const child = spawn(process.execPath, ["dist/index.mjs"], { env: { ...process.env, KONE_RUNE_DATA_DIR: directory }, stdio: ["pipe", "pipe", "pipe"] });
    let next = 0;
    const waiters = new Map();
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      const resolve = waiters.get(message.id);
      if (resolve) { waiters.delete(message.id); resolve(message); }
    });
    return {
      async call(method, params = {}) {
        const id = ++next;
        const result = new Promise((resolve) => waiters.set(id, resolve));
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        const message = await result;
        assert.equal(message.error, undefined);
        return message.result;
      },
      async close() {
        const ended = new Promise((resolve) => child.once("close", resolve));
        child.stdin.end();
        assert.equal(await ended, 0);
      },
    };
  }
  try {
    let app = await open();
    await app.call("projects.remember", { path: "/tmp/one", name: "One" });
    await app.call("projects.pin", { path: "/tmp/one", pinned: true });
    await app.call("projects.remember", { path: "/tmp/two", name: "Two" });
    await app.call("studio.save", { layout: { version: 2, rows: [] } });
    await app.close();
    app = await open();
    const list = await app.call("projects.list");
    assert.deepEqual(list.map((entry) => entry.name), ["One", "Two"]);
    assert.equal(list[0].pinned, true);
    assert.deepEqual(await app.call("studio.load"), { version: 2, rows: [] });
    await app.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
