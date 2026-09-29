import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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

if (process.platform === "darwin") {
  await installMac();
} else if (process.platform === "linux") {
  await installLinux();
} else {
  console.error(`install:local is not supported on ${process.platform} (macOS and Linux only).`);
  process.exit(1);
}

async function installMac() {
  const built = path.join(desktopDir, "release", "mac-arm64", "Kone.app");
  const installed = "/Applications/Kone.app";

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
}

async function installLinux() {
  const builtDir = path.join(desktopDir, "release", "linux-unpacked");
  const home = os.homedir();
  const installedDir = path.join(home, ".local", "share", "Kone");
  const binDir = path.join(home, ".local", "bin");
  const binLink = path.join(binDir, "kone");
  const applicationsDir = path.join(home, ".local", "share", "applications");
  const desktopEntry = path.join(applicationsDir, "kone.desktop");

  await $`bun run package`.cwd(desktopDir);

  if (!existsSync(builtDir)) {
    console.error(`Expected packaged output at ${builtDir} (electron-builder --dir).`);
    console.error("Check apps/desktop/release/ for the actual artifact directory.");
    process.exit(1);
  }

  // Resolve the packaged executable. electron-builder defaults the Linux
  // binary name to `executableName` (set to "kone" in package.json), but older
  // artifacts used the package name ("desktop"), so probe both plus "Kone".
  // The configured name wins when present; anything else is a legacy fallback.
  const configured = await readLinuxExecutableName();
  const candidates = [...new Set([configured, "kone", "Kone", "desktop"].filter(Boolean))];
  const binaryName = candidates.find((n) => existsSync(path.join(builtDir, n as string)));
  if (!binaryName) {
    console.error(`No executable found in ${builtDir} (tried ${candidates.join(", ")}).`);
    process.exit(1);
  }

  // A running copy can't be replaced cleanly.
  await $`pkill -f ${"share/Kone/kone"}`.nothrow().quiet();
  await $`pkill -f ${"linux-unpacked/kone"}`.nothrow().quiet();
  await $`pkill -f ${"linux-unpacked/Kone"}`.nothrow().quiet();
  await $`pkill -f ${"linux-unpacked/desktop"}`.nothrow().quiet();

  console.log(`Installing to ${installedDir} ...`);
  rmSync(installedDir, { recursive: true, force: true });
  mkdirSync(installedDir, { recursive: true });
  cpSync(builtDir, installedDir, { recursive: true });
  await $`chmod +x ${path.join(installedDir, binaryName)}`.nothrow().quiet();

  // Ship an icon the .desktop entry can reference without an icon-cache update.
  const repoIcon = path.join(desktopDir, "icons", "icon.png");
  if (existsSync(repoIcon)) {
    cpSync(repoIcon, path.join(installedDir, "icon.png"));
  }

  mkdirSync(binDir, { recursive: true });
  rmSync(binLink, { force: true });
  // Symlink (not a wrapper script) so Chromium resolves its sandbox helper
  // and resources relative to the real install dir via /proc/self/exe.
  await $`ln -s ${path.join(installedDir, binaryName)} ${binLink}`;

  mkdirSync(applicationsDir, { recursive: true });
  const installedBinary = path.join(installedDir, binaryName);
  const installedIcon = existsSync(path.join(installedDir, "icon.png"))
    ? path.join(installedDir, "icon.png")
    : path.join(desktopDir, "icons", "icon.png");
  // StartupWMClass must match the `class` switch set in src/main.ts
  // (configureLinuxShell) or the window groups under the wrong taskbar icon.
  writeFileSync(
    desktopEntry,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Kone",
      "Comment=Kone desktop",
      `Exec=${installedBinary} %U`,
      `Icon=${installedIcon}`,
      "Terminal=false",
      "Categories=Development;",
      "StartupWMClass=kone",
      "",
    ].join("\n"),
  );
  await $`update-desktop-database ${applicationsDir}`.nothrow().quiet();

  console.log(`Kone installed to ${installedDir}.`);
  console.log(`Launcher: ${binLink} (ensure ~/.local/bin is on PATH).`);
  console.log(`Desktop entry: ${desktopEntry}`);
}

async function readLinuxExecutableName(): Promise<string | null> {
  try {
    const pkg = await Bun.file(path.join(desktopDir, "package.json")).json();
    const name = pkg?.build?.linux?.executableName;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}
