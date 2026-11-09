import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const node = process.env.KONE_RUNE_TEST_NODE ?? "node";
const script = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));

test("project and Studio state survive a sidecar restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kone-rune-test-"));
  async function open() {
    const child = spawn(node, [script], { env: { ...process.env, KONE_RUNE_DATA_DIR: directory }, stdio: ["pipe", "pipe", "pipe"] });
    let next = 0;
    const waiters = new Map();
    child.once("error", (error) => { for (const waiter of waiters.values()) waiter.reject(error); waiters.clear(); });
    child.once("close", (code) => { for (const waiter of waiters.values()) waiter.reject(new Error(`sidecar exited: ${code}`)); waiters.clear(); });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter) { waiters.delete(message.id); waiter.resolve(message); }
    });
    return {
      async call(method, params = {}) {
        const id = ++next;
        const result = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`sidecar request timed out: ${method}`)); }, 10000);
          waiters.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        });
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
    const created = await app.call("projects.create", { parent: directory, name: "project", git: true, readme: true });
    assert.equal(created.path, path.join(directory, "project"));
    const setup = await app.call("projects.create", { parent: directory, name: "setup", command: "printf ready > marker" });
    assert.equal(await readFile(path.join(setup.path, "marker"), "utf8"), "ready");
    assert.deepEqual(await app.call("projects.cancelClone", { requestId: 999999 }), { cancelled: false });
    const overview = await app.call("projects.overview", { path: created.path });
    assert.ok(overview.repository);
    assert.ok(overview.readme);
    assert.deepEqual(await app.call("history.list", { projectPath: created.path }), []);
    const cloned = await app.call("projects.clone", { url: created.path, parent: directory, name: "clone" });
    assert.equal(cloned.path, path.join(directory, "clone"));
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

test("invalid frames preserve the stream and requests retain their IDs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kone-rune-wire-"));
  const child = spawn(node, [script], { env: { ...process.env, KONE_RUNE_DATA_DIR: directory }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const messages = [];
    const done = new Promise((resolve, reject) => {
      createInterface({ input: child.stdout }).on("line", (line) => {
        try { messages.push(JSON.parse(line)); } catch (error) { reject(error); }
      });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    });
    child.stdin.end('{oops}\n{"jsonrpc":"2.0","method":"initialize"}\n{"jsonrpc":"2.0","id":"bad-params","method":"projects.pin","params":{}}\n{"jsonrpc":"2.0","id":42,"method":"initialize"}\n');
    await done;
    assert.equal(messages.find((m) => m.error?.code === -32700)?.id, null);
    assert.equal(messages.find((m) => m.error?.code === -32600)?.id, null);
    assert.equal(messages.find((m) => m.id === "bad-params")?.error?.code, -32000);
    assert.equal(messages.find((m) => m.id === 42)?.result?.version, 1);
  } finally { child.kill(); await rm(directory, { recursive: true, force: true }); }
});

test("requires an isolated absolute data directory", async () => {
  const child = spawn(node, [script], { env: { ...process.env, KONE_RUNE_DATA_DIR: "relative" }, stdio: ["ignore", "ignore", "pipe"] });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.notEqual(code, 0);
});
