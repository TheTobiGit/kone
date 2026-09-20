import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForUrl } from "./wait-for-url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const rootDir = path.resolve(desktopDir, "../..");
const webDir = path.join(rootDir, "apps/web");
const devServerUrl = "http://localhost:3001";

const children: ChildProcess[] = [];

/**
 * Fold the repository's `.env` into this process's environment.
 *
 * Two things make this the launcher's job rather than something the runtime
 * picks up for free. The task runner hands each task a filtered environment,
 * so a variable exported in the shell does not survive the trip; and the
 * automatic `.env` pickup reads the working directory, which is this package,
 * not the repository the file sits in. Reading the file here sidesteps both —
 * everything spawned below inherits what this sets.
 *
 * An already-set variable wins: a value put on the command line for one run is
 * the more specific instruction, and a file on disk must not quietly override
 * it. The parser is deliberately minimal — `KEY=value`, `#` comments, optional
 * surrounding quotes — because this file's job is to start the app, not to
 * implement a configuration format.
 */
function loadRootEnv(): void {
  const file = path.join(rootDir, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
}

loadRootEnv();

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  children.push(child);
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`${command} ${args.join(" ")} exited with code ${code}`);
      shutdown(code);
    }
  });

  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("Starting Kone desktop dev stack...");

run("bun", ["run", "dev"], webDir, {
  ...process.env,
  KONE_DESKTOP: "1",
});

await waitForUrl(devServerUrl);

console.log("Compiling Electron main/preload...");
// Keep the Claude Agent SDK external — it resolves its own native `claude` CLI
// binary relative to its real node_modules location, so bundling it (which moves
// the import.meta.url anchor) breaks that resolution at runtime. See build.ts.
// node-pty is also kept external because it loads native .node extensions at runtime.
// @ast-grep/napi stays external for the same reason: its loader requires the
// platform .node binary relative to its real node_modules location. See build.ts.
const compileMain = spawnSync(
  "bun",
  [
    "build",
    "src/main.ts",
    "--outfile",
    "dist/main.js",
    "--target",
    "node",
    "--external",
    "electron",
    "--external",
    "@anthropic-ai/claude-agent-sdk",
    "--external",
    "node-pty",
    "--external",
    "@ast-grep/napi",
  ],
  { cwd: desktopDir, stdio: "inherit" },
);
// Sandboxed preloads must be CommonJS; emit .cjs so it's unambiguous under
// package.json "type": "module".
const compilePreload = spawnSync(
  "bun",
  ["build", "src/preload.ts", "--outfile", "dist/preload.cjs", "--format", "cjs", "--target", "node", "--external", "electron"],
  { cwd: desktopDir, stdio: "inherit" },
);

if (compileMain.status !== 0 || compilePreload.status !== 0) {
  shutdown(compileMain.status ?? compilePreload.status ?? 1);
}

// The stdio→HTTP MCP proxy is a plain runtime asset (not bundled — injection.ts
// resolves it relative to the bundle, so it must sit next to dist/main.js).
cpSync(
  path.join(rootDir, "packages/agent-core/src/gateway/stdioProxy.mjs"),
  path.join(desktopDir, "dist/stdioProxy.mjs"),
);

const mainEntry = path.join(desktopDir, "dist/main.js");
if (!existsSync(mainEntry)) {
  console.error(`Expected Electron entry at ${mainEntry} after compile.`);
  shutdown(1);
}

run("bunx", ["electron", "."], desktopDir, {
  ...process.env,
  KONE_DEV: "1",
  KONE_DEV_SERVER_URL: devServerUrl,
});
