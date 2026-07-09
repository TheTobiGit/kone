export type ResponseParagraphBlock = {
  type: "paragraph";
  text: string;
};

export type ResponseCodeBlock = {
  type: "code";
  language?: string;
  text: string;
};

export type ResponseHeadingBlock = {
  type: "heading";
  level: number;
  text: string;
};

export type ResponseListBlock = {
  type: "list";
  ordered: boolean;
  items: string[];
};

export type ResponseBlock =
  | ResponseParagraphBlock
  | ResponseCodeBlock
  | ResponseHeadingBlock
  | ResponseListBlock;

const CODE_FENCE_PATTERN = /^```([^\n]*)\n?([\s\S]*?)```$/;
const HEADING_PATTERN = /^(#{1,3})\s+(.+)$/;
const LIST_ITEM_PATTERN = /^\s*(?:[-*+]|\d+\.)\s+/;

export function hasInlineMarkdown(text: string) {
  return /(\*\*.+?\*\*|`[^`]+`|\*[^*]+\*|__[^_]+__)/.test(text);
}

export function stripInlineMarkdown(text: string) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

export function parseResponseBlocks(text: string): ResponseBlock[] {
  const blocks: ResponseBlock[] = [];
  const sections = text.split(/\n{2,}/);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const codeMatch = trimmed.match(CODE_FENCE_PATTERN);
    if (codeMatch) {
      blocks.push({
        type: "code",
        language: codeMatch[1]?.trim() || undefined,
        text: codeMatch[2]?.trim() ?? "",
      });
      continue;
    }

    const headingMatch = trimmed.match(HEADING_PATTERN);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      continue;
    }

    const lines = trimmed.split("\n");
    const isList =
      lines.length > 0 && lines.every((line) => LIST_ITEM_PATTERN.test(line));

    if (isList) {
      blocks.push({
        type: "list",
        ordered: /^\s*\d+\./.test(lines[0] ?? ""),
        items: lines.map((line) => line.replace(LIST_ITEM_PATTERN, "").trim()),
      });
      continue;
    }

    blocks.push({
      type: "paragraph",
      text: lines.join(" ").replace(/\s+/g, " ").trim(),
    });
  }

  return blocks.length > 0 ? blocks : [{ type: "paragraph", text: text.trim() }];
}
