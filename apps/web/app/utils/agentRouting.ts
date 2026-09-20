/**
 * Jev — the picker row that decides instead of you.
 *
 * Everywhere else in the app, choosing a partner is a statement about who does
 * the work. Choosing Jev is a statement about who *chooses*: the request is
 * classified the moment you send it, and the thread settles on whichever agent
 * the classification named — or on the default partner, which is the answer
 * most requests should get.
 *
 * Two things follow from that, and they are why routing lives in its own file
 * rather than inside `~/utils/agents`:
 *
 * Jev is not an agent. It has no instructions, no face on a transcript, and
 * nothing that reaches a provider session. Giving it a roster row would make
 * every consumer of the roster — the team lists, the capability pins, the
 * transcript's "who wrote this" — have to special-case a member that can never
 * write a line. The id below is a sentinel the selection may hold and the
 * roster never returns.
 *
 * And it is available everywhere. A project's team is who may work in that
 * repository; Jev works in none of them, so the team gate that quietly demotes
 * an off-team agent to a guest must not see it at all.
 *
 * The decision itself is made in the main process — see the desktop `jev`
 * module — because the credential it needs must not reach a renderer.
 */
import type { Agent } from "~/utils/agents";
import type {
  JevCandidate,
  JevRouteInput,
  JevRouteResult,
  ThreadAgentRoute,
} from "~/types/desktop";

/**
 * The selection value that means "let Jev decide".
 *
 * A reserved word rather than a uuid so a selection read back from storage is
 * legible, and so a user-made agent can never collide with it: ids the roster
 * mints are uuids, and the shipped presets are named here in the build.
 */
export const JEV_ROUTER_ID = "jev";

export const JEV_LABEL = "Jev";
export const JEV_ROLE = "Routes each request to the right agent";

/** The host the routing decision is made on.
 *
 *  Named in the picker rather than buried here. Every other choice in that list
 *  runs against a provider the user already signed in to, on a subscription
 *  they already hold; this one is the only row that sends anything to a service
 *  they have not chosen, and a row that reads like its neighbours while being
 *  unlike them in that way is the part worth stating. */
export const JEV_HOST = "api.typesafe.ai";

/** What leaves the machine when a request is routed, in the order it matters:
 *  the message itself, where it was typed, and who was available to take it.
 *  Kept next to the constant that makes the call so the two cannot drift. */
export const JEV_DISCLOSURE =
  `Sends your message, the project name, and your team's agent descriptions to ${JEV_HOST} to choose who answers. Nothing is sent until you pick Jev and send.`;

/** Whether a selection is the router rather than an agent. Worth asking
 *  wherever a selection is about to be treated as somebody who can work. */
export function isRouterId(id: string | null | undefined): boolean {
  return id === JEV_ROUTER_ID;
}

function bridge() {
  return import.meta.client ? window.koneDesktop?.jev : undefined;
}

/**
 * The roster, described to the router.
 *
 * An agent's standing orders are the only honest description of what it is
 * for — they are what the user actually wrote about it — so they are the brief,
 * and an agent that has none is described by its name and role alone. Nothing
 * is invented here: an agent nobody has described is one the router will
 * rightly struggle to pick, and papering over that with a generated summary
 * would produce confident routing built on this file's guesses.
 */
export function routerCandidates(agents: Agent[]): JevCandidate[] {
  return agents
    .filter((agent) => !isRouterId(agent.id))
    .map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      brief: agent.instructions ?? "",
    }));
}

/** What the default partner looks like as a routing result, for the paths that
 *  never reach the router at all. */
function unrouted(outcome: JevRouteResult["outcome"]): JevRouteResult {
  return { agentId: null, outcome, confidence: 0, probabilities: {} };
}

/**
 * Who should carry this request.
 *
 * Never rejects and never throws: the caller is holding a send, and a routing
 * failure has to cost the user a specialist, not their message. Every way this
 * can go wrong comes back as the default partner with a reason attached.
 */
export async function routeRequest(
  request: string,
  agents: Agent[],
  projectName?: string | null,
): Promise<JevRouteResult> {
  const api = bridge();
  if (!api) return unrouted("unavailable");

  const candidates = routerCandidates(agents);
  if (candidates.length === 0) return unrouted("no-match");

  const input: JevRouteInput = { request, candidates };
  if (projectName) input.project = projectName;
  try {
    return await api.route(input);
  } catch (err) {
    console.warn("[jev] routing call failed:", err);
    return unrouted("failed");
  }
}

/**
 * The line the composer shows after a routed send — the receipt for a decision
 * the user did not make.
 *
 * It always says something. A router that only spoke up when it found a
 * specialist would be indistinguishable, on the common path, from one that was
 * silently broken.
 */
export function routingReceipt(result: JevRouteResult, agentName?: string): string {
  switch (result.outcome) {
    case "routed":
      return `Jev → ${agentName ?? "an agent"} · ${Math.round(result.confidence * 100)}%`;
    case "no-match":
      return "Jev → Default · nobody on the team owns this";
    case "unsure":
      return "Jev → Default · no clear owner";
    case "unavailable":
      return "Jev is not configured — running as Default";
    case "failed":
      return "Jev could not be reached — running as Default";
  }
}

/**
 * What of a router's reply settles onto the thread's binding, or null when
 * nothing does.
 *
 * Only a real decision is durable. The other four outcomes say the router never
 * answered or declined to, which leaves the thread on the default partner —
 * true of the send, and nothing at all about who works the thread. Recording
 * them would make one network blip a permanent line in a conversation's
 * history, and carry it onto every thread reborn from it; the composer's
 * receipt is where a send that went nowhere is reported, and a receipt is the
 * right lifetime for it.
 *
 * What survives is the decision, not the whole reply: the alternatives it
 * weighed are working-out, and storing them would only be storing them to be
 * believed later.
 */
export function routeForBinding(result: JevRouteResult): ThreadAgentRoute | null {
  if (result.outcome !== "routed" || result.agentId === null) return null;
  return { outcome: result.outcome, confidence: result.confidence };
}
