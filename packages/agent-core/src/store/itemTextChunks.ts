/** Append-only streaming text: the encode/decode pair and the read-time
 *  reassembly expressions shared by the item write path (`store/events.ts`)
 *  and every read site that renders item text.
 *
 *  Why chunks: `item.updated` fires once per text delta and each event carries
 *  the full accumulated snapshot, so persisting the snapshot itself per event
 *  writes O(n^2) bytes for an n-byte message. Appending only the new suffix
 *  as an ordered chunk row costs O(n) total, and reads concatenate the chunks
 *  in sequence order. Chunk rows are transient — `item.completed` folds them
 *  into the `items` row and deletes them.
 *
 *  Why JSON-encoded chunks: SQLite TEXT cannot round-trip every JS string.
 *  Reads through this repo's driver truncate at an embedded NUL byte, and an
 *  unpaired UTF-16 surrogate has no UTF-8 form at all, so either byte stored
 *  raw comes back corrupted. A JSON string literal escapes both (`\u0000`,
 *  `\ud800`), which the driver carries opaquely and `json_each` decodes back
 *  to the exact original — including the NUL and the lone surrogate. The
 *  settled `items` row keeps its raw `text` column for the common case and
 *  carries the same encoding in `items.text_json` only when the raw form
 *  cannot round-trip. */

/** Whether `text` needs the encoded fallback: it contains a byte the TEXT
 *  column cannot round-trip (an embedded NUL truncates the read) or a code
 *  unit with no UTF-8 form (an unpaired surrogate). */
export function needsTextFallback(text: string): boolean {
  return (
    text.includes("\u0000") ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
  );
}

/** The encoded form of `text` when the raw TEXT column cannot round-trip it,
 *  else null. The encoding is a JSON string literal: it escapes NUL and lone
 *  surrogates opaquely, and `JSON.parse` inverts it byte-identically. */
export function encodeTextFallback(text: string): string | null {
  return needsTextFallback(text) ? JSON.stringify(text) : null;
}

/** The raw `text` value to store alongside `encodeTextFallback(text)`: the
 *  text itself when it round-trips, else the empty string — never the raw
 *  unsafe bytes, which would read back truncated or replaced. */
export function rawTextForStorage(text: string): string {
  return needsTextFallback(text) ? "" : text;
}

/** Reconstruct a settled base text from its two stored forms: the encoded
 *  fallback wins when present, otherwise the raw column (null reads as
 *  empty — the column predates its NOT NULL discipline in practice). */
export function decodeStoredText(text: string | null, textJson: string | null): string {
  if (textJson !== null && textJson !== "") {
    // SAFETY: text_json columns are only ever written from JSON.stringify of a
    // string, so parsing inverts the write exactly.
    return JSON.parse(textJson) as string;
  }
  return text ?? "";
}

/** Correlated SQL expression evaluating to one `items` row's pending chunks
 *  as a JSON array string: each chunk delta still in its JSON-encoded form,
 *  ordered by sequence ('[]' when the item has none — settled, or written
 *  before chunking existed). The array text itself is plain ASCII, so it
 *  crosses the driver opaquely; decoding happens in JS (see
 *  decodeChunkArray), because decoding inside SQLite cannot round-trip an
 *  unpaired surrogate — SQLite TEXT has no form for it, so it comes back as
 *  replacement characters. One indexed lookup per row, never one query per
 *  item. `itemsAlias` is the SQL alias (or table name) of the `items` row the
 *  expression correlates against; callers pass a literal, never user input. */
export function itemChunkArraySql(itemsAlias: string): string {
  return (
    `COALESCE((SELECT json_group_array(c.text_json ORDER BY c.seq) ` +
    `FROM item_text_chunks c WHERE c.thread_id = ${itemsAlias}.thread_id ` +
    `AND c.turn_id = ${itemsAlias}.turn_id AND c.item_id = ${itemsAlias}.item_id), '[]')`
  );
}

/** Decode one `itemChunkArraySql` value into the concatenated chunk suffix.
 *  Each array element is one JSON-encoded delta; parsing twice inverts the
 *  two encodings (the writer's `JSON.stringify` and the array's) exactly —
 *  NUL bytes, lone surrogates, and all. */
export function decodeChunkArray(chunksJson: string | null): string {
  if (!chunksJson) return "";
  // SAFETY: the array was aggregated by SQLite over text_json values this
  // writer JSON-encoded, so it parses to an array of JSON strings.
  const encoded = JSON.parse(chunksJson) as Array<string>;
  let out = "";
  for (const element of encoded) {
    // SAFETY: each element is one JSON-encoded chunk delta (see above), so it
    // parses back to the exact delta string.
    out += JSON.parse(element) as string;
  }
  return out;
}

/** Correlated SQL expression evaluating to one `items` row's full
 *  reassembled text: the settled base (preferring the encoded fallback when
 *  present) plus the pending chunk suffix. Byte-identical to what the row
 *  held before chunking existed whenever the item has no chunks.
 *
 *  Approximation note: the suffix is decoded inside SQLite here, which
 *  cannot round-trip an unpaired surrogate (see itemChunkArraySql) — a
 *  pathological code unit in still-streaming text reads back as a replacement
 *  character through this expression. NUL bytes are unaffected. This
 *  expression serves the thread-list snippet, where a single scalar keeps the
 *  read to one query; the transcript reads (which must be exact) aggregate
 *  with itemChunkArraySql and decode in JS instead. */
export function itemFullTextSql(itemsAlias: string): string {
  return (
    `COALESCE((SELECT value FROM json_each(${itemsAlias}.text_json)), ${itemsAlias}.text, '') || ` +
    `COALESCE((SELECT GROUP_CONCAT((SELECT value FROM json_each(c.text_json)), '' ORDER BY c.seq) ` +
    `FROM item_text_chunks c WHERE c.thread_id = ${itemsAlias}.thread_id ` +
    `AND c.turn_id = ${itemsAlias}.turn_id AND c.item_id = ${itemsAlias}.item_id), '')`
  );
}
