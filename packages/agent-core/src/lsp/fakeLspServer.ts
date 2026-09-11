import { readFileSync } from "node:fs";

// Test-only fake language server, spawned as `process.execPath -e <script>`
// so tests drive real Content-Length bytes over real pipes without any real
// language-server binary. One script serves every scenario; the interpolated
// SCENARIO constant switches behaviors that need a slow or partial server.
// Inbound method names (plus probe answers) append to the interpolated log
// file with synchronous writes, so whatever the client resolved already has
// its evidence flushed.

export type FakeLspScenario = "basic" | "quietSymbol" | "flakyRefs" | "malformed" | "manyRefs";

export function fakeServerScript(logPath: string, scenario: FakeLspScenario): string {
  return `
const fs = require("node:fs");
const LOG = ${JSON.stringify(logPath)};
const SCENARIO = ${JSON.stringify(scenario)};
let buf = Buffer.alloc(0);
let seq = 1;
let refsCalls = 0;
const probeReplies = {};
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  process.stdout.write(Buffer.concat([
    Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf8"),
    body
  ]));
}
function note(text) {
  try { fs.appendFileSync(LOG, text + "\\n"); } catch (e) {}
}
function onNotify(msg) {
  if (msg.method === "textDocument/didOpen") {
    const doc = msg.params && msg.params.textDocument;
    const uri = doc && doc.uri;
    if (typeof uri === "string") {
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: {
        uri: uri,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "fake diag" }]
      } });
    }
  }
  if (msg.method === "exit") { process.exit(0); }
}
function declarationOnly() {
  return [{ uri: "file:///decl.ts", range: { start: { line: 1, character: 2 }, end: { line: 1, character: 6 } } }];
}
function fullRefs() {
  return declarationOnly().concat([
    { uri: "file:///use.ts", range: { start: { line: 5, character: 0 }, end: { line: 5, character: 4 } } }
  ]);
}
function onRequest(msg) {
  const m = msg.method;
  if (m === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { hoverProvider: true } } });
    return;
  }
  if (m === "shutdown") { send({ jsonrpc: "2.0", id: msg.id, result: null }); return; }
  if (m === "textDocument/hover") {
    if (SCENARIO === "malformed") {
      process.stdout.write("GARBAGE-WITHOUT-LENGTH\\r\\n\\r\\n");
      process.stdout.write("Content-Length: 8\\r\\n\\r\\n{{{{{{{{");
      send({ jsonrpc: "2.0", id: "stale-1", result: "stale" });
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { contents: { kind: "markdown", value: "**fake-hover**" } } });
    return;
  }
  if (m === "textDocument/references") {
    refsCalls++;
    if (SCENARIO === "manyRefs") {
      const manyDoc = msg.params && msg.params.textDocument;
      const manyUri = (manyDoc && manyDoc.uri) || "file:///decl.ts";
      const out = [];
      for (let line = 0; line < 12; line++) {
        out.push({ uri: manyUri, range: { start: { line: line, character: 0 }, end: { line: line, character: 4 } } });
      }
      send({ jsonrpc: "2.0", id: msg.id, result: out });
    } else if (SCENARIO === "flakyRefs" && refsCalls === 1) {
      send({ jsonrpc: "2.0", id: msg.id, result: declarationOnly() });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: fullRefs() });
    }
    return;
  }
  if (m === "textDocument/definition") {
    send({ jsonrpc: "2.0", id: msg.id, result: declarationOnly() });
    return;
  }
  if (m === "textDocument/documentSymbol") {
    send({ jsonrpc: "2.0", id: msg.id, result: [{
      name: "fakeSymbol", kind: 12, detail: "const",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
      selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }
    }] });
    return;
  }
  if (m === "textDocument/rename") {
    const renameDoc = msg.params && msg.params.textDocument;
    const renameUri = (renameDoc && renameDoc.uri) || "file:///a.ts";
    const renameTo = (msg.params && msg.params.newName) || "renamed";
    const renameChanges = {};
    renameChanges[renameUri] = [{
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
      newText: renameTo
    }];
    send({ jsonrpc: "2.0", id: msg.id, result: { changes: renameChanges } });
    return;
  }
  if (m === "workspace/symbol") {
    if (SCENARIO === "quietSymbol") return;
    send({ jsonrpc: "2.0", id: msg.id, result: [] });
    return;
  }
  if (m === "test/hang") { return; }
  if (m === "test/fail") {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom" } });
    return;
  }
  if (m === "test/probe") {
    const kind = msg.params && msg.params.kind;
    const id = "srv-" + (seq++);
    probeReplies[id] = msg.id;
    if (kind === "configuration") {
      send({ jsonrpc: "2.0", id: id, method: "workspace/configuration", params: { items: [{ section: "fake" }, { section: "fake" }] } });
    } else if (kind === "applyEdit") {
      send({ jsonrpc: "2.0", id: id, method: "workspace/applyEdit", params: { edit: {} } });
    } else if (kind === "register") {
      send({ jsonrpc: "2.0", id: id, method: "client/registerCapability", params: { registrations: [{ id: "r1", method: "textDocument/didOpen" }] } });
    } else {
      send({ jsonrpc: "2.0", id: id, method: "test/neverHeard" });
    }
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + m } });
}
function onMessage(msg) {
  if (msg && typeof msg.method === "string") note("in:" + msg.method);
  const hasId = msg && msg.id !== undefined && msg.id !== null;
  if (hasId && typeof msg.id === "string" && msg.id.indexOf("srv-") === 0 && !msg.method) {
    note("probe:" + JSON.stringify(msg.result !== undefined ? msg.result : msg.error));
    const orig = probeReplies[msg.id];
    delete probeReplies[msg.id];
    if (orig !== undefined) send({ jsonrpc: "2.0", id: orig, result: "ok" });
    return;
  }
  if (!hasId) {
    if (msg) { try { onNotify(msg); } catch (e) {} }
    return;
  }
  try { onRequest(msg); } catch (e) {
    try { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "fake blew up" } }); } catch (ignored) {}
  }
}
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const h = buf.indexOf("\\r\\n\\r\\n");
    if (h < 0) return;
    const hm = /Content-Length:\\s*(\\d+)/i.exec(buf.subarray(0, h).toString("utf8"));
    if (!hm) { buf = buf.subarray(h + 4); continue; }
    const len = parseInt(hm[1], 10);
    if (buf.length < h + 4 + len) return;
    const text = buf.subarray(h + 4, h + 4 + len).toString("utf8");
    buf = buf.subarray(h + 4 + len);
    let msg = null;
    try { msg = JSON.parse(text); } catch (e) { continue; }
    onMessage(msg);
  }
});
`;
}

// Log lines written so far; empty when the server never got that far.
export function readLogLines(logPath: string): string[] {
  try {
    return readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

// How many log lines equal the needle exactly. Exact match, not substring:
// "in:initialized" contains "in:initialize", and counting that twice would
// invent a server that never started.
export function countLogLines(lines: readonly string[], needle: string): number {
  return lines.filter((line) => line === needle).length;
}
