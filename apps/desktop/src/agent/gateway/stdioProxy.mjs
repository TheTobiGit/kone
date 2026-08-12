// kone agent gateway stdio→HTTP MCP proxy (docs/mcp-gateway-design.md §3/§4).
//
// The ACP fallback for Cursor/Droid sessions whose agent does not advertise
// agentGateway/stdioProxyScript.ts — mechanics borrowed verbatim, branded for
// kone). The provider CLI spawns this script as an MCP stdio server; every
// newline-delimited JSON-RPC message on stdin is POSTed to the loopback HTTP
// gateway, and the JSON response is written back as one NDJSON line.
//
// Token delivery without leaking into the provider process env: the
// per-session bearer arrives via `KONE_GATEWAY_TOKEN`, set ONLY in this
// proxy's own spawn env (the ACP `mcpServers[].env` array). kone's provider
// env builders (buildCursorEnv / buildDroidEnv) never include it, so the CLI
// process env — and therefore every exec-tool subprocess the agent spawns —
// never sees the token. The proxy holds it in memory only.
//
// which the comment below anticipated): Antigravity's MCP config lives in a
// GLOBAL plugin on disk, so it must be secret-free — no token anywhere in the
// plugin file. Instead the CLI's process env carries `KONE_GATEWAY_URL` plus
// a single-use `KONE_GATEWAY_BOOTSTRAP_TOKEN`, and the plugin spawns this
// proxy with those two; the proxy exchanges the bootstrap at
// `POST <url>/bootstrap` for the real session token, which exists only in
// this process's memory. A bootstrap leaked to an exec-tool subprocess is
// spent after exactly one exchange.
//
// Self-bootstrap for packaged builds: the ACP entry's `command` is
// `process.execPath` — a packaged Electron binary in production. Electron
// won't run a plain script without `ELECTRON_RUN_AS_NODE=1`, so when we
// detect the Electron runtime without that flag we re-exec ourselves with it
// set, then exit. The env array in the ACP entry stays exactly the two
// kone vars (matching the design doc's shape); the flag lives inside the
// script instead of the entry.
//
// Dependency-free (fetch / AbortController / URL / setTimeout().unref()), so
// it runs on whichever node/bun/runtime backs `process.execPath`.

import { spawn } from "node:child_process";

if (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== "1") {
  const child = spawn(process.execPath, process.argv.slice(1), {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  });
  child.on("error", () => process.exit(1));
  process.exit(0);
}

const url = process.env.KONE_GATEWAY_URL;
let token = process.env.KONE_GATEWAY_TOKEN;
const bootstrapToken = process.env.KONE_GATEWAY_BOOTSTRAP_TOKEN;
const active = Boolean(url && (token || bootstrapToken));

const BOOTSTRAP_TIMEOUT_MS = 5000;
let tokenResolution;
let bootstrapController;
let bootstrapTimeout;
const activeRequests = new Map();
const activeControllers = new Set();
const inFlight = new Set();
let outputQueue = Promise.resolve();

async function resolveToken() {
  if (token) return token;
  if (!url || !bootstrapToken) return null;
  if (!tokenResolution) {
    const controller = new AbortController();
    bootstrapController = controller;
    bootstrapTimeout = setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS);
    bootstrapTimeout.unref?.();
    tokenResolution = (async () => {
      const bootstrapUrl = new URL(url);
      bootstrapUrl.pathname = bootstrapUrl.pathname.replace(/\/$/, "") + "/bootstrap";
      bootstrapUrl.search = "";
      bootstrapUrl.hash = "";
      const response = await fetch(bootstrapUrl, {
        method: "POST",
        headers: { Authorization: "Bearer " + bootstrapToken },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error("kone gateway bootstrap failed with HTTP " + response.status);
      }
      const payload = await response.json();
      if (!isRecord(payload) || typeof payload.bearerToken !== "string") {
        throw new Error("kone gateway bootstrap returned an invalid response");
      }
      token = payload.bearerToken;
      return token;
    })().finally(() => {
      if (bootstrapController === controller) bootstrapController = undefined;
      if (bootstrapTimeout) clearTimeout(bootstrapTimeout);
      bootstrapTimeout = undefined;
    });
    // Begin the exchange before the provider can process a prompt or launch
    // command descendants. Keep the rejection observed even if no JSON-RPC
    // request has arrived yet; the first request receives the same failure.
    tokenResolution.catch(() => undefined);
  }
  return tokenResolution;
}

if (active && !token && bootstrapToken) {
  void resolveToken().catch(() => undefined);
}

function writeMessage(message) {
  outputQueue = outputQueue.then(() => {
    process.stdout.write(JSON.stringify(message) + "\n");
  });
  return outputQueue;
}

function requestKey(id) {
  return typeof id === "string" || typeof id === "number" ? `${typeof id}:${String(id)}` : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestKeyForMessage(message) {
  if (!isRecord(message)) return null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return null;
  return requestKey(message.id);
}

function cancelledRequestKey(message) {
  if (
    !isRecord(message) ||
    "id" in message ||
    message.jsonrpc !== "2.0" ||
    message.method !== "notifications/cancelled" ||
    !isRecord(message.params)
  ) {
    return null;
  }
  return requestKey(message.params.requestId);
}

/** No credentials (e.g. the script run by hand, or a session that lost its
 *  token): answer as a valid-but-empty MCP server rather than a noisy failure. */
function localInactiveResponse(message) {
  const id = isRecord(message) && "id" in message ? message.id : undefined;
  if (id === undefined) return [];
  if (message.method === "initialize") {
    return [
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: message.params?.protocolVersion || 1,
          capabilities: { tools: {} },
          serverInfo: { name: "kone", version: "0.1.0" },
        },
      },
    ];
  }
  if (message.method === "ping") {
    return [{ jsonrpc: "2.0", id, result: {} }];
  }
  if (message.method === "tools/list") {
    return [{ jsonrpc: "2.0", id, result: { tools: [] } }];
  }
  return [
    {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "kone gateway is not active for this session." },
    },
  ];
}

async function forwardMessage(message, controller) {
  const hasId = isRecord(message) && "id" in message;
  const id = hasId ? message.id : null;
  if (!active) {
    return localInactiveResponse(message);
  }
  try {
    const resolvedToken = await resolveToken();
    if (!resolvedToken) return localInactiveResponse(message);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer " + resolvedToken,
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    if (response.status === 202) {
      // Accepted-async: the gateway owns the outcome; nothing to write back.
      return [];
    }
    const payload = await response.json();
    const messages = Array.isArray(payload) ? payload : [payload];
    return messages.filter((value) => value && typeof value === "object");
  } catch (error) {
    if (controller.signal.aborted || !hasId) return [];
    return [
      {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "kone gateway request failed: " + String(error) },
      },
    ];
  }
}

function startForward(message) {
  const controller = new AbortController();
  const key = requestKeyForMessage(message);
  // Keep the first owner of an in-flight id. A duplicate request is still
  // forwarded, but it must never steal the cancellation route from the
  // original long-running call.
  if (key !== null && !activeRequests.has(key)) activeRequests.set(key, controller);
  activeControllers.add(controller);
  const task = forwardMessage(message, controller).finally(() => {
    activeControllers.delete(controller);
    if (key !== null && activeRequests.get(key) === controller) {
      activeRequests.delete(key);
    }
  });
  return task;
}

function track(task) {
  inFlight.add(task);
  task.then(
    () => inFlight.delete(task),
    () => inFlight.delete(task),
  );
}

function handleLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0) {
    return writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
  }

  // Register every request before applying cancellations, so a cancellation
  // embedded in the same batch is immediate regardless of entry order.
  const forwards = messages.map((message) => startForward(message));
  for (const message of messages) {
    const key = cancelledRequestKey(message);
    if (key !== null) activeRequests.get(key)?.abort();
  }

  return Promise.all(forwards).then((responseGroups) => {
    const responses = responseGroups.flat();
    if (responses.length === 0) return;
    return writeMessage(Array.isArray(parsed) ? responses : responses[0]);
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line.length > 0) {
      // JSON-RPC responses may arrive out of order. Keeping each forward
      // independent lets cancellation and ping bypass a slow tool call.
      track(Promise.resolve(handleLine(line)));
    }
  }
});
process.stdin.on("end", async () => {
  // Give short responses one event-loop turn to reach the gateway, then abort
  // anything still hung.
  bootstrapController?.abort();
  await Promise.race([
    Promise.allSettled(Array.from(inFlight)),
    new Promise((resolve) => setTimeout(resolve, 100)),
  ]);
  for (const controller of activeControllers) controller.abort();
  await Promise.allSettled(Array.from(inFlight));
  await outputQueue.catch(() => undefined);
  process.exit(0);
});
