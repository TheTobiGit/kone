import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const rootDir = path.resolve(desktopDir, "../..");
const webDir = path.join(rootDir, "apps/web");
const bridgeDir = path.join(rootDir, "apps/bridge");
const rendererOut = path.join(desktopDir, "resources/renderer");
const bridgeOut = path.join(desktopDir, "resources/bridge");

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
await $`bun build src/main.ts --outfile dist/main.js --target node --external electron`.cwd(desktopDir);
await $`bun build src/preload.ts --outfile dist/preload.js --target node --external electron`.cwd(desktopDir);

console.log("Staging renderer assets...");
cleanDir(rendererOut);
cpSync(nuxtOutput, rendererOut, { recursive: true });

console.log("Staging bridge runtime...");
cleanDir(bridgeOut);

console.log("Attempting bridge compile (optional)...");
try {
  await $`bun build --compile src/index.ts --outfile kone-bridge`.cwd(bridgeDir);
  cpSync(path.join(bridgeDir, "kone-bridge"), path.join(bridgeOut, "kone-bridge"));
  console.log("Bridge compiled successfully.");
} catch (error) {
  console.warn(
    "Bridge compile failed; staging Bun bridge sources for runtime fallback (requires Bun on PATH).",
  );
  if (error instanceof Error) {
    console.warn(error.message);
  }

  cpSync(path.join(bridgeDir, "src"), path.join(bridgeOut, "src"), { recursive: true });

  const protocolOut = path.join(bridgeOut, "packages/bridge-protocol");
  mkdirSync(path.dirname(protocolOut), { recursive: true });
  cpSync(path.join(rootDir, "packages/bridge-protocol"), protocolOut, { recursive: true });

  const bridgePackage = JSON.parse(readFileSync(path.join(bridgeDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  bridgePackage.dependencies = {
    ...bridgePackage.dependencies,
    "@kone/bridge-protocol": "file:./packages/bridge-protocol",
  };
  writeFileSync(path.join(bridgeOut, "package.json"), `${JSON.stringify(bridgePackage, null, 2)}\n`);
  await $`bun install --production`.cwd(bridgeOut);
}

console.log("Desktop build complete.");
