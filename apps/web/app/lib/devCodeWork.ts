// Browser dev only. A canned coding turn for the mock agent (a search through
// the code, a read, two edits, a test run, a lint run that fails, the fix and
// the clean re-run) so the code rows (files a search landed in, the lines an
// edit changed, how a run came out) can be watched end to end without a live
// provider. Bodies use the dialects real sessions hand over: `file:line:text`
// search results, Claude's bare `+`/`-` diff lines, and the runners' own output.

export type CodeWorkStep =
  | { kind: "reasoning_text" | "assistant_text"; text: string }
  | { kind: "tool_call"; name: string; target: string; detail?: string; ms: number }
  | { kind: "tool_fail"; name: string; target: string; detail: string; ms: number };

/** Prompts that ask the mock to work on the code. */
export const CODE_PROMPT = /\b(fix|bug|refactor|rename|implement|tests?)\b/i;

export const CODE_WORK: CodeWorkStep[] = [
  {
    kind: "reasoning_text",
    text: "The flicker is the whole message re-rendering on every token. I'll find where the stream text is rendered before changing anything.",
  },
  {
    kind: "tool_call",
    name: "grep_search",
    target: "renderWords",
    ms: 1400,
    detail: [
      "app/components/markdown/MarkdownMessage.vue:88:function renderWords(content: string, key: number): VNode {",
      "app/components/markdown/MarkdownMessage.vue:141:  return renderWords(tail, words.length);",
      "app/components/markdown/MarkdownMessage.vue:163:    renderWords(block.text, i)",
      "app/components/conversation/ConversationThread.vue:472:    <MarkdownMessage :source=\"segText(seg)\" :render=\"renderWords\" />",
      "app/utils/streamWords.ts:12:export function renderWords(words: string[]) {",
      "app/utils/streamWords.test.ts:30:  expect(renderWords([\"a\", \"b\"])).toHaveLength(2);",
      "app/composables/useStreaming.ts:57:  const html = renderWords(buffer.value);",
    ].join("\n"),
  },
  { kind: "tool_call", name: "read_file", target: "app/components/markdown/MarkdownMessage.vue", ms: 900 },
  {
    kind: "tool_call",
    name: "edit_file",
    target: "app/components/markdown/MarkdownMessage.vue",
    ms: 1300,
    detail: [
      " function renderWords(content: string, key: number): VNode {",
      "-  return h(\"span\", { class: \"md-words\" }, content);",
      "+  // One stable key per word, so a word mounts once and the ones",
      "+  // before it are never re-rendered as the stream grows.",
      "+  const words = content.split(/(\\s+)/);",
      "+  return h(\"span\", { class: \"md-words\" }, words.map((w, i) => h(\"span\", { key: `${key}:${i}` }, w)));",
      " }",
    ].join("\n"),
  },
  {
    kind: "tool_call",
    name: "write_to_file",
    target: "app/components/markdown/MarkdownMessage.test.ts",
    ms: 1100,
    detail: [
      "+import { describe, expect, test } from \"bun:test\";",
      "+import { mount } from \"@vue/test-utils\";",
      "+import MarkdownMessage from \"./MarkdownMessage.vue\";",
      "+",
      "+describe(\"MarkdownMessage\", () => {",
      "+  test(\"keeps earlier words mounted as the stream grows\", async () => {",
      "+    const w = mount(MarkdownMessage, { props: { source: \"one two\" } });",
      "+    const first = w.find(\"span span\").element;",
      "+    await w.setProps({ source: \"one two three\" });",
      "+    expect(w.find(\"span span\").element).toBe(first);",
      "+  });",
      "+});",
    ].join("\n"),
  },
  {
    kind: "tool_call",
    name: "bash",
    target: "bun test MarkdownMessage",
    ms: 1800,
    detail: "app/components/markdown/MarkdownMessage.test.ts:\n✓ MarkdownMessage > keeps earlier words mounted as the stream grows [3.10ms]\n\n 14 pass\n 0 fail\n 31 expect() calls\nRan 14 tests across 2 files. [388ms]",
  },
  {
    kind: "tool_fail",
    name: "bash",
    target: "bun run lint",
    ms: 1200,
    detail: "app/components/markdown/MarkdownMessage.vue\n  92:9  error  'key' is defined but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)",
  },
  {
    kind: "reasoning_text",
    text: "The lint is right: the old signature still names `key` in a branch that no longer uses it.",
  },
  {
    kind: "tool_call",
    name: "edit_file",
    target: "app/components/markdown/MarkdownMessage.vue",
    ms: 900,
    detail: "-function renderPlain(content: string, key: number): VNode {\n+function renderPlain(content: string): VNode {",
  },
  {
    kind: "tool_call",
    name: "bash",
    target: "bun run lint",
    ms: 1100,
    detail: "Checked 412 files in 1.2s.\n✓ 0 problems",
  },
  {
    kind: "assistant_text",
    text: "Fixed. Each streamed word now mounts once under a stable key, so earlier words never re-render and the flicker is gone. I added a test that holds the first word's element across an update, and lint and the suite are both clean.",
  },
];
