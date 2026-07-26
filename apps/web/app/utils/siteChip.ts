// Parse a URL-ish tool target into host + path tail for chip rendering, and
// build the favicon service URL MarkdownLink uses for external links.

export type SiteParts = { host: string; tail: string; title: string; href: string };

const EXTENSIONLESS_FILES = /^(dockerfile|makefile|license|readme|changelog|gemfile|procfile)$/i;

/** Split `vercel.com/blog/post · label` into host, path tail, and a usable href. */
export function parseSiteTarget(raw: string): SiteParts {
  const title = raw.trim();
  const main = title.split(/\s·\s/)[0]?.trim() ?? title;
  let href = main;
  if (!/^https?:\/\//i.test(href)) href = `https://${href.replace(/^\/\//, "")}`;
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./, "");
    const path = `${u.pathname}${u.search}${u.hash}`.replace(/\/$/, "") || "";
    const tail = path.startsWith("/") ? path.slice(1) : path;
    return { host, tail, title, href: u.href };
  } catch {
    const slash = main.indexOf("/");
    if (slash === -1) {
      const host = main.replace(/^www\./, "");
      return { host, tail: "", title, href: `https://${host}` };
    }
    const host = main.slice(0, slash).replace(/^www\./, "");
    return { host, tail: main.slice(slash + 1), title, href: `https://${main}` };
  }
}

export function siteFaviconUrl(host: string): string {
  return host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64` : "";
}

/** True when a path names a directory rather than a file (last segment has no extension). */
export function looksLikeDirectoryPath(s: string): boolean {
  if (!s || looksLikeSite(s)) return false;
  const clean = s.replace(/\/+$/, "");
  if (!/[\\/]/.test(clean)) return false;
  const base = clean.split(/[\\/]/).filter(Boolean).pop() ?? "";
  if (!base || base.includes(".")) return false;
  if (EXTENSIONLESS_FILES.test(base)) return false;
  return true;
}

export function looksLikeSite(s: string): boolean {
  if (!s) return false;
  const main = s.split(/\s·\s/)[0]?.trim() ?? s;
  if (/^https?:\/\//i.test(main)) return true;
  // `vercel.com/blog/...` — domain with a path or a bare registrable domain.
  return /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(main);
}
