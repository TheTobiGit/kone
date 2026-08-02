import { $ } from "bun";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Package kone and promote it into /Applications as a dogfood build.
//
// The mac build sets `identity: null`, so electron-builder deliberately skips
// signing — an unsigned bundle can't spawn the agent CLIs, so we ad-hoc sign
// here instead. The one rule that matters: the OUTER bundle must be signed
// LAST. Touching any file inside an already-signed bundle invalidates its seal
// ("a sealed resource is missing or invalid") and macOS then treats the whole
// app as tampered — which is exactly how the codex/claude spawning broke before.
// So: copy everything first, sign once at the end, then verify the seal held.
//
// Never ad-hoc sign the vendored agent CLIs (codex, claude) to "fix" Gatekeeper:
// they ship legitimately notarized, and re-signing strips that and triggers an
// XProtect malware block. This script deliberately touches nothing inside them.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const built = path.join(desktopDir, "release", "mac-arm64", "Kone.app");
const installed = "/Applications/Kone.app";

if (process.platform !== "darwin") {
  console.error("install:local is macOS-only.");
  process.exit(1);
}

await $`bun run package`.cwd(desktopDir);

// A running copy can't be replaced cleanly.
await $`pkill -f ${"MacOS/Kone"}`.nothrow().quiet();

console.log(`Installing to ${installed} ...`);
await $`rm -rf ${installed}`;
await $`cp -R ${built} ${installed}`;

// electron-builder signs with the Developer ID cert when one is discoverable.
// Only fall back to ad-hoc when it didn't — ad-hoc signing over a real
// Developer ID signature would downgrade the app, and an ad-hoc parent is what
// gets its spawned agent CLIs blocked by XProtect in the first place.
const signature = await $`codesign -dvvv ${installed}`.nothrow().quiet();
const signedInfo = signature.stderr.toString();
if (signedInfo.includes("Developer ID Application")) {
  console.log("Developer ID signature present — leaving it intact.");
} else {
  console.log("No Developer ID signature — ad-hoc signing ...");
  await $`codesign --force --deep --sign - ${installed}`.quiet();
}
await $`xattr -dr com.apple.quarantine ${installed}`.nothrow().quiet();

// A failed verify means the bundle would be treated as tampered — fail loudly
// rather than leave a broken app installed.
const verify = await $`codesign --verify --deep --strict ${installed}`.nothrow().quiet();
if (verify.exitCode !== 0) {
  console.error("Code seal verification FAILED:");
  console.error(verify.stderr.toString().trim());
  process.exit(1);
}

console.log("Kone installed to /Applications and sealed. Launch it to test.");
