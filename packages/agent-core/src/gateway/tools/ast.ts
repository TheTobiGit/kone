// Structural call search + rewrite previews gateway tools.
//
// kone_ast_find_calls finds call expressions to a plain identifier across the
// project through the shared ast engine. kone_ast_preview shows what a fixed
// rewrite (rename the callee, add one argument) would change, as text the
// caller applies with its own edit tools. Like the lsp read both are
// permission "allow" with no active turn required — every run only reads. The
// model passes bare names; kone builds the matching pattern internally, so
// there is no way to send a pattern, a wildcard, or a regular expression.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  AST_MAX_MATCHES,
  AST_MAX_PARSE_ISSUES_SHOWN,
  AstEngine,
  formatFindCalls,
  isPlainIdentifier,
  langForPath,
} from "../../ast/engine.js";
import type { AstParseIssue } from "../../ast/engine.js";
import {
  AstRewriteError,
  formatRewritePreview,
  previewAddArgument,
  previewRenameCall,
} from "../../ast/rewrite.js";
import type { AstFilePreview, AstPreviewChange } from "../../ast/rewrite.js";
import type {
  GatewayRecord,
  GatewayToolContext,
  GatewayToolResult,
  ToolEntry,
} from "../schemas.js";
import { GatewayToolError } from "../schemas.js";
import { gatewayToolErrorResult } from "../registry.js";

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

// A workspace-relative path resolved against the project root, or null when
// it escapes. Absolute paths inside the project resolve fine; anything
// climbing out with `..` is refused rather than normalized into place.
function resolveInWorkspace(projectRoot: string, relPath: string): string | null {
  const absolute = path.resolve(projectRoot, relPath);
  const relative = path.relative(projectRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  return absolute;
}

function hasGlobMagic(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.includes("[");
}

// Resolve a tool path argument to an absolute search root. Escapes and
// literal paths naming nothing throw invalid_input (a glob matching nothing
// is a successful empty search instead). Shared by both ast tools; the
// registry maps the throw to the usual error result.
function resolveSearchRoot(projectRoot: string, relPath: string): string {
  const absPath = resolveInWorkspace(projectRoot, relPath);
  if (absPath === null) {
    throw new GatewayToolError(
      "invalid_input",
      `Path "${relPath}" escapes the project root; pass a workspace-relative path inside the project.`,
    );
  }
  // A literal path naming nothing is an agent-fixable mistake; a glob that
  // matches nothing is a successful empty search.
  let exists = false;
  try {
    statSync(absPath);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists && !hasGlobMagic(relPath)) {
    throw new GatewayToolError(
      "invalid_input",
      `Cannot search "${relPath}": no such file or directory inside the project.`,
    );
  }
  return absPath;
}

// ── rewrite previews ─────────────────────────────────────────────────────
// kone_ast_preview shows what a fixed call rewrite would change, as text the
// caller applies with its own edit tools. It never writes: the handler only
// reads, the pure previews only splice strings, and every call is stateless —
// no proposals are staged, so a preview goes stale the moment a file changes.

export const AstPreviewInputSchema = z
  .object({
    op: z.enum(["rename-call", "add-argument"]),
    name: z.string().min(1).optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    argText: z.string().optional(),
    position: z.enum(["first", "last"]).default("last"),
    path: z.string().min(1).default("."),
  })
  .superRefine((data, ctx) => {
    if (data.op === "rename-call") {
      if (data.from === undefined || !isPlainIdentifier(data.from)) {
        ctx.addIssue({
          code: "custom",
          path: ["from"],
          message:
            'op "rename-call" needs "from" as a plain identifier (letters, digits, _, $); patterns and wildcards are refused',
        });
      }
      if (data.to === undefined || !isPlainIdentifier(data.to)) {
        ctx.addIssue({
          code: "custom",
          path: ["to"],
          message:
            'op "rename-call" needs "to" as a plain identifier (letters, digits, _, $); patterns and wildcards are refused',
        });
      }
      return;
    }
    if (data.name === undefined || !isPlainIdentifier(data.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message:
          'op "add-argument" needs "name" as a plain identifier (letters, digits, _, $); patterns and wildcards are refused',
      });
    }
    if (data.argText === undefined || data.argText.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["argText"],
        message: 'op "add-argument" needs "argText" as a non-empty comma-separated expression list',
      });
    }
  });

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

/** One validated preview request: the schema guarantees the fields per op. */
type AstPreviewRequest =
  | { op: "rename-call"; from: string; to: string }
  | { op: "add-argument"; name: string; argText: string; position: "first" | "last" };

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
    const args = parsed.data;
    // Pin the per-op fields without assertions: the schema narrows nothing
    // across the union, so the checks below carry the defined types forward.
    let request: AstPreviewRequest;
    if (args.op === "rename-call") {
      if (args.from === undefined || args.to === undefined) {
        return gatewayToolErrorResult(
          new GatewayToolError(
            "invalid_input",
            'op "rename-call" needs "from" and "to"; pass both plain identifiers.',
          ),
        );
      }
      request = { op: "rename-call", from: args.from, to: args.to };
    } else {
      if (args.name === undefined || args.argText === undefined) {
        return gatewayToolErrorResult(
          new GatewayToolError(
            "invalid_input",
            'op "add-argument" needs "name" and "argText"; pass the call name and a comma-separated expression list.',
          ),
        );
      }
      request = { op: "add-argument", name: args.name, argText: args.argText, position: args.position };
    }
    const projectRoot = path.resolve(ctx.cwd);
    const absPath = resolveSearchRoot(projectRoot, args.path);
    // Same walk and glob rules as find-calls, in sorted order so the preview
    // and its cap are deterministic. Only reads happen below — the pure
    // previews splice strings, never the files.
    const files = engine.collectFiles(absPath, projectRoot).sort();
    let filesSearched = 0;
    let totalReplacements = 0;
    const perFile: AstFilePreview[] = [];
    const parseIssues: AstParseIssue[] = [];
    let parseIssuesTotal = 0;
    for (const filePath of files) {
      const lang = langForPath(filePath);
      if (lang === null) continue;
      let text: string | null = null;
      try {
        text = readFileSync(filePath, "utf8");
      } catch {
        text = null;
      }
      if (text === null) {
        parseIssuesTotal += 1;
        if (parseIssues.length < AST_MAX_PARSE_ISSUES_SHOWN) {
          parseIssues.push({
            path: filePath,
            message: "could not read file: it is missing or unreadable",
          });
        }
        continue;
      }
      filesSearched += 1;
      let preview: AstFilePreview;
      try {
        preview =
          request.op === "rename-call"
            ? previewRenameCall(text, { from: request.from, to: request.to, lang, path: filePath })
            : previewAddArgument(text, {
                name: request.name,
                argText: request.argText,
                position: request.position,
                lang,
                path: filePath,
              });
      } catch (error) {
        // Unparseable files join the same counted-issue accounting as
        // find-calls; any other rewrite failure (overlap, invalid argument)
        // aborts the call so no partial preview goes out.
        if (error instanceof AstRewriteError && error.issue === "parse") {
          parseIssuesTotal += 1;
          if (parseIssues.length < AST_MAX_PARSE_ISSUES_SHOWN) {
            parseIssues.push({ path: filePath, message: error.message });
          }
          continue;
        }
        if (error instanceof AstRewriteError) {
          return gatewayToolErrorResult(new GatewayToolError("invalid_input", error.message));
        }
        throw error;
      }
      totalReplacements += preview.replacements.length;
      perFile.push(preview);
    }
    const limitReached = totalReplacements > AST_MAX_MATCHES;
    // The first AST_MAX_MATCHES replacements in file order, mirroring the
    // find-calls cap; the totals below stay exact.
    const shown: AstFilePreview[] = [];
    let kept = 0;
    for (const file of perFile) {
      if (kept >= AST_MAX_MATCHES) break;
      const slice = file.replacements.slice(0, AST_MAX_MATCHES - kept);
      kept += slice.length;
      if (slice.length > 0) shown.push({ path: file.path, replacements: slice });
    }
    const filesTouched = perFile.filter((file) => file.replacements.length > 0).length;
    const change: AstPreviewChange =
      request.op === "rename-call"
        ? { kind: "rename", from: request.from, to: request.to }
        : { kind: "add", name: request.name, argText: request.argText };
    const structured: GatewayRecord = {
      op: request.op,
      ...(request.op === "rename-call"
        ? { from: request.from, to: request.to }
        : { name: request.name, argText: request.argText, position: request.position }),
      files: shown.map((file) => ({
        path: file.path,
        replacements: file.replacements.map((replacement) => ({
          line: replacement.line,
          before: replacement.before,
          after: replacement.after,
        })),
      })),
      filesTouched,
      totalReplacements,
      filesSearched,
      previewOnly: true,
      limitReached,
      parseIssues: parseIssues.map((issue) => ({ path: issue.path, message: issue.message })),
      parseIssuesTotal,
    };
    return {
      content: [
        {
          type: "text",
          text: formatRewritePreview({
            change,
            files: shown,
            totalReplacements,
            filesTouched,
            filesSearched,
            limitReached,
            parseIssues,
            parseIssuesTotal,
          }),
        },
      ],
      structuredContent: structured,
    };
  }
}
