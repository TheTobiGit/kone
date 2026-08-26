// FILE: onDemandDocs.ts
// Purpose: generates concise on-demand documentation and guideline index prompts.
// Instead of preloading thousands of tokens of full SKILL.md / AGENTS.md /
// CLAUDE.md files into the context window,
// it formats a compact index (<500 tokens) with summary descriptions and file paths,
// instructing the model to use its `read` tool to load relevant files on-demand.
// Exports: formatOnDemandSkillIndex, formatOnDemandRuleIndex, formatOnDemandDocIndex,
//          formatOnDemandInventoryIndex, estimateTokenCount, sanitizeSummary,
//          DEFAULT_MAX_SUMMARY_CHARS, DEFAULT_SKILL_XML_TAG, DEFAULT_RULE_XML_TAG,
//          DEFAULT_DOC_XML_TAG, OnDemandSkillItem, OnDemandRuleItem, OnDemandDocItem,
//          OnDemandIndexOptions, OnDemandIndexFormat

import path from "node:path";

import type { AgentInventory, InstructionFile, SkillEntry } from "./types.js";

export const DEFAULT_MAX_SUMMARY_CHARS = 160;
export const DEFAULT_SKILL_XML_TAG = "available_skills";
export const DEFAULT_RULE_XML_TAG = "available_rules";
export const DEFAULT_DOC_XML_TAG = "available_docs";

export type OnDemandIndexFormat = "xml" | "markdown";

/** One skill entry suitable for on-demand indexing. Accepts `SkillEntry` directly. */
export type OnDemandSkillItem = {
  readonly name: string;
  readonly description?: string | null;
  readonly shortDescription?: string | null;
  readonly path: string;
  readonly directory?: string;
  readonly scope?: "user" | "project" | "plugin" | "system" | string;
  readonly origin?: string;
  readonly manualOnly?: boolean;
  readonly displayName?: string | null;
};

/** One rule or instruction file suitable for on-demand indexing. Accepts `InstructionFile` directly. */
export type OnDemandRuleItem = {
  readonly path: string;
  readonly name?: string;
  readonly title?: string;
  readonly kind?: "AGENTS.md" | "CLAUDE.md" | "other" | string;
  readonly scope?: "user" | "project" | "nested" | string;
  readonly excerpt?: string | null;
  readonly description?: string | null;
};

/** A generic document entry for on-demand indexing. */
export type OnDemandDocItem = {
  readonly name: string;
  readonly path: string;
  readonly description?: string | null;
  readonly scope?: string | null;
  readonly category?: string | null;
};

/** Configuration options for on-demand index generation. */
export type OnDemandIndexOptions = {
  /** Maximum length for individual summary descriptions (default: 160 chars). */
  readonly maxSummaryChars?: number;
  /** Whether to include file paths in each index entry (default: true). */
  readonly includePath?: boolean;
  /** Whether to include manual-only skills (default: false). */
  readonly includeManualOnly?: boolean;
  /** Output style: "xml" (enclosed in tags) or "markdown" (default: "xml"). */
  readonly format?: OnDemandIndexFormat;
  /** Custom XML tag name when format is "xml". */
  readonly xmlTag?: string;
  /** Custom preamble/instructions text to override the default header. */
  readonly customHeader?: string;
  /** When true, renders an index block even when the list is empty (default: false). */
  readonly renderEmpty?: boolean;
  /** Optional base path to compute relative display paths against. */
  readonly relativeTo?: string;
};

/** Cleans and collapses multi-line descriptions into a concise single-line summary,
 *  truncating at word boundaries if it exceeds `maxChars`. */
export function sanitizeSummary(
  raw: string | null | undefined,
  maxChars: number = DEFAULT_MAX_SUMMARY_CHARS,
): string {
  if (!raw) return "";

  // Strip frontmatter delimiters and markdown heading/bullet marks
  const withoutFrontmatter = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
  const withoutHeadings = withoutFrontmatter.replace(/^#{1,6}\s+/gm, "");
  const withoutBullets = withoutHeadings.replace(/^[-*+]\s+/gm, "");

  // Collapse whitespace and trim
  const collapsed = withoutBullets.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }

  // Truncate at word boundary
  const truncated = collapsed.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.6) {
    return `${truncated.slice(0, lastSpace).trim()}…`;
  }
  return `${truncated.trim()}…`;
}

/** Simple character-based token estimator (~4 chars per token). */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function resolveDisplayPath(filePath: string, relativeTo?: string): string {
  if (!relativeTo) return filePath;
  try {
    const rel = path.relative(relativeTo, filePath);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel;
    }
    return filePath;
  } catch {
    return filePath;
  }
}

/** Formats a concise on-demand skill index (<500 tokens) with summary descriptions
 *  and file paths, instructing the model to read full files on-demand. */
export function formatOnDemandSkillIndex(
  skills: readonly (OnDemandSkillItem | SkillEntry)[],
  options: OnDemandIndexOptions = {},
): string {
  const {
    maxSummaryChars = DEFAULT_MAX_SUMMARY_CHARS,
    includePath = true,
    includeManualOnly = false,
    format = "xml",
    xmlTag = DEFAULT_SKILL_XML_TAG,
    customHeader,
    renderEmpty = false,
    relativeTo,
  } = options;

  const eligibleSkills = skills.filter((skill) => {
    if (!includeManualOnly && skill.manualOnly) return false;
    return true;
  });

  if (eligibleSkills.length === 0 && !renderEmpty) {
    return "";
  }

  const header =
    customHeader ??
    "The following skills provide specialized domain instructions and workflows. " +
      "When a task matches a skill's description, use the read tool to load its full " +
      "documentation from the specified path before taking action:";

  const lines: string[] = [];

  for (const skill of eligibleSkills) {
    const name = skill.displayName || skill.name;
    const rawSummary = skill.shortDescription || skill.description || "Domain guidance and instructions.";
    const summary = sanitizeSummary(rawSummary, maxSummaryChars);
    const scopeTag = skill.scope ? ` (${skill.scope})` : "";
    const displayPath = resolveDisplayPath(skill.path, relativeTo);
    const pathTag = includePath ? ` [Path: ${displayPath}]` : "";

    if (format === "markdown") {
      lines.push(`- **${name}**${scopeTag}: ${summary}${pathTag}`);
    } else {
      lines.push(`- ${name}${scopeTag}: ${summary}${pathTag}`);
    }
  }

  if (format === "markdown") {
    const content = lines.length > 0 ? lines.join("\n") : "_No skills available._";
    return `### Available Skills\n\n${header}\n\n${content}`;
  }

  const content = lines.length > 0 ? lines.join("\n") : "(none)";
  return `<${xmlTag}>\n${header}\n\n${content}\n</${xmlTag}>`;
}

/** Formats a concise on-demand rule & instruction index with summary excerpts
 *  and file paths for AGENTS.md / CLAUDE.md / project guidelines. */
export function formatOnDemandRuleIndex(
  rules: readonly (OnDemandRuleItem | InstructionFile)[],
  options: OnDemandIndexOptions = {},
): string {
  const {
    maxSummaryChars = DEFAULT_MAX_SUMMARY_CHARS,
    includePath = true,
    format = "xml",
    xmlTag = DEFAULT_RULE_XML_TAG,
    customHeader,
    renderEmpty = false,
    relativeTo,
  } = options;

  if (rules.length === 0 && !renderEmpty) {
    return "";
  }

  const header =
    customHeader ??
    "The following guideline and instruction files define rules, conventions, and constraints. " +
      "When working in the relevant scope or when a task touches these areas, use the read tool " +
      "to load the full document from the specified path:";

  const lines: string[] = [];

  for (const rule of rules) {
    // `InstructionFile` carries none of name/title/description, so each is read
    // through an `in` guard and the chain falls through to kind, then basename.
    const name =
      ("name" in rule ? rule.name : undefined) ||
      ("title" in rule ? rule.title : undefined) ||
      ("kind" in rule && rule.kind ? rule.kind : undefined) ||
      path.basename(rule.path);

    const rawSummary =
      ("description" in rule ? rule.description : undefined) ||
      ("excerpt" in rule && rule.excerpt ? rule.excerpt : undefined) ||
      "Project rules, conventions, and instruction set.";

    const summary = sanitizeSummary(rawSummary, maxSummaryChars);
    const scopeTag = rule.scope ? ` (${rule.scope})` : "";
    const displayPath = resolveDisplayPath(rule.path, relativeTo);
    const pathTag = includePath ? ` [Path: ${displayPath}]` : "";

    if (format === "markdown") {
      lines.push(`- **${name}**${scopeTag}: ${summary}${pathTag}`);
    } else {
      lines.push(`- ${name}${scopeTag}: ${summary}${pathTag}`);
    }
  }

  if (format === "markdown") {
    const content = lines.length > 0 ? lines.join("\n") : "_No rules available._";
    return `### Available Rules & Guidelines\n\n${header}\n\n${content}`;
  }

  const content = lines.length > 0 ? lines.join("\n") : "(none)";
  return `<${xmlTag}>\n${header}\n\n${content}\n</${xmlTag}>`;
}

/** Formats a generic on-demand document index for arbitrary documentation items. */
export function formatOnDemandDocIndex(
  docs: readonly OnDemandDocItem[],
  options: OnDemandIndexOptions = {},
): string {
  const {
    maxSummaryChars = DEFAULT_MAX_SUMMARY_CHARS,
    includePath = true,
    format = "xml",
    xmlTag = DEFAULT_DOC_XML_TAG,
    customHeader,
    renderEmpty = false,
    relativeTo,
  } = options;

  if (docs.length === 0 && !renderEmpty) {
    return "";
  }

  const header =
    customHeader ??
    "The following reference documents are available. Use the read tool to inspect " +
      "a document's full contents from the specified path on demand:";

  const lines: string[] = [];

  for (const doc of docs) {
    const summary = sanitizeSummary(doc.description || "Reference documentation.", maxSummaryChars);
    const categoryTag = doc.category ? ` [${doc.category}]` : "";
    const scopeTag = doc.scope ? ` (${doc.scope})` : "";
    const displayPath = resolveDisplayPath(doc.path, relativeTo);
    const pathTag = includePath ? ` [Path: ${displayPath}]` : "";

    if (format === "markdown") {
      lines.push(`- **${doc.name}**${categoryTag}${scopeTag}: ${summary}${pathTag}`);
    } else {
      lines.push(`- ${doc.name}${categoryTag}${scopeTag}: ${summary}${pathTag}`);
    }
  }

  if (format === "markdown") {
    const content = lines.length > 0 ? lines.join("\n") : "_No documentation available._";
    return `### Available Documentation\n\n${header}\n\n${content}`;
  }

  const content = lines.length > 0 ? lines.join("\n") : "(none)";
  return `<${xmlTag}>\n${header}\n\n${content}\n</${xmlTag}>`;
}

/** Formats both skills and instruction files from an `AgentInventory` snapshot into
 *  a unified on-demand prompt block, keeping prompt overhead to a minimum. */
export function formatOnDemandInventoryIndex(
  inventory: Pick<AgentInventory, "skills" | "instructions">,
  options: OnDemandIndexOptions = {},
): string {
  // The two sections are wrapped in distinct tags, so a single shared `xmlTag`
  // would label both identically. Each section keeps its own tag here.
  const { xmlTag: _sharedXmlTag, ...shared } = options;
  const skillIndex = formatOnDemandSkillIndex(inventory.skills, {
    ...shared,
    xmlTag: DEFAULT_SKILL_XML_TAG,
  });
  const ruleIndex = formatOnDemandRuleIndex(inventory.instructions, {
    ...shared,
    xmlTag: DEFAULT_RULE_XML_TAG,
  });

  const sections = [skillIndex, ruleIndex].filter((s) => s.length > 0);
  return sections.join("\n\n");
}
