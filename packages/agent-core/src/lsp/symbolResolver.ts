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
 *  1-indexed line, and the optional symbol disambiguator. A bare line is
 *  always refused: without symbol text on the line the position is ambiguous,
 *  so the caller must name what sits there. */
export interface SymbolResolveRequest {
  documentLines: readonly string[];
  line1Indexed: number;
  symbol?: string;
  occurrence?: number;
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

function error(message: string): SymbolResolveResult {
  return { kind: "error", message };
}

export function resolvePosition(request: SymbolResolveRequest): SymbolResolveResult {
  const total = request.documentLines.length;
  // The single line guard: any out-of-range, fractional, or otherwise
  // unusable line indexes no element, so one check covers every bad line.
  const lineText = request.documentLines[request.line1Indexed - 1];
  if (lineText === undefined) {
    return error(`line ${request.line1Indexed} is outside the document (1-${total})`);
  }

  const symbol = request.symbol;
  if (symbol === undefined || symbol.trim().length === 0) {
    return error(`line ${request.line1Indexed} needs a symbol; pass the symbol text on the line`);
  }

  const occurrence = request.occurrence ?? 1;
  if (!Number.isInteger(occurrence) || occurrence < 1) {
    return error(`occurrence must be a positive integer, got ${occurrence}`);
  }
  const starts = matchStarts(lineText, symbol);
  if (starts.length === 0) {
    return error(`symbol "${symbol}" not found on line ${request.line1Indexed}`);
  }
  // The single occurrence guard: any pick past the last match indexes no
  // element, so one check covers every out-of-range occurrence.
  const start = starts[occurrence - 1];
  if (start === undefined) {
    return error(
      `occurrence ${occurrence} is out of range: line ${request.line1Indexed} has ${starts.length} of "${symbol}"`,
    );
  }
  return { kind: "ok", line: request.line1Indexed - 1, character: start };
}
