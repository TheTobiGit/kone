import { describe, expect, test } from "bun:test";

import { lintSkill } from "./skillLint.js";
import type { LintInput, SkillFinding } from "./skillLint.js";

// In-memory SKILL.md fixtures: `frontmatterText` goes between the `---`
// delimiters, `bodyText` after them. `input.frontmatter` is left empty so the
// module's own YAML subset parser drives every check, except where a test
// exercises the caller-parse fallback.
function lintText(
  frontmatterText: string,
  bodyText: string,
  extra?: Partial<LintInput>,
): SkillFinding[] {
  const fileText = frontmatterText === "" ? bodyText : `---\n${frontmatterText}\n---\n${bodyText}`;
  return lintSkill({
    name: "demo-skill",
    directoryName: "demo-skill",
    frontmatter: {},
    body: fileText,
    siblingFiles: ["SKILL.md"],
    siblingDirs: [],
    ...extra,
  });
}

function ids(findings: SkillFinding[]): string[] {
  return findings.map((finding) => finding.id);
}

function byId(findings: SkillFinding[], id: string): SkillFinding | undefined {
  return findings.find((finding) => finding.id === id);
}

// A clean, routing-capable skill: name matches the folder, description leads
// with "Use this skill when", covers the negative space, and the body has a
// Gotchas section. No rule should fire on it.
const BASELINE = {
  frontmatterText: `name: demo-skill
description: Use this skill when the user asks to review code or catch bugs. Do not trigger on style-only requests.`,
  bodyText: `# Demo Skill

## Gotchas

- Skim the diff before commenting.
`,
};

describe("lintSkill — clean baseline", () => {
  test("a well-formed skill produces no findings", () => {
    expect(lintText(BASELINE.frontmatterText, BASELINE.bodyText)).toEqual([]);
  });
});

describe("lintSkill — 6.1 structural", () => {
  test("sk-structure-missing-file: listing shows no SKILL.md in either casing", () => {
    const findings = lintText(BASELINE.frontmatterText, BASELINE.bodyText, {
      siblingFiles: ["README.md"],
    });
    expect(byId(findings, "sk-structure-missing-file")?.severity).toBe("error");
  });

  test("sk-fm-no-frontmatter: body has no frontmatter block", () => {
    const findings = lintText("", "# Demo\n");
    expect(ids(findings)).toContain("sk-fm-no-frontmatter");
    expect(ids(findings)).toContain("sk-name-missing");
    expect(ids(findings)).toContain("sk-desc-missing");
  });

  test("sk-fm-invalid-yaml: unterminated quoted string", () => {
    const findings = lintText(`name: demo-skill
description: "unclosed`, "# Body\n");
    expect(byId(findings, "sk-fm-invalid-yaml")?.severity).toBe("error");
  });

  test("sk-fm-invalid-yaml: frontmatter that parses as a sequence", () => {
    const findings = lintText("- one\n- two", "# Body\n");
    expect(byId(findings, "sk-fm-invalid-yaml")?.severity).toBe("error");
  });

  test("sk-fm-invalid-yaml: tab indentation", () => {
    const findings = lintText("name: demo-skill\n\tbad: y", "# Body\n");
    expect(byId(findings, "sk-fm-invalid-yaml")?.severity).toBe("error");
  });

  test("an exotic-but-valid block the inline subset rejects is trusted when the caller's parse is present", () => {
    const findings = lintText("name: demo-skill\n\tbad: y", "# Body\n", {
      frontmatter: { name: "demo-skill", description: "Use this skill when the user needs a summary." },
    });
    expect(ids(findings)).not.toContain("sk-fm-invalid-yaml");
    expect(ids(findings)).not.toContain("sk-name-missing");
  });

  test("sk-name-missing: no name field", () => {
    const findings = lintText(
      `description: Use this skill when the user needs a summary.`,
      BASELINE.bodyText,
    );
    expect(byId(findings, "sk-name-missing")?.severity).toBe("error");
  });

  test("sk-desc-missing: no description field", () => {
    const findings = lintText(`name: demo-skill`, BASELINE.bodyText);
    expect(byId(findings, "sk-desc-missing")?.severity).toBe("error");
  });

  test("sk-desc-not-string: boolean description", () => {
    const findings = lintText("name: demo-skill\ndescription: true", "# Body\n");
    const finding = byId(findings, "sk-desc-not-string");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("boolean");
    expect(ids(findings)).not.toContain("sk-desc-missing");
  });

  test("sk-desc-not-string: numeric description", () => {
    const findings = lintText("name: demo-skill\ndescription: 123", "# Body\n");
    expect(byId(findings, "sk-desc-not-string")?.message).toContain("number");
  });

  test("sk-fm-unknown-field: one finding per unknown key", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.
argument-hint: x`,
      "# Body\n",
    );
    const unknown = findings.filter((finding) => finding.id === "sk-fm-unknown-field");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.message).toContain("argument-hint");
    expect(unknown[0]?.severity).toBe("error");
  });

  test("sk-body-empty: frontmatter only", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.`,
      "",
    );
    expect(byId(findings, "sk-body-empty")?.severity).toBe("error");
  });
});

describe("lintSkill — 6.2 naming", () => {
  test("sk-name-charset: uppercase name", () => {
    const findings = lintText(
      `name: Code-Review
description: Use this skill when the user needs a summary.`,
      "# Body\n",
    );
    expect(byId(findings, "sk-name-charset")?.severity).toBe("error");
  });

  test("sk-name-charset: underscores", () => {
    const findings = lintText(
      `name: code__review
description: Use this skill when the user needs a summary.`,
      "# Body\n",
    );
    expect(ids(findings)).toContain("sk-name-charset");
  });

  test("sk-name-charset: name over 64 chars", () => {
    const findings = lintText(
      `name: ${"a".repeat(65)}
description: Use this skill when the user needs a summary.`,
      "# Body\n",
    );
    expect(ids(findings)).toContain("sk-name-charset");
  });

  test("sk-name-dir-mismatch: warning with both names", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.`,
      "# Body\n",
      { directoryName: "other-folder" },
    );
    const finding = byId(findings, "sk-name-dir-mismatch");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("demo-skill");
    expect(finding?.message).toContain("other-folder");
  });

  test("sk-name-reserved: info for a reserved substring", () => {
    const findings = lintText(
      `name: claude-helper
description: Use this skill when the user needs a summary.`,
      "# Body\n",
    );
    const finding = byId(findings, "sk-name-reserved");
    expect(finding?.severity).toBe("info");
    expect(finding?.message).toContain("claude");
  });
});

describe("lintSkill — 6.3 description", () => {
  test("sk-desc-too-short: warning with the character count", () => {
    const desc = "Helps with PDFs.";
    const findings = lintText(`name: demo-skill\ndescription: ${desc}`, "# Body\n");
    const finding = byId(findings, "sk-desc-too-short");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain(`\`${desc.length}\``);
  });

  test("sk-desc-too-long: warning in the bloat band", () => {
    const findings = lintText(
      `name: demo-skill
description: ${"a".repeat(600)}`,
      "# Body\n",
    );
    expect(byId(findings, "sk-desc-too-long")?.severity).toBe("warning");
  });

  test("sk-desc-too-long: error past the hard cap", () => {
    const findings = lintText(
      `name: demo-skill
description: ${"a".repeat(1100)}`,
      "# Body\n",
    );
    expect(byId(findings, "sk-desc-too-long")?.severity).toBe("error");
  });

  test("sk-desc-no-trigger: description never says when to fire", () => {
    const findings = lintText(
      `name: demo-skill
description: This skill does the thing.`,
      "# Body\n",
    );
    expect(byId(findings, "sk-desc-no-trigger")?.severity).toBe("warning");
  });

  test("a quoted user phrasing counts as a trigger", () => {
    const findings = lintText(
      `name: demo-skill
description: Route when they ask "can you summarize this codebase for me".`,
      "# Body\n",
    );
    expect(ids(findings)).not.toContain("sk-desc-no-trigger");
  });

  test("sk-desc-vague: info from the embedded list", () => {
    const findings = lintText(
      `name: demo-skill
description: Use when working with various things and stuff.`,
      "# Body\n",
    );
    const finding = byId(findings, "sk-desc-vague");
    expect(finding?.severity).toBe("info");
  });

  test("sk-desc-overlaps-default: info for native work", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user is debugging code.`,
      "# Body\n",
    );
    expect(byId(findings, "sk-desc-overlaps-default")?.severity).toBe("info");
  });

  test("sk-desc-no-negatives: info when no boundary is drawn", () => {
    const findings = lintText(
      `name: demo-skill
description: Use when the user wants a summary of the code.`,
      "# Body\n",
    );
    expect(byId(findings, "sk-desc-no-negatives")?.severity).toBe("info");
  });

  test("sk-desc-xml-tags: error for markup in the description", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs <b>bold</b> help.`,
      "# Body\n",
    );
    expect(byId(findings, "sk-desc-xml-tags")?.severity).toBe("error");
  });

  test("sk-desc-first-person: info for first/second person voice", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when I can help with PDFs.`,
      "# Body\n",
    );
    expect(byId(findings, "sk-desc-first-person")?.severity).toBe("info");
  });

  test("sk-desc-blank-lines: blank line inside a literal description", () => {
    const findings = lintText(
      `name: demo-skill
description: |
  Use this skill when the user wants a summary of the code.

  More detail about when to fire.`,
      "# Body\n",
    );
    expect(byId(findings, "sk-desc-blank-lines")?.severity).toBe("info");
  });

  test("no sk-desc-blank-lines for a single blank line in a folded description", () => {
    const findings = lintText(
      `name: demo-skill
description: >
  Use this skill when the user wants a summary of the code.

  More detail about when to fire.`,
      "# Body\n",
    );
    expect(ids(findings)).not.toContain("sk-desc-blank-lines");
  });

  test("sk-desc-listing-cap: info when description plus when_to_use overflows the listing", () => {
    const findings = lintText(
      `name: demo-skill
description: ${"a".repeat(100)}
when_to_use: ${"b".repeat(1500)}`,
      "# Body\n",
    );
    expect(byId(findings, "sk-desc-listing-cap")?.severity).toBe("info");
    // when_to_use is outside the six spec fields, so it is also an unknown field.
    expect(ids(findings)).toContain("sk-fm-unknown-field");
  });

  test("colons inside a plain description survive parsing", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when doing X: run the Y step.`,
      "# Body\n",
    );
    expect(ids(findings)).not.toContain("sk-fm-invalid-yaml");
    expect(ids(findings)).not.toContain("sk-desc-missing");
  });

  test("a quoted description keeps quotes and inner colons", () => {
    const findings = lintText(
      `name: demo-skill
description: "Use when: now"`,
      "# Body\n",
    );
    expect(ids(findings)).not.toContain("sk-fm-invalid-yaml");
  });
});

describe("lintSkill — 6.4 body", () => {
  test("sk-body-too-long: warning past 500 lines", () => {
    const findings = lintText(BASELINE.frontmatterText, `${"x\n".repeat(500)}tail`);
    expect(byId(findings, "sk-body-too-long")?.severity).toBe("warning");
  });

  test("sk-body-way-too-long: error past 1500 lines, not the warning too", () => {
    const findings = lintText(BASELINE.frontmatterText, "x\n".repeat(1500));
    expect(byId(findings, "sk-body-way-too-long")?.severity).toBe("error");
    expect(ids(findings)).not.toContain("sk-body-too-long");
  });

  test("sk-body-token-budget: warning past ~5000 tokens", () => {
    const findings = lintText(BASELINE.frontmatterText, "y".repeat(20_004));
    expect(byId(findings, "sk-body-token-budget")?.severity).toBe("warning");
  });

  test("sk-body-placeholder: warning for template stubs", () => {
    const findings = lintText(BASELINE.frontmatterText, "# Skill\n\nReplace with your instructions.\n");
    expect(byId(findings, "sk-body-placeholder")?.severity).toBe("warning");
  });

  test("sk-body-hardcoded-path: warning for author-machine paths", () => {
    const findings = lintText(
      BASELINE.frontmatterText,
      "Run the script at /Users/me/scripts/run.sh.\n",
    );
    const finding = byId(findings, "sk-body-hardcoded-path");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("/Users/me");
  });

  test("hardcoded paths inside fenced code blocks are ignored", () => {
    const findings = lintText(
      BASELINE.frontmatterText,
      "```\n/Users/me/scripts/run.sh\n```\n",
    );
    expect(ids(findings)).not.toContain("sk-body-hardcoded-path");
  });

  test("sk-body-gotchas: info when the section is absent", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.`,
      "# Demo\n\nPlain instructions.\n",
    );
    expect(byId(findings, "sk-body-gotchas")?.severity).toBe("info");
  });

  test("sk-body-structure: info for a long body with no bundled files", () => {
    const findings = lintText(BASELINE.frontmatterText, "line\n".repeat(250));
    expect(byId(findings, "sk-body-structure")?.severity).toBe("info");
  });

  test("sk-body-structure stays quiet when the skill bundles files", () => {
    const findings = lintText(BASELINE.frontmatterText, "line\n".repeat(250), {
      siblingDirs: ["references"],
    });
    expect(ids(findings)).not.toContain("sk-body-structure");
  });
});

describe("lintSkill — 6.5 bundled files", () => {
  test("sk-ref-broken: markdown link to a missing file", () => {
    const findings = lintText(BASELINE.frontmatterText, "See [guide](guide.md).\n");
    const finding = byId(findings, "sk-ref-broken");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("guide.md");
  });

  test("sk-ref-broken: backtick path to a missing file", () => {
    const findings = lintText(BASELINE.frontmatterText, "Run `scripts/run.sh`.\n");
    expect(byId(findings, "sk-ref-broken")?.message).toContain("scripts/run.sh");
  });

  test("a reference that resolves in the listing is fine", () => {
    const findings = lintText(BASELINE.frontmatterText, "Run `scripts/run.sh`.\n", {
      siblingDirs: ["scripts"],
    });
    expect(ids(findings)).not.toContain("sk-ref-broken");
  });

  test("sk-ref-escape: parent-directory escape", () => {
    const findings = lintText(BASELINE.frontmatterText, "See [x](../secret.md).\n");
    expect(byId(findings, "sk-ref-escape")?.severity).toBe("error");
  });

  test("sk-ref-depth: two directory levels deep", () => {
    const findings = lintText(BASELINE.frontmatterText, "See [x](references/a/b.md).\n", {
      siblingDirs: ["references"],
    });
    const finding = byId(findings, "sk-ref-depth");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("`2`");
    expect(ids(findings)).not.toContain("sk-ref-broken");
  });

  test("one-level references stay quiet", () => {
    const findings = lintText(BASELINE.frontmatterText, "See [x](references/guide.md).\n", {
      siblingDirs: ["references"],
    });
    expect(ids(findings)).not.toContain("sk-ref-depth");
    expect(ids(findings)).not.toContain("sk-ref-broken");
  });

  test("a deep reference whose top segment is unknown is broken", () => {
    const findings = lintText(BASELINE.frontmatterText, "See [x](missing/guide.md).\n");
    expect(ids(findings)).toContain("sk-ref-broken");
  });

  test("URLs and anchors are not references", () => {
    const findings = lintText(
      BASELINE.frontmatterText,
      "See [docs](https://example.com/a.md) and [top](#top).\n",
    );
    expect(ids(findings)).not.toContain("sk-ref-broken");
  });

  test("references inside fenced code blocks are not extracted", () => {
    const findings = lintText(BASELINE.frontmatterText, "```\n[x](missing.md)\n```\n");
    expect(ids(findings)).not.toContain("sk-ref-broken");
  });

  test("file: directives are extracted and resolved", () => {
    const findings = lintText(
      BASELINE.frontmatterText,
      "Read file:./references/guide.md when needed.\n",
      { siblingDirs: ["references"] },
    );
    expect(ids(findings)).not.toContain("sk-ref-broken");
  });

  test("sk-orphan-file: bundled file never mentioned in the body", () => {
    const findings = lintText(BASELINE.frontmatterText, BASELINE.bodyText, {
      siblingFiles: ["SKILL.md", "README.md"],
    });
    const finding = byId(findings, "sk-orphan-file");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("README.md");
  });

  test("a mentioned file is not an orphan", () => {
    const findings = lintText(BASELINE.frontmatterText, "See guide.md for details.\n", {
      siblingFiles: ["SKILL.md", "guide.md"],
    });
    expect(ids(findings)).not.toContain("sk-orphan-file");
  });
});

describe("lintSkill — 6.6 tools, compatibility, metadata", () => {
  test("sk-tools-unknown: warning naming the dead grant", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.
allowed-tools: Bash Read Frobnicate`,
      "# Body\n",
    );
    const finding = byId(findings, "sk-tools-unknown");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("Frobnicate");
    expect(findings.filter((f) => f.id === "sk-tools-unknown")).toHaveLength(1);
  });

  test("argument patterns are stripped to bare tool names", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.
allowed-tools: Bash(git:*) Read`,
      "# Body\n",
    );
    expect(ids(findings)).not.toContain("sk-tools-unknown");
  });

  test("sk-tools-bad-format: non-string allowed-tools", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.
allowed-tools: true`,
      "# Body\n",
    );
    expect(byId(findings, "sk-tools-bad-format")?.severity).toBe("warning");
  });

  test("sk-tools-bad-format: empty allowed-tools", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.
allowed-tools: ""`,
      "# Body\n",
    );
    expect(ids(findings)).toContain("sk-tools-bad-format");
  });

  test("sk-tools-overgranted: analysis skill holding write/shell tools", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs an analysis of the codebase.
allowed-tools: Read Bash`,
      "# Body\n",
    );
    const finding = byId(findings, "sk-tools-overgranted");
    expect(finding?.severity).toBe("info");
    expect(finding?.message).toContain("Bash");
  });

  test("sk-tools-no-tools-when-shelling: body shells out with no allowed-tools", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.`,
      "Run the build with Bash.\n",
    );
    expect(byId(findings, "sk-tools-no-tools-when-shelling")?.severity).toBe("info");
  });

  test("sk-compat-too-long: warning past 500 chars", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.
compatibility: ${"c".repeat(501)}`,
      "# Body\n",
    );
    expect(byId(findings, "sk-compat-too-long")?.severity).toBe("warning");
  });

  test("sk-metadata-shape: string metadata is not a map", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.
metadata: notes`,
      "# Body\n",
    );
    expect(byId(findings, "sk-metadata-shape")?.severity).toBe("warning");
  });

  test("sk-metadata-shape: flow array metadata", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.
metadata: [a, b]`,
      "# Body\n",
    );
    expect(ids(findings)).toContain("sk-metadata-shape");
  });

  test("sk-metadata-shape: block array metadata", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.
metadata:
  - a
  - b`,
      "# Body\n",
    );
    expect(ids(findings)).toContain("sk-metadata-shape");
  });

  test("sk-metadata-shape: non-string value in a metadata map", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.
metadata: {a: 1}`,
      "# Body\n",
    );
    expect(ids(findings)).toContain("sk-metadata-shape");
  });

  test("a string-valued metadata map is fine", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.
metadata: {a: "1"}`,
      "# Body\n",
    );
    expect(ids(findings)).not.toContain("sk-metadata-shape");
  });

  test("a nested metadata map via indentation is fine", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.
metadata:
  a: "1"
  b: "two"`,
      "# Body\n",
    );
    expect(ids(findings)).not.toContain("sk-metadata-shape");
  });
});

describe("lintSkill — 6.7 hygiene", () => {
  test("sk-hygiene-case: lowercase skill file", () => {
    const findings = lintText(BASELINE.frontmatterText, BASELINE.bodyText, {
      siblingFiles: ["skill.md"],
    });
    expect(byId(findings, "sk-hygiene-case")?.severity).toBe("info");
  });

  test("sk-hygiene-final-newline: file not ending in a newline", () => {
    const findings = lintText(BASELINE.frontmatterText, "# Demo\n\n## Gotchas\n\n- no trailing newline");
    expect(byId(findings, "sk-hygiene-final-newline")?.severity).toBe("info");
  });

  test("sk-hygiene-trailing-ws: reports the line number in the file", () => {
    const findings = lintText(BASELINE.frontmatterText, "clean\nbad  \nclean\n");
    const finding = byId(findings, "sk-hygiene-trailing-ws");
    expect(finding?.severity).toBe("info");
    // Line 1 is `---`, so the first body line is file line 5; the dirty line
    // is the second body line, file line 6.
    expect(finding?.message).toContain("`6`");
  });

  test("sk-hygiene-unknown-metadata-keys: metadata key shadows a spec field", () => {
    const findings = lintText(
      `name: demo-skill
description: Use this skill when the user needs a summary.
metadata: {name: "x"}`,
      "# Body\n",
    );
    const finding = byId(findings, "sk-hygiene-unknown-metadata-keys");
    expect(finding?.severity).toBe("info");
    expect(finding?.message).toContain("name");
  });
});

describe("lintSkill — severity ladder", () => {
  test("a messy skill produces a mix of severities", () => {
    const findings = lintText(
      `name: Code_Review
description: Helps with PDFs.`,
      "# Body\n",
      { directoryName: "other-dir" },
    );
    expect(findings.some((f) => f.severity === "error")).toBe(true);
    expect(findings.some((f) => f.severity === "warning")).toBe(true);
    expect(findings.some((f) => f.severity === "info")).toBe(true);
  });
});
