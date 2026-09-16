// One canonical spelling per tool, resolved once as items enter the UI.
//
// Providers surface MCP tools qualified by their server — `mcp__kone__kone_x`
// under the envelope, or bare `kone__kone_x` from CLIs that skip it. kone's
// server and its own tools share the `kone` head, so humanizing a qualified
// name repeats it ("kone kone spawn batch"). Unwrap kone's own server (and
// fold a doubly-stamped head) so identity checks and phrasing see the plain
// tool. Foreign servers keep the envelope, so generic-MCP branches still
// catch them.
//
// Everything downstream — the icon/label table, the target peel, the phrasing,
// the status pill — reads `item.name` as-is. Canonicalizing here rather than in
// each vocabulary means the next pill or badge cannot forget to unwrap.

import type { RuntimeItem } from "~/types/desktop";

export function canonicalToolName(rawName: string | undefined): string {
  const trimmed = (rawName ?? "").trim().toLowerCase();
  if (!trimmed) return "";
  let key = trimmed;
  if (key.startsWith("mcp__")) {
    const parts = key.split("__").filter((part) => part.length > 0);
    const tail = parts[parts.length - 1] ?? key;
    if (parts[1] !== "kone") return key;
    key = tail;
  } else if (key.startsWith("kone__")) {
    key = key.slice("kone__".length);
  }
  while (key.startsWith("kone_kone_")) key = key.slice("kone_".length);
  return key;
}

/** Restamp a tool_call with its canonical name, and any nested subagent run's
 *  items with theirs. Other kinds pass through untouched, as does an item
 *  already spelled canonically — an unchanged item is returned by identity, so
 *  the common case allocates nothing. */
export function canonicalizeItem(item: RuntimeItem): RuntimeItem {
  if (item.kind !== "tool_call") return item;
  const name = canonicalToolName(item.name);
  const renamed = Boolean(name) && name !== item.name;
  const run = item.subagent;
  const nested = run ? run.items.map(canonicalizeItem) : undefined;
  const nestedChanged = Boolean(
    run && nested && nested.some((child, i) => child !== run.items[i]),
  );
  if (!renamed && !nestedChanged) return item;
  const next: RuntimeItem = renamed ? { ...item, name } : { ...item };
  if (run && nested && nestedChanged) next.subagent = { ...run, items: nested };
  return next;
}
