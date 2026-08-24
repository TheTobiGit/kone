import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
// intercept — with its one relative import (./spawn.js) rewritten to the real
// file's URL. Same source, same compiler, only the module instance differs.
const JSONRPC_SOURCE = fileURLToPath(new URL("./jsonRpc.ts", import.meta.url));

async function loadRealJsonRpcModule(): Promise<JsonRpcModule> {
  const source = readFileSync(JSONRPC_SOURCE, "utf8").replace(
    'from "./spawn.js"',
    `from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("./spawn.ts", import.meta.url))).href)}`,
  );
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
