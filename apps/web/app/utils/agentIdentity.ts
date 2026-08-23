/**
 * Who answered — one face and one name per thread.
 *
 * A named agent answers for themselves: when a thread has been handed to one,
 * this gives back their name and their face, unchanged from thread to thread.
 * Everything below is for a thread that was never handed to anybody — a guest,
 * derived entirely from the thread's durable id, so the same conversation wears
 * the same face on every launch, on every surface, with nothing stored
 * alongside it. No identity table, no migration, no way for the face to drift
 * out of sync with the thread it belongs to.
 *
 * The face is `thumbs`: one rounded body and two eyes, which is the same
 * anatomy as the composer's resting mark — a thread's agent reads as a sibling
 * of kone's own face rather than as a sticker dropped on top of it. Its palette
 * is replaced wholesale below; the shipped one is a bright toy set that would
 * shout on warm paper.
 */
import { createAvatar } from "@dicebear/core";
import { thumbs } from "@dicebear/collection";
import { agentForThread } from "~/utils/agents";
import { resolveRootThreadId } from "~/composables/useSideChats";

export interface AgentIdentity {
  /** The id this identity was derived from. */
  seed: string;
  /** The agent's call sign — what the transcript names as the speaker. */
  name: string;
  /** Inline SVG markup, ready to mount. */
  svg: string;
  /** A picture of the agent, when it has one — drawn in place of the SVG, which
   *  stays filled in as the fallback for anything that can't show an image. A
   *  guest never has one: a guest's whole point is that nothing about it is
   *  stored, and a picture is the one part of an identity that has to be. */
  avatar?: string;
}

/**
 * Call signs. Concrete, quiet, and all one word — the name sits inline in a
 * speaker line next to a timestamp, so anything longer starts wrapping the row
 * on a narrow column. Nothing cute and nothing sci-fi: these read as names a
 * colleague could have, which is the point.
 */
const NAMES = [
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

/**
 * Bodies. Every one is mid-tone on purpose: the face has to hold its silhouette
 * against warm paper AND against the near-black dark scheme, and the ink eyes
 * have to stay legible on all of them. Hues stay in the accent's family of
 * clays, sages and slates so a row of agents reads as one set.
 */
const BODIES = [
  "b8654a", "c08a5b", "9c6b58", "a86f6f", "8a6a86",
  "6b7391", "5f7a76", "5c7f6a", "7f8b6b", "94794f",
  "6e7d8a", "7a6a5d",
];

/** The eyes and mouth, high-contrast ink features for sharp definition. */
const FEATURES = ["18181b"];

/** The paper the light scheme is printed on — what a tile is tinted toward. */
const PAPER = "f6f5f3";

/**
 * How far a tile travels from its body toward paper. Far enough that the body
 * still reads as the subject, near enough that the tile survives being drawn on
 * warm paper at 14px — go much paler and the muted bodies lose their ground
 * entirely on the light scheme.
 */
const TILE_TINT = 0.7;

function channels(hex: string): [number, number, number] {
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** `a` blended `t` of the way toward `b`, back as a hex triplet. */
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = channels(a);
  const [r2, g2, b2] = channels(b);
  return [r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]
    .map((v) => Math.round(v).toString(16).padStart(2, "0"))
    .join("");
}

/** FNV-1a. Cheap, stable, and well spread across short id strings. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A thread with no id yet — the blank column before its first send. */
const ANONYMOUS: AgentIdentity = { seed: "", name: "kone", svg: "" };

// Generating an avatar walks the style's whole option schema, which is far more
// work than a list row should do on every re-render. The result is a pure
// function of the seed, so it is worth keeping.
const cache = new Map<string, AgentIdentity>();

export function agentIdentity(seed: string | null | undefined): AgentIdentity {
  // A thread handed to an agent wears that agent's face, not one drawn from its
  // id — the identity belongs to the person, not to the conversation. A thread
  // nobody was assigned to falls through to the guest below, so the derived face
  // stays what you get unless you asked for otherwise.
  //
  // Deliberately not memoised: an agent can be renamed, and the new name has to
  // reach every speaker line already on screen.
  const agent = agentForThread(seed);
  if (agent) {
    const identity: AgentIdentity = { seed: seed ?? "", name: agent.name, svg: agent.svg };
    if (agent.avatar) identity.avatar = agent.avatar.src;
    return identity;
  }

  if (!seed) return ANONYMOUS;
  const effectiveSeed = resolveRootThreadId(seed) ?? seed;
  const hit = cache.get(effectiveSeed);
  if (hit) return hit;

  const h = hash(effectiveSeed);
  // The name and the body are taken from different ends of the hash so two
  // threads that happen to share a call sign don't also share a colour.
  const name = NAMES[h % NAMES.length]!;
  const body = BODIES[(h >>> 11) % BODIES.length]!;

  const identity: AgentIdentity = {
    seed: effectiveSeed,
    name,
    svg: createAvatar(thumbs, {
      seed: effectiveSeed,
      // The tile is the body's own hue washed out, so an agent stays one colour
      // and the face keeps a ground of its own on both schemes — a body alone
      // has nothing to sit on once the surface behind it goes near-black.
      backgroundColor: [mix(body, PAPER, TILE_TINT)],
      // Circular, to stay in the same family as kone's other round marks.
      radius: 50,
      // `shapeColor`/`shapeRotation` are the option names the `thumbs` face
      // (imported above) reads; they're its contract, not ours to rename.
      // eslint-disable-next-line anti-slop/no-shape-in-symbol-names
      shapeColor: [body],
      eyesColor: FEATURES,
      mouthColor: FEATURES,
      // The body is pulled back off the edges so the tile reads as a ring
      // rather than a crescent, then nudged down, since `thumbs` draws its body
      // sitting high in the frame.
      scale: 72,
      translateY: 8,
      faceRotation: [-8, 8],
      // eslint-disable-next-line anti-slop/no-shape-in-symbol-names
      shapeRotation: [-6, 6],
      // Inlined avatars share one document, so their internal ids have to be
      // unique or the first one on the page clips all the others.
      randomizeIds: true,
    }).toString(),
  };

  cache.set(effectiveSeed, identity);
  return identity;
}
