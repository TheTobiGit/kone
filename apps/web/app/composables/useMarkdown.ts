import type MarkdownIt from "markdown-it";

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
    return md.render(src);
  }

  return { render };
}
