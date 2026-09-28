// One canonical spelling per tool, resolved once as items enter the UI.
//
// Providers surface kone's tools qualified by the server they reached it
// through — `mcp__kone__scratchpad_read` under the MCP envelope, `kone__…` from
// CLIs that skip it, `kone_…` from CLIs that join server and tool with a single
// underscore. Unwrap all three so identity checks and phrasing see the plain
// tool, and bring a name from before the tools were renamed up to its current
// one, so an old thread reads like a new one. Foreign servers keep the
// envelope, so generic-MCP branches still catch them.
//
// Everything downstream — the icon/label table, the target peel, the phrasing,
// the status pill — reads `item.name` as-is. Canonicalizing here rather than in
// each vocabulary means the next pill or badge cannot forget to unwrap.

import { currentKoneToolName, isKoneToolName } from "@kone/protocol/kone-tools";
import type { RuntimeItem } from "~/types/desktop";

/** The servers kone's gateway reaches a provider as: `kone`, plus
 *  `kone_extra` for the tools a deferring provider loads on demand. */
const KONE_SERVERS = new Set(["kone", "kone_extra"]);

/** A kone tool under its current name, or undefined when `name` is not one —
 *  under either its current or its former spelling. */
function koneTool(name: string): string | undefined {
  const current = currentKoneToolName(name);
  return isKoneToolName(current) ? current : undefined;
}

export function canonicalToolName(rawName: string | undefined): string {
  const trimmed = (rawName ?? "").trim().toLowerCase();
  if (!trimmed) return "";
  let key = trimmed;
  if (key.startsWith("mcp__")) {
    const parts = key.split("__").filter((part) => part.length > 0);
    if (!KONE_SERVERS.has(parts[1] ?? "")) return key;
    key = parts[parts.length - 1] ?? key;
  } else if (key.startsWith("kone_extra__")) {
    key = key.slice("kone_extra__".length);
  } else if (key.startsWith("kone__")) {
    key = key.slice("kone__".length);
  }
  const direct = koneTool(key);
  if (direct) return direct;
  // A single-underscore join is only a server stamp when what follows it is a
  // kone tool; a foreign `kone_…` name stays as it is.
  if (key.startsWith("kone_")) return koneTool(key.slice("kone_".length)) ?? key;
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
