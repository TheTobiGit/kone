// Read-only language-server gateway tool (fronted as MCP).
//
// One tool, `kone_lsp`, fronts the pooled language servers: go-to-definition,
// references, hover, document and workspace symbols, diagnostics, and rename
// previews. Like the scratchpad read it is permission "allow" with no active
// turn required — every action only reads, and rename only previews the edit
// list the server WOULD apply. Nothing here writes to user files, ever: the
// client itself refuses the server's applyEdit requests, and this module never
// calls one.
//
// Addressing follows the resolver contract: agents name a workspace-relative
// path plus a 1-indexed line plus the symbol substring on that line, never a
// column. The one pathless action is a project-wide symbols search, which runs
// workspace/symbol directly — the only server call that needs no file text.
//
// This module validates input, resolves the file, and owns the client; each
// action's round trip lives in lsp/actions.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  definitionAction,
  diagnosticsAction,
  documentSymbolsAction,
  hoverAction,
  referencesAction,
  renamePreviewAction,
  workspaceSymbolsAction,
} from "../../lsp/actions.js";
import type { LspActionDeps, LspActionResult } from "../../lsp/actions.js";
import { LspAbortError, LspClientError } from "../../lsp/client.js";
import { LspManager, LspManagerError, LspNoServerError } from "../../lsp/manager.js";
import { resolvePosition } from "../../lsp/symbolResolver.js";
import type { LspPosition } from "../../lsp/types.js";
import { resolveInWorkspace } from "../paths.js";
import type {
  GatewayRecord,
  GatewayToolContext,
  GatewayToolResult,
  ToolEntry,
} from "../schemas.js";
import type { LspToolInput } from "../schemas.js";
import { GatewayToolError, LspToolInputSchema, LSP_JSON_SCHEMA } from "../schemas.js";
import { gatewayToolErrorResult } from "../registry.js";

const LSP_DESCRIPTION = [
  "Read-only language-server insight for the project codebase: go-to-definition, references, hover, document and workspace symbols, diagnostics, and rename previews.",
  "",
  "Address a position with a workspace-relative path plus a 1-indexed line plus the symbol text on that line (there are no column addresses; occurrence picks among repeats of the symbol on the line).",
  "",
  "Every action only reads. Rename returns the edit list the server WOULD apply as a preview and never writes files. Paths must stay inside the project.",
].join("\n");

const LSP_PROMPT_SNIPPET =
  "Ask the language server about project code: definitions, references, hover, symbols, diagnostics, and preview-only renames.";

export interface LspToolOptions {
  manager?: LspManager;
  readTextFile?: (filePath: string) => string | null;
}

function defaultReadTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// Position-needing actions share one rule: a 1-indexed line plus the symbol
// on it. A bare line is refused rather than guessed at. The resolver's
// message already names the problem; the wrapper tells the agent how to fix
// it.
function actionPosition(action: string, text: string, args: LspToolInput): LspPosition {
  if (args.line === undefined) {
    throw new GatewayToolError(
      "invalid_input",
      `Action "${action}" needs "line" (1-indexed) plus the "symbol" on it; positions are never addressed by column.`,
    );
  }
  const resolved = resolvePosition({
    documentLines: text.split("\n"),
    line1Indexed: args.line,
    symbol: args.symbol,
    occurrence: args.occurrence,
  });
  if (resolved.kind === "error") {
    throw new GatewayToolError(
      "invalid_input",
      `Cannot locate a position: ${resolved.message}. Pass the symbol text on the line, with "occurrence" when it repeats.`,
    );
  }
  return { line: resolved.line, character: resolved.character };
}

// One action's answer as a tool result: the action already built the text
// and the payload from the same objects, so this only wraps them.
function actionResult(action: LspActionResult): GatewayToolResult {
  return {
    content: [{ type: "text", text: action.text }],
    structuredContent: action.structured,
  };
}

/**
 * Creates the read-only language-server gateway tool, `kone_lsp`.
 */
export function createLspTools(options: LspToolOptions = {}): ToolEntry[] {
  const manager = options.manager ?? new LspManager();
  const readTextFile = options.readTextFile ?? defaultReadTextFile;

  const handler = async (
    ctx: GatewayToolContext,
    input: GatewayRecord,
  ): Promise<GatewayToolResult> => {
    const parsed = LspToolInputSchema.safeParse(input);
    if (!parsed.success) {
      return gatewayToolErrorResult(
        new GatewayToolError("invalid_input", parsed.error.message),
      );
    }
    const args = parsed.data;
    const projectRoot = path.resolve(ctx.cwd);
    const deps: LspActionDeps = { manager, projectRoot, readTextFile, signal: ctx.signal };
    try {
      if (args.action === "symbols" && args.path === undefined) {
        return actionResult(await workspaceSymbolsAction(deps, args.query ?? ""));
      }
      const relPath = args.path;
      if (relPath === undefined) {
        throw new GatewayToolError(
          "invalid_input",
          `Action "${args.action}" needs "path": name a workspace-relative file inside the project.`,
        );
      }
      const absPath = resolveInWorkspace(projectRoot, relPath);
      if (absPath === null) {
        throw new GatewayToolError(
          "invalid_input",
          `Path "${relPath}" escapes the project root; pass a workspace-relative path inside the project.`,
        );
      }
      const text = readTextFile(absPath);
      if (text === null) {
        throw new GatewayToolError(
          "invalid_input",
          `Cannot read file "${relPath}": it is missing or unreadable.`,
        );
      }
      const client = await manager.getClient({ cwd: projectRoot, filePath: absPath });
      const uri = pathToFileURL(absPath).toString();
      client.openDocument(uri, manager.languageIdForFile(projectRoot, absPath), text);
      switch (args.action) {
        case "definition":
          return actionResult(
            await definitionAction(deps, client, uri, actionPosition("definition", text, args)),
          );
        case "references":
          return actionResult(
            await referencesAction(deps, client, uri, actionPosition("references", text, args)),
          );
        case "hover":
          return actionResult(
            await hoverAction(deps, client, uri, actionPosition("hover", text, args)),
          );
        case "symbols":
          return actionResult(await documentSymbolsAction(deps, client, uri, relPath));
        case "diagnostics":
          return actionResult(diagnosticsAction(client, uri, relPath));
        case "rename": {
          const newName = args.newName;
          if (newName === undefined) {
            throw new GatewayToolError(
              "invalid_input",
              "Rename needs \"newName\": the name the symbol should become.",
            );
          }
          return actionResult(
            await renamePreviewAction(
              deps,
              client,
              uri,
              actionPosition("rename", text, args),
              newName,
            ),
          );
        }
      }
    } catch (error) {
      if (error instanceof GatewayToolError) throw error;
      // Cancellation is not a tool failure: abort errors already carry the
      // transport's name from their definition, so they pass straight through.
      if (error instanceof LspAbortError) throw error;
      // No server owns the file (or a configured one is disabled): the agent
      // can fix its args, so this is invalid input, not an outage.
      if (error instanceof LspNoServerError) {
        throw new GatewayToolError("invalid_input", error.message);
      }
      if (error instanceof LspManagerError || error instanceof LspClientError) {
        throw new GatewayToolError("internal", error.message);
      }
      throw error;
    }
  };

  return [
    {
      name: "kone_lsp",
      description: LSP_DESCRIPTION,
      inputSchema: LspToolInputSchema,
      jsonSchema: LSP_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet: LSP_PROMPT_SNIPPET,
      handler,
    },
  ];
}
