// The official Antigravity ACP server release kone drives for its ACP
// transport: a versioned executable plus its local-harness helper, shipped per
// platform as a zip. One entry per supported host; anything else reports
// "no managed runtime for this machine" and falls back to an explicit binary
// path or PATH lookup (see antigravityAcpBinary.ts).
//
// The hashes and byte sizes pin exactly what gets executed: a download whose
// bytes or extracted files differ is discarded, never launched.

export const ANTIGRAVITY_ACP_RELEASE_VERSION = "agy_acp_server_1.1.1";

export type AntigravityReleaseAsset = {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly executable: { readonly name: string; readonly bytes: number };
  readonly harness: { readonly name: string; readonly bytes: number };
};

const RELEASE_ASSETS: Readonly<Record<string, AntigravityReleaseAsset>> = {
  "darwin-arm64": {
    version: ANTIGRAVITY_ACP_RELEASE_VERSION,
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip",
    sha256: "fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189",
    archiveBytes: 316_014_828,
    executable: { name: "agy_acp_server.par", bytes: 802_163_856 },
    harness: { name: "localharness_external", bytes: 116_766_704 },
  },
  "linux-x64": {
    version: ANTIGRAVITY_ACP_RELEASE_VERSION,
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip",
    sha256: "38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df",
    archiveBytes: 681_969_407,
    executable: { name: "agy_acp_server.par", bytes: 1_880_360_328 },
    harness: { name: "localharness_external", bytes: 128_966_920 },
  },
  "linux-arm64": {
    version: ANTIGRAVITY_ACP_RELEASE_VERSION,
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip",
    sha256: "ed69e64b308fcb123ab54bf3277bf9cb0d651064f885ea5aab0ff520c7175398",
    archiveBytes: 656_572_786,
    executable: { name: "agy_acp_server.par", bytes: 1_862_073_131 },
    harness: { name: "localharness_external", bytes: 122_158_704 },
  },
  "win32-x64": {
    version: ANTIGRAVITY_ACP_RELEASE_VERSION,
    url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip",
    sha256: "47cb50eef14f0a4655d78cfcfda869bcea7aaee5f9787e936bc2935ea612c3b8",
    archiveBytes: 468_238_392,
    executable: { name: "agy_acp_server.exe", bytes: 430_801_616 },
    harness: { name: "localharness_external.exe", bytes: 130_971_800 },
  },
  "win32-arm64": {
    version: ANTIGRAVITY_ACP_RELEASE_VERSION,
    url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip",
    sha256: "35f4b1f47ba6a3fea7b0a3e30010df5ea73a64b4f0e7cf991cddc673ddfbcafc",
    archiveBytes: 468_521_191,
    executable: { name: "agy_acp_server.exe", bytes: 435_075_816 },
    harness: { name: "localharness_external.exe", bytes: 122_455_704 },
  },
};

/** Normalize Node's arch spelling to the release table's key segment. */
function archKey(arch: string): string {
  if (arch === "arm64") return "arm64";
  if (arch === "x64" || arch === "x86_64") return "x64";
  return arch;
}

/** The managed ACP server asset for this machine, or null when the table has
 *  no build for it (Intel Macs have no published runtime). Null is a normal
 *  answer, not an error — the caller falls through to explicit-path / PATH. */
export function resolveAntigravityReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): AntigravityReleaseAsset | null {
  return RELEASE_ASSETS[`${platform}-${archKey(arch)}`] ?? null;
}
