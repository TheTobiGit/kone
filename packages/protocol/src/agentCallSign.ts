// The name a thread nobody was handed to goes by.
//
// A guest thread has no stored name: its call sign is rolled from its durable
// id, so the same conversation answers to the same name on every launch, on
// every surface, with nothing stored alongside it. The roll has to come out the
// same in the renderer, which shows the name, and in the main process, which
// tells other agents who is talking — if the two disagreed, an agent would be
// addressed by a name the user never sees. So it lives here, once, and both
// sides call it. Pure, and free of anything either side can't import.

/**
 * Call signs. Concrete, quiet, and all one word — the name sits inline in a
 * speaker line next to a timestamp, so anything longer starts wrapping the row
 * on a narrow column. Nothing cute and nothing sci-fi: these read as names a
 * colleague could have, which is the point.
 *
 * Append-only in effect: the roll indexes into this list, so inserting,
 * removing or reordering an entry renames every guest thread there is.
 */
export const AGENT_CALL_SIGNS = [
  "Alder", "Ansel", "Arbor", "Ash", "Aster", "Basalt", "Beacon", "Birch",
  "Bramble", "Brass", "Briar", "Cairn", "Canvas", "Cedar", "Chalk", "Cinder",
  "Clay", "Clove", "Cobalt", "Compass", "Coral", "Cove", "Crest", "Cypress",
  "Dune", "Ember", "Fable", "Fathom", "Fennel", "Fern", "Flint", "Forge",
  "Gable", "Garnet", "Glade", "Gorse", "Granite", "Grove", "Harbor", "Hazel",
  "Heron", "Hollow", "Indigo", "Ivory", "Juniper", "Kestrel", "Kiln", "Lantern",
  "Larch", "Lark", "Ledger", "Linen", "Loam", "Lumen", "Marble", "Marlow",
  "Meadow", "Meridian", "Mica", "Millet", "Mistral", "Moss", "Nettle", "Nimbus",
  "Oak", "Onyx", "Opal", "Orchard", "Osprey", "Otter", "Pallas", "Pebble",
  "Pine", "Plume", "Quarry", "Quill", "Rally", "Reed", "Relay", "Ridge",
  "Rill", "Rook", "Rowan", "Rune", "Sable", "Sage", "Sand", "Sequoia",
  "Shale", "Shore", "Sienna", "Slate", "Sorrel", "Spruce", "Stone", "Summit",
  "Tally", "Tansy", "Teal", "Terrace", "Thicket", "Thistle", "Tide", "Timber",
  "Trellis", "Tundra", "Umber", "Vale", "Vellum", "Verge", "Vesper", "Warden",
  "Wick", "Willow", "Wren", "Yarrow", "Zephyr",
] as const;

/** FNV-1a. Cheap, stable, and well spread across short id strings. */
export function callSignHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The call sign rolled from `seed` — the id of the thread's root
 *  conversation, not of a side chat forked from it (see rootConversationId). */
export function callSignFor(seed: string): string {
  return AGENT_CALL_SIGNS[callSignHash(seed) % AGENT_CALL_SIGNS.length]!;
}

/**
 * The conversation a thread's call sign is rolled from: a side chat answers
 * under the name of the thread it was forked from, so it reads as the same
 * agent stepping aside rather than a stranger. `sourceOf` names the thread a
 * side chat was forked from, or nothing for any other thread. Cycles stop
 * where they close, so bad data can't hang the walk.
 */
export function rootConversationId(threadId: string, sourceOf: (threadId: string) => string | null | undefined): string {
  let current = threadId;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const source = sourceOf(current);
    if (!source) break;
    current = source;
  }
  return current;
}
