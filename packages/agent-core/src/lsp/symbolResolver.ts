// File + line + symbol-substring addressing for agent requests.
//
// Agents cannot do columns, so every action resolves a (line, symbol,
// occurrence) triple to a protocol position first. All offsets below are
// utf-16 code units — the same units plain js string indices count in — so an
// index straight out of indexOf is already the character the server expects.
// Astral characters occupy two units each; counting anything else (code
// points, graphemes) would land one column off after the first emoji on the
// line.

/** What the resolver needs: the open document as lines, the agent's
 *  1-indexed line, and the optional symbol disambiguator. projectAware marks
 *  servers that need the symbol to pick a node (a bare line is ambiguous to
 *  them); lenient servers accept a bare line as "start of content". */
export interface SymbolResolveRequest {
  documentLines: readonly string[];
  line1Indexed: number;
  symbol?: string;
  occurrence?: number;
  projectAware: boolean;
}

export type SymbolResolveResult =
  | { kind: "ok"; line: number; character: number }
  | { kind: "error"; message: string };

/** Non-overlapping match starts for a non-empty needle: exact substring,
 *  case-sensitive, so what the agent typed is what the line must hold. */
function matchStarts(lineText: string, symbol: string): readonly number[] {
  if (symbol.length === 0) return [];
  const starts: number[] = [];
  let from = 0;
  while (from <= lineText.length) {
    const found = lineText.indexOf(symbol, from);
    if (found < 0) break;
    starts.push(found);
    from = found + symbol.length;
  }
  return starts;
}

/** First non-whitespace column. A blank line has none; column 0 keeps the
 *  position valid instead of erroring on whitespace-only lines. */
function firstContentColumn(lineText: string): number {
  const found = lineText.search(/\S/);
  return found < 0 ? 0 : found;
}

function error(message: string): SymbolResolveResult {
  return { kind: "error", message };
}

export function resolvePosition(request: SymbolResolveRequest): SymbolResolveResult {
  const total = request.documentLines.length;
  if (!Number.isInteger(request.line1Indexed) || request.line1Indexed < 1 || request.line1Indexed > total) {
    return error(`line ${request.line1Indexed} is outside the document (1-${total})`);
  }
  const lineText = request.documentLines[request.line1Indexed - 1];
  if (lineText === undefined) {
    // The range check above keeps this index in bounds; the guard is for the
    // indexed-access type, which cannot see that.
    return error(`line ${request.line1Indexed} is outside the document (1-${total})`);
  }

  const symbol = request.symbol;
  if (symbol === undefined || symbol.trim().length === 0) {
    if (request.projectAware) {
      return error(`line ${request.line1Indexed} needs a symbol on project-aware servers`);
    }
    return { kind: "ok", line: request.line1Indexed - 1, character: firstContentColumn(lineText) };
  }

  const occurrence = request.occurrence ?? 1;
  if (!Number.isInteger(occurrence) || occurrence < 1) {
    return error(`occurrence must be a positive integer, got ${occurrence}`);
  }
  const starts = matchStarts(lineText, symbol);
  if (starts.length === 0) {
    return error(`symbol "${symbol}" not found on line ${request.line1Indexed}`);
  }
  if (occurrence > starts.length) {
    return error(
      `occurrence ${occurrence} is out of range: line ${request.line1Indexed} has ${starts.length} of "${symbol}"`,
    );
  }
  const start = starts[occurrence - 1];
  if (start === undefined) {
    // Bounds-checked above; the guard is for the indexed-access type.
    return error(
      `occurrence ${occurrence} is out of range: line ${request.line1Indexed} has ${starts.length} of "${symbol}"`,
    );
  }
  return { kind: "ok", line: request.line1Indexed - 1, character: start };
}
