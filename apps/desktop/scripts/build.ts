import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const rootDir = path.resolve(desktopDir, "../..");
const webDir = path.join(rootDir, "apps/web");
const rendererOut = path.join(desktopDir, "resources/renderer");

function cleanDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

console.log("Building Nuxt renderer for desktop...");
await $`bun run build:desktop`.cwd(webDir).env({
  ...process.env,
  KONE_DESKTOP: "1",
});

const nuxtOutput = path.join(webDir, ".output/public");
if (!existsSync(path.join(nuxtOutput, "index.html"))) {
  throw new Error(`Expected Nuxt static output at ${nuxtOutput}`);
}

console.log("Bundling Electron main/preload...");
// The Claude Agent SDK must stay external: it locates its own native `claude`
// CLI binary via `createRequire(import.meta.url).resolve(...)`, so it has to run
// from its real node_modules location. Bundling it into dist/main.js moves that
// anchor and the sibling native-binary package (@anthropic-ai/claude-agent-sdk-*)
// becomes unresolvable at runtime ("Native CLI binary not found").
await $`bun build src/main.ts --outfile dist/main.js --target node --external electron --external @anthropic-ai/claude-agent-sdk`.cwd(
  desktopDir,
);
// Sandboxed preloads must be CommonJS; emit .cjs so it's unambiguous under
// package.json "type": "module".
await $`bun build src/preload.ts --outfile dist/preload.cjs --format cjs --target node --external electron`.cwd(desktopDir);

console.log("Staging renderer assets...");
cleanDir(rendererOut);
cpSync(nuxtOutput, rendererOut, { recursive: true });

console.log("Desktop build complete.");
