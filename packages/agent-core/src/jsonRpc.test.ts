import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createLaunchFixture, recordingSpawn } from "./testing/win32Launch.js";
import { escapeCmdCommand } from "./windowsLaunch.js";

// A fake app-server child. On `initialize` it dumps a batch of leaked
// subprocess/hook output onto stdout — invalid JSON fragments, standalone
// JSON (`null`, strings, numbers, `{}`, `[]`), JSON-RPC lookalikes that are
// not proper envelopes, and a stale response for an id nothing is waiting
// on — and only then answers the call.
const FAKE_CHILD = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    const junk = [null, "hello", 42, true, {}, [], {"name":"synara"}, {"method":123}, {"id":999,"result":"stale"}];
    for (const entry of junk) {
      process.stdout.write(JSON.stringify(entry) + "\\n");
    }
    process.stdout.write('{"method":"item/started"\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\\n");
  }
  if (msg.method === "fail") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom" } }) + "\\n");
  }
});
`;

// A child that closes its own read end and then stays alive, so the parent's
// stdin pipe is broken while the process — and thus the `exited` guard — is
// not. Announces readiness on stdout only after the pipe is dead.
const DEAD_STDIN_CHILD = `
process.stdin.destroy();
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready" }) + "\\n");
setTimeout(() => {}, 10_000);
`;

type JsonRpcModule = typeof import("./jsonRpc.js");
let JsonRpcClientCtor: JsonRpcModule["JsonRpcClient"];
let JsonRpcErrorCtor: JsonRpcModule["JsonRpcError"];

// The gateway-injection suites stub jsonRpc.ts with mock.module and bun keeps
// one mock registry per worker process, so their stub can reach this file
// when both land in the same worker (standalone runs never hit it). Importing
// jsonRpc.js here would resolve to that stub. Instead, load the REAL transport
// from a temp copy of the source — a different resolved path no mock can
// intercept — with its relative imports (./spawn.js and ./windowsLaunch.js)
// rewritten to the real files' URLs. Same source, same compiler, only the
// module instance differs; windowsLaunch is never stubbed, so it stays real
// even for the unstubbed copy.
const JSONRPC_SOURCE = fileURLToPath(new URL("./jsonRpc.ts", import.meta.url));
const SPAWN_SOURCE_URL = pathToFileURL(fileURLToPath(new URL("./spawn.ts", import.meta.url))).href;
const WINDOWS_LAUNCH_SOURCE_URL = pathToFileURL(
  fileURLToPath(new URL("./windowsLaunch.ts", import.meta.url)),
).href;

async function loadRealJsonRpcModule(): Promise<JsonRpcModule> {
  const source = readFileSync(JSONRPC_SOURCE, "utf8")
    .replace('from "./spawn.js"', `from ${JSON.stringify(SPAWN_SOURCE_URL)}`)
    .replace('from "./windowsLaunch.js"', `from ${JSON.stringify(WINDOWS_LAUNCH_SOURCE_URL)}`);
  const dir = mkdtempSync(path.join(tmpdir(), "kone-jsonrpc-real-"));
  const copy = path.join(dir, "jsonRpc.ts");
  writeFileSync(copy, source);
  return await import(pathToFileURL(copy).href);
}

{
  const mod = await loadRealJsonRpcModule();
  JsonRpcClientCtor = mod.JsonRpcClient;
  JsonRpcErrorCtor = mod.JsonRpcError;
}

/** The message a call rejected with, or a marker when it resolved instead —
 *  every rejection path in this transport constructs an Error, so the message
 *  is always readable without asserting the value's type. */
async function rejectionMessage(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "<resolved>";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function spawnFakeChild(script: string): InstanceType<typeof JsonRpcClientCtor> {
  return new JsonRpcClientCtor(process.execPath, ["-e", script], { env: {} });
}

describe("JsonRpcClient stdout envelope validation", () => {
  test("ignores leaked subprocess/hook output and still resolves the real call", async () => {
    const rpc = spawnFakeChild(FAKE_CHILD);
    try {
      const result = await rpc.call<{ ok: boolean }>("initialize", {}, 5_000);
      expect(result).toEqual({ ok: true });
    } finally {
      rpc.kill();
    }
  });

  test("a write to a broken stdin pipe is swallowed, not thrown", async () => {
    const rpc = spawnFakeChild(DEAD_STDIN_CHILD);
    try {
      await new Promise<void>((resolve) => {
        rpc.onNotification("ready", () => resolve());
      });
      // The read end is gone but the child is alive, so this write hits a dead
      // pipe with `exited` still false — the race that previously crashed the
      // main process. It must return without throwing.
      expect(() => rpc.notify("ping", {})).not.toThrow();
    } finally {
      rpc.kill();
    }
  });

  test("an exit rejects in-flight calls naming THIS child, not a hardcoded provider", async () => {
    // Three adapters share this transport, so the exit error must name the
    // child that actually died — a Cursor session reported as "codex
    // app-server" is a lie the user (and classifyProviderError) reads.
    const rpc = new JsonRpcClientCtor(process.execPath, ["-e", "process.exit(0)"], {
      env: {},
      label: "cursor-agent",
    });
    expect(await rejectionMessage(rpc.call("initialize", {}, 5_000))).toBe(
      "cursor-agent process exited",
    );
    // And a call made after the exit says the same thing.
    expect(await rejectionMessage(rpc.call("ping", {}, 5_000))).toBe(
      "cursor-agent process has exited",
    );
  });

  test("the transport labels itself from the binary when no label is given", async () => {
    const rpc = new JsonRpcClientCtor(process.execPath, ["-e", "process.exit(0)"], { env: {} });
    expect(await rejectionMessage(rpc.call("initialize", {}, 5_000))).toBe(
      `${path.basename(process.execPath)} process exited`,
    );
  });

  test("surfaces error responses as JsonRpcError", async () => {
    const rpc = spawnFakeChild(FAKE_CHILD);
    try {
      const failure: unknown = await rpc.call("fail", {}, 5_000).then(
        () => undefined,
        (error) => error,
      );
      expect(failure).toBeInstanceOf(JsonRpcErrorCtor);
      if (!(failure instanceof JsonRpcErrorCtor)) throw new Error("expected a JsonRpcError");
      expect(failure.code).toBe(-32000);
      expect(failure.message).toBe("boom");
    } finally {
      rpc.kill();
    }
  });
});

// ── Windows launch resolution ───────────────────────────────────────────────
// The transport spawns its child by bare name, so on Windows an npm `.cmd` shim
// has to be resolved and wrapped before spawn sees it; a launch that cannot
// happen has to feel exactly like the spawn "error" the child would have
// emitted. Off Windows nothing about the launch may change.

describe("JsonRpcClient Windows launch", () => {
  test("resolves an npm .cmd shim through ComSpec and still speaks the protocol", async () => {
    const fixture = createLaunchFixture();
    fixture.installNpmSiblings("x");
    const env = fixture.env({ windows: true });
    const { calls, spawn: fakeSpawn } = recordingSpawn(FAKE_CHILD);
    const rpc = new JsonRpcClientCtor("x", ["app-server"], {
      cwd: fixture.root,
      env,
      launch: { platform: "win32", spawn: fakeSpawn },
    });
    try {
      const result = await rpc.call<{ ok: boolean }>("initialize", {}, 5_000);
      expect(result).toEqual({ ok: true });
    } finally {
      await rpc.kill();
    }
    expect(calls).toEqual([
      {
        file: fixture.comspec,
        args: [
          "/d",
          "/s",
          "/c",
          `"${escapeCmdCommand(path.join(fixture.binDir, "x.cmd"))} ^^^"app-server^^^""`,
        ],
        options: {
          cwd: fixture.root,
          env,
          windowsHide: true,
          detached: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsVerbatimArguments: true,
        },
      },
    ]);
    expect(Object.keys(calls[0]!.options)).toEqual([
      "cwd",
      "env",
      "windowsHide",
      "detached",
      "stdio",
      "windowsVerbatimArguments",
    ]);
  });

  test("a launch that cannot happen rejects and exits exactly like a failed spawn", async () => {
    const fixture = createLaunchFixture();
    const env = fixture.env({ windows: true });
    const { calls, spawn: fakeSpawn } = recordingSpawn();
    let rpc!: InstanceType<typeof JsonRpcClientCtor>;
    // The constructor must not throw: a real spawn failure is an event later.
    expect(() => {
      rpc = new JsonRpcClientCtor("x", ["app-server"], {
        env,
        launch: { platform: "win32", spawn: fakeSpawn },
      });
    }).not.toThrow();

    // A handler registered right after construction must still see the exit.
    const exits: (number | null)[] = [];
    rpc.onExit((code) => exits.push(code));

    expect(await rejectionMessage(rpc.call("initialize", {}, 5_000))).toBe("x process exited");
    expect(exits).toEqual([null]);
    // Every later call reads the same state a dead child leaves behind.
    expect(await rejectionMessage(rpc.call("ping", {}, 1_000))).toBe("x process has exited");
    expect(calls).toEqual([]);
  });

  test("the label names the configured command, not the interpreter", async () => {
    // A configured path (not a bare name) still goes through cmd.exe, but the
    // errors have to name the CLI the user pointed kone at.
    const fixture = createLaunchFixture();
    fixture.installNpmSiblings("x");
    const env = fixture.env({ windows: true });
    const { calls, spawn: fakeSpawn } = recordingSpawn("process.exit(0)");
    const rpc = new JsonRpcClientCtor(path.join(fixture.binDir, "x.cmd"), ["app-server"], {
      env,
      launch: { platform: "win32", spawn: fakeSpawn },
    });
    expect(await rejectionMessage(rpc.call("initialize", {}, 5_000))).toBe("x.cmd process exited");
    expect(calls[0]!.file).toBe(fixture.comspec);
  });

  test("off Windows the bare command and argv are spawned exactly as before", async () => {
    const { calls, spawn: fakeSpawn } = recordingSpawn("process.exit(0)");
    const rpc = new JsonRpcClientCtor(process.execPath, ["-e", "process.exit(0)"], {
      env: {},
      launch: { platform: "linux", spawn: fakeSpawn },
    });
    await rejectionMessage(rpc.call("initialize", {}, 5_000));
    // The literal object the constructor has always passed: an absent cwd key
    // still present as undefined, no wrapping, no verbatim-arguments key.
    expect(calls).toEqual([
      {
        file: process.execPath,
        args: ["-e", "process.exit(0)"],
        options: {
          cwd: undefined,
          env: {},
          windowsHide: true,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      },
    ]);
    expect(Object.keys(calls[0]!.options)).toEqual([
      "cwd",
      "env",
      "windowsHide",
      "detached",
      "stdio",
    ]);
  });
});
