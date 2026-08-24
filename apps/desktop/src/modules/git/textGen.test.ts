import { describe, expect, it } from "bun:test";
import {
  buildCommitPrompt,
  createFallbackCommitSuggestion,
  deriveFallbackCommitSubject,
  extractJsonObject,
  sanitizeBranchFragment,
  sanitizeCommitSubject,
} from "./textGen.js";

describe("textGen", () => {
  describe("extractJsonObject", () => {
    it("extracts a simple JSON object from raw text", () => {
      const raw = 'Here is your commit: {"subject": "feat: add login", "body": "test"} Thank you!';
      expect(extractJsonObject(raw)).toBe('{"subject": "feat: add login", "body": "test"}');
    });

    it("handles nested braces and strings with escaped quotes", () => {
      const raw = '{"subject": "feat: say \\"hello\\"", "nested": {"a": 1}}';
      expect(extractJsonObject(raw)).toBe('{"subject": "feat: say \\"hello\\"", "nested": {"a": 1}}');
    });

    it("returns raw text if no JSON found", () => {
      expect(extractJsonObject("no json here")).toBe("no json here");
    });
  });

  describe("sanitizeCommitSubject", () => {
    it("removes trailing periods and clips to first line", () => {
      const input = "feat: add authentication endpoint.\n\nMore details here.";
      expect(sanitizeCommitSubject(input)).toBe("feat: add authentication endpoint");
    });

    it("truncates subjects longer than 72 characters", () => {
      const longInput = "a".repeat(80);
      const sanitized = sanitizeCommitSubject(longInput);
      expect(sanitized.length).toBe(72);
    });

    it("returns fallback for empty string", () => {
      expect(sanitizeCommitSubject("")).toBe("Update project files");
      expect(sanitizeCommitSubject("   ...  ")).toBe("Update project files");
    });
  });

  describe("sanitizeBranchFragment", () => {
    it("converts strings to safe git branch slugs", () => {
      expect(sanitizeBranchFragment("Feat: Add OAuth Login!")).toBe("feat-add-oauth-login");
      expect(sanitizeBranchFragment("feature/new-button_v2")).toBe("feature/new-button_v2");
    });
  });

  describe("deriveFallbackCommitSubject", () => {
    it("derives Add for single added file", () => {
      expect(deriveFallbackCommitSubject("A\tsrc/auth/login.ts")).toBe("Add login.ts");
    });

    it("derives Remove for single deleted file", () => {
      expect(deriveFallbackCommitSubject("D\tsrc/old.ts")).toBe("Remove old.ts");
    });

    it("derives Rename for single renamed file", () => {
      expect(deriveFallbackCommitSubject("R100\tsrc/a.ts\tsrc/b.ts")).toBe("Rename b.ts");
    });

    it("derives Update for single modified file", () => {
      expect(deriveFallbackCommitSubject("M\tsrc/components/Button.vue")).toBe("Update Button.vue");
    });

    it("derives directory summary for multiple files in same folder", () => {
      const summary = "M\tsrc/auth/login.ts\nA\tsrc/auth/oauth.ts\nM\tsrc/auth/session.ts";
      expect(deriveFallbackCommitSubject(summary)).toBe("Update src files");
    });
  });

  describe("createFallbackCommitSuggestion", () => {
    it("builds fallback suggestion with branch if requested", () => {
      const suggestion = createFallbackCommitSuggestion("A\tsrc/components/Modal.vue", true);
      expect(suggestion.subject).toBe("Add Modal.vue");
      expect(suggestion.branch).toBe("add-modal-vue");
      expect(suggestion.body).toBe("");
    });
  });

  describe("buildCommitPrompt", () => {
    it("includes branch, summary, and patch in prompt", () => {
      const prompt = buildCommitPrompt({
        branch: "main",
        stagedSummary: "M\tapp.ts",
        stagedPatch: "+ console.log('hi');",
        includeBranch: true,
      });

      expect(prompt).toContain("Branch: main");
      expect(prompt).toContain("M\tapp.ts");
      expect(prompt).toContain("+ console.log('hi');");
      expect(prompt).toContain('"branch"');
    });
  });
});
