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

export type ResponseBlockquoteBlock = {
  type: "blockquote";
  text: string;
};

export type ResponseRuleBlock = {
  type: "rule";
};

export type ResponseTableBlock = {
  type: "table";
  headers: string[];
  rows: string[][];
};

export type ResponseBlock =
  | ResponseParagraphBlock
  | ResponseCodeBlock
  | ResponseHeadingBlock
  | ResponseListBlock
  | ResponseBlockquoteBlock
  | ResponseRuleBlock
  | ResponseTableBlock;

const HEADING_PATTERN = /^(#{1,3})\s+(.+)$/;
const LIST_ITEM_PATTERN = /^\s*(?:[-*+]|\d+\.)\s+/;
const RULE_PATTERN = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_DIVIDER_PATTERN =
  /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

export function hasInlineMarkdown(text: string) {
  return /(\*\*.+?\*\*|`[^`]+`|\*[^*]+\*|__[^_]+__|\[[^\]]+\]\([^)]+\))/.test(
    text,
  );
}

export function stripInlineMarkdown(text: string) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function splitTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function parseResponseBlocks(text: string): ResponseBlock[] {
  const blocks: ResponseBlock[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      index++;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      index++;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index++;
      }
      if (index < lines.length) index++;
      blocks.push({
        type: "code",
        language,
        text: codeLines.join("\n").replace(/\n$/, ""),
      });
      continue;
    }

    const headingMatch = trimmed.match(HEADING_PATTERN);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1]!.length,
        text: headingMatch[2]!.trim(),
      });
      index++;
      continue;
    }

    if (RULE_PATTERN.test(trimmed)) {
      blocks.push({ type: "rule" });
      index++;
      continue;
    }

    if (
      trimmed.includes("|") &&
      index + 1 < lines.length &&
      TABLE_DIVIDER_PATTERN.test(lines[index + 1] ?? "")
    ) {
      const headers = splitTableRow(trimmed);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (LIST_ITEM_PATTERN.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (
        index < lines.length &&
        LIST_ITEM_PATTERN.test(lines[index] ?? "") &&
        /^\s*\d+\./.test(lines[index] ?? "") === ordered
      ) {
        items.push((lines[index] ?? "").replace(LIST_ITEM_PATTERN, "").trim());
        index++;
      }
      blocks.push({
        type: "list",
        ordered,
        items,
      });
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (index < lines.length && (lines[index] ?? "").trim().startsWith(">")) {
        quoteLines.push((lines[index] ?? "").trim().replace(/^>\s?/, ""));
        index++;
      }
      blocks.push({ type: "blockquote", text: quoteLines.join(" ") });
      continue;
    }

    const paragraphLines: string[] = [trimmed];
    index++;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      const nextTrimmed = next.trim();
      if (
        !nextTrimmed ||
        nextTrimmed.startsWith("```") ||
        HEADING_PATTERN.test(nextTrimmed) ||
        RULE_PATTERN.test(nextTrimmed) ||
        LIST_ITEM_PATTERN.test(next) ||
        nextTrimmed.startsWith(">")
      ) {
        break;
      }
      if (
        nextTrimmed.includes("|") &&
        index + 1 < lines.length &&
        TABLE_DIVIDER_PATTERN.test(lines[index + 1] ?? "")
      ) {
        break;
      }
      paragraphLines.push(nextTrimmed);
      index++;
    }
    blocks.push({
      type: "paragraph",
      text: paragraphLines.join(" ").replace(/\s+/g, " ").trim(),
    });
  }

  return blocks.length > 0
    ? blocks
    : text.trim()
      ? [{ type: "paragraph", text: text.trim() }]
      : [];
}
