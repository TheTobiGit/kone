import { createAvatar } from "@dicebear/core";
import { thumbs } from "@dicebear/collection";

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
  // SAFETY: mapping over the three-element literal [0, 2, 4] always yields
  // exactly three numbers, so the result is a tuple, not just an array.
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
  if (!seed) return ANONYMOUS;
  const effectiveSeed = seed;
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

/** Resolve a stored roster row using the same preset fallbacks as the renderer. */
export function namedIdentity(seed: string, agent: import("@kone/agent-core/rosterRecord.js").AgentRecord | null): AgentIdentity | null {
  if (!agent) return null;
  const preset = agent.presetId === "kone" ? { name: "kone", body: "#b8654a", avatar: "/agents/kone.jpg" }
    : agent.presetId === "orchestrator" ? { name: "Orchestrator", body: "#5f7a76", avatar: undefined }
    : undefined;
  const name = agent.name?.trim() || preset?.name;
  if (!name) return null;
  const body = agent.faceBody || preset?.body || `#${BODIES[hash(agent.agentId) % BODIES.length]}`;
  const ink = agent.faceInk || "#1b1b1f";
  const eye = "M-4.46 -5.42A4.46 4.46 0 0 1 0 -9.89L0 -9.89A4.46 4.46 0 0 1 4.46 -5.42L4.46 5.42A4.46 4.46 0 0 1 0 9.89L0 9.89A4.46 4.46 0 0 1 -4.46 5.42Z";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="translate(2 1.6)"><path d="M0.06 48.12A48 48.24 0 0 1 96.06 48.12A48 48.24 0 0 1 0.06 48.12Z" fill="${body}"/><path d="${eye}" transform="matrix(0.95,-0.27,0.24,0.95,37.24,41.46)" fill="${ink}"/><path d="${eye}" transform="matrix(0.93,-0.16,0.24,0.95,62.09,35.7)" fill="${ink}"/></g></svg>`;
  const avatar = agent.avatar?.src ?? preset?.avatar;
  const identity: AgentIdentity = { seed, name, svg };
  if (avatar) identity.avatar = avatar;
  return identity;
}
