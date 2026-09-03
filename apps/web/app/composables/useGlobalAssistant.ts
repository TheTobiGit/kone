import { ref, computed, shallowRef } from "vue";
import type { StoredThreadMeta } from "~/types/desktop";
import {
  bootAssistantModel,
  bootAssistantProvider,
  bootAssistantReasoning,
} from "~/utils/modelPicker";
import { useAgent } from "./useAgent";

export const GLOBAL_ASSISTANT_PROJECT_PATH = "__kone_assistant__";

const isOpen = ref(false);
const threads = shallowRef<StoredThreadMeta[]>([]);
const isHistoryLoading = ref(false);
const showHistoryDropdown = ref(false);

/** The mounted modal's exit animation, lent to this module for as long as the
 *  card is on screen. The open flag lives here because the assistant is summoned
 *  from everywhere — a hotkey, the tray, the app menu — but the animation can
 *  only be driven by the component that owns the card, so it hands its player
 *  over on mount and takes it back on unmount. Without one, closing is instant. */
let playExit: ((done: () => void) => void) | null = null;

export function useGlobalAssistant() {
  // `rehydrate: false`: the boot session's habit of adopting the project's
  // latest stored conversation belongs to a board resuming a project. Here it
  // would fire on the first send — after the user block is already on screen —
  // and pull the last chat in underneath it, so the message would land in a
  // conversation nobody chose. The assistant opens on a new chat; History is
  // how you get back to an old one.
  const agent = useAgent({
    provider: bootAssistantProvider(),
    model: bootAssistantModel(),
    reasoning: bootAssistantReasoning(),
    cwd: GLOBAL_ASSISTANT_PROJECT_PATH,
    rehydrate: false,
  });

  /** The session the card writes in. */
  function current() {
    return (
      agent.sessions.value.find((s) => s.key === agent.activeKey.value) ??
      agent.sessions.value[0] ??
      null
    );
  }

  /** Make the session startable, without starting it.
   *
   *  Nothing else does it for this surface. A thread column is started by the
   *  strip it is mounted in, and the compose surfaces mint their own deferred
   *  session — but the assistant writes in the registry's boot session, which
   *  is neither started nor deferred by anybody, so a send reached the backend
   *  with no session behind it: no CLI, and no thread row for the prompt to be
   *  journaled against. Deferring it puts the spawn on the first send, which is
   *  where the wait belongs.
   *
   *  Idempotent — a live session is left alone — so every entry point can call
   *  it rather than working out whether this particular session needs it. */
  function armSession(): void {
    current()?.deferStart();
  }

  async function refreshThreads(): Promise<void> {
    if (!import.meta.client || !window.koneDesktop?.agent) return;
    isHistoryLoading.value = true;
    try {
      const list = await window.koneDesktop.agent.history.list(
        GLOBAL_ASSISTANT_PROJECT_PATH,
        { archived: false },
      );
      threads.value = list ?? [];
    } catch (err) {
      console.error("[assistant] failed to list threads:", err);
    } finally {
      isHistoryLoading.value = false;
    }
  }

  function registerExit(player: ((done: () => void) => void) | null): void {
    playExit = player;
  }

  function open(): void {
    isOpen.value = true;
    armSession();
    void refreshThreads();
  }

  function close(): void {
    showHistoryDropdown.value = false;
    const drop = (): void => {
      isOpen.value = false;
    };
    if (playExit) playExit(drop);
    else drop();
  }

  function toggle(): void {
    if (isOpen.value) {
      close();
    } else {
      open();
    }
  }

  async function newChat(): Promise<void> {
    showHistoryDropdown.value = false;
    await agent.newThread();
    // newThread reuses a blank session when it finds one, and a reused blank
    // carries whatever start state it already had — on the board that is a
    // column the strip has started, here it is the unarmed boot session.
    armSession();
    await refreshThreads();
  }

  async function selectChat(threadId: string): Promise<void> {
    showHistoryDropdown.value = false;
    await agent.openThread(threadId);
    await refreshThreads();
  }

  async function deleteChat(threadId: string): Promise<void> {
    if (!import.meta.client || !window.koneDesktop?.agent) return;
    try {
      await window.koneDesktop.agent.history.remove(threadId);
      if (agent.threadId.value === threadId) {
        await newChat();
      } else {
        await refreshThreads();
      }
    } catch (err) {
      console.error("[assistant] failed to remove thread:", err);
    }
  }

  const activeTitle = computed(() => {
    const title = agent.title.value;
    if (title) return title;
    return "New Assistant Chat";
  });

  return {
    isOpen,
    open,
    close,
    toggle,
    registerExit,
    threads,
    isHistoryLoading,
    showHistoryDropdown,
    refreshThreads,
    armSession,
    newChat,
    selectChat,
    deleteChat,
    agent,
    activeTitle,
  };
}
