import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ProcessSupervisor, createLaunchTools } from "./launch.js";
import { createRegistry } from "../registry.js";
import type { GatewayRecord, GatewayToolContext } from "../schemas.js";
import { GatewayToolError } from "../schemas.js";

/** Supervised processes are namespaced per project root; tests share one. */
const SCOPE = process.cwd();

/** kone_launch is `permission: "ask"`; most cases here exercise what happens
 *  after a human has cleared it. */
const approveAll = async () => true;

function makeCtx(overrides: Partial<GatewayToolContext> = {}): GatewayToolContext {
  return {
    threadId: "thread-test",
    turnId: "turn-test",
    provider: "claudeAgent",
    model: "claude-3-7-sonnet",
    cwd: process.cwd(),
    requestId: 1,
    ...overrides,
  };
}

describe("ProcessSupervisor", () => {
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    supervisor = new ProcessSupervisor();
  });

  afterEach(async () => {
    await supervisor.stopAll();
  });

  it("starts a process, collects logs, and stops it cleanly", async () => {
    const result = await supervisor.start({
      scope: SCOPE,
      name: "echo-worker",
      command: "node",
      args: [
        "-e",
        "console.log('Worker started'); setTimeout(() => console.log('second-line'), 50); setInterval(() => {}, 1000);",
      ],
      ready: { log: "second-line", timeout: 5 },
    });

    expect(result.status).toBe("running");
    expect(result.ready).toBe(true);
    expect(Number.isFinite(result.pid)).toBe(true);

    const logResult = await supervisor.logs({
      scope: SCOPE,
      name: "echo-worker", lines: 10 });
    expect(logResult.logs.length).toBeGreaterThanOrEqual(2);
    expect(logResult.logs.some((l) => l.text.includes("Worker started"))).toBe(true);

    const stopped = await supervisor.stop(SCOPE, "echo-worker", "SIGTERM", 3);
    expect(stopped).toBe(true);
    const proc = supervisor.get(SCOPE, "echo-worker");
    expect(proc?.status).toBe("stopped");
  });

  it("fails early and stops process when command is ENOENT", async () => {
    await expect(
      supervisor.start({
      scope: SCOPE,
        name: "bad-bin",
        command: "definitely-nonexistent-command-12345",
      }),
    ).rejects.toThrow(GatewayToolError);

    const proc = supervisor.get(SCOPE, "bad-bin");
    expect(proc?.status).toBe("failed");

    // Retrying with same name should not throw "already running"
    await expect(
      supervisor.start({
      scope: SCOPE,
        name: "bad-bin",
        command: "definitely-nonexistent-command-12345",
      }),
    ).rejects.toThrow(GatewayToolError);
  });

  it("fails and terminates process when ready condition times out, allowing immediate retry", async () => {
    await expect(
      supervisor.start({
      scope: SCOPE,
        name: "timeout-proc",
        command: "node",
        args: ["-e", "console.log('hi'); setInterval(() => {}, 1000);"],
        ready: { log: "never-matches-pattern-xyz", timeout: 1 },
      }),
    ).rejects.toThrow(GatewayToolError);

    const proc = supervisor.get(SCOPE, "timeout-proc");
    expect(proc?.status).toBe("failed");

    // Immediate retry on the same name should not hit "already running"
    const okResult = await supervisor.start({
      scope: SCOPE,
      name: "timeout-proc",
      command: "node",
      args: ["-e", "console.log('READY NOW'); setInterval(() => {}, 1000);"],
      ready: { log: "READY NOW", timeout: 5 },
    });
    expect(okResult.status).toBe("running");
    expect(okResult.ready).toBe(true);
  });

  it("waits for TCP port readiness before resolving start", async () => {
    const port = 49152 + Math.floor(Math.random() * 10000);
    const result = await supervisor.start({
      scope: SCOPE,
      name: "port-server",
      command: "node",
      args: [
        "-e",
        `const http = require('http'); const server = http.createServer((req, res) => res.end('ok')); setTimeout(() => server.listen(${port}, '127.0.0.1'), 100); setInterval(() => {}, 1000);`,
      ],
      ready: { port, timeout: 5 },
    });

    expect(result.status).toBe("running");
    expect(result.ready).toBe(true);
  });

  it("supports sending stdin input and following logs in real time", async () => {
    const result = await supervisor.start({
      scope: SCOPE,
      name: "stdin-worker",
      command: "node",
      args: [
        "-e",
        "console.log('READY'); const readline = require('readline').createInterface({ input: process.stdin }); readline.on('line', (line) => console.log('GOT:' + line));",
      ],
      ready: { log: "READY", timeout: 5 },
    });
    expect(result.ready).toBe(true);

    // Start follow logs in background
    const followPromise = supervisor.logs({
      scope: SCOPE,
      name: "stdin-worker",
      follow: true,
      cursor: 1,
      lines: 5,
      timeout: 3,
    });

    // Send input to trigger output
    const sent = supervisor.send(SCOPE, "stdin-worker", "hello-supervisor", true);
    expect(sent).toBe(true);

    const followResult = await followPromise;
    expect(followResult.logs.some((l) => l.text.includes("GOT:hello-supervisor"))).toBe(true);
  });

  it("restarts a running process cleanly without duplicate conflict", async () => {
    await supervisor.start({
      scope: SCOPE,
      name: "restartable",
      command: "node",
      args: ["-e", "console.log('RUNNING 1'); setInterval(() => {}, 1000);"],
      ready: { log: "RUNNING 1", timeout: 5 },
    });

    const restarted = await supervisor.restart(SCOPE, "restartable", 2);
    expect(restarted.status).toBe("running");
    expect(restarted.ready).toBe(true);
  });

  it("lists supervised processes with correct metadata", async () => {
    await supervisor.start({
      scope: SCOPE,
      name: "quick-proc",
      command: "node",
      args: ["-e", "console.log('done'); setInterval(() => {}, 1000);"],
      ready: { log: "done", timeout: 5 },
    });

    const list = supervisor.list(SCOPE);
    expect(list.some((p) => p.name === "quick-proc")).toBe(true);
    const item = supervisor.get(SCOPE, "quick-proc");
    expect(item).toBeDefined();
    expect(item?.command).toBe("node");
  });

  it("namespaces processes per scope so one project cannot reach another's", async () => {
    const other = "/some/other/project";

    await supervisor.start({
      scope: SCOPE,
      name: "dev",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
    });

    // Same name under a different project root is a different process, not a conflict.
    await supervisor.start({
      scope: other,
      name: "dev",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
    });

    expect(supervisor.get(SCOPE, "dev")?.pid).not.toBe(supervisor.get(other, "dev")?.pid);

    // Neither scope sees the other's processes.
    expect(supervisor.list(SCOPE).map((p) => p.name)).toEqual(["dev"]);
    expect(supervisor.list(other).map((p) => p.name)).toEqual(["dev"]);

    // Reads and writes aimed at a name in the wrong scope find nothing.
    expect(supervisor.get("/third/project", "dev")).toBeUndefined();
    expect(await supervisor.stop("/third/project", "dev")).toBe(false);
    expect(() => supervisor.send("/third/project", "dev", "x")).toThrow(GatewayToolError);
    await expect(supervisor.logs({ scope: "/third/project", name: "dev" })).rejects.toThrow(
      GatewayToolError,
    );

    // Stopping one scope leaves the other running.
    expect(await supervisor.stop(SCOPE, "dev")).toBe(true);
    expect(supervisor.get(other, "dev")?.status).toBe("running");
  });
});

describe("Launch gateway tool", () => {
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    supervisor = new ProcessSupervisor();
  });

  afterEach(async () => {
    await supervisor.stopAll(1);
  });

  it("dispatches launch tool calls through registry", async () => {
    const tools = createLaunchTools({ supervisor });
    const registry = createRegistry(tools, { approve: approveAll });

    const startResult = await registry.call(makeCtx(), "kone_launch", {
      op: "start",
      name: "test-node",
      command: "node",
      args: ["-e", "console.log('Ready pattern'); setInterval(() => {}, 1000);"],
      ready: { log: "Ready pattern", timeout: 5 },
    });

    expect(startResult.isError).toBeFalsy();
    expect(startResult.content[0].text).toContain("Started process");

    const statusResult = await registry.call(makeCtx({ turnId: null }), "kone_launch", {
      op: "status",
      name: "test-node",
    });
    expect(statusResult.isError).toBeFalsy();
    expect(statusResult.content[0].text).toContain("status=");

    const listResult = await registry.call(makeCtx({ turnId: null }), "kone_launch", {
      op: "list",
    });
    expect(listResult.isError).toBeFalsy();

    const stopResult = await registry.call(makeCtx(), "kone_launch", {
      op: "stop",
      name: "test-node",
    });
    expect(stopResult.isError).toBeFalsy();
    expect(stopResult.content[0].text).toContain("Stopped process");
  });

  it("refuses mutating launch actions when no active turn is live", async () => {
    const tools = createLaunchTools({ supervisor });
    const registry = createRegistry(tools, { approve: approveAll });

    const result = await registry.call(makeCtx({ turnId: null }), "kone_launch", {
      op: "start",
      command: "node",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({
      code: "capability_denied",
    });
  });

  it("rejects cwd that escapes project root", async () => {
    const tools = createLaunchTools({ supervisor });
    const registry = createRegistry(tools, { approve: approveAll });

    const result = await registry.call(makeCtx({ cwd: "/tmp/project" }), "kone_launch", {
      op: "start",
      command: "node",
      cwd: "../../etc",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({
      code: "permission_denied",
    });
  });
});

describe("kone_launch approval gate", () => {
  const tools = createLaunchTools({ supervisor: new ProcessSupervisor() });
  const startArgs = { op: "start", command: "node", args: ["-e", "0"], name: "gated" };

  it("is advertised as requiring approval", () => {
    expect(tools.find((t) => t.name === "kone_launch")?.permission).toBe("ask");
  });

  it("refuses to run when the session has no approval channel", async () => {
    const registry = createRegistry(tools);
    const result = await registry.call(makeCtx(), "kone_launch", startArgs);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("permission_denied");
  });

  it("refuses to run when the user declines", async () => {
    const registry = createRegistry(tools, { approve: async () => false });
    const result = await registry.call(makeCtx(), "kone_launch", startArgs);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not approved");
  });

  it("shows the user the validated command before it runs", async () => {
    const seen: unknown[] = [];
    const registry = createRegistry(tools, {
      approve: async (req) => {
        seen.push(req);
        return false;
      },
    });
    await registry.call(makeCtx({ threadId: "thread-9" }), "kone_launch", startArgs);

    expect(seen.length).toBe(1);
    // SAFETY: Approval callback pushes approval request object with known shape
    const req = seen[0] as { threadId: string; toolName: string; args: GatewayRecord };
    expect(req.threadId).toBe("thread-9");
    expect(req.toolName).toBe("kone_launch");
    expect(req.args.command).toBe("node");
  });

  it("still refuses a denied call that is otherwise valid, without starting anything", async () => {
    const supervisor = new ProcessSupervisor();
    const registry = createRegistry(createLaunchTools({ supervisor }), {
      approve: async () => false,
    });
    await registry.call(makeCtx(), "kone_launch", startArgs);

    expect(supervisor.list(process.cwd()).length).toBe(0);
  });
});
