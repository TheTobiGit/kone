/**
 * Community themes from Open VSX — the Eclipse Foundation's public registry
 * for VS Code extensions, browsed and imported without an account.
 *
 * The flow mirrors the file import (parse the theme file, grow a kone palette)
 * but the input arrives differently: a search on the registry, a per-extension
 * detail fetch, then the extension package itself (a VSIX, i.e. a zip) from
 * which the theme files are extracted. Everything between fetch and palette is
 * distrust: the package is size-capped, its zip directory inspected before any
 * entry is read, paths are normalised so nothing can escape the archive, the
 * sha256 published by the registry is re-computed, the manifest inside must
 * match the one the registry advertised (identity, version, license), and only
 * extensions under a permissive open-source license are offered at all.
 */
import JSZip from "jszip";
import { parse, type ParseError } from "jsonc-parser";
import {
  buildImportedThemes,
  isRecord,
  isVsCodeThemeFile,
  parseVsCodeThemeEntry,
  type ThemeJsonObject,
  type VsCodeImportEntry,
} from "./import-vscode";
import type { ThemeDefinition, ThemeScheme } from "./roles";

const OPEN_VSX_SEARCH_URL = "https://open-vsx.org/api/-/search";
const MAX_VSIX_BYTES = 20 * 1024 * 1024;
const MAX_SEARCH_BYTES = 512 * 1024;
const MAX_DETAIL_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const SEARCH_REQUEST_TIMEOUT_MS = 10_000;
const MAX_THEME_BYTES = 256 * 1024;
const MAX_ZIP_ENTRIES = 2_000;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_THEMES_PER_EXTENSION = 40;
const MAX_INCLUDE_DEPTH = 8;
const MAX_PACKAGE_PATH_LENGTH = 1_024;
const MAX_COLOR_VALUE_LENGTH = 128;
const MAX_RESOLVED_THEME_FILES = MAX_THEMES_PER_EXTENSION * MAX_INCLUDE_DEPTH;

// Extensions under these SPDX licenses may be imported; anything proprietary
// is never offered, which keeps the pane honest about what it is browsing.
const SUPPORTED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  "Unlicense",
]);

/** The workbench keys kone's importer reads, plus the terminal ANSI family. */
const USED_WORKBENCH_COLORS = new Set([
  "activityBar.background",
  "activityBarBadge.background",
  "badge.background",
  "button.background",
  "descriptionForeground",
  "dropdown.background",
  "editor.background",
  "editor.foreground",
  "editor.selectionBackground",
  "editorCursor.foreground",
  "editorError.foreground",
  "editorPane.background",
  "editorWarning.foreground",
  "editorWidget.background",
  "errorForeground",
  "focusBorder",
  "foreground",
  "input.background",
  "input.placeholderForeground",
  "panel.background",
  "progressBar.background",
  "sideBar.background",
  "terminal.background",
  "terminal.foreground",
  "terminal.selectionBackground",
  "terminalCursor.foreground",
  "textLink.foreground",
  // terminal.ansi* — the whole family, keyed by their first letter.
  "terminal.ansiBlack",
  "terminal.ansiRed",
  "terminal.ansiGreen",
  "terminal.ansiYellow",
  "terminal.ansiBlue",
  "terminal.ansiMagenta",
  "terminal.ansiCyan",
  "terminal.ansiWhite",
  "terminal.ansiBrightBlack",
  "terminal.ansiBrightRed",
  "terminal.ansiBrightGreen",
  "terminal.ansiBrightYellow",
  "terminal.ansiBrightBlue",
  "terminal.ansiBrightMagenta",
  "terminal.ansiBrightCyan",
  "terminal.ansiBrightWhite",
]);

export type OpenVsxThemeSort = "downloadCount" | "rating" | "timestamp" | "relevance";

/** One extension the pane can offer, as the search pass resolved it. */
export type OpenVsxThemeExtension = {
  id: string;
  name: string;
  publisher: string;
  description: string;
  downloadCount: number;
  sourceUrl: string | null;
  manifestUrl: string;
  sha256Url: string;
  vsixUrl: string;
  version: string;
  license: string;
};

export type OpenVsxThemeSearchOptions = {
  signal?: AbortSignal;
  sortBy?: OpenVsxThemeSort;
  /** How many candidates the registry is asked for. License and colour-theme
   *  filtering removes some, so a catalog asks for more than a search box. */
  size?: number;
};

/** 6-byte hash — enough to tell theme ids apart, short enough to read. */
async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(new TextEncoder().encode(value)));
  return Array.from(new Uint8Array(digest).slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Only absolute URLs on the registry's own host are trusted — the detail
 *  response is remote data, and every fetch from it must stay in one domain. */
function trustedOpenVsxUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "open-vsx.org"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** Public https URLs only (repository/homepage links shown to the user). */
function publicSourceUrl(value: unknown): string | null {
  const rawValue =
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.url === "string"
        ? value.url
        : null;
  if (!rawValue) return null;
  try {
    const url = new URL(rawValue);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

type ThemeContribution = { label?: unknown; uiTheme?: unknown; path?: unknown };

function themeContributions(manifest: ThemeJsonObject): ThemeContribution[] {
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : null;
  return Array.isArray(contributes?.themes) ? contributes.themes.filter(isRecord) : [];
}

function manifestLicenseMatches(manifest: ThemeJsonObject, license: string): boolean {
  return (
    typeof manifest.license === "string" &&
    manifest.license.trim().toLowerCase() === license.toLowerCase()
  );
}

function extensionFromDetail(value: unknown): OpenVsxThemeExtension | null {
  if (!isRecord(value) || !isRecord(value.files)) {
    throw new Error("Open VSX returned malformed theme details.");
  }
  const namespace = typeof value.namespace === "string" ? value.namespace.trim() : "";
  const extensionName = typeof value.name === "string" ? value.name.trim() : "";
  const displayName =
    (typeof value.displayName === "string" ? value.displayName.trim() : "") || extensionName;
  const version = typeof value.version === "string" ? value.version.trim() : "";
  const license = typeof value.license === "string" ? value.license.trim() : "";
  const manifestUrl = trustedOpenVsxUrl(value.files.manifest);
  const sha256Url = trustedOpenVsxUrl(value.files.sha256);
  const vsixUrl = trustedOpenVsxUrl(value.files.download);
  if (!namespace || !extensionName || !version || !manifestUrl || !sha256Url || !vsixUrl) {
    throw new Error("Open VSX returned malformed theme details.");
  }
  if (!SUPPORTED_LICENSES.has(license)) return null;
  return {
    id: `${namespace}.${extensionName}`,
    name: displayName,
    publisher: namespace,
    description: typeof value.description === "string" ? value.description : "",
    downloadCount:
      typeof value.downloadCount === "number" && Number.isFinite(value.downloadCount)
        ? value.downloadCount
        : 0,
    sourceUrl:
      publicSourceUrl(value.repository) ??
      publicSourceUrl(value.homepage) ??
      publicSourceUrl(value.url),
    manifestUrl,
    sha256Url,
    vsixUrl,
    version,
    license,
  };
}

async function withSearchTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, SEARCH_REQUEST_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } catch (cause) {
    if (controller.signal.aborted && !parentSignal?.aborted) {
      throw new Error("Open VSX took too long to respond.", { cause });
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abort);
  }
}

/**
 * Search the registry for theme extensions. Results are fetched per extension
 * (the search response alone carries no license or file URLs), filtered to
 * supported licenses and extensions that actually contribute colour themes.
 *
 * An empty query is a legitimate request: the registry answers with the
 * category's most downloaded extensions, which is the catalog the picker
 * fills itself with before anyone types.
 */
export async function searchOpenVsxThemes(
  query: string,
  { signal, sortBy = "downloadCount", size = 16 }: OpenVsxThemeSearchOptions = {},
): Promise<OpenVsxThemeExtension[]> {
  const searchText = query.trim();
  const url = new URL(OPEN_VSX_SEARCH_URL);
  url.searchParams.set("query", searchText);
  url.searchParams.set("category", "Themes");
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", "desc");
  // Ask for a few extras because results without a supported SPDX license
  // are intentionally omitted.
  url.searchParams.set("size", String(size));
  const value = await withSearchTimeout(async (requestSignal) => {
    const response = await fetch(url, { signal: requestSignal });
    if (!response.ok) throw new Error("Open VSX search is unavailable right now.");
    const searchBytes = await readCappedResponse(
      response,
      MAX_SEARCH_BYTES,
      "Open VSX returned an unexpectedly large response.",
    );
    try {
      // SAFETY: JSON.parse yields unknown; consumers probe fields before use.
      const parsed: unknown = JSON.parse(new TextDecoder().decode(searchBytes));
      return parsed;
    } catch {
      throw new Error("Open VSX returned an unreadable response.");
    }
  }, signal);
  if (!isRecord(value) || !Array.isArray(value.extensions)) {
    throw new Error("Open VSX returned an unreadable search response.");
  }
  const identities = value.extensions.flatMap((candidate): Array<[string, string]> => {
    if (!isRecord(candidate)) return [];
    const namespace = typeof candidate.namespace === "string" ? candidate.namespace : "";
    const name = typeof candidate.name === "string" ? candidate.name : "";
    return namespace && name ? [[namespace, name]] : [];
  });
  const details = await Promise.allSettled(
    identities.slice(0, size).map(([namespace, name]) =>
      withSearchTimeout(async (requestSignal) => {
        const detailUrl = `https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
        const detailResponse = await fetch(detailUrl, { signal: requestSignal });
        if (!detailResponse.ok) throw new Error("Open VSX theme details are unavailable.");
        const detailBytes = await readCappedResponse(
          detailResponse,
          MAX_DETAIL_BYTES,
          "Open VSX returned an unexpectedly large detail response.",
        );
        try {
          const extension = extensionFromDetail(JSON.parse(new TextDecoder().decode(detailBytes)));
          if (!extension) return null;
          const [manifestResponse, packageResponse] = await Promise.all([
            fetch(extension.manifestUrl, { signal: requestSignal }),
            fetch(extension.vsixUrl, { method: "HEAD", signal: requestSignal }),
          ]);
          if (!manifestResponse.ok) throw new Error("manifest unavailable");
          if (!packageResponse.ok) return null;
          const packageLength = Number(packageResponse.headers.get("content-length"));
          if (Number.isFinite(packageLength) && packageLength > MAX_VSIX_BYTES) {
            return null;
          }
          const manifestBytes = await readCappedResponse(
            manifestResponse,
            MAX_MANIFEST_BYTES,
            "Open VSX returned an unexpectedly large manifest.",
          );
          const manifest = parseJsoncObject(
            new TextDecoder().decode(manifestBytes),
            "Extension manifest",
          );
          return themeContributions(manifest).length > 0 &&
            manifestLicenseMatches(manifest, extension.license)
            ? extension
            : null;
        } catch {
          throw new Error("Open VSX returned unreadable theme details.");
        }
      }, signal),
    ),
  );
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  const completedDetails = details.filter((result) => result.status === "fulfilled");
  if (identities.length > 0 && completedDetails.length === 0) {
    throw new Error("Open VSX theme details are unavailable right now.");
  }
  return completedDetails.flatMap((result) => (result.value ? [result.value] : [])).slice(0, 8);
}

// ── the picker's catalog ────────────────────────────────────────────────────
// The most downloaded theme extensions, cached for the process: the picker
// fills itself with this on every open, and it should not re-fetch the
// registry each time. The cache holds the promise, so concurrent opens share
// one flight; a failure clears it so the next open retries.

let popularCache: Promise<OpenVsxThemeExtension[]> | null = null;

/** The registry's most downloaded colour themes (licenses and colour-theme
 *  contributions already filtered). Never throws — an unavailable registry
 *  leaves the picker empty rather than loud. */
export function popularThemes(): Promise<OpenVsxThemeExtension[]> {
  if (!popularCache) {
    // A larger pool than the search box uses: filtering (license, colour-theme
    // contributions) removes candidates, and a catalog wants a full shelf.
    popularCache = searchOpenVsxThemes("", { sortBy: "downloadCount", size: 40 }).catch((cause) => {
      popularCache = null;
      throw cause;
    });
  }
  return popularCache;
}

function parseJsoncObject(source: string, description: string): ThemeJsonObject {
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value)) throw new Error(`${description} is not valid JSON.`);
  return value;
}

/** A theme file stripped to what kone reads: its workbench colours and,
 *  optionally, the file it extends. */
type SanitizedThemeFile = {
  colors: Record<string, string>;
  include?: string;
};

/** Strip a theme file to the keys kone will actually read. */
function sanitizeThemeObject(value: ThemeJsonObject): SanitizedThemeFile {
  const colors: Record<string, string> = {};
  if (isRecord(value.colors)) {
    for (const [key, color] of Object.entries(value.colors)) {
      if (
        USED_WORKBENCH_COLORS.has(key) &&
        typeof color === "string" &&
        color.length <= MAX_COLOR_VALUE_LENGTH
      ) {
        colors[key] = color;
      }
    }
  }
  return typeof value.include === "string" ? { include: value.include, colors } : { colors };
}

/** Resolve a theme path inside the package, resolving `..` without ever
 *  allowing the result to escape the archive root. */
function normalizePackagePath(path: string, relativeTo = "extension/"): string {
  if (
    path.length > MAX_PACKAGE_PATH_LENGTH ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path)
  ) {
    throw new Error("Theme path is not a safe relative package path.");
  }
  const normalizedInput = path.replaceAll("\\", "/");
  const baseSegments = relativeTo.split("/").slice(0, -1);
  const segments = baseSegments;
  for (const segment of normalizedInput.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length <= 1) throw new Error("Theme path escapes the extension package.");
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments[0] !== "extension") segments.unshift("extension");
  return segments.join("/");
}

/** `vs`/`vs-dark`/`hc-*` from the manifest's contribution into kone's scheme. */
function contributionType(uiTheme: unknown): ThemeScheme | null {
  if (uiTheme === "vs") return "light";
  if (uiTheme === "vs-dark") return "dark";
  if (uiTheme === "hc-black" || uiTheme === "hc-light") {
    return uiTheme === "hc-black" ? "dark" : "light";
  }
  return null;
}

type ZipEntrySizes = {
  uncompressedSize?: unknown;
};

type InspectableZipObject = JSZip.JSZipObject & {
  _data?: ZipEntrySizes;
  unsafeOriginalName?: string;
  internalStream?: (type: "uint8array") => JSZip.JSZipStreamHelper<Uint8Array>;
};

/**
 * Read the zip's own directory before handing the bytes to JSZip: entry count,
 * declared sizes and compression ratios are checked first, so a crafted
 * archive is refused before anything is decompressed.
 */
function inspectZipDirectory(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = bytes.byteLength - 22;
  while (
    endOffset >= minimumOffset &&
    (view.getUint32(endOffset, true) !== 0x06054b50 ||
      endOffset + 22 + view.getUint16(endOffset + 20, true) !== bytes.byteLength)
  ) {
    endOffset -= 1;
  }
  if (endOffset < minimumOffset) throw new Error("That extension package has no ZIP directory.");

  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd !== endOffset || directoryEnd > bytes.byteLength) {
    throw new Error("That extension package has an invalid ZIP directory.");
  }

  let entryCount = 0;
  let totalUncompressed = 0;
  let offset = directoryOffset;
  while (offset < directoryEnd) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("That extension package has an invalid ZIP directory.");
    }
    entryCount += 1;
    if (entryCount > MAX_ZIP_ENTRIES) {
      throw new Error("That extension package has too many files.");
    }
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new Error("That extension package has unsupported ZIP64 metadata.");
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("That extension package expands beyond the safe import limit.");
    }
    if (
      uncompressed > 0 &&
      (compressed === 0 || uncompressed / compressed > MAX_COMPRESSION_RATIO)
    ) {
      throw new Error("That extension package has an unsafe compression ratio.");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== directoryEnd)
    throw new Error("That extension package has an invalid ZIP directory.");

  const commentLength = view.getUint16(endOffset + 20, true);
  if (commentLength === 0) return bytes;

  // JSZip mistakes EOCD-like bytes inside an archive comment for the real EOCD.
  // The comment is not needed for theme import, so remove it before parsing.
  const withoutComment = bytes.slice(0, endOffset + 22);
  withoutComment[endOffset + 20] = 0;
  withoutComment[endOffset + 21] = 0;
  return withoutComment;
}

function inspectZip(zip: JSZip): void {
  // SAFETY: JSZip types omit its private _data/internalStream fields, which
  // every entry carries at runtime; InspectableZipObject names them for probing.
  const entries = Object.values(zip.files) as InspectableZipObject[];
  if (entries.length > MAX_ZIP_ENTRIES)
    throw new Error("That extension package has too many files.");

  for (const entry of entries) {
    if (entry.unsafeOriginalName) normalizePackagePath(entry.unsafeOriginalName);
  }
}

async function readZipText(
  zip: JSZip,
  path: string,
  description: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  // SAFETY: same JSZip-private fields as inspectZip — zip.file's declared
  // return type omits them, so the narrower view is asserted at this I/O boundary.
  const file = zip.file(path) as InspectableZipObject | null;
  if (!file) throw new Error(`${description} is missing from the extension package.`);
  if (typeof file._data?.uncompressedSize !== "number" || !file.internalStream) {
    throw new Error(`${description} has unreadable size metadata.`);
  }
  if (file._data.uncompressedSize > MAX_THEME_BYTES) {
    throw new Error(`${description} is too large.`);
  }

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let settled = false;
    const stream = file.internalStream!("uint8array");
    const cleanup = () => signal?.removeEventListener("abort", handleAbort);
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      stream.pause();
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    stream
      .on("data", (chunk) => {
        if (settled) return;
        byteLength += chunk.byteLength;
        if (byteLength > MAX_THEME_BYTES) {
          settled = true;
          stream.pause();
          cleanup();
          reject(new Error(`${description} is too large.`));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (cause) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      })
      .on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(new TextDecoder().decode(bytes));
      })
      .resume();
  });
}

/**
 * Load a theme file, resolving its `include` chain (a file that extends
 * another theme) with depth, cycle and file-count budgets.
 */
async function loadThemeObject(
  zip: JSZip,
  path: string,
  cache: Map<string, SanitizedThemeFile>,
  budget: { files: number },
  ancestors: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
): Promise<SanitizedThemeFile> {
  signal?.throwIfAborted();
  if (ancestors.size >= MAX_INCLUDE_DEPTH) throw new Error("Theme includes are nested too deeply.");
  if (ancestors.has(path)) throw new Error("Theme includes contain a cycle.");
  const cached = cache.get(path);
  if (cached) return cached;
  budget.files += 1;
  if (budget.files > MAX_RESOLVED_THEME_FILES) {
    throw new Error("That extension references too many theme files.");
  }

  const value = sanitizeThemeObject(
    parseJsoncObject(await readZipText(zip, path, path, signal), path),
  );
  if (value.include === undefined) {
    cache.set(path, value);
    return value;
  }

  const includePath = normalizePackagePath(value.include, path);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(path);
  const base = await loadThemeObject(zip, includePath, cache, budget, nextAncestors, signal);
  const resolved: SanitizedThemeFile = {
    ...base,
    ...value,
    colors: { ...base.colors, ...value.colors },
  };
  cache.set(path, resolved);
  return resolved;
}

async function readCappedResponse(
  response: Response,
  limit: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > limit) throw new Error(tooLargeMessage);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error(tooLargeMessage);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > limit) {
        await reader.cancel();
        throw new Error(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchPackage(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error("That Open VSX theme could not be downloaded.");
  return readCappedResponse(
    response,
    MAX_VSIX_BYTES,
    "That theme extension is too large to import safely.",
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Download one extension from the registry and turn every colour theme inside
 * it into kone theme definitions. Throws with a readable reason on any failure
 * — nothing is partially registered.
 */
export async function importOpenVsxThemeExtension(
  extension: OpenVsxThemeExtension,
  signal?: AbortSignal,
): Promise<readonly ThemeDefinition[]> {
  const manifestResponse = await fetch(extension.manifestUrl, signal ? { signal } : {});
  if (!manifestResponse.ok) throw new Error("That Open VSX extension has no readable manifest.");
  const manifestBytes = await readCappedResponse(
    manifestResponse,
    MAX_MANIFEST_BYTES,
    "That Open VSX extension manifest is too large.",
  );
  const manifest = parseJsoncObject(new TextDecoder().decode(manifestBytes), "Extension manifest");
  const advertisedContributions = themeContributions(manifest);
  if (advertisedContributions.length === 0) {
    throw new Error("That extension does not contain colour themes.");
  }
  if (advertisedContributions.length > MAX_THEMES_PER_EXTENSION) {
    throw new Error("That extension contains too many colour themes to import safely.");
  }

  const packageBytes = await fetchPackage(extension.vsixUrl, signal);
  signal?.throwIfAborted();
  const checksumResponse = await fetch(extension.sha256Url, signal ? { signal } : {});
  if (!checksumResponse.ok) throw new Error("That Open VSX theme has no readable checksum.");
  const expectedChecksum = new TextDecoder()
    .decode(
      await readCappedResponse(
        checksumResponse,
        256,
        "That Open VSX checksum response is invalid.",
      ),
    )
    .trim()
    .split(/\s+/)[0];
  if (!expectedChecksum || !/^[a-f\d]{64}$/i.test(expectedChecksum)) {
    throw new Error("That Open VSX theme has an invalid checksum.");
  }
  signal?.throwIfAborted();
  const actualChecksum = await sha256Hex(packageBytes);
  if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
    throw new Error("That Open VSX theme failed its integrity check.");
  }
  signal?.throwIfAborted();
  let zip: JSZip;
  try {
    const inspectedPackageBytes = inspectZipDirectory(packageBytes);
    zip = await JSZip.loadAsync(inspectedPackageBytes);
    signal?.throwIfAborted();
    inspectZip(zip);
  } catch (cause) {
    if (signal?.aborted) signal.throwIfAborted();
    if (cause instanceof Error && cause.message.startsWith("That extension package")) throw cause;
    throw new Error("That Open VSX extension package could not be opened.", { cause });
  }

  const packagedManifest = parseJsoncObject(
    await readZipText(zip, "extension/package.json", "Extension manifest", signal),
    "Extension manifest",
  );
  if (
    typeof packagedManifest.publisher !== "string" ||
    packagedManifest.publisher.toLowerCase() !== extension.publisher.toLowerCase() ||
    typeof packagedManifest.name !== "string" ||
    `${packagedManifest.publisher}.${packagedManifest.name}`.toLowerCase() !==
      extension.id.toLowerCase() ||
    packagedManifest.version !== extension.version
  ) {
    throw new Error("That extension package does not match the selected Open VSX theme.");
  }
  if (!manifestLicenseMatches(packagedManifest, extension.license)) {
    throw new Error("That extension package does not match its advertised license.");
  }
  const contributions = themeContributions(packagedManifest);
  if (contributions.length === 0) throw new Error("That extension does not contain colour themes.");
  if (contributions.length > MAX_THEMES_PER_EXTENSION) {
    throw new Error("That extension contains too many colour themes to import safely.");
  }

  const entries: VsCodeImportEntry[] = [];
  const themeCache = new Map<string, SanitizedThemeFile>();
  const themeBudget = { files: 0 };
  for (const contribution of contributions) {
    signal?.throwIfAborted();
    if (typeof contribution.path !== "string") {
      throw new Error("A colour theme in that extension has no file path.");
    }
    try {
      const path = normalizePackagePath(contribution.path);
      const themeValue = await loadThemeObject(zip, path, themeCache, themeBudget, new Set(), signal);
      const type = contributionType(contribution.uiTheme);
      const label =
        typeof contribution.label === "string" && contribution.label.trim()
          ? contribution.label.trim()
          : extension.name;
      const decorated = type
        ? { ...themeValue, displayName: label, type }
        : { ...themeValue, displayName: label };
      if (!isVsCodeThemeFile(decorated)) throw new Error("not a VS Code colour theme");
      entries.push(parseVsCodeThemeEntry(decorated, path.split("/").at(-1)!));
    } catch (cause) {
      signal?.throwIfAborted();
      throw new Error("One or more colour themes in that extension could not be imported safely.", {
        cause,
      });
    }
  }
  if (entries.length === 0) {
    throw new Error("That extension has no compatible colour themes.");
  }

  const extensionKey = extension.id.toLowerCase();

  // Deterministic ids are computed before the build, because the builder's id
  // supplier is synchronous: one id per theme file, and one per possible
  // light/dark pair, keyed by their sorted source stems. Re-importing the same
  // extension lands on the same ids, so the library updates in place.
  const stems = entries.map((entry) => entry.sourceStem);
  const sourceSets = new Set<string>();
  for (const stem of stems) sourceSets.add(stem);
  for (let i = 0; i < stems.length; i += 1) {
    for (let j = i + 1; j < stems.length; j += 1) {
      sourceSets.add([stems[i]!, stems[j]!].sort().join("\0"));
    }
  }
  const idsBySources = new Map<string, string>();
  for (const key of sourceSets) {
    idsBySources.set(key, `ovx-${await shortHash(`${extensionKey}\0${key}`)}`);
  }
  const idKey = (sources: readonly string[]) => [...new Set(sources)].sort().join("\0");

  // The pane's blurb is what the theme *is*, and the extension's own
  // description says that better than a provenance stamp does.
  const blurb =
    (extension.description.trim().replace(/\s+/g, " ").slice(0, 200) ||
      "Imported from Open VSX.");

  const built = buildImportedThemes(entries, new Set(), {
    blurb,
    idFor: ({ sources }) => idsBySources.get(idKey(sources)) ?? "ovx-missing",
  });

  // Every theme remembers its extension so the picker can hide what's already
  // here — the id is deliberately not the way to find this out.
  return built.map((theme) => ({ ...theme, source: extensionKey }));
}
