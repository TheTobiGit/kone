// Structural call search + rewrite previews gateway tools.
//
// kone_ast_find_calls finds call expressions to a plain identifier across the
// project through the shared ast engine. kone_ast_preview shows what a fixed
// rewrite (rename the callee, add one argument) would change, as text the
// caller applies with its own edit tools. Like the lsp read both are
// permission "allow" with no active turn required — every run only reads. The
// model passes bare names; kone builds the matching pattern internally, so
// there is no way to send a pattern, a wildcard, or a regular expression.

import path from "node:path";

import { z } from "zod";

import { AstEngine } from "../../ast/engine.js";
import type { AstPreviewOne, AstPreviewRun } from "../../ast/engine.js";
import { formatFindCalls, formatRewritePreview, isPlainIdentifier } from "../../ast/format.js";
import type { AstPreviewChange } from "../../ast/format.js";
import {
  AstRewriteError,
  previewAddArgument,
  previewRenameCall,
} from "../../ast/rewrite.js";
import type {
  GatewayRecord,
  GatewayToolContext,
  GatewayToolResult,
  ToolEntry,
} from "../schemas.js";
import { GatewayToolError } from "../schemas.js";
import { gatewayToolErrorResult } from "../registry.js";
import { resolveSearchRoot } from "../paths.js";

export const AstFindCallsInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .refine(isPlainIdentifier, {
      message: "name must be a plain identifier (letters, digits, _, $); patterns and wildcards are refused",
    }),
  path: z.string().min(1).default("."),
});

export type AstFindCallsInput = z.infer<typeof AstFindCallsInputSchema>;

export const AST_FIND_CALLS_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "The plain function name to find calls to (e.g. \"foo\"). Patterns and wildcards are refused.",
    },
    path: {
      type: "string",
      description:
        "Workspace-relative file, directory, or glob to search (default \".\"). A slashless glob such as \"*.ts\" matches by file name at any depth. Must stay inside the project.",
    },
  },
  required: ["name"],
} satisfies GatewayRecord;

const AST_DESCRIPTION = [
  "Find call expressions to a plain function name across the project (structural search, not text grep).",
  "",
  "Pass a plain identifier in `name` — patterns and wildcards are refused. Matching is structural: a call split across lines still matches, while comments and partial identifiers (myfoo never matches foo) never do.",
  "",
  "`path` names a workspace-relative file, directory, or glob inside the project (default \".\"). Reads only; paths escaping the project are refused.",
].join("\n");

const AST_PROMPT_SNIPPET =
  "Find where a function is called across the project: pass its plain name, get back path:line matches with snippets.";

export interface AstToolOptions {
  engine?: AstEngine;
}

// ── rewrite previews ─────────────────────────────────────────────────────
// kone_ast_preview shows what a fixed call rewrite would change, as text the
// caller applies with its own edit tools. It never writes: the handler only
// reads, the pure previews only splice strings, and every call is stateless —
// no proposals are staged, so a preview goes stale the moment a file changes.

const AstRenameCallSchema = z.object({
  op: z.literal("rename-call"),
  from: z.string().min(1).refine(isPlainIdentifier, {
    message:
      'op "rename-call" needs "from" as a plain identifier (letters, digits, _, $); patterns and wildcards are refused',
  }),
  to: z.string().min(1).refine(isPlainIdentifier, {
    message:
      'op "rename-call" needs "to" as a plain identifier (letters, digits, _, $); patterns and wildcards are refused',
  }),
  path: z.string().min(1).default("."),
});

const AstAddArgumentSchema = z.object({
  op: z.literal("add-argument"),
  name: z.string().min(1).refine(isPlainIdentifier, {
    message:
      'op "add-argument" needs "name" as a plain identifier (letters, digits, _, $); patterns and wildcards are refused',
  }),
  argText: z.string().refine((value) => value.trim().length > 0, {
    message: 'op "add-argument" needs "argText" as a non-empty comma-separated expression list',
  }),
  position: z.enum(["first", "last"]).default("last"),
  path: z.string().min(1).default("."),
});

export const AstPreviewInputSchema = z.discriminatedUnion("op", [
  AstRenameCallSchema,
  AstAddArgumentSchema,
]);

export type AstPreviewInput = z.infer<typeof AstPreviewInputSchema>;

export const AST_PREVIEW_JSON_SCHEMA = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: ["rename-call", "add-argument"],
      description:
        'The fixed rewrite to preview: "rename-call" renames the callee, "add-argument" inserts one argument into every match.',
    },
    name: {
      type: "string",
      description: 'The plain function name to find calls to (for "add-argument"). Patterns and wildcards are refused.',
    },
    from: {
      type: "string",
      description: 'The plain callee name to rename (for "rename-call"). Patterns and wildcards are refused.',
    },
    to: {
      type: "string",
      description: 'The plain replacement callee name (for "rename-call"). Patterns and wildcards are refused.',
    },
    argText: {
      type: "string",
      description:
        'The argument to insert (for "add-argument"): a comma-separated expression list such as "ctx" or "a, b". Anything else is refused.',
    },
    position: {
      type: "string",
      enum: ["first", "last"],
      description: 'Where the new argument lands (for "add-argument", default "last").',
    },
    path: {
      type: "string",
      description:
        "Workspace-relative file, directory, or glob to preview (default \".\"). A slashless glob such as \"*.ts\" matches by file name at any depth. Must stay inside the project.",
    },
  },
  required: ["op"],
} satisfies GatewayRecord;

const AST_PREVIEW_DESCRIPTION = [
  "Preview a fixed call rewrite across the project as before→after text (structural preview, not an edit).",
  "",
  '`op` picks the rewrite: "rename-call" needs `from` + `to` (plain identifiers — patterns and wildcards are refused); "add-argument" needs `name` (plain identifier) + `argText` (a comma-separated expression list) with optional `position` (`first`|`last`, default `last`). `path` names a workspace-relative file, directory, or glob inside the project (default "."); paths escaping the project are refused.',
  "",
  "Preview only: kone never writes. Apply the shown lines with your own edit tools. Previews go stale the moment a file changes — kone keeps no state between calls — so re-verify every match in the file before applying.",
].join("\n");

const AST_PREVIEW_PROMPT_SNIPPET =
  "Preview renaming a call or adding an argument across the project: pass the op and names, get back before→after lines to apply yourself; kone never writes.";

/**
 * Creates the structural call-search gateway tools: `kone_ast_find_calls`
 * plus the preview-only `kone_ast_preview`.
 */
export function createAstTools(options: AstToolOptions = {}): ToolEntry[] {
  const engine = options.engine ?? new AstEngine();

  const handler = async (
    ctx: GatewayToolContext,
    input: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const parsed = AstFindCallsInputSchema.safeParse(input);
    if (!parsed.success) {
      return gatewayToolErrorResult(
        new GatewayToolError("invalid_input", parsed.error.message),
      );
    }
    const args = parsed.data;
    const projectRoot = path.resolve(ctx.cwd);
    const absPath = resolveSearchRoot(projectRoot, args.path);
    const result = engine.search(absPath, projectRoot, args.name);
    const fileCount = new Set(result.matches.map((match) => match.path)).size;
    const structured: GatewayRecord = {
      name: args.name,
      matches: result.matches.map((match) => ({
        path: match.path,
        line: match.line,
        column: match.column,
        snippet: match.snippet,
        argCount: match.argCount,
      })),
      matchCount: result.matches.length,
      fileCount,
      filesSearched: result.filesSearched,
      limitReached: result.limitReached,
      parseIssues: result.parseIssues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
      parseIssuesTotal: result.parseIssuesTotal,
    };
    return {
      content: [{ type: "text", text: formatFindCalls(args.name, result) }],
      structuredContent: structured,
    };
  };

  return [
    {
      name: "kone_ast_find_calls",
      description: AST_DESCRIPTION,
      inputSchema: AstFindCallsInputSchema,
      jsonSchema: AST_FIND_CALLS_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      target: "all",
      promptSnippet: AST_PROMPT_SNIPPET,
      handler,
    },
    {
      name: "kone_ast_preview",
      description: AST_PREVIEW_DESCRIPTION,
      inputSchema: AstPreviewInputSchema,
      jsonSchema: AST_PREVIEW_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      target: "all",
      promptSnippet: AST_PREVIEW_PROMPT_SNIPPET,
      handler: previewHandler,
    },
  ];

  async function previewHandler(
    ctx: GatewayToolContext,
    input: GatewayRecord,
  ): Promise<GatewayToolResult> {
    const parsed = AstPreviewInputSchema.safeParse(input);
    if (!parsed.success) {
      return gatewayToolErrorResult(
        new GatewayToolError("invalid_input", parsed.error.message),
      );
    }
    // The discriminated union narrows args by op, so each branch carries only
    // its own fields — no re-checks for undefined, no assertions.
    const args = parsed.data;
    let previewOne: AstPreviewOne;
    let change: AstPreviewChange;
    let opFields: GatewayRecord;
    if (args.op === "rename-call") {
      previewOne = (text, lang, filePath) =>
        previewRenameCall(text, { from: args.from, to: args.to, lang, path: filePath });
      change = { kind: "rename", from: args.from, to: args.to };
      opFields = { from: args.from, to: args.to };
    } else {
      previewOne = (text, lang, filePath) =>
        previewAddArgument(text, {
          name: args.name,
          argText: args.argText,
          position: args.position,
          lang,
          path: filePath,
        });
      change = { kind: "add", name: args.name, argText: args.argText };
      opFields = { name: args.name, argText: args.argText, position: args.position };
    }
    const projectRoot = path.resolve(ctx.cwd);
    const absPath = resolveSearchRoot(projectRoot, args.path);
    // Same walk and glob rules as find-calls: the engine walks, reads, caps,
    // and counts, while the callback above only splices strings, never files.
    let run: AstPreviewRun;
    try {
      run = engine.previewFiles(absPath, projectRoot, previewOne);
    } catch (error) {
      // Unparseable files never reach here (counted skips); any other
      // rewrite failure (overlap, invalid argument) aborts the call so no
      // partial preview goes out.
      if (error instanceof AstRewriteError) {
        return gatewayToolErrorResult(new GatewayToolError("invalid_input", error.message));
      }
      throw error;
    }
    const structured: GatewayRecord = {
      op: args.op,
      ...opFields,
      files: run.files.map((file) => ({
        path: file.path,
        replacements: file.replacements.map((replacement) => ({
          line: replacement.line,
          before: replacement.before,
          after: replacement.after,
        })),
      })),
      filesTouched: run.filesTouched,
      totalReplacements: run.totalReplacements,
      filesSearched: run.filesSearched,
      previewOnly: true,
      limitReached: run.limitReached,
      parseIssues: run.parseIssues.map((issue) => ({ path: issue.path, message: issue.message })),
      parseIssuesTotal: run.parseIssuesTotal,
    };
    return {
      content: [
        {
          type: "text",
          text: formatRewritePreview({
            change,
            files: run.files,
            totalReplacements: run.totalReplacements,
            filesTouched: run.filesTouched,
            filesSearched: run.filesSearched,
            limitReached: run.limitReached,
            parseIssues: run.parseIssues,
            parseIssuesTotal: run.parseIssuesTotal,
          }),
        },
      ],
      structuredContent: structured,
    };
  }
}
