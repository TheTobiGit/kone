import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

import { repairMarkdownTableDelimiters } from "~/utils/padMarkdown";
import { createHtmlMedia, createLinkSanitizer } from "~/utils/safeHtmlMedia";
import { treeify } from "~/utils/markdownTree";
import { expandHtmlTables, type MdNode } from "~/utils/safeHtmlTable";

// Rich rendering for Markdown. The thread walks `parse`'s token stream into a
// Vue component tree (never v-html); the file/skill/scratchpad previews pass
// `render`'s escaped HTML to v-html. Two configurations, one per need, both
// code-split behind a dynamic import:
//
//   · render — html:false, so a raw tag in an untrusted file is escaped text,
//     never markup. This is the only path that sets HTML, so it stays closed.
//   · parse  — html:true, so raw markup becomes html_block/html_inline tokens
//     carrying its source verbatim. Inline transforms (linkify, typographer)
//     never touch those tokens, so downstream code reads the tags and their
//     attributes exactly as written, and the component tree escapes them anyway.
//
// Past MAX_RENDER the file renders raw instead — markdown-it's render is
// synchronous, so a huge document would block the open.

const MAX_RENDER = 150_000;

let renderMdPromise: Promise<MarkdownIt> | null = null;
let parseMdPromise: Promise<MarkdownIt> | null = null;

/** The rules both instances share. `file:` is allowed through so a local
 *  document link survives to the file-chip renderer (it is never a
 *  navigation); everything else markdown-it refuses stays refused. Links open
 *  externally: a bare in-page navigation would replace the desktop shell. */
export function configureMarkdown(md: MarkdownIt): MarkdownIt {
  // Agents constantly write bare filenames — README.md, config.io, run.sh — and
  // linkify's fuzzy mode would auto-link them because .md/.io/.sh are real
  // ccTLDs. That turns file references into bogus web links, so switch fuzzy
  // matching off: only explicit [text](url) links and real schemed / www. URLs
  // become links.
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
  // markdown-it blocks the `file:` scheme by default (it's a potential
  // exfiltration vector in a browser). We render local file links as inert file
  // chips — never navigations — so it's safe to let them through here;
  // otherwise `[README.md](file:///…)` collapses to raw text.
  const safeLink = md.validateLink.bind(md);
  md.validateLink = (url: string) => /^file:/i.test(url.trim()) || safeLink(url);
  const openLink =
    md.renderer.rules.link_open ??
    ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
  md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
    tokens[i]!.attrSet("target", "_blank");
    tokens[i]!.attrSet("rel", "noopener noreferrer");
    return openLink(tokens, i, opts, env, self);
  };
  return md;
}

function getMd(html: boolean): Promise<MarkdownIt> {
  if (html) {
    if (!parseMdPromise) {
      parseMdPromise = import("markdown-it").then(({ default: MarkdownIt }) =>
        configureMarkdown(new MarkdownIt({ html: true, linkify: true, typographer: true })),
      );
    }
    return parseMdPromise;
  }
  if (!renderMdPromise) {
    renderMdPromise = import("markdown-it").then(({ default: MarkdownIt }) =>
      configureMarkdown(new MarkdownIt({ html: false, linkify: true, typographer: true })),
    );
  }
  return renderMdPromise;
}

export function useMarkdown() {
  /** Render Markdown source to a safe HTML string, or null to fall back to the
   *  raw view (server render, or a document too large to render inline). */
  async function render(src: string): Promise<string | null> {
    if (import.meta.server || src.length > MAX_RENDER) return null;
    const md = await getMd(false);
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
   *  code blocks, favicon links, file chips — that raw HTML can't carry. */
  async function parse(src: string): Promise<Token[] | null> {
    if (import.meta.server) return null;
    const md = await getMd(true);
    // Same repair as `render` — the conversation thread walks these tokens
    // into components, so a broken delimiter row must become a table here too.
    return md.parse(repairMarkdownTableDelimiters(src), {});
  }

  /** The conversation's component tree, including allowed HTML, using the
   *  same parser and URL policy throughout the conversion. */
  async function parseNodes(src: string): Promise<MdNode[] | null> {
    if (import.meta.server) return null;
    const md = await getMd(true);
    const tokens = md.parse(repairMarkdownTableDelimiters(src), {});
    const media = createHtmlMedia(createLinkSanitizer(md));
    return media.expandHtmlMedia(expandHtmlTables(treeify(tokens)));
  }

  return { render, parse, parseNodes };
}
