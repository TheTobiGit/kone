// Read a web tool call's result body back into something the activity row can
// draw: a search's hits as titled links, a fetch's page as a title and an
// excerpt. Providers hand both over as plain text, each in its own dialect, so
// every reader here is forgiving — a body it can't read yields nothing, and the
// row falls back to the plain phrase it always had.

import type { InjectionKey, Ref } from "vue";
import { parseSiteTarget } from "~/utils/siteChip";

export type WebHit = { title: string; url: string; host: string };
export type WebPage = { title: string; excerpt: string; bytes: number };
export type WebReadState = "running" | "done" | "error";
export type WebRead = { state: WebReadState; page: WebPage | null };

/** What a batch of steps did on the web, seen whole: every page it opened
 *  (keyed by `webKey`) and every hit its searches turned up. A search row
 *  grows the reads of its own hits in place; a fetch of one of those hits then
 *  has nothing left to say on a row of its own. */
export type WebTrail = { reads: ReadonlyMap<string, WebRead>; hits: ReadonlySet<string> };

export const WEB_TRAIL: InjectionKey<Ref<WebTrail>> = Symbol("web-trail");

const SEARCH_NAMES = new Set(["web_search", "search_web", "websearch"]);
const FETCH_NAMES = new Set(["web_fetch", "read_url_content", "view_web_document", "webfetch"]);

export function isWebSearchTool(name: string | undefined): boolean {
  return SEARCH_NAMES.has((name ?? "").toLowerCase());
}

export function isWebFetchTool(name: string | undefined): boolean {
  return FETCH_NAMES.has((name ?? "").toLowerCase());
}

/** A fetch's target is its URL, sometimes followed by ` · label`. */
export function fetchTargetUrl(target: string): string {
  return target.split(/\s·\s/)[0]?.trim() ?? "";
}

/** One spelling per page, for telling a fetch apart from the hit it opened:
 *  no scheme, no `www.`, no trailing slash, no fragment. */
export function webKey(url: string): string {
  const { host, tail } = parseSiteTarget(url);
  const path = tail.replace(/#.*$/, "").replace(/\/+$/, "");
  return `${host.toLowerCase()}/${path}`;
}

function hit(title: string, url: string): WebHit | null {
  const clean = url.trim().replace(/[).,;]+$/, "");
  if (!/^https?:\/\//i.test(clean)) return null;
  const { host } = parseSiteTarget(clean);
  return { title: title.trim() || host, url: clean, host };
}

/** Claude's search body: `Links: [{"title": …, "url": …}, …]`, once per query
 *  round. Read every array; skip any that isn't JSON. */
function linksBlocks(detail: string): WebHit[] {
  const out: WebHit[] = [];
  const re = /Links:\s*(\[[\s\S]*?\])(?=\s*(?:\n|$))/g;
  for (const m of detail.matchAll(re)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    // SAFETY: the provider writes an array of `{ title, url }` records; `hit`
    // re-checks the URL, so a malformed entry is dropped rather than drawn.
    for (const entry of parsed as Partial<Record<"title" | "url", string>>[]) {
      const h = hit(String(entry?.title ?? ""), String(entry?.url ?? ""));
      if (h) out.push(h);
    }
  }
  return out;
}

/** Every other dialect: markdown links first, then bare URLs. */
function looseLinks(detail: string): WebHit[] {
  const out: WebHit[] = [];
  for (const m of detail.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const h = hit(m[1]!, m[2]!);
    if (h) out.push(h);
  }
  if (out.length) return out;
  for (const m of detail.matchAll(/https?:\/\/[^\s"'<>\])]+/g)) {
    const h = hit("", m[0]);
    if (h) out.push(h);
  }
  return out;
}

/** The hits a search came back with, in the order the provider ranked them,
 *  each page once. */
export function parseWebSearchHits(detail: string | undefined): WebHit[] {
  if (!detail?.trim()) return [];
  const found = linksBlocks(detail);
  const all = found.length ? found : looseLinks(detail);
  const seen = new Set<string>();
  return all.filter((h) => {
    const k = webKey(h.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Markdown down to the words a reader would see. */
function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** What a fetch brought back: the page's own heading when it has one, and the
 *  first real paragraph under it. */
export function parseWebPage(detail: string | undefined): WebPage | null {
  const body = detail?.trim();
  if (!body) return null;
  const bytes = new TextEncoder().encode(body).length;
  const lines = body.split("\n");
  const headingAt = lines.findIndex((l) => /^#{1,3}\s+\S/.test(l));
  const title = headingAt >= 0 ? plainText(lines[headingAt]!) : "";
  const rest = headingAt >= 0 ? lines.slice(headingAt + 1) : lines;
  const paragraphs = rest
    .join("\n")
    .split(/\n\s*\n/)
    .map(plainText)
    .filter((p) => p.length > 0);
  // A page that opens on a one-line tagline says more in the paragraph after it.
  const excerpt = paragraphs.find((p) => p.length >= 80) ?? paragraphs.find((p) => p.length >= 40) ?? paragraphs[0] ?? "";
  if (!title && !excerpt) return null;
  return { title, excerpt, bytes };
}

/** `2.1 KB`, for the size a fetch pulled in. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}
