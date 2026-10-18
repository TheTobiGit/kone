// Browser dev only. A canned research turn for the mock agent — two web
// searches and the pages read off them — so the web rows (the query field, the
// hits landing, a hit lighting up as it's read, the page preview) can be
// watched end to end without a live provider. Search bodies use Claude's own
// result dialect (`Links: [...]`), the one real sessions hand over most.

export type WebResearchStep =
  | { kind: "reasoning_text" | "assistant_text"; text: string }
  | { kind: "tool_call"; name: string; target: string; detail: string; ms: number };

/** Prompts that ask the mock to go online. */
export const WEB_PROMPT = /\b(web|search|research|look ?up|online|internet|google)\b/i;

function searchBody(query: string, links: { title: string; url: string }[], summary: string): string {
  return `Web search results for query: "${query}"\n\nLinks: ${JSON.stringify(links)}\n\n${summary}`;
}

export const WEB_RESEARCH: WebResearchStep[] = [
  {
    kind: "reasoning_text",
    text: "Rendering markdown while it streams is a solved-ish problem elsewhere. I'll look at how others deal with half-finished syntax before picking an approach.",
  },
  {
    kind: "tool_call",
    name: "web_search",
    target: "streaming markdown rendering unterminated syntax",
    ms: 2200,
    detail: searchBody(
      "streaming markdown rendering unterminated syntax",
      [
        { title: "vercel/streamdown: a drop-in markdown renderer built for AI streaming", url: "https://github.com/vercel/streamdown" },
        { title: "Streams—The definitive guide", url: "https://web.dev/articles/streams" },
        { title: "markdown-it/markdown-it: Markdown parser, done right", url: "https://github.com/markdown-it/markdown-it" },
        { title: "Streams API - Web APIs | MDN", url: "https://developer.mozilla.org/en-US/docs/Web/API/Streams_API" },
        { title: "remarkjs/react-markdown: Markdown component for React", url: "https://github.com/remarkjs/react-markdown" },
        { title: "Marked documentation", url: "https://marked.js.org/" },
        { title: "markdown-it on npm", url: "https://www.npmjs.com/package/markdown-it" },
      ],
      "Renderers built for streaming close unterminated blocks before parsing each chunk.",
    ),
  },
  {
    kind: "tool_call",
    name: "web_fetch",
    target: "github.com/vercel/streamdown",
    ms: 2000,
    detail:
      "# Streamdown\n\nA drop-in replacement for react-markdown, designed for AI-powered streaming.\n\nStreamdown handles incomplete markdown as it arrives: an unterminated bold run, an open code fence or a half-written link is closed before each render, so the text never flashes raw syntax mid-stream.\n\n## Features\n\n- Unterminated block parsing\n- Code highlighting with Shiki\n- Math and Mermaid support",
  },
  {
    kind: "tool_call",
    name: "web_fetch",
    target: "web.dev/articles/streams",
    ms: 1700,
    detail:
      "# Streams—The definitive guide\n\nThe Streams API lets you programmatically access streams of data received over the network and process them with JavaScript, chunk by chunk, as they arrive.\n\nA readable stream is a data source; a transform stream sits between a readable and a writable one and changes each chunk on its way through.",
  },
  {
    kind: "assistant_text",
    text: "Streamdown's trick is to repair the tail before each parse. Let me check whether markdown-it can be fed the same way.",
  },
  {
    kind: "tool_call",
    name: "web_search",
    target: "markdown-it incremental parse open code fence",
    ms: 1800,
    detail: searchBody(
      "markdown-it incremental parse open code fence",
      [
        { title: "markdown-it/markdown-it: Markdown parser, done right", url: "https://github.com/markdown-it/markdown-it" },
        { title: "markdown-it API documentation", url: "https://markdown-it.github.io/markdown-it/" },
        { title: "CommonMark Spec: fenced code blocks", url: "https://spec.commonmark.org/0.31.2/#fenced-code-blocks" },
      ],
      "markdown-it has no incremental mode; re-parsing the whole buffer is cheap at chat sizes.",
    ),
  },
  {
    kind: "tool_call",
    name: "web_fetch",
    target: "spec.commonmark.org/0.31.2/#fenced-code-blocks",
    ms: 1500,
    detail:
      "## 4.5 Fenced code blocks\n\nA code fence is a sequence of at least three consecutive backtick characters or tildes. If the end of the containing block (or document) is reached and no closing code fence has been found, the code block contains all of the lines after the opening code fence until the end of the containing block.",
  },
  {
    kind: "assistant_text",
    text: "Here's what I found.\n\n- **Repair, then parse.** [Streamdown](https://github.com/vercel/streamdown) closes unterminated bold, links and fences before every render, so raw syntax never flashes.\n- **An open fence is already safe.** The [CommonMark spec](https://spec.commonmark.org/0.31.2/#fenced-code-blocks) runs an unclosed fence to the end of the document, so a half-streamed code block renders as code.\n- **No incremental mode needed.** markdown-it re-parses the whole buffer, which is cheap at chat sizes.\n\nSo the plan is a small tail-repair pass in front of the parser we already have.",
  },
];
