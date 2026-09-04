import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yauzl from "yauzl";

import { writeFileAtomicSync } from "@kone/agent-core/lib-atomicWrite.js";

import {
  resolveAntigravityAcpManagedDir,
  readAntigravityAcpActiveRecord,
  type AntigravityAcpResolvedBinary,
} from "./antigravityAcpBinary.js";
import {
  ANTIGRAVITY_ACP_RELEASE_VERSION,
  resolveAntigravityReleaseAsset,
} from "./antigravityRelease.js";

// Managed download of the official Antigravity ACP server: fetch the release
// zip, verify its SHA-256 and size, extract exactly the two shipped files, and
// flip the managed dir's active.json pointer once the bytes on disk are
// verified. Nothing unverified is ever launched — a mismatch discards the
// download instead.
//
// Layout inside `<managedDir>/`: `<version>/agy_acp_server[.exe]` +
// `<version>/localharness_external[.exe]` plus the atomic `active.json`
// `{ version, executable, harness }` the binary resolver reads. Only the
// current version is kept; superseded ones are pruned best-effort.

const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const PROGRESS_REPORT_BYTES = 32 * 1024 * 1024;

export type AntigravityInstallProgress = {
  readonly downloadedBytes: number;
  readonly totalBytes: number;
};

type FetchImpl = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/** Which managed version is installed for this host, if any and verified. */
export function installedAntigravityAcpVersion(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const managedDir = resolveAntigravityAcpManagedDir(userDataDir, platform, arch);
  const active = readAntigravityAcpActiveRecord(managedDir);
  if (!active) return null;
  if (
    !fs.existsSync(path.join(managedDir, active.executable)) ||
    !fs.existsSync(path.join(managedDir, active.harness))
  ) {
    return null;
  }
  return active.version;
}

/** True when the managed runtime for this host is installed and current. */
export function isAntigravityAcpRuntimeCurrent(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return installedAntigravityAcpVersion(userDataDir, platform, arch) === ANTIGRAVITY_ACP_RELEASE_VERSION;
}

const inFlight = new Map<string, Promise<AntigravityAcpResolvedBinary>>();

/** Download + install the managed ACP server for this host (single-flight per
 *  managed dir, so concurrent callers share one download). Resolves to the
 *  verified executable + harness. Throws when no runtime is published for the
 *  host, the download fails, or verification rejects the bytes. */
export function ensureAntigravityAcpRuntime(
  userDataDir: string,
  options: {
    platform?: NodeJS.Platform;
    arch?: string;
    fetchImpl?: FetchImpl;
    onProgress?: (progress: AntigravityInstallProgress) => void;
  } = {},
): Promise<AntigravityAcpResolvedBinary> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const managedDir = resolveAntigravityAcpManagedDir(userDataDir, platform, arch);
  const cached = inFlight.get(managedDir);
  if (cached) return cached;
  const run = installAntigravityAcpRuntime(userDataDir, {
    platform,
    arch,
    fetchImpl: options.fetchImpl,
    onProgress: options.onProgress,
  }).finally(() => {
    if (inFlight.get(managedDir) === run) inFlight.delete(managedDir);
  });
  inFlight.set(managedDir, run);
  return run;
}

async function installAntigravityAcpRuntime(
  userDataDir: string,
  options: {
    platform: NodeJS.Platform;
    arch: string;
    fetchImpl?: FetchImpl;
    onProgress?: (progress: AntigravityInstallProgress) => void;
  },
): Promise<AntigravityAcpResolvedBinary> {
  const { platform, arch } = options;
  const asset = resolveAntigravityReleaseAsset(platform, arch);
  if (!asset) {
    throw new Error(
      `No managed Antigravity ACP runtime is published for ${platform}-${arch}. Point the Antigravity binary path at a manual install instead.`,
    );
  }
  const managedDir = resolveAntigravityAcpManagedDir(userDataDir, platform, arch);
  const active = readAntigravityAcpActiveRecord(managedDir);
  if (active?.version === asset.version) {
    const executablePath = path.join(managedDir, active.executable);
    const harnessPath = path.join(managedDir, active.harness);
    if (fs.existsSync(executablePath) && fs.existsSync(harnessPath)) {
      return { executablePath, harnessPath, source: "managed" };
    }
  }

  const versionDir = path.join(managedDir, asset.version);
  await fs.promises.mkdir(versionDir, { recursive: true });
  const archivePath = path.join(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), "kone-antigravity-dl-")),
    "runtime.zip",
  );
  try {
    await downloadToFile(asset.url, archivePath, asset.archiveBytes, options);
    verifyArchiveSize(archivePath, asset.archiveBytes);
    await verifyFileSha256(archivePath, asset.sha256);
    await extractRuntimeArchive(archivePath, versionDir, platform, asset.executable.name, asset.harness.name);
    verifyExtractedSizes(versionDir, platform, asset.executable, asset.harness);
  } finally {
    await fs.promises.rm(path.dirname(archivePath), { recursive: true, force: true });
  }

  const executable = `${asset.version}/${asset.executable.name}`;
  const harness = `${asset.version}/${asset.harness.name}`;
  writeFileAtomicSync(
    path.join(managedDir, "active.json"),
    JSON.stringify({ version: asset.version, executable, harness }, null, 2),
  );
  pruneSupersededVersions(managedDir, asset.version);
  return {
    executablePath: path.join(managedDir, executable),
    harnessPath: path.join(managedDir, harness),
    source: "managed",
  };
}

async function downloadToFile(
  url: string,
  destPath: string,
  totalBytes: number,
  options: { fetchImpl?: FetchImpl; onProgress?: (progress: AntigravityInstallProgress) => void },
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Antigravity ACP download failed with status ${response.status}.`);
    }
    const file = fs.createWriteStream(destPath);
    let downloadedBytes = 0;
    let lastReport = 0;
    try {
      // SAFETY: fetch Response bodies are async-iterable byte streams; each
      // chunk is a Uint8Array handed to the file write below.
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        await new Promise<void>((resolve, reject) => {
          if (!file.write(chunk, (error) => (error ? reject(error) : resolve()))) {
            file.once("drain", () => resolve());
          }
        });
        downloadedBytes += chunk.byteLength;
        if (downloadedBytes - lastReport >= PROGRESS_REPORT_BYTES) {
          lastReport = downloadedBytes;
          options.onProgress?.({ downloadedBytes, totalBytes });
        }
      }
    } finally {
      await new Promise<void>((resolve) => file.close(() => resolve()));
    }
    options.onProgress?.({ downloadedBytes, totalBytes });
  } catch (error) {
    await fs.promises.rm(destPath, { force: true });
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

function verifyArchiveSize(archivePath: string, expectedBytes: number): void {
  const actual = fs.statSync(archivePath).size;
  if (actual !== expectedBytes) {
    throw new Error(
      `Antigravity ACP download failed verification: expected ${expectedBytes} bytes, got ${actual}.`,
    );
  }
}

async function verifyFileSha256(filePath: string, expectedHex: string): Promise<void> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    // SAFETY: chunks from a file stream are Buffers; hash.update accepts them.
    hash.update(chunk as Buffer);
  }
  const actual = hash.digest("hex");
  if (actual !== expectedHex.toLowerCase()) {
    throw new Error("Antigravity ACP download failed verification: SHA-256 mismatch.");
  }
}

/** Extract exactly the two shipped entries; anything else in the archive is
 *  ignored, and path separators in entry names never escape the version dir. */
async function extractRuntimeArchive(
  archivePath: string,
  versionDir: string,
  platform: NodeJS.Platform,
  executableName: string,
  harnessName: string,
): Promise<void> {
  const wanted = new Set([executableName, harnessName]);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) reject(error ?? new Error("Could not open runtime archive."));
      else resolve(zipFile);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", () => resolve());
      zip.on("entry", (entry: yauzl.Entry) => {
        const base = path.basename(entry.fileName);
        if (!wanted.has(base)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error ?? new Error(`Could not read ${base} from runtime archive.`));
            return;
          }
          const dest = path.join(versionDir, base);
          const out = fs.createWriteStream(dest, { mode: platform === "win32" ? 0o666 : 0o755 });
          out.on("error", reject);
          out.on("finish", () => zip.readEntry());
          stream.on("error", reject);
          stream.pipe(out);
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

function verifyExtractedSizes(
  versionDir: string,
  platform: NodeJS.Platform,
  executable: { name: string; bytes: number },
  harness: { name: string; bytes: number },
): void {
  for (const file of [executable, harness]) {
    const filePath = path.join(versionDir, file.name);
    let size = -1;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      size = -1;
    }
    if (size !== file.bytes) {
      throw new Error(
        `Antigravity ACP runtime failed verification: ${file.name} expected ${file.bytes} bytes, got ${size < 0 ? "missing" : size}.`,
      );
    }
    if (platform !== "win32") {
      try {
        fs.chmodSync(filePath, 0o755);
      } catch {
        // Best-effort: the file is usable when the umask already allowed exec.
      }
    }
  }
}

/** Drop version dirs older than the active one. Best-effort — a failure just
 *  leaves the old bytes for the next install to prune. */
function pruneSupersededVersions(managedDir: string, currentVersion: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(managedDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === currentVersion || entry === "active.json") continue;
    if (entry.startsWith(".") || entry.includes("/") || entry.includes("\\")) continue;
    const candidate = path.join(managedDir, entry);
    try {
      if (fs.statSync(candidate).isDirectory()) {
        fs.rmSync(candidate, { recursive: true, force: true });
      }
    } catch {
      // Leave it; the next install retries.
    }
  }
}

/** Remove the managed runtime for this host. The caller must refuse while the
 *  runtime is in use (live sessions hold the executable open). Keeps Google
 *  credentials, thread history and files — only the downloaded bytes go. */
export async function removeAntigravityAcpRuntime(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<void> {
  await fs.promises.rm(resolveAntigravityAcpManagedDir(userDataDir, platform, arch), {
    recursive: true,
    force: true,
  });
}
