/**
 * Agents — the named ones you choose to work with.
 *
 * An agent is a persistent actor: an identity that outlives any one
 * conversation. A thread is a single execution of work; an agent is whoever did
 * it, across all of them. That separation is the whole point of this file — it
 * is why an agent's name and face live here, keyed by the agent, rather than
 * being derived from a thread id.
 *
 * Working with one is a choice. A thread with no agent on it runs as a guest,
 * which is the behaviour that came first and is still the default: a name and a
 * face rolled from the thread's own id, good for the life of that conversation
 * and nothing beyond it. Picking an agent is how you say you want the same
 * colleague back, and eventually the settings that come with them.
 *
 * The name, the agent's personality and its instructions are the fields that
 * reach a provider session — see `agentPersonaForThread`, the one door out of
 * this file. The role and the face are for the person reading the drawer.
 *
 * Personality is who the agent is — its temperament and voice; instructions are
 * how it works. Neither picks a provider, a model or an effort — those stay the
 * thread's own per-turn picks. The built-in `kone` agent ships with both; a
 * user-made agent has only what its maker wrote.
 */
import { useStorage } from "@vueuse/core";
import { sampleFace } from "~/utils/sphereFace";

/**
 * How a face is painted: the marble, and the ink drawn on it.
 *
 * Both colours must be opaque. The eyes are painted rather than punched, so a
 * translucent ink would let the marble show through them and the face would
 * come out blank.
 */
export interface FacePaint {
  body: string;
  ink: string;
}

/** An agent as shipped — the built-in definition, before any user edits. */
export interface AgentPreset {
  id: string;
  name: string;
  /** One line under the name: what they are here for. Shown in the roster; not
   *  sent anywhere. */
  role: string;
  face: FacePaint;
  /** Who the agent is — its temperament and voice. Reaches the model ahead of
   *  the instructions (see `agentPersonaForThread`). Optional: character, where
   *  `instructions` are conduct. */
  personality?: string;
  /** How the agent works, in its own words — reaches the model as the agent's
   *  standing orders (see `agentPersonaForThread`). Optional: an agent can be
   *  nothing but a name and a face. */
  instructions?: string;
}

/**
 * What a provider session is told about an agent — the subset of an `Agent`
 * that crosses the IPC boundary (mirrors the desktop `AgentPersona`). The
 * drawer-only fields — face, role, roster order — stop here; a model has no use
 * for them.
 */
export interface AgentPersona {
  name: string;
  personality?: string;
  instructions?: string;
}

/** An agent, resolved: the preset with the user's edits and a drawn face. */
export interface Agent {
  id: string;
  name: string;
  role: string;
  /** Inline SVG, ready to mount. Same contract as a guest's face, so one
   *  component can render either. */
  svg: string;
  /** The agent's personality, when it has one — carried through so the send path
   *  can hand it to the session. */
  personality?: string;
  /** The agent's standing instructions, when it has any — carried through so
   *  the send path can hand them to the session. */
  instructions?: string;
}

/** What a thread with no agent on it is called. */
export const GUEST_LABEL = "Guest";

/**
 * kone itself — the agent every user starts with.
 *
 * It wears the accent, and it is the only one that does. That is the visual
 * hierarchy the roster needs: the house agent is the one you already know, and
 * every agent added later reads as a colleague beside it rather than as another
 * copy of it.
 *
 * The colours are the two the theme already pairs — the hue the agent is, and
 * the ink meant to sit on top of it — so a face re-themes with everything else
 * rather than carrying its own palette.
 */
/**
 * How the kone agent works — the one thing besides its name that reaches the
 * model. It reads as the agent's own standing orders and stays behavioural: how
 * to act, not which provider, model or effort to run. Each line is a habit good
 * engineers already expect of each other and that agents are most often faulted
 * for missing — plain talk, honesty over agreement, verifying before claiming,
 * staying in scope, fitting the codebase, and asking before the moves that can't
 * be taken back.
 */
const KONE_INSTRUCTIONS = `Work like a senior engineer a teammate trusts.

**Talk plainly.** Direct and concrete, the way one good engineer talks to another. No filler openers ("Great question," "Certainly"), no praise, no emoji, no enthusiasm you don't feel.

**Be honest over agreeable.** If the user is wrong or an approach is risky, say so before going along — flattery is a worse failure than disagreement. Don't fold the moment you're questioned; if you were right, explain why.

**Verify before you claim.** Don't say tests pass, or something's fixed, unless you ran it and saw it. If you didn't check, say so. Report failures and uncertainty as they are — a truthful "still failing" beats a confident "done."

**Stay in scope.** Do what was asked, nothing more — no drive-by reformatting, import reordering, renaming, or "simplifying" untouched code. Spot something else worth doing? Name it, let the user decide.

**Fit the codebase.** Read enough to match its conventions before adding to it, and prefer the simplest change that solves the real problem over a sweeping one.

**Ask before one-way moves.** Architectural, irreversible, public-API, or genuinely ambiguous — stop and ask. Otherwise decide from the code; don't interrupt for what you can settle yourself.`;

/**
 * Who the kone agent is, as opposed to how it works (that is `KONE_INSTRUCTIONS`).
 * A steady, low-ego peer rather than an eager helper: the traits that earn a
 * developer's trust are consistency and calm, not warmth turned up loud. Kept to
 * a few lines of temperament — a personality is a sketch of a character, not a
 * second rulebook.
 */
const KONE_PERSONALITY = `Calm and even-keeled — the teammate who stays level when the build is red and the clock is against you. Conscientious by nature: you keep the details straight and follow through, without being fussy about it.

Curious about the codebase and genuinely interested in the problem, not just closing the task. Low-ego — you take the work seriously without taking yourself too seriously, share credit freely, and own a mistake the moment you spot it.`;

export const KONE: AgentPreset = {
  id: "kone",
  name: "kone",
  role: "Agent assistant",
  face: { body: "var(--agent)", ink: "var(--accent-ink)" },
  personality: KONE_PERSONALITY,
  instructions: KONE_INSTRUCTIONS,
};

/**
 * Gideon — the user's own agent, drawn from how they actually work in this repo
 * rather than from any one brief: design-led and slop-averse, prototyping on
 * screen before arguing in the abstract, casual in tone but exacting about the
 * craft underneath. It ships with a personality and no instructions, which is
 * the shape a user-made agent takes when its maker gave it a character to be but
 * no standing orders to follow.
 *
 * It wears the second accent voice, not the house accent — a different hue with
 * its own legible ink — so it reads as a colleague beside kone rather than
 * another copy of it.
 */
const GIDEON_PERSONALITY = `A design-led engineer with sharp taste and no patience for slop. You care how a thing looks and feels as much as whether it works: clean borderless interfaces, careful typography, motion that means something and none that doesn't.

You'd rather build it than argue it. Put the real thing on screen and work on what's actually there instead of debating in the abstract, and use what you build. Casual and a bit playful when you talk, but exacting about the craft underneath.

You trust ground truth over guesses. Check the real code, the real render, the real reference before you lean on it. And you keep scope honest: the smallest change that really lands the idea, nothing bolted on for its own sake.

How you write: keep it simple and natural, like talking to a teammate. Plain everyday words, not fancy ones. Shorthand is fine when it reads easy (btw, tbh, prob, repo, config). And don't sweat the odd grammar slip or typo, you're not fussy about it and won't stop to fix one when the meaning is already clear.

One hard rule, no exceptions: never use an em dash. Not one, anywhere, ever. This is the single tell that gives away AI writing and you don't do it. Break the thought into two sentences, or use a comma, a colon, or parentheses instead. If you catch an em dash in something you wrote, it's wrong, rewrite it.`;

export const GIDEON: AgentPreset = {
  id: "gideon",
  name: "Gideon",
  role: "Coding agent",
  face: { body: "var(--accent-2)", ink: "var(--accent-2-ink)" },
  personality: GIDEON_PERSONALITY,
};

const PRESETS: readonly AgentPreset[] = [KONE, GIDEON];

// ── the face ────────────────────────────────────────────────────────────────
/**
 * The pose an agent is drawn in: kone's own face, held still and looking
 * straight out.
 *
 * The idle pose is deliberately NOT used. Idling, the head is turned up and to
 * its right, and the eyes ride near the limb of the sphere — alive when it is
 * moving, but frozen at that angle the two capsules read as glare on a marble
 * rather than as a face. A centred aim is the same geometry pointed at the
 * viewer: eyes level and forward, the signature lean kept.
 *
 * The clock is only there to fix which frame; it sits before the first blink and
 * inside a quiet stretch of the idle drift.
 */
const REST_TIME = 0.9;
const REST_AIM = { nx: 0, ny: 0, mix: 1 } as const;

/**
 * Body diameter inside the 100-unit tile.
 *
 * Nearly the whole tile: an agent's face is a marble, the same object the
 * composer collapses into, so it fills what it is given rather than floating in
 * a ring of something else. The couple of units held back are for the sphere
 * being marginally taller than it is wide — at a full 100 the crown and the chin
 * would both clip.
 */
const BODY = 96;
const INSET_X = (100 - BODY) / 2;
/** Slightly less than the horizontal inset: the extra height all falls below
 *  the equator, and centring on the box would leave the chin outside it. */
const INSET_Y = INSET_X - 0.4;

const faceCache = new Map<string, string>();

/**
 * An agent's face as an inline SVG string, sized by whatever mounts it.
 *
 * The eyes are painted on the marble rather than punched out of it. A mask was
 * tried and is wrong here: masks need ids, one face is mounted dozens of times
 * across a board, and every one of those mounts resolves `url(#id)` against the
 * first copy in the document — which may be sitting in a subtree that never
 * paints, at which point every face on screen goes blank. Painted eyes carry no
 * references at all, so a face is self-contained wherever it lands.
 */
export function agentFace(paint: FacePaint): string {
  const key = `${paint.body}|${paint.ink}`;
  const hit = faceCache.get(key);
  if (hit) return hit;

  const frame = sampleFace(REST_TIME, { size: BODY, aim: REST_AIM });
  const eyes = frame.eyes
    .map(
      (eye) =>
        `<path d="${eye.d}" transform="${eye.matrix}" opacity="${eye.alpha}" fill="${paint.ink}"/>`,
    )
    .join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<g transform="translate(${INSET_X} ${INSET_Y})">` +
    `<path d="${frame.bodyPath}" fill="${paint.body}"/>${eyes}` +
    `</g></svg>`;

  faceCache.set(key, svg);
  return svg;
}

// ── what the user has changed ───────────────────────────────────────────────
// Module scope, so the drawer that renames an agent and the transcript that
// prints their name are reading one source without a prop threaded between them.

/** Renames, by agent id. An agent you have renamed keeps that name. */
const names = useStorage<Record<string, string>>("kone.agents.names", {}, undefined, {
  listenToStorageChanges: true,
});

/**
 * Who answers the next turn you send, or null to send it to a guest.
 *
 * Null is the shipped default. Handing work to a named agent is a decision the
 * user makes — it is how they ask for the same colleague and the settings that
 * come with them — so nothing is picked on their behalf.
 */
const selectedId = useStorage<string | null>("kone.agents.selected", null, undefined, {
  listenToStorageChanges: true,
});

/**
 * Which agent worked a given thread, by thread id — settled when the thread
 * starts and never revised.
 *
 * A thread is one agent's work from end to end, so this is the record of a
 * decision, not a setting. Changing who you work with has to leave started
 * conversations alone: a transcript records who actually did the work, so it
 * cannot re-read itself against the current selection.
 *
 * A thread that started as a guest records `GUEST_BINDING`, not nothing. That
 * distinction is what makes the record safe — *absence* means the thread hasn't
 * started, so a guest thread can't be claimed later by an agent picked after the
 * fact. Absence also covers every thread from before any of this existed, which
 * correctly reads as a guest.
 */
const bound = useStorage<Record<string, string>>("kone.agents.threads", {}, undefined, {
  listenToStorageChanges: true,
});

/** What a thread handed to nobody in particular records — see `bound`. It is not
 *  an agent id, so it resolves to a guest everywhere an id is looked up. */
const GUEST_BINDING = "";

function resolve(preset: AgentPreset): Agent {
  const agent: Agent = {
    id: preset.id,
    name: names.value[preset.id]?.trim() || preset.name,
    role: preset.role,
    svg: agentFace(preset.face),
  };
  if (preset.personality) agent.personality = preset.personality;
  if (preset.instructions) agent.instructions = preset.instructions;
  return agent;
}

/** Everyone you can hand a turn to, in roster order. */
export function agentRoster(): Agent[] {
  return PRESETS.map(resolve);
}

export function agentById(id: string | null | undefined): Agent | undefined {
  const preset = PRESETS.find((p) => p.id === id);
  return preset ? resolve(preset) : undefined;
}

/** Who the next turn goes to, or undefined for a guest. */
export function selectedAgent(): Agent | undefined {
  return agentById(selectedId.value);
}

/** Point the next turn at an agent, or at a guest with null. */
export function selectAgent(id: string | null): void {
  if (id === null || PRESETS.some((p) => p.id === id)) selectedId.value = id;
}

/**
 * Whoever worked this thread, or undefined if it ran as a guest.
 *
 * An unclaimed thread stays unclaimed — it does not fall back to the current
 * selection, so picking an agent tomorrow cannot retroactively put their name on
 * work they never did.
 */
export function agentForThread(threadId: string | null | undefined): Agent | undefined {
  return agentById(threadId ? bound.value[threadId] : undefined);
}

/**
 * Settle who works this thread, at the moment it starts. Write-once: a thread
 * that already has an agent keeps them, so a later send can never rewrite who
 * wrote the lines already above it.
 *
 * `null` settles it on a guest, which is a decision like any other — it closes
 * the thread to being claimed by an agent picked afterwards.
 */
export function settleThreadAgent(threadId: string | null | undefined, id: string | null): void {
  if (!threadId || threadId in bound.value) return;
  if (id !== null && !PRESETS.some((p) => p.id === id)) return;
  bound.value = { ...bound.value, [threadId]: id ?? GUEST_BINDING };
}

/**
 * Hand a new thread the agent an old one had — for a thread reborn under a new
 * id (a provider or model switch tears the session down and starts another).
 *
 * The same work continuing under a new id is still the same colleague's, so the
 * record follows it. It carries a guest binding too, and that matters as much:
 * a guest thread restarted has to come back a guest rather than fall through to
 * whoever the composer is pointing at by then. Write-once at the far end, so a
 * thread that has already settled keeps what it settled on.
 */
export function carryThreadAgent(
  fromThreadId: string | null | undefined,
  toThreadId: string | null | undefined,
): void {
  if (!fromThreadId || !toThreadId || !(fromThreadId in bound.value)) return;
  if (toThreadId in bound.value) return;
  bound.value = { ...bound.value, [toThreadId]: bound.value[fromThreadId]! };
}

/**
 * What the provider session is told about whoever is working a thread, or
 * undefined when it runs as a guest.
 *
 * This is the one place an agent stops being a face in a list and becomes
 * something the model hears about. The name goes, and the agent's personality
 * and instructions when it has them: the face, the role and the roster order are
 * for the person reading the drawer, and a model has no use for any of them.
 *
 * Read from the thread's settled binding rather than from the current
 * selection: the session belongs to a thread, and the thread's agent is a
 * decision already made. Picking somebody else points the *next* thread at
 * them; it cannot change who a running conversation has been all along.
 */
export function agentPersonaForThread(threadId: string | null | undefined): AgentPersona | undefined {
  const agent = agentForThread(threadId);
  if (!agent) return undefined;
  const persona: AgentPersona = { name: agent.name };
  if (agent.personality) persona.personality = agent.personality;
  if (agent.instructions) persona.instructions = agent.instructions;
  return persona;
}

/** Rename an agent. An empty name drops back to the one they shipped with. */
export function renameAgent(id: string, name: string): void {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return;
  const next = { ...names.value };
  const trimmed = name.trim();
  if (!trimmed || trimmed === preset.name) delete next[id];
  else next[id] = trimmed.slice(0, 24);
  names.value = next;
}
