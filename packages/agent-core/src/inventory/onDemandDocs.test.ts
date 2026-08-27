// FILE: onDemandDocs.test.ts
// Purpose: unit tests for the on-demand skill, rule, and document indexer.
// Verifies anti-bloat prompt formatting, summary sanitization, token budget constraints,
// manual-only filtering, relative path resolution, and Markdown/XML rendering modes.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_RULE_XML_TAG,
  DEFAULT_SKILL_XML_TAG,
  estimateTokenCount,
  formatOnDemandDocIndex,
  formatOnDemandInventoryIndex,
  formatOnDemandRuleIndex,
  formatOnDemandSkillIndex,
  type OnDemandDocItem,
  type OnDemandRuleItem,
  type OnDemandSkillItem,
  sanitizeSummary,
} from "./onDemandDocs.js";
import type { InstructionFile, SkillEntry } from "./types.js";

describe("sanitizeSummary", () => {
  test("returns empty string for null, undefined, or empty inputs", () => {
    expect(sanitizeSummary(null)).toBe("");
    expect(sanitizeSummary(undefined)).toBe("");
    expect(sanitizeSummary("")).toBe("");
    expect(sanitizeSummary("   \n\t  ")).toBe("");
  });

  test("collapses multi-line text and whitespace into a single line", () => {
    const raw = "First line of text.\n\nSecond line with   extra   spaces.\nThird line.";
    const result = sanitizeSummary(raw);
    expect(result).toBe("First line of text. Second line with extra spaces. Third line.");
  });

  test("strips YAML frontmatter blocks", () => {
    const raw = "---\nname: my-skill\ndescription: Frontmatter desc\n---\nActual body description for the skill.";
    const result = sanitizeSummary(raw);
    expect(result).toBe("Actual body description for the skill.");
  });

  test("strips markdown headings and bullet prefixes", () => {
    const raw = "### Overview\n- First point about the tool\n* Second point about behavior\n+ Third point.";
    const result = sanitizeSummary(raw);
    expect(result).toBe("Overview First point about the tool Second point about behavior Third point.");
  });

  test("truncates long text at word boundaries with an ellipsis", () => {
    const longText =
      "This is a very long description that goes on and on to explain all the intricate details of how this specific tool works across different operating systems and environments.";
    const maxChars = 45;
    const result = sanitizeSummary(longText, maxChars);

    expect(result.length).toBeLessThanOrEqual(maxChars + 1); // +1 for the single '…' char
    expect(result.endsWith("…")).toBe(true);
    expect(result).toBe("This is a very long description that goes on…");
  });
});

describe("estimateTokenCount", () => {
  test("returns 0 for empty or null strings", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  test("estimates roughly 1 token per 4 characters", () => {
    expect(estimateTokenCount("1234")).toBe(1);
    expect(estimateTokenCount("12345678")).toBe(2);
    expect(estimateTokenCount("a".repeat(100))).toBe(25);
  });
});

describe("formatOnDemandSkillIndex", () => {
  const sampleSkills: SkillEntry[] = [
    {
      name: "remotion-best-practices",
      displayName: "Remotion Best Practices",
      description: "Comprehensive guide and patterns for building video components, transitions, and audio sync.",
      shortDescription: "Best practices for Remotion video components.",
      path: "/Users/dev/.claude/skills/remotion-best-practices/SKILL.md",
      directory: "/Users/dev/.claude/skills/remotion-best-practices",
      origin: "claude",
      scope: "user",
      author: null,
      shadowedBy: [],
      manualOnly: false,
    },
    {
      name: "sql-optimizer",
      displayName: null,
      description: "Analyzes SQLite and Postgres queries, recommends indexing strategies and query rewrites.",
      shortDescription: null,
      path: "/Users/dev/.codex/skills/sql-optimizer/SKILL.md",
      directory: "/Users/dev/.codex/skills/sql-optimizer",
      origin: "codex",
      scope: "project",
      author: "Database Team",
      shadowedBy: [],
      manualOnly: false,
    },
    {
      name: "manual-danger-op",
      displayName: "Manual Danger Operation",
      description: "Performs sensitive migrations that require explicit human approval.",
      shortDescription: null,
      path: "/Users/dev/.claude/skills/manual-danger-op/SKILL.md",
      directory: "/Users/dev/.claude/skills/manual-danger-op",
      origin: "claude",
      scope: "user",
      author: null,
      shadowedBy: [],
      manualOnly: true,
    },
  ];

  test("formats skills into XML format with default tag and prompt instructions", () => {
    const output = formatOnDemandSkillIndex(sampleSkills);

    expect(output).toContain(`<${DEFAULT_SKILL_XML_TAG}>`);
    expect(output).toContain(`</${DEFAULT_SKILL_XML_TAG}>`);
    expect(output).toContain("When a task matches a skill's description, use the read tool");
    expect(output).toContain("- Remotion Best Practices (user): Best practices for Remotion video components. [Path: /Users/dev/.claude/skills/remotion-best-practices/SKILL.md]");
    expect(output).toContain("- sql-optimizer (project): Analyzes SQLite and Postgres queries, recommends indexing strategies and query rewrites. [Path: /Users/dev/.codex/skills/sql-optimizer/SKILL.md]");
  });

  test("filters out manual-only skills by default", () => {
    const output = formatOnDemandSkillIndex(sampleSkills);
    expect(output).not.toContain("manual-danger-op");
  });

  test("includes manual-only skills when includeManualOnly is true", () => {
    const output = formatOnDemandSkillIndex(sampleSkills, { includeManualOnly: true });
    expect(output).toContain("Manual Danger Operation");
  });

  test("omits paths when includePath is false", () => {
    const output = formatOnDemandSkillIndex(sampleSkills, { includePath: false });
    expect(output).not.toContain("[Path:");
    expect(output).toContain("- Remotion Best Practices (user): Best practices for Remotion video components.");
  });

  test("supports Markdown format", () => {
    const output = formatOnDemandSkillIndex(sampleSkills, { format: "markdown" });

    expect(output).toContain("### Available Skills");
    expect(output).toContain("- **Remotion Best Practices** (user): Best practices for Remotion video components. [Path: /Users/dev/.claude/skills/remotion-best-practices/SKILL.md]");
    expect(output).not.toContain(`<${DEFAULT_SKILL_XML_TAG}>`);
  });

  test("supports custom XML tag and custom header", () => {
    const customHeader = "Special skills registry for this agent session:";
    const output = formatOnDemandSkillIndex(sampleSkills, {
      xmlTag: "skills_catalog",
      customHeader,
    });

    expect(output).toContain("<skills_catalog>");
    expect(output).toContain("</skills_catalog>");
    expect(output).toContain(customHeader);
  });

  test("returns empty string when skills list is empty and renderEmpty is false", () => {
    expect(formatOnDemandSkillIndex([])).toBe("");
  });

  test("returns empty structure when renderEmpty is true", () => {
    const xmlOutput = formatOnDemandSkillIndex([], { renderEmpty: true });
    expect(xmlOutput).toContain(`<${DEFAULT_SKILL_XML_TAG}>`);
    expect(xmlOutput).toContain("(none)");

    const mdOutput = formatOnDemandSkillIndex([], { format: "markdown", renderEmpty: true });
    expect(mdOutput).toContain("### Available Skills");
    expect(mdOutput).toContain("_No skills available._");
  });

  test("resolves relative paths when relativeTo is supplied", () => {
    const output = formatOnDemandSkillIndex(sampleSkills, {
      relativeTo: "/Users/dev/.claude",
    });

    expect(output).toContain("[Path: skills/remotion-best-practices/SKILL.md]");
  });

  test("keeps token count well under 500 tokens for typical library of 10 skills", () => {
    const tenSkills: OnDemandSkillItem[] = Array.from({ length: 10 }, (_, i) => ({
      name: `skill-module-${i + 1}`,
      description: `Handles domain operations and automated workflows for sub-system ${i + 1}.`,
      path: `/workspace/project/.skills/skill-module-${i + 1}/SKILL.md`,
      scope: "project",
    }));

    const output = formatOnDemandSkillIndex(tenSkills);
    const estimatedTokens = estimateTokenCount(output);

    expect(estimatedTokens).toBeLessThan(500);
    expect(estimatedTokens).toBeGreaterThan(50);
  });
});

describe("formatOnDemandRuleIndex", () => {
  const sampleRules: InstructionFile[] = [
    {
      path: "/workspace/project/CLAUDE.md",
      kind: "CLAUDE.md",
      scope: "project",
      bytes: 2048,
      modifiedAt: 1700000000000,
      excerpt: "Project architecture guidelines: monorepo with agent-core and desktop app. Use strict TypeScript.",
    },
    {
      path: "/home/dev/.agents/AGENTS.md",
      kind: "AGENTS.md",
      scope: "user",
      bytes: 1024,
      modifiedAt: 1700000000000,
      excerpt: "Global agent operating conventions, security requirements, and tool policies.",
    },
  ];

  test("formats rules into XML format with default tag and prompt instructions", () => {
    const output = formatOnDemandRuleIndex(sampleRules);

    expect(output).toContain(`<${DEFAULT_RULE_XML_TAG}>`);
    expect(output).toContain(`</${DEFAULT_RULE_XML_TAG}>`);
    expect(output).toContain("The following guideline and instruction files define rules");
    expect(output).toContain("- CLAUDE.md (project): Project architecture guidelines: monorepo with agent-core and desktop app. Use strict TypeScript. [Path: /workspace/project/CLAUDE.md]");
    expect(output).toContain("- AGENTS.md (user): Global agent operating conventions, security requirements, and tool policies. [Path: /home/dev/.agents/AGENTS.md]");
  });

  test("supports OnDemandRuleItem objects with custom names and titles", () => {
    const customRules: OnDemandRuleItem[] = [
      {
        path: "/workspace/docs/security.md",
        name: "Security Policy",
        scope: "project",
        description: "Authentication invariants, permission boundaries, and token handling policies.",
      },
    ];

    const output = formatOnDemandRuleIndex(customRules, { format: "markdown" });
    expect(output).toContain("### Available Rules & Guidelines");
    expect(output).toContain("- **Security Policy** (project): Authentication invariants, permission boundaries, and token handling policies. [Path: /workspace/docs/security.md]");
  });

  test("returns empty string when rules list is empty", () => {
    expect(formatOnDemandRuleIndex([])).toBe("");
  });
});

describe("formatOnDemandDocIndex", () => {
  const sampleDocs: OnDemandDocItem[] = [
    {
      name: "API Reference",
      path: "/workspace/docs/api.md",
      description: "Complete REST and WebSocket API reference for agent services.",
      category: "api",
      scope: "project",
    },
    {
      name: "Architecture Blueprint",
      path: "/workspace/docs/architecture.md",
      description: "Core architecture patterns and component dependencies.",
      category: "design",
      scope: "project",
    },
  ];

  test("formats generic docs into XML and Markdown", () => {
    const xmlOutput = formatOnDemandDocIndex(sampleDocs);
    expect(xmlOutput).toContain("- API Reference [api] (project): Complete REST and WebSocket API reference for agent services. [Path: /workspace/docs/api.md]");

    const mdOutput = formatOnDemandDocIndex(sampleDocs, { format: "markdown" });
    expect(mdOutput).toContain("### Available Documentation");
    expect(mdOutput).toContain("- **API Reference** [api] (project): Complete REST and WebSocket API reference for agent services. [Path: /workspace/docs/api.md]");
  });
});

describe("formatOnDemandInventoryIndex", () => {
  test("combines skills and instruction files from AgentInventory snapshot", () => {
    const inventory = {
      skills: [
        {
          name: "test-runner",
          description: "Runs and evaluates integration test suites.",
          path: "/workspace/.skills/test-runner/SKILL.md",
          directory: "/workspace/.skills/test-runner",
          origin: "kone",
          scope: "project" as const,
          displayName: null,
          shortDescription: null,
          author: null,
          shadowedBy: [],
          manualOnly: false,
        },
      ],
      instructions: [
        {
          path: "/workspace/CLAUDE.md",
          kind: "CLAUDE.md" as const,
          scope: "project" as const,
          bytes: 1500,
          modifiedAt: 1700000000000,
          excerpt: "General project coding conventions.",
        },
      ],
    };

    const combined = formatOnDemandInventoryIndex(inventory);
    expect(combined).toContain("<available_skills>");
    expect(combined).toContain("<available_rules>");
    expect(combined).toContain("test-runner");
    expect(combined).toContain("CLAUDE.md");
    expect(estimateTokenCount(combined)).toBeLessThan(500);
  });

  test("returns single section if only one list is populated", () => {
    const inventory = {
      skills: [],
      instructions: [
        {
          path: "/workspace/CLAUDE.md",
          kind: "CLAUDE.md" as const,
          scope: "project" as const,
          bytes: 1500,
          modifiedAt: 1700000000000,
          excerpt: "Conventions only.",
        },
      ],
    };

    const result = formatOnDemandInventoryIndex(inventory);
    expect(result).not.toContain("<available_skills>");
    expect(result).toContain("<available_rules>");
  });
});
