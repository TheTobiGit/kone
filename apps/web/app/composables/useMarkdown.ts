import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

import { repairMarkdownTableDelimiters } from "~/utils/padMarkdown";

// Rich rendering for the file-detail preview of Markdown files. markdown-it is
// loaded once (module-level singleton, code-split via dynamic import) the first
// time a preview is asked for.
//
// html:false escapes any raw HTML in the source rather than rendering it, so a
// file from an untrusted repo can't inject markup/script into the preview —
// v-html then only ever receives markdown-it's own escaped output. typographer
// turns straight quotes/dashes into their proper glyphs; linkify auto-links.

// Past this the file renders raw instead — markdown-it's render is synchronous,
// so a huge document would block the open. Mirrors the highlighter's own cap.
const MAX_RENDER = 150_000;

let mdPromise: Promise<MarkdownIt> | null = null;

function getMd(): Promise<MarkdownIt> {
  if (!mdPromise) {
    mdPromise = import("markdown-it").then(({ default: MarkdownIt }) => {
      const md = new MarkdownIt({
        html: false,
        linkify: true,
        typographer: true,
      });
      // Agents constantly write bare filenames — README.md, config.io, run.sh —
      // and linkify's fuzzy mode would auto-link them because .md/.io/.sh are
      // real ccTLDs. That turns file references into bogus web links, so switch
      // fuzzy matching off: only explicit [text](url) links and real schemed /
      // www. URLs become links.
      md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
      // markdown-it blocks the `file:` scheme by default (it's a potential
      // exfiltration vector in a browser). We render local file links as inert
      // file chips — never navigations — so it's safe to let them through here;
      // otherwise `[README.md](file:///…)` collapses to raw text.
      const safeLink = md.validateLink.bind(md);
      md.validateLink = (url: string) => /^file:/i.test(url.trim()) || safeLink(url);
      // Force links to open externally: in the desktop shell a bare in-page
      // navigation would replace the whole app, so every link goes through the
      // window-open handler (→ system browser) and carries noopener.
      const openLink =
        md.renderer.rules.link_open ??
        ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
      md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
        tokens[i]!.attrSet("target", "_blank");
        tokens[i]!.attrSet("rel", "noopener noreferrer");
        return openLink(tokens, i, opts, env, self);
      };
      return md;
    });
  }
  return mdPromise;
}

export function useMarkdown() {
  /** Render Markdown source to a safe HTML string, or null to fall back to the
   *  raw view (server render, or a document too large to render inline). */
  async function render(src: string): Promise<string | null> {
    if (import.meta.server || src.length > MAX_RENDER) return null;
    const md = await getMd();
    // Repair GFM delimiter rows whose cell count disagrees with their header
    // before rendering — otherwise a malformed table renders as a run-on
    // there is nothing to repair, so valid Markdown stays byte-identical.
    const repaired = repairMarkdownTableDelimiters(src);
    // Fenced/indented code blocks scroll horizontally (pre { overflow-x: auto }),
    // which would make each one a focusable scroller — an extra Tab stop inside
    // the preview. The whole body scrolls by arrow key, so take them out of the
    // tab order; Tab then visits only the real controls and links.
    return md.render(repaired).replaceAll("<pre>", '<pre tabindex="-1">');
  }

  /** Parse Markdown to markdown-it's token stream, or null on the server. The
   *  conversation thread walks these tokens into a Vue component tree (rather
   *  than a v-html string) so it can mount rich elements — syntax-highlighted
   *  code blocks, favicon links, file chips — that raw HTML can't carry. Shares
   *  the same parser (and its safe config) as `render`. */
  async function parse(src: string): Promise<Token[] | null> {
    if (import.meta.server) return null;
    const md = await getMd();
    // Same repair as `render` — the conversation thread walks these tokens
    // into components, so a broken delimiter row must become a table here too.
    return md.parse(repairMarkdownTableDelimiters(src), {});
  }

  return { render, parse };
}
