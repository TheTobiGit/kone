import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForUrl } from "./wait-for-url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const rootDir = path.resolve(desktopDir, "../..");
const webDir = path.join(rootDir, "apps/web");
const devServerUrl = "http://localhost:3001";

const children: ChildProcess[] = [];

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
