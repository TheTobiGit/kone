// FILE: skillLint.ts
// Purpose: the static rule set for a single SKILL.md, as pure functions over
// the file text, its parsed frontmatter, and the skill folder's one-level
// listing. Never touches disk and never calls a model, so it can run on every
// keystroke while the user edits a skill in the pane.
//
// The input contract: `body` is the RAW file text, frontmatter included,
// untrimmed — the whole-file hygiene rules (final newline, trailing
// whitespace) and the frontmatter-block checks need the bytes as written.
// The module splits the frontmatter block off itself. `frontmatter` is the
// caller's parsed mapping and is the fallback when this module's inline YAML
// subset parser cannot handle the block: a caller using a fuller parser has
// already decided the block is valid, so an exotic-but-valid block must not
// be reported as broken YAML. The sibling listings are one level deep, so a
// reference deeper than its first segment can only be checked against the
// directory's name, never the directory's contents.
//
// Skipped rules, and why:
//   - sk-desc-typo: needs a real dictionary and an allowlist of AI/dev-tool
//     terms; a hand-rolled word list would flag more than it catches.
//   - sk-body-emoji: opt-in in the linters that have it; flagging emoji adds
//     noise with no routing cost.
//   - sk-ref-mutually-referenced: needs the contents of the referenced
//     files, which a one-skill, one-level input does not carry.
//   - sk-name-duplicate, sk-trigger-conflict, sk-desc-duplicate,
//     sk-listing-budget: compare several skills at once — they belong to a
//     later system-level pass over the whole install.
//   - sk-desc-vague and sk-desc-overlaps-default are implemented against
//     tiny embedded phrase lists, so they fire as info, never as warnings or
//     errors — a phrase list is a heuristic, and the severity ladder reserves
//     warnings for routing that is measurably degraded.
// Exports: lintSkill, LintInput, SkillFinding, LintSeverity

export type LintSeverity = "error" | "warning" | "info";

export type SkillFinding = {
  id: string;
  severity: LintSeverity;
  message: string;
};

export type LintInput = {
  /** The skill name as the caller knows it — the frontmatter name, or the
   *  folder name when the frontmatter omits one (what the inventory scan
   *  derives). Used as the fallback for the naming rules. */
  name: string;
  /** Basename of the skill's folder. */
  directoryName: string;
  /** The caller's parsed frontmatter mapping. */
  frontmatter: Record<string, unknown>;
  /** Raw SKILL.md text, frontmatter included, untrimmed. */
  body: string;
  /** Top-level files in the skill folder, SKILL.md included when present. */
  siblingFiles: string[];
  /** Top-level directories in the skill folder. */
  siblingDirs: string[];
};

// ── rule thresholds ──────────────────────────────────────────────────────────
// The six fields every host recognizes; anything else is ignored on load, so
// an unknown field is a silent no-op the author should know about.
const SPEC_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

// The portable name shape: lowercase alphanumeric segments joined by single
// hyphens, at most 64 characters. Anything else loads under an identifier the
// agent's routing never produces.
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;

// 60 chars is the floor below which a description cannot carry enough
// keywords to route on; 500 is the top of the healthy band; 1024 is the hard
// cap beyond which the description is invalid outright; 1536 is where
// listings start truncating the trigger tail.
const MIN_DESCRIPTION_LENGTH = 60;
const WARNING_DESCRIPTION_LENGTH = 500;
const HARD_DESCRIPTION_LENGTH = 1024;
const LISTING_CAP = 1536;

// 500 lines / ~5000 tokens is the consensus body budget; past 1500 lines the
// file is a document dump, not a triggerable skill.
const MAX_BODY_LINES = 500;
const DUMP_BODY_LINES = 1500;
const TOKEN_BUDGET = 5000;
const MAX_COMPATIBILITY_LENGTH = 500;

const NAME_RESERVED = ["claude", "anthropic", "synced"];

// Any one of these says when to fire: a trigger lead-in or a quoted user
// phrasing. The description is the whole routing surface, so its absence is
// the single highest-signal warning the lint produces.
const TRIGGER_PATTERN =
  /\b(use this skill (when|for)|use when|use for|when the user|trigger(?:s|ed)? on|activate when|invoke when)\b|"[^"\n]{4,}"/i;

// A tiny hand-written list of words that carry no concrete routing content.
// The rule fires only when every token of a long-enough description is vague,
// so a description that names any real noun or verb passes.
const VAGUE_WORDS: ReadonlySet<string> = new Set([
  "a", "about", "all", "an", "and", "any", "anything", "are", "basic", "be",
  "can", "create", "creating", "do", "does", "doing", "everything", "for",
  "general", "generic", "handle", "handles", "handling", "help", "helps", "in",
  "is", "it", "make", "makes", "making", "need", "needs", "of", "on", "or",
  "should", "simple", "skill", "skills", "some", "stuff", "that", "the",
  "things", "thing", "this", "to", "use", "used", "useful", "uses", "using",
  "various", "want", "wants", "when", "with", "work", "working", "would",
  "you", "your",
]);

// A tiny hand-written list of work the model already does without a skill;
// claiming it back makes the skill hard to trigger and costs listing space.
const OVERLAP_PHRASES = [
  "reviewing code",
  "reviewing pull requests",
  "writing tests",
  "writing code",
  "building a feature",
  "debugging",
  "answering questions",
  "general programming",
];

const NEGATIVE_PATTERN = /\b(do not|don't|not for|unless|only when|not)\b/i;
const XML_TAG_PATTERN = /<\/?[a-zA-Z\/][^>]*>/;
const FIRST_PERSON_PATTERN =
  /(\bI\s+(can|will|am|do|have|would|should|need)\b|\bMy\b|\byou\s+(can|will|should|must|need)\b)/i;

const PLACEHOLDER_PATTERN = /(replace with|example skill|\bTODO\b|\blorem\b|<your [^>]*>)/i;
const HARDCODED_PATH_PATTERN =
  /(\/Users\/[^\s`"'<>|]*|\/home\/[^\s`"'<>|]*|C:\\Users\\[^\s`"'<>|]*|~\/[^\s`"'<>|]*)/;
const GOTCHAS_PATTERN = /^##\s+Gotchas\b/m;
const SHELL_MARKER_PATTERN = /\b(bash|subprocess|os\.system|shell)\b|!\w/i;

// The tool names kone exposes to agents through its providers; an
// allowed-tools entry outside this set is a grant to something that does not
// exist. Names are compared case-insensitively.
const TOOL_CATALOG: ReadonlySet<string> = new Set([
  "read", "grep", "glob", "edit", "write", "bash", "webfetch", "websearch",
  "task", "todowrite", "notebook", "skill", "killshell",
]);
const WRITE_SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "write", "edit"]);

// A small keyword set for classifying a skill as read-only/analysis work;
// heuristic, so the rule it feeds is info.
const ANALYSIS_PATTERN = /(analyz|analysis|research|inspect|summariz|summaris|read[- ]?only|audit)/i;

// The same leading-block pattern frontmatter.ts parses with, so this module's
// frontmatter/body split and the scanner's parse always agree about what a
// file contains. The regex itself is duplicated because frontmatter.ts does
// not export it.
const FRONTMATTER_BLOCK = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

// ── YAML-subset parser ───────────────────────────────────────────────────────
// SKILL.md frontmatter is six known fields plus a nested `metadata` map, so a
// full YAML dependency is not justified; this parses exactly the subset that
// matters: mappings with nested maps, one level of block sequences, flow
// collections, and literal/folded block scalars (whose style and blank lines
// the description rules must see). Anything outside the subset throws, and
// the caller's fuller parse then decides whether the block is truly invalid.

class YamlSyntaxError extends Error {}

type YamlContainer =
  | { kind: "map"; entries: Map<string, unknown> }
  | { kind: "seq"; items: unknown[] };

const BLOCK_SCALAR_HEADER = /^[>|](?:[0-9])?(?:[+-])?$/;

// A `#` starts a comment only when it is preceded by whitespace (or is the
// first character); a `#` glued to a word is content. Quotes are honored so
// `key: "a # b"` keeps its hash — but a quote only opens when preceded by a
// delimiter, so an apostrophe in a plain value like `don't` does not start a
// quote.
function stripInlineComment(line: string): string {
  let inQuote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuote) {
      if (c === "\\" && inQuote === '"') {
        i++;
        continue;
      }
      if (c === inQuote) inQuote = null;
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || " \t:,[{".includes(line[i - 1]!))) {
      inQuote = c;
      continue;
    }
    if (c === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseDoubleQuoted(text: string): string {
  let out = "";
  let closed = false;
  let i = 1;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      const n = text[i + 1]!;
      if (n === undefined) throw new YamlSyntaxError("unterminated escape sequence");
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new YamlSyntaxError("bad unicode escape");
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else out += n;
      continue;
    }
    if (c === '"') {
      closed = true;
      i++;
      break;
    }
    out += c;
  }
  if (!closed) throw new YamlSyntaxError("unterminated double-quoted string");
  if (text.slice(i).trim() !== "") throw new YamlSyntaxError("unexpected content after quoted string");
  return out;
}

function parseSingleQuoted(text: string): string {
  let out = "";
  let closed = false;
  let i = 1;
  for (; i < text.length; i++) {
    if (text[i] === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      closed = true;
      i++;
      break;
    }
    out += text[i];
  }
  if (!closed) throw new YamlSyntaxError("unterminated single-quoted string");
  if (text.slice(i).trim() !== "") throw new YamlSyntaxError("unexpected content after quoted string");
  return out;
}

function typePlainScalar(text: string): string | number | boolean | null {
  const t = text.trim();
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  const lower = t.toLowerCase();
  if (lower === "true" || lower === "false" || lower === "yes" || lower === "no" || lower === "on" || lower === "off") {
    return lower === "true" || lower === "yes" || lower === "on";
  }
  if (/^0x[0-9a-fA-F]+$/.test(t)) return Number.parseInt(t, 16);
  if (/^-?(?:0|[1-9][0-9]*)$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(t) && /[.eE]/.test(t)) {
    return Number.parseFloat(t);
  }
  return t;
}

// Flow collections `{...}` / `[...]` for the metadata field: the shape rules
// need to see whether a flow value is a map, a list, or a scalar.
// A flow value is a scalar, a list, or a map, decided only at runtime; the shape
// rules that consume it narrow it. This parser layer names no domain type.
// eslint-disable-next-line anti-slop/no-unknown-returns
function parseFlow(text: string): unknown {
  let i = 0;

  const skipWs = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const readQuoted = (): string => {
    const quote = text[i]!;
    i++;
    let out = "";
    while (i < text.length) {
      const c = text[i]!;
      if (quote === "'") {
        if (c === "'") {
          if (text[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          i++;
          return out;
        }
        out += c;
        i++;
        continue;
      }
      if (c === "\\") {
        const n = text[i + 1]!;
        if (n === undefined) throw new YamlSyntaxError("unterminated escape sequence");
        if (n === "n") out += "\n";
        else if (n === "t") out += "\t";
        else out += n;
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return out;
      }
      out += c;
      i++;
    }
    throw new YamlSyntaxError("unterminated quoted string in flow collection");
  };
  const readBare = (): string => {
    const start = i;
    while (i < text.length && !",]}{".includes(text[i]!) && !/\s/.test(text[i]!)) i++;
    return text.slice(start, i);
  };
  // eslint-disable-next-line anti-slop/no-unknown-returns
  const parseValue = (): unknown => {
    skipWs();
    if (i >= text.length) throw new YamlSyntaxError("unexpected end of flow collection");
    const c = text[i]!;
    if (c === "{") return parseMap();
    if (c === "[") return parseSeq();
    if (c === '"' || c === "'") return readQuoted();
    return typePlainScalar(readBare());
  };
  // eslint-disable-next-line anti-slop/no-unknown-returns
  const parseMap = (): unknown => {
    i++;
    const map = new Map<string, unknown>();
    for (;;) {
      skipWs();
      if (text[i] === "}") {
        i++;
        return Object.fromEntries(map);
      }
      let key: string;
      if (text[i] === '"' || text[i] === "'") key = readQuoted();
      else {
        const start = i;
        while (i < text.length && text[i] !== ":" && text[i] !== "," && text[i] !== "}") i++;
        key = text.slice(start, i).trim();
      }
      skipWs();
      if (text[i] !== ":") throw new YamlSyntaxError("expected `:` in flow mapping");
      i++;
      map.set(key, parseValue());
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return Object.fromEntries(map);
      }
      throw new YamlSyntaxError("expected `,` or `}` in flow mapping");
    }
  };
  const parseSeq = (): unknown[] => {
    i++;
    const items: unknown[] = [];
    for (;;) {
      skipWs();
      if (text[i] === "]") {
        i++;
        return items;
      }
      items.push(parseValue());
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return items;
      }
      throw new YamlSyntaxError("expected `,` or `]` in flow sequence");
    }
  };

  const result = parseValue();
  skipWs();
  if (i !== text.length) throw new YamlSyntaxError("unexpected content after flow collection");
  return result;
}

// eslint-disable-next-line anti-slop/no-unknown-returns
function parseInlineValue(text: string): unknown {
  if (text === "") return null;
  if (text.startsWith('"')) return parseDoubleQuoted(text);
  if (text.startsWith("'")) return parseSingleQuoted(text);
  if (text.startsWith("{") || text.startsWith("[")) return parseFlow(text);
  return typePlainScalar(text);
}

// Splits a `key: value` line. A colon followed by space (or end of line)
// always splits; for mapping lines a bare colon (`key:value`) also splits,
// which matches YAML. For sequence items the colon must be followed by space,
// so `- http://x` stays a plain scalar instead of becoming a bogus key.
function splitKeyValue(
  line: string,
  requireSpaceAfterColon: boolean,
): { key: string; rest: string } | null {
  const start = line.length - line.trimStart().length;
  let inQuote: "'" | '"' | null = null;
  for (let i = start; i < line.length; i++) {
    const c = line[i]!;
    if (inQuote) {
      if (c === "\\" && inQuote === '"') {
        i++;
        continue;
      }
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      continue;
    }
    if (c !== ":") continue;
    const next = line[i + 1]!;
    const keyPart = line.slice(start, i).trim();
    if (keyPart === "") throw new YamlSyntaxError("empty mapping key");
    if (next === undefined || next === " " || next === "\t" || !requireSpaceAfterColon) {
      const key =
        keyPart.length >= 2 && (keyPart[0] === '"' || keyPart[0] === "'")
          ? keyPart[0] === '"'
            ? parseDoubleQuoted(keyPart)
            : parseSingleQuoted(keyPart)
          : keyPart;
      return { key, rest: line.slice(i + 1) };
    }
  }
  if (inQuote) throw new YamlSyntaxError("unterminated quoted key");
  return null;
}

type BlockScalar = { value: string; next: number };

// Reads the indented lines under a `|` or `>` header. Literal scalars keep
// every newline; folded scalars turn single line breaks between non-blank
// lines into spaces, with each blank line becoming a newline — so a blank
// line inside a literal description really is `\n\n` in the parsed value,
// which is exactly what sk-desc-blank-lines must detect.
function readBlockScalar(
  lines: readonly string[],
  start: number,
  keyIndent: number,
  header: string,
): BlockScalar {
  const folded = header.startsWith(">");
  const chomping = header.includes("+") ? "keep" : header.includes("-") ? "strip" : "clip";
  const explicitIndent = header.match(/[0-9]/);
  let scalarIndent = explicitIndent ? Number(explicitIndent[0]) : -1;

  const raw: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      raw.push("");
      continue;
    }
    let indent = 0;
    while (indent < line.length && line[indent] === " ") indent++;
    if (indent <= keyIndent) break;
    if (scalarIndent === -1) scalarIndent = indent;
    raw.push(line);
  }
  if (scalarIndent === -1) scalarIndent = keyIndent + 1;

  const content = raw.map((line) => (line === "" ? "" : line.slice(scalarIndent)));
  let value: string;
  if (folded) {
    let out = "";
    let lastBlank = false;
    for (const line of content) {
      if (line === "") {
        out += "\n";
        lastBlank = true;
      } else {
        if (out !== "" && !lastBlank) out += " ";
        out += line.trimEnd();
        lastBlank = false;
      }
    }
    value = out;
  } else {
    value = content.join("\n");
  }

  if (chomping === "strip") value = value.replace(/\n+$/, "");
  else if (chomping === "clip") value = value === "" ? "" : value.replace(/\n+$/, "") + "\n";
  return { value, next: i };
}

function attachValue(parent: YamlContainer, key: string, value: YamlContainer | null): void {
  if (parent.kind !== "map") throw new YamlSyntaxError("pending key under a sequence item");
  parent.entries.set(key, value === null ? null : value.kind === "map" ? value.entries : value.items);
}

type ParsedFrontmatter = { mapping: Record<string, unknown>; blockScalarKeys: string[] };

// Parses the frontmatter text between the `---` delimiters. Indentation-aware
// enough for nested `metadata:` maps and one level of block sequences; a
// top-level sequence is rejected because the frontmatter must be a mapping.
function parseFrontmatterYaml(text: string): ParsedFrontmatter {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const root: YamlContainer = { kind: "map", entries: new Map() };
  const stack: { indent: number; node: YamlContainer }[] = [{ indent: -1, node: root }];
  let pending: { parent: YamlContainer; key: string; indent: number } | null = null;
  const blockScalarKeys: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line.startsWith("\t")) throw new YamlSyntaxError("tab indentation is not allowed");

    let indent = 0;
    while (indent < line.length && line[indent] === " ") indent++;
    const content = line.slice(indent);
    if (content.startsWith("\t")) throw new YamlSyntaxError("tab indentation is not allowed");

    if (content === "-" || content.startsWith("- ")) {
      // Sequence item: either an existing sequence continues, a pending key
      // materializes as a sequence, or the document itself is a sequence
      // (which a frontmatter mapping must not be).
      if (pending) {
        if (indent > pending.indent) {
          const seq: YamlContainer = { kind: "seq", items: [] };
          attachValue(pending.parent, pending.key, seq);
          stack.push({ indent: pending.indent, node: seq });
          pending = null;
        } else {
          attachValue(pending.parent, pending.key, null);
          pending = null;
        }
      }
      while (
        stack.length > 1 &&
        (stack[stack.length - 1]!.indent > indent ||
          (stack[stack.length - 1]!.node.kind === "map" && stack[stack.length - 1]!.indent === indent))
      ) {
        stack.pop();
      }
      const top = stack[stack.length - 1]!;
      if (top.node.kind !== "seq") {
        if (top.node === root) throw new YamlSyntaxError("the document is a sequence, not a mapping");
        throw new YamlSyntaxError("a sequence cannot follow a mapping key");
      }

      const itemText = content.slice(1).trim();
      if (itemText === "" || itemText.startsWith("#")) {
        top.node.items.push(null);
        continue;
      }
      const itemNoComment = stripInlineComment(itemText).trim();
      if (BLOCK_SCALAR_HEADER.test(itemNoComment)) {
        const block = readBlockScalar(lines, i + 1, indent, itemNoComment);
        top.node.items.push(block.value);
        i = block.next - 1;
        continue;
      }
      const kv = splitKeyValue(itemNoComment, true);
      if (kv) {
        const mapItem: YamlContainer = { kind: "map", entries: new Map() };
        top.node.items.push(mapItem.entries);
        const rest = stripInlineComment(kv.rest).trim();
        if (BLOCK_SCALAR_HEADER.test(rest)) {
          const block = readBlockScalar(lines, i + 1, indent, rest);
          mapItem.entries.set(kv.key, block.value);
          blockScalarKeys.push(kv.key);
          i = block.next - 1;
        } else if (rest === "") {
          pending = { parent: mapItem, key: kv.key, indent };
        } else {
          mapItem.entries.set(kv.key, parseInlineValue(rest));
        }
        stack.push({ indent, node: mapItem });
        continue;
      }
      top.node.items.push(parseInlineValue(itemNoComment));
      continue;
    }

    // Mapping line: a pending key materializes as a nested map when the line
    // is deeper, or as null when a sibling key arrives first.
    if (pending) {
      if (indent > pending.indent) {
        const map: YamlContainer = { kind: "map", entries: new Map() };
        attachValue(pending.parent, pending.key, map);
        stack.push({ indent: pending.indent, node: map });
        pending = null;
      } else {
        attachValue(pending.parent, pending.key, null);
        pending = null;
      }
    }
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const top = stack[stack.length - 1]!;
    if (top.node.kind !== "map") throw new YamlSyntaxError("a mapping key cannot follow a sequence item");

    const kv = splitKeyValue(stripInlineComment(content).trim(), false);
    if (!kv) throw new YamlSyntaxError("expected `key: value`");
    const rest = stripInlineComment(kv.rest).trim();
    if (BLOCK_SCALAR_HEADER.test(rest)) {
      const block = readBlockScalar(lines, i + 1, indent, rest);
      top.node.entries.set(kv.key, block.value);
      blockScalarKeys.push(kv.key);
      i = block.next - 1;
    } else if (rest === "") {
      pending = { parent: top.node, key: kv.key, indent };
    } else {
      top.node.entries.set(kv.key, parseInlineValue(rest));
    }
  }

  if (pending) attachValue(pending.parent, pending.key, null);
  return { mapping: toPlainValue(Object.fromEntries(root.entries)) as Record<string, unknown>, blockScalarKeys };
}

// Containers are built as Maps and arrays; the lint consumes plain records,
// so nested maps are converted depth-first before the parse result escapes.
// eslint-disable-next-line anti-slop/no-unknown-returns
function toPlainValue(value: unknown): unknown {
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of value) out[key] = toPlainValue(child);
    return out;
  }
  if (Array.isArray(value)) return value.map(toPlainValue);
  return value;
}

// ── body helpers ─────────────────────────────────────────────────────────────

function stripFencedBlocks(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
}

// Collects file references from the body: markdown links and images, backtick
// paths that contain a separator, and `file:`/`source:` directives. URLs,
// anchors, and absolute or user-home paths are not references into the skill
// folder and are skipped.
function extractFileReferences(markdown: string): string[] {
  const found = new Set<string>();
  const push = (candidate: string, requireSlash: boolean): void => {
    let ref = candidate.trim().replace(/^(?:file|source):/i, "");
    const hashIndex = ref.indexOf("#");
    const queryIndex = ref.indexOf("?");
    const cut =
      hashIndex === -1 && queryIndex === -1
        ? ref.length
        : Math.min(...[hashIndex, queryIndex].filter((i) => i !== -1));
    ref = ref.slice(0, cut).trim();
    while (ref.startsWith("./")) ref = ref.slice(2);
    if (ref === "" || ref.startsWith("#") || ref.startsWith("/") || ref.startsWith("~")) return;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref) || ref.startsWith("www.")) return;
    if (!requireSlash || ref.includes("/") || ref.includes("\\")) found.add(ref);
  };

  const stripped = stripFencedBlocks(markdown);
  for (const m of stripped.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) push(m[1]!, false);
  for (const m of stripped.matchAll(/`([^`\n]+)`/g)) push(m[1]!, true);
  for (const m of stripped.matchAll(/(?:^|\s)(?:file|source):([^\s`"'<>|]+)/g)) push(m[1]!, false);
  return [...found];
}

// `Bash(git:*)` names the Bash tool with an argument pattern; the bare name
// is what must exist in the catalog.
function parseToolNames(list: string): string[] {
  return list
    .split(/[\s,]+/)
    .map((part) => part.replace(/\(.*$/, "").replace(/:+$/, "").trim())
    .filter((part) => part !== "");
}

// ── the lint ─────────────────────────────────────────────────────────────────

export function lintSkill(input: LintInput): SkillFinding[] {
  const findings: SkillFinding[] = [];
  const body = input.body.replace(/\r\n/g, "\n");

  const blockMatch = FRONTMATTER_BLOCK.exec(body);
  let mine: { mapping: Record<string, unknown>; blockScalarKeys: string[] } | null = null;
  let mineFailed = false;
  let markdownBody = body;
  if (blockMatch) {
    try {
      mine = parseFrontmatterYaml(blockMatch[1]!);
    } catch {
      mineFailed = true;
    }
    markdownBody = body.slice(blockMatch[0].length);
  }
  const callerFmPresent = Object.keys(input.frontmatter).length > 0;

  let fm: Record<string, unknown>;
  if (mine) {
    fm = mine.mapping;
  } else if (mineFailed && callerFmPresent) {
    fm = input.frontmatter;
  } else if (mineFailed) {
    findings.push({
      id: "sk-fm-invalid-yaml",
      severity: "error",
      message: "Frontmatter isn't valid YAML — the skill loads with empty metadata and can never auto-trigger.",
    });
    fm = {};
  } else {
    if (!callerFmPresent) {
      findings.push({
        id: "sk-fm-no-frontmatter",
        severity: "error",
        message: "No YAML frontmatter — a `description` is the only thing that makes the model route to this skill.",
      });
    }
    fm = input.frontmatter;
  }

  // ── 6.1 structural ──────────────────────────────────────────────────────
  // The listing is the only file-system evidence a single-skill lint sees:
  // when it shows neither casing of the entry file, the folder has none.
  if (!input.siblingFiles.includes("SKILL.md") && !input.siblingFiles.includes("skill.md")) {
    findings.push({
      id: "sk-structure-missing-file",
      severity: "error",
      message: "Missing `SKILL.md` — every skill needs a `SKILL.md` file at its root.",
    });
  }

  const fmName = typeof fm.name === "string" ? fm.name.trim() : "";
  const effectiveName = fmName !== "" ? fmName : input.name.trim();
  if (fmName === "") {
    findings.push({
      id: "sk-name-missing",
      severity: "error",
      message: "Missing `name` — add `name: <folder-name>` to the frontmatter.",
    });
  }

  const fmDesc = typeof fm.description === "string" ? fm.description : null;
  if (fm.description !== undefined && typeof fm.description !== "string") {
    const typeName = fm.description === null ? "null" : typeof fm.description;
    findings.push({
      id: "sk-desc-not-string",
      severity: "error",
      message: `\`description\` parsed as a \`${typeName}\` — quote it: \`description: "…"\`.`,
    });
  } else if (fmDesc === null || fmDesc.trim() === "") {
    findings.push({
      id: "sk-desc-missing",
      severity: "error",
      message: "Missing `description` — without one, the model has nothing to route on.",
    });
  }

  const unknownFields = Object.keys(fm).filter((key) => !SPEC_FIELDS.has(key)).sort();
  for (const key of unknownFields) {
    findings.push({
      id: "sk-fm-unknown-field",
      severity: "error",
      message: `Unknown frontmatter field \`${key}\` — kone ignores it; only name, description, license, compatibility, metadata, and allowed-tools are supported.`,
    });
  }

  const bodyEmpty = markdownBody.trim() === "";
  if (bodyEmpty) {
    findings.push({
      id: "sk-body-empty",
      severity: "error",
      message: "The skill body is empty — write the instructions the agent should follow.",
    });
  }

  // ── 6.2 naming ──────────────────────────────────────────────────────────
  if (effectiveName !== "") {
    const normalized = effectiveName.normalize("NFKC");
    if (normalized.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(normalized)) {
      findings.push({
        id: "sk-name-charset",
        severity: "error",
        message: "Skill name must be lowercase letters/digits with single hyphens (e.g. `code-review`), 64 chars max.",
      });
    }
    if (normalized !== input.directoryName.normalize("NFKC")) {
      findings.push({
        id: "sk-name-dir-mismatch",
        severity: "warning",
        message: `Name \`${effectiveName}\` doesn't match folder \`${input.directoryName}\` — the skill loads under the folder name, so the label will mislead.`,
      });
    }
    const lowered = normalized.toLowerCase();
    const reserved = NAME_RESERVED.find((word) => lowered.includes(word));
    if (reserved) {
      findings.push({
        id: "sk-name-reserved",
        severity: "info",
        message: `Name contains \`${reserved}\` — reserved namespaces can shadow or break the skill on some hosts.`,
      });
    }
  }

  // ── 6.3 description (the routing surface) ───────────────────────────────
  const desc = fmDesc !== null && fmDesc.trim() !== "" ? fmDesc.trim() : null;
  if (desc !== null) {
    const descLen = desc.length;
    if (descLen < MIN_DESCRIPTION_LENGTH) {
      findings.push({
        id: "sk-desc-too-short",
        severity: "warning",
        message: `Description is \`${descLen}\` chars — too short to route on; add what the skill does and the user phrasings that should trigger it.`,
      });
    } else if (descLen > HARD_DESCRIPTION_LENGTH) {
      findings.push({
        id: "sk-desc-too-long",
        severity: "error",
        message: `Description is \`${descLen}\` chars — trim toward 100–500; over 1024 is invalid and every char eats the shared listing budget.`,
      });
    } else if (descLen > WARNING_DESCRIPTION_LENGTH) {
      findings.push({
        id: "sk-desc-too-long",
        severity: "warning",
        message: `Description is \`${descLen}\` chars — trim toward 100–500; every char past that eats the shared listing budget.`,
      });
    }

    const whenToUse = typeof fm.when_to_use === "string" ? fm.when_to_use : "";
    if (descLen + whenToUse.length > LISTING_CAP) {
      findings.push({
        id: "sk-desc-listing-cap",
        severity: "info",
        message: "Description is long enough that Claude Code truncates it in the skill listing — the trigger tail may be cut off.",
      });
    }

    if (!TRIGGER_PATTERN.test(desc)) {
      findings.push({
        id: "sk-desc-no-trigger",
        severity: "warning",
        message: "Description never says when to use the skill — add 'Use when…' plus example phrasings.",
      });
    }

    const tokens = desc.toLowerCase().match(/[a-z]+/g) ?? [];
    if (tokens.length >= 6 && tokens.every((token) => VAGUE_WORDS.has(token))) {
      findings.push({
        id: "sk-desc-vague",
        severity: "info",
        message: "Description is mostly vague filler — name the concrete tasks, formats, and trigger scenarios.",
      });
    }

    if (OVERLAP_PHRASES.some((phrase) => desc.toLowerCase().includes(phrase))) {
      findings.push({
        id: "sk-desc-overlaps-default",
        severity: "info",
        message: "Description overlaps what the model already does on its own — it may never trigger and adds listing bloat.",
      });
    }

    if (!NEGATIVE_PATTERN.test(desc)) {
      findings.push({
        id: "sk-desc-no-negatives",
        severity: "info",
        message: "Description has no 'do not trigger on…' line — near-miss requests may fire it wrongly.",
      });
    }

    if (XML_TAG_PATTERN.test(desc)) {
      findings.push({
        id: "sk-desc-xml-tags",
        severity: "error",
        message: "Description contains `<…>` markup, which hosts escape or strip — remove it.",
      });
    }

    if (FIRST_PERSON_PATTERN.test(desc)) {
      findings.push({
        id: "sk-desc-first-person",
        severity: "info",
        message: "Description is written in first/second person — route on 'when the user…' phrasing instead.",
      });
    }
  }

  // Blank lines only reach a parsed description through a block scalar; the
  // style matters, so this needs this module's own parse, which records it.
  if (
    mine &&
    mine.blockScalarKeys.includes("description") &&
    typeof mine.mapping.description === "string" &&
    mine.mapping.description.includes("\n\n")
  ) {
    findings.push({
      id: "sk-desc-blank-lines",
      severity: "info",
      message: "Description contains blank lines from YAML folding — they inject `\n\n` into the trigger text.",
    });
  }

  // ── 6.4 body ────────────────────────────────────────────────────────────
  const bodyLines = markdownBody.split("\n").length;
  if (bodyLines > DUMP_BODY_LINES) {
    findings.push({
      id: "sk-body-way-too-long",
      severity: "error",
      message: `Body is \`${bodyLines}\` lines — this is a document dump, not a triggerable skill; split it into references.`,
    });
  } else if (bodyLines > MAX_BODY_LINES) {
    findings.push({
      id: "sk-body-too-long",
      severity: "warning",
      message: `Body is \`${bodyLines}\` lines — keep SKILL.md under 500 lines; move detail into reference files.`,
    });
  }

  const estimatedTokens = Math.ceil(markdownBody.length / 4);
  if (estimatedTokens > TOKEN_BUDGET) {
    findings.push({
      id: "sk-body-token-budget",
      severity: "warning",
      message: `Body is ~\`${estimatedTokens}\` tokens — past ~5,000 tokens it bloats every activation; split it up.`,
    });
  }

  if (!bodyEmpty) {
    if (PLACEHOLDER_PATTERN.test(markdownBody)) {
      findings.push({
        id: "sk-body-placeholder",
        severity: "warning",
        message: "Body still has placeholder text — write real instructions or the skill runs nothing.",
      });
    }

    const strippedBody = stripFencedBlocks(markdownBody);
    const pathMatch = HARDCODED_PATH_PATTERN.exec(strippedBody);
    if (pathMatch) {
      const snippet = pathMatch[1]!.length > 40 ? `${pathMatch[1]!.slice(0, 40)}…` : pathMatch[1]!;
      findings.push({
        id: "sk-body-hardcoded-path",
        severity: "warning",
        message: `Body hardcodes \`${snippet}\` from your machine — it breaks on any other computer.`,
      });
    }

    if (!GOTCHAS_PATTERN.test(markdownBody)) {
      findings.push({
        id: "sk-body-gotchas",
        severity: "info",
        message: "No 'Gotchas' section — the highest-value content in many skills is concrete failure modes to avoid.",
      });
    }

    const bundledEntries = [...input.siblingDirs, ...input.siblingFiles].filter(
      (entry) => entry !== "SKILL.md" && entry !== "skill.md" && !entry.startsWith("."),
    );
    if (bodyLines > 200 && bundledEntries.length === 0) {
      findings.push({
        id: "sk-body-structure",
        severity: "info",
        message: `Body is \`${bodyLines}\` lines with no bundled files — consider moving detail into \`references/\` or \`scripts/\`.`,
      });
    }
  }

  // ── 6.5 bundled files ───────────────────────────────────────────────────
  const refs = extractFileReferences(markdownBody);
  for (const ref of refs) {
    if (ref.startsWith("../") || ref.split("/").includes("..")) {
      findings.push({
        id: "sk-ref-escape",
        severity: "error",
        message: `Reference \`${ref}\` resolves outside the skill folder — keep all references inside it.`,
      });
      continue;
    }
    const segments = ref.split("/").filter((segment) => segment !== "" && segment !== ".");
    if (segments.length === 0) continue;
    const exists =
      segments.length === 1
        ? input.siblingFiles.includes(segments[0]!) || input.siblingDirs.includes(segments[0]!)
        : input.siblingDirs.includes(segments[0]!);
    if (!exists) {
      findings.push({
        id: "sk-ref-broken",
        severity: "error",
        message: `Body references \`${ref}\`, which doesn't exist in the skill folder — the agent will hit a dead link.`,
      });
      continue;
    }
    const depth = ref.endsWith("/") ? segments.length : segments.length - 1;
    if (depth > 1) {
      findings.push({
        id: "sk-ref-depth",
        severity: "warning",
        message: `Reference \`${ref}\` is \`${depth}\` levels deep — keep references one level deep from SKILL.md.`,
      });
    }
  }

  const orphanCandidates = [...input.siblingFiles].sort();
  const strippedBody = stripFencedBlocks(markdownBody);
  for (const entry of orphanCandidates) {
    if (entry === "SKILL.md" || entry === "skill.md" || entry.startsWith(".") || entry === "evals") continue;
    if (!strippedBody.includes(entry)) {
      findings.push({
        id: "sk-orphan-file",
        severity: "warning",
        message: `File \`${entry}\` is bundled but never mentioned in the body — the agent won't know it exists; reference it and say when to read it.`,
      });
    }
  }

  // ── 6.6 tools, compatibility, metadata ──────────────────────────────────
  const allowedTools = fm["allowed-tools"];
  if (allowedTools !== undefined) {
    if (typeof allowedTools !== "string" || allowedTools.trim() === "") {
      findings.push({
        id: "sk-tools-bad-format",
        severity: "warning",
        message: "`allowed-tools` must be a space-separated list of tool names (e.g. `Bash(git:*) Read`).",
      });
    } else {
      const granted = parseToolNames(allowedTools);
      const seen = new Set<string>();
      for (const name of granted) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (!TOOL_CATALOG.has(key)) {
          findings.push({
            id: "sk-tools-unknown",
            severity: "warning",
            message: `\`allowed-tools\` names \`${name}\`, which isn't a tool kone exposes — the grant is dead.`,
          });
        }
      }
      if (desc !== null && ANALYSIS_PATTERN.test(desc)) {
        const seenGranted = new Set<string>();
        const overgranted: string[] = [];
        for (const name of granted) {
          const key = name.toLowerCase();
          if (seenGranted.has(key) || !WRITE_SHELL_TOOLS.has(key)) continue;
          seenGranted.add(key);
          overgranted.push(name);
        }
        if (overgranted.length > 0) {
          findings.push({
            id: "sk-tools-overgranted",
            severity: "info",
            message: `Read-only skill grants ${overgranted.map((name) => `\`${name}\``).join(" and ")} — consider dropping write/shell access.`,
          });
        }
      }
    }
  }
  const hasAllowedTools = typeof allowedTools === "string" && allowedTools.trim() !== "";
  if (!hasAllowedTools && SHELL_MARKER_PATTERN.test(strippedBody)) {
    findings.push({
      id: "sk-tools-no-tools-when-shelling",
      severity: "info",
      message: "Body runs shell commands but `allowed-tools` is unset — every command will need approval.",
    });
  }

  if (typeof fm.compatibility === "string" && fm.compatibility.length > MAX_COMPATIBILITY_LENGTH) {
    findings.push({
      id: "sk-compat-too-long",
      severity: "warning",
      message: `\`compatibility\` is \`${fm.compatibility.length}\` chars — the spec caps it at 500.`,
    });
  }

  const metadata = fm.metadata;
  if (metadata !== undefined) {
    const isMap = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata);
    const allStringValues =
      isMap && Object.values(metadata as Record<string, unknown>).every((value) => typeof value === "string");
    if (!isMap || !allStringValues) {
      findings.push({
        id: "sk-metadata-shape",
        severity: "warning",
        message: "`metadata` must be a map of string keys to string values.",
      });
    }
    if (isMap) {
      const shadowed = Object.keys(metadata as Record<string, unknown>)
        .filter((key) => SPEC_FIELDS.has(key))
        .sort();
      for (const key of shadowed) {
        findings.push({
          id: "sk-hygiene-unknown-metadata-keys",
          severity: "info",
          message: `\`metadata\` key \`${key}\` shadows a frontmatter field name — hosts may read the wrong value.`,
        });
      }
    }
  }

  // ── 6.7 hygiene ─────────────────────────────────────────────────────────
  if (input.siblingFiles.includes("skill.md")) {
    findings.push({
      id: "sk-hygiene-case",
      severity: "info",
      message: "File is `skill.md` — use all-caps `SKILL.md` for maximum compatibility.",
    });
  }

  if (body !== "" && !body.endsWith("\n")) {
    findings.push({
      id: "sk-hygiene-final-newline",
      severity: "info",
      message: "Missing trailing newline — add one to keep diffs and tooling clean.",
    });
  }

  const wsLines: number[] = [];
  const bodyLinesArr = body.split("\n");
  for (let i = 0; i < bodyLinesArr.length; i++) {
    if (/[ \t]+$/.test(bodyLinesArr[i]!)) wsLines.push(i + 1);
  }
  for (let i = 0; i < Math.min(wsLines.length, 10); i++) {
    findings.push({
      id: "sk-hygiene-trailing-ws",
      severity: "info",
      message: `Trailing whitespace on line \`${wsLines[i]!}\` — strip it.`,
    });
  }
  if (wsLines.length > 10) {
    findings.push({
      id: "sk-hygiene-trailing-ws",
      severity: "info",
      message: `Trailing whitespace on \`${wsLines.length - 10}\` more lines — strip it.`,
    });
  }

  return findings;
}
