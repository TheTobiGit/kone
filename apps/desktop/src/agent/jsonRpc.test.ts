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
  return (await import(pathToFileURL(copy).href)) as JsonRpcModule;
}

{
  const mod = await loadRealJsonRpcModule();
  JsonRpcClientCtor = mod.JsonRpcClient;
  JsonRpcErrorCtor = mod.JsonRpcError;
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

  test("surfaces error responses as JsonRpcError", async () => {
    const rpc = spawnFakeChild(FAKE_CHILD);
    try {
      const failure: unknown = await rpc.call("fail", {}, 5_000).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(JsonRpcErrorCtor);
      expect((failure as InstanceType<typeof JsonRpcErrorCtor>).code).toBe(-32000);
      expect((failure as InstanceType<typeof JsonRpcErrorCtor>).message).toBe("boom");
    } finally {
      rpc.kill();
    }
  });
});
