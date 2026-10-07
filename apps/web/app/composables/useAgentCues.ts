// The sounds agents make — the two moments worth hearing from across the room.
//
// A turn finishing (`ready`, or `error` when it failed) and an agent parking on
// the user (`attention`) are the only agent events that play. Both are watched
// app-wide, off the module-scope registries, so a reply that lands in the
// inbox, a studio column, or the assistant is heard the same as one in the
// project page — no single surface has to be mounted for its turn to count.
//
// Everything in between stays silent on purpose: turn start (the send already
// made a sound), streamed text, tool calls, subagent runs. Those fire in bursts,
// and a sound that fires in bursts is one the user mutes.
//
// Mounted once, by plugins/agentCues.client.ts.

import { watch } from "vue";
import { inlineThreadIds, latestTurns, liveAttention } from "~/composables/agent/agentLive";
import { userIsHere, useSound } from "~/composables/useSound";

export function useAgentCues(): void {
  const { cue } = useSound();

  // ── a turn settling ─────────────────────────────────────────────────────────
  // Only a turn this watcher has *seen running* can finish. A rehydrated thread
  // arrives already settled, and a project opened after a restart brings every
  // past turn with it — none of those just happened, and none were ever running
  // here, so none of them ring. An interrupt is the user's own doing (cued at the
  // stop) and stays silent.
  const running = new Map<string, string>(); // session key → the running turn's id
  const turnSignature = () =>
    [...latestTurns.value].map(([key, t]) => `${key}:${t.turnId}:${t.state}`).join("|");

  watch(
    turnSignature,
    () => {
      let finished = false;
      let failed = false;
      const present = new Set<string>();
      for (const [key, turn] of latestTurns.value) {
        present.add(key);
        if (turn.state === "running") {
          running.set(key, turn.turnId);
          continue;
        }
        if (running.get(key) !== turn.turnId) continue;
        running.delete(key);
        if (turn.state === "completed") finished = true;
        else if (turn.state === "failed") failed = true;
      }
      // A thread closed mid-turn takes its turn with it; it can't finish later.
      for (const key of running.keys()) if (!present.has(key)) running.delete(key);
      // Several threads settling in one tick are one moment, not a chord of
      // them. A failure outranks a finish: it's the one that needs a look.
      if (failed) cue("error");
      else if (finished) cue("ready");
    },
    { immediate: true },
  );

  // ── an agent parking on the user ────────────────────────────────────────────
  // A permission gate or a question blocks the turn until someone answers, so
  // it's the one agent event that rings the bell. When the ask lands in a thread
  // the user is already looking at, the approval card rising in front of them
  // is the news — it plays as that card coming up, not as a bell.
  //
  // An ask is identified by what it asks, so a second approval in the same
  // thread rings again. Asks already parked when the app mounts were waiting
  // before this watcher existed and are seeded silently.
  const announced = new Set<string>();
  let primed = false;
  watch(
    () => liveAttention.value,
    (items) => {
      const current = new Set<string>();
      let ring = false;
      let rise = false;
      for (const item of items) {
        const id = `${item.key}:${item.kind}:${item.detail ?? ""}`;
        current.add(id);
        if (announced.has(id)) continue;
        announced.add(id);
        if (!primed) continue;
        const inFront = inlineThreadIds.value.has(item.threadId) && userIsHere();
        if (inFront) rise = true;
        else ring = true;
      }
      // Forget answered asks, so the same ask raised again later is news again.
      for (const id of announced) if (!current.has(id)) announced.delete(id);
      primed = true;
      if (ring) cue("attention");
      else if (rise) cue("show");
    },
    { immediate: true },
  );
}
