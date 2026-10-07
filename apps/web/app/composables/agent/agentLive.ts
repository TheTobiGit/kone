import { computed, ref } from "vue";
import { latestAssistant } from "../agentPrefetch";
import type { AssistantBlock, LiveAttentionItem } from "../agentTypes";
import { registries, registryVersion } from "./agentRegistry";
import type { ThreadSession } from "../useAgent";

/** Visit every resident session in every project, reactively: a computed that
 *  walks through here re-derives when a session's contents change *and* when a
 *  project's registry appears or goes away (the Map itself is not reactive,
 *  `registryVersion` stands in for it). Each app-wide projection below is one
 *  of these walks. */
function eachSession(visit: (s: ThreadSession, projectPath: string) => void): void {
  void registryVersion.value;
  for (const [projectPath, r] of registries.entries()) {
    for (const s of r.sessions.value) visit(s, projectPath);
  }
}

/** Every turn running anywhere in the app right now, keyed by thread id.
 *
 *  A surface that owns a session knows its own thread's state from that session.
 *  The inbox list owns none: its rows are read off disk, and a stored row cannot
 *  know that the same thread is mid-turn in a studio column two surfaces away.
 *  The registries do know — they are module-scope and outlive any one view — so
 *  this is the join between "a row on disk" and "a turn in flight", and it is
 *  read-only by design: nothing here starts, adopts, or keeps a session alive. */
export const liveTurns = computed<Map<string, AssistantBlock>>(() => {
  const out = new Map<string, AssistantBlock>();
  eachSession((s) => {
    const threadId = s.threadId.value;
    if (!threadId) return;
    const block = latestAssistant(s.timelineBlocks.value);
    if (block?.state === "running") out.set(threadId, block);
  });
  return out;
});

/** Every resident thread's newest turn — running or settled — keyed by the
 *  session's stable registry key (a provider thread id can change under a
 *  live session; the key never does).
 *
 *  `liveTurns` only says what is running; something that has to notice a turn
 *  *finishing* anywhere in the app needs the settled states as well, and like
 *  `liveTurns` it can't rely on whichever surface happens to be mounted. */
export const latestTurns = computed<Map<string, Pick<AssistantBlock, "turnId" | "state">>>(() => {
  const out = new Map<string, Pick<AssistantBlock, "turnId" | "state">>();
  eachSession((s) => {
    const block = latestAssistant(s.timelineBlocks.value);
    if (block) out.set(s.key, { turnId: block.turnId, state: block.state });
  });
  return out;
});

/** Every thread parked on a person anywhere in the app — the feed the inbox
 *  bot row reads.
 *
 *  Same join as `liveTurns`, one surface over: a surface that owns a session
 *  knows its own thread's asks from that session, but the inbox reading pane
 *  only owns the thread it is showing — a parked ask in any other thread, in
 *  any project, would be invisible there. The registries are module-scope and
 *  outlive any one view, so walking them is how a session-less surface sees
 *  every live claim. Read-only by design: answering still goes through the
 *  owning session (the inbox jumps you into the thread for that).
 *
 *  Derived from the same per-session `attention` the studio beacon reads, so
 *  the two surfaces never disagree about what is waiting — only about which
 *  thread is in front of you (each host filters out the one it is showing). */
export const liveAttention = computed<LiveAttentionItem[]>(() => {
  const out: LiveAttentionItem[] = [];
  eachSession((s, projectPath) => {
    const attention = s.attention.value;
    if (!attention) return;
    const threadId = s.threadId.value;
    if (!threadId) return;
    const provider = s.provider.value;
    if (!provider) return;
    out.push({
      key: s.key,
      threadId,
      title: s.title.value,
      provider,
      model: s.model.value,
      projectPath,
      kind: attention.kind,
      detail: attention.detail,
    });
  });
  return out;
});

/** Threads whose ask is currently answered inline on a visible surface, keyed
 *  by the surface reporting them (one studio row per project, plus the inbox).
 *  Scoped rather than single so concurrent surfaces never clobber each other —
 *  each writer owns its key and only ever clears its own.
 *
 *  The global bots read this as their skip list: a thread in front of the user
 *  needs no bot, its ask is right there. Reporting is "shown", not "parked" —
 *  a shown thread without an ask is simply absent from the feed, so the rule
 *  costs nothing when nothing waits. */
const inlineByScope = ref<Record<string, string | null>>({});
export function setInlineThread(scope: string, threadId: string | null): void {
  if (inlineByScope.value[scope] === threadId) return;
  inlineByScope.value = { ...inlineByScope.value, [scope]: threadId };
}
/** The thread ids currently shown inline, across every surface. */
export const inlineThreadIds = computed<ReadonlySet<string>>(() => {
  const out = new Set<string>();
  for (const id of Object.values(inlineByScope.value)) {
    if (id) out.add(id);
  }
  return out;
});
