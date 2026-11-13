import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
    let statusWaiter;
    child.once("error", (error) => { for (const waiter of waiters.values()) waiter.reject(error); waiters.clear(); });
    child.once("close", (code) => { for (const waiter of waiters.values()) waiter.reject(new Error(`sidecar exited: ${code}`)); waiters.clear(); });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "projects.status" && statusWaiter) { const resolve = statusWaiter; statusWaiter = undefined; resolve(message.params); }
      const waiter = waiters.get(message.id);
      if (waiter) { waiters.delete(message.id); waiter.resolve(message); }
    });
    return {
      nextStatus() {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { statusWaiter = undefined; reject(new Error("status notification timed out")); }, 10000);
          statusWaiter = (value) => { clearTimeout(timer); resolve(value); };
        });
      },
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
      abort() { child.kill(); },
    };
  }
  let app;
  try {
    app = await open();
    const created = await app.call("projects.create", { parent: directory, name: "project", git: true, readme: true });
    assert.equal(created.path, path.join(directory, "project"));
    const listing = await app.call("projects.listDirectories", { path: directory });
    assert.ok(listing.entries.some((entry) => entry.path === created.path && entry.name === "project"));
    const setup = await app.call("projects.create", { parent: directory, name: "setup", command: "printf ready > marker" });
    assert.equal(await readFile(path.join(setup.path, "marker"), "utf8"), "ready");
    assert.deepEqual(await app.call("projects.cancelClone", { requestId: 999999 }), { cancelled: false });
    const overview = await app.call("projects.overview", { path: created.path });
    assert.ok(overview.repository);
    assert.ok(overview.readme);
    const summary = await app.call("projects.summary", { path: created.path });
    assert.equal(summary.root, await realpath(created.path));
    assert.ok(Array.isArray(summary.changes));
    assert.equal(await app.call("projects.summary", { path: directory }), null);
    await app.call("projects.watchSummaries", { paths: [created.path] });
    const changed = app.nextStatus();
    await writeFile(path.join(created.path, "watch-proof.txt"), "changed\n");
    assert.ok((await changed).tree.changes.some((entry) => entry.path === "watch-proof.txt"));
    await app.call("projects.watchSummaries", { paths: [] });
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
    assert.deepEqual(await app.call("studio.load"), { version: 2, rows: [], focusedRow: null });
    await app.close();
  } finally { app?.abort(); await rm(directory, { recursive: true, force: true }); }
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

test("PTY sessions stream shell output, accept input, report foreground children, and close", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kone-rune-pty-"));
  const child = spawn(node, [script], { env: { ...process.env, KONE_RUNE_DATA_DIR: directory }, stdio: ["pipe", "pipe", "pipe"] });
  const notifications = [];
  const waiters = [];
  const responses = new Map();
  const responseWaiters = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id != null) { responses.set(message.id, message); responseWaiters.get(message.id)?.(message); }
    if (message.method?.startsWith("terminal.")) {
      notifications.push(message);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(message)) { const [waiter] = waiters.splice(i, 1); waiter.resolve(message); }
      }
    }
  });
  const waitFor = (match) => {
    const existing = notifications.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, reject };
      waiters.push(waiter);
      setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error("PTY event timed out")); }, 5000);
    });
  };
  let next = 0;
  const call = (method, params) => {
    const id = ++next;
    const result = new Promise((resolve, reject) => responseWaiters.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  };
  try {
    const terminalId = "pty-smoke";
    const opened = await call("terminal.open", { terminalId, cwd: directory, cols: 80, rows: 24 });
    assert.equal(opened.status, "ready");
    await call("terminal.write", { terminalId, data: "printf '\\033[31m__RUNE_PTY_OK__\\033[0m\\n'; sleep 2\r" });
    await waitFor((event) => event.method === "terminal.output" && event.params.terminalId === terminalId && event.params.data.includes("__RUNE_PTY_OK__"));
    const activity = await waitFor((event) => event.method === "terminal.activity" && event.params.terminalId === terminalId && event.params.hasRunningSubprocess);
    assert.ok(activity.params.childCommandLabel);
    await call("terminal.resize", { terminalId, cols: 100, rows: 30 });
    await call("terminal.close", { terminalId });
    await waitFor((event) => event.method === "terminal.exited" && event.params.terminalId === terminalId);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("close", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});


test("cancelling one clone leaves its sibling running", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kone-rune-cancel-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const git = path.join(bin, "git");
  await writeFile(git, `#!/bin/sh
if [ "$4" = "slow" ]; then
  echo 'Receiving objects: 1%' >&2
  sleep 30
else
  mkdir "$5"
  echo 'Receiving objects: 100%' >&2
fi
`);
  await chmod(git, 0o755);
  const child = spawn(node, [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KONE_RUNE_DATA_DIR: directory }, stdio: ["pipe", "pipe", "pipe"] });
  const responses = new Map();
  const waiters = new Map();
  let slowStarted;
  const started = new Promise((resolve) => { slowStarted = resolve; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "projects.cloneProgress" && message.params.requestId === 1) slowStarted();
    if (message.id != null) { responses.set(message.id, message); waiters.get(message.id)?.(message); }
  });
  const wait = (id) => responses.has(id) ? Promise.resolve(responses.get(id)) : new Promise((resolve) => waiters.set(id, resolve));
  const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  try {
    send(1, "projects.clone", { url: "slow", parent: directory, name: "slow" });
    const timer = setTimeout(() => child.kill(), 10000);
    try { await started; } finally { clearTimeout(timer); }
    send(2, "projects.clone", { url: "fast", parent: directory, name: "fast" });
    send(3, "projects.cancelClone", { requestId: 1 });
    assert.deepEqual((await wait(3)).result, { cancelled: true });
    assert.ok((await wait(1)).error);
    assert.equal((await wait(2)).result.path, path.join(directory, "fast"));
    send(4, "projects.cancelClone", { requestId: 1 });
    assert.deepEqual((await wait(4)).result, { cancelled: false });
  } finally {
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.stdin.end();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
