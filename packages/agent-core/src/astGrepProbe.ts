import { Lang, parse } from "@ast-grep/napi";
import type { Range } from "@ast-grep/napi";

// Minimal load + match probe for the native binding.
// Not an engine, just enough surface to prove the dep works in every runtime.
const TWO_ARG_CALL_PATTERN = "foo($A, $B)";

export interface AstGrepProbeHit {
  text: string;
  range: Range;
}

export interface AstGrepProbeResult {
  hits: Array<AstGrepProbeHit>;
  firstArgOfFirstHit: string | null;
  transformedOfFirstHit: string | null;
}

export function probeTwoArgFooCalls(source: string): AstGrepProbeResult {
  // SgRoot carries no matching api, only root()/filename(); findAll lives on SgNode.
  const matches = parse(Lang.TypeScript, source).root().findAll(TWO_ARG_CALL_PATTERN);
  const hits = matches.map((node) => ({ text: node.text(), range: node.range() }));
  const first = matches[0];
  if (first === undefined) {
    return { hits, firstArgOfFirstHit: null, transformedOfFirstHit: null };
  }
  const arg = first.getMatch("A");
  return {
    hits,
    firstArgOfFirstHit: arg === null ? null : arg.text(),
    // GetTransformed is known-broken upstream and always resolves to null.
    // Later slices must substitute text themselves instead of relying on it.
    transformedOfFirstHit: first.getTransformed("edited($A, $B)"),
  };
}
