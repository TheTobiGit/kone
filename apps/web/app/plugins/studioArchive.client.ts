import { useStudioIntake } from "~/composables/useStudioIntake";
import type { RuntimeEvent } from "~/types/desktop";

// Archiving a thread takes its column with it, wherever the gesture came from.
//
// The surface that presses archive closes the pane it knows about — the inbox
// row, the studio's own column header. That covers one thread in one project.
// The stamp is wider than that: the store puts the whole spawned subtree away
// and emits one `thread.archived` per affected thread, and a spawned
// descendant's column can be sitting on a row nobody pressed anything on. It can
// also come from somewhere else entirely — another window, or the agent gateway
// archiving on its own.
//
// So the event is the authority, and it is subscribed once for the app rather
// than per list: the stamp has already been accepted by the time it arrives (no
// refusal to race), and it names every thread that actually moved.
export default defineNuxtPlugin(() => {
  const agent = window.koneDesktop?.agent;
  if (!agent) return;

  const intake = useStudioIntake();
  agent.onEvent((event: RuntimeEvent) => {
    if (event.type !== "thread.archived") return;
    void intake.dismissThreadAnywhere(event.threadId);
  });
});
