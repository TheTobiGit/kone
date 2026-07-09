import { useLocalStorage } from "@vueuse/core";
import { computed } from "vue";

import type { ProviderId } from "~/lib/model-catalog";
import type { ConversationTurn } from "~/types/conversation";

export type StoredThread = {
  id: string;
  title: string;
  turns: ConversationTurn[];
  draft: string;
  provider: ProviderId;
  modelId: string;
  reasoningEffort: string;
  thinking: boolean;
  createdAt: string;
  updatedAt: string;
  scrollTop: number;
};

export type ThreadStorage = {
  version: 1;
  activeThreadId: string | null;
  threads: StoredThread[];
};

const EMPTY_STORAGE: ThreadStorage = {
  version: 1,
  activeThreadId: null,
  threads: [],
};

export function normalizeThreadStorage(value: unknown): ThreadStorage {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STORAGE);
  const candidate = value as Partial<ThreadStorage>;
  if (candidate.version !== 1 || !Array.isArray(candidate.threads)) {
    return structuredClone(EMPTY_STORAGE);
  }
  return {
    version: 1,
    activeThreadId:
      typeof candidate.activeThreadId === "string"
        ? candidate.activeThreadId
        : null,
    threads: candidate.threads.filter(
      (thread): thread is StoredThread =>
        Boolean(thread) &&
        typeof thread === "object" &&
        typeof (thread as StoredThread).id === "string" &&
        Array.isArray((thread as StoredThread).turns),
    ),
  };
}

function titleFromPrompt(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 48
    ? `${normalized.slice(0, 47).trimEnd()}…`
    : normalized || "New thread";
}

export function useThreadStore() {
  const rawStorage = useLocalStorage<ThreadStorage>(
    "kone:threads:v1",
    structuredClone(EMPTY_STORAGE),
    {
      serializer: {
        read: (value) => {
          try {
            return normalizeThreadStorage(JSON.parse(value));
          } catch {
            return structuredClone(EMPTY_STORAGE);
          }
        },
        write: (value) => JSON.stringify(value),
      },
    },
  );

  const activeThreadId = computed({
    get: () => rawStorage.value.activeThreadId,
    set: (value: string | null) => {
      rawStorage.value = { ...rawStorage.value, activeThreadId: value };
    },
  });
  const threads = computed(() =>
    [...rawStorage.value.threads].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    ),
  );
  const activeThread = computed(
    () =>
      rawStorage.value.threads.find(
        (thread) => thread.id === rawStorage.value.activeThreadId,
      ) ?? null,
  );

  function createThread(input: {
    provider: ProviderId;
    modelId: string;
    reasoningEffort: string;
    thinking: boolean;
    prompt?: string;
  }) {
    const now = new Date().toISOString();
    const thread: StoredThread = {
      id: crypto.randomUUID(),
      title: input.prompt ? titleFromPrompt(input.prompt) : "New thread",
      turns: [],
      draft: "",
      provider: input.provider,
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      thinking: input.thinking,
      createdAt: now,
      updatedAt: now,
      scrollTop: 0,
    };
    rawStorage.value = {
      ...rawStorage.value,
      activeThreadId: thread.id,
      threads: [thread, ...rawStorage.value.threads],
    };
    return thread;
  }

  function updateThread(
    threadId: string,
    patch: Partial<Omit<StoredThread, "id" | "createdAt">>,
  ) {
    rawStorage.value = {
      ...rawStorage.value,
      threads: rawStorage.value.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              ...patch,
              updatedAt: patch.updatedAt ?? new Date().toISOString(),
            }
          : thread,
      ),
    };
  }

  function renameThread(threadId: string, title: string) {
    const normalized = title.replace(/\s+/g, " ").trim();
    if (!normalized) return;
    updateThread(threadId, { title: normalized });
  }

  function deleteThread(threadId: string) {
    const remaining = rawStorage.value.threads.filter(
      (thread) => thread.id !== threadId,
    );
    rawStorage.value = {
      version: 1,
      activeThreadId:
        rawStorage.value.activeThreadId === threadId
          ? (remaining[0]?.id ?? null)
          : rawStorage.value.activeThreadId,
      threads: remaining,
    };
  }

  function activateThread(threadId: string) {
    if (rawStorage.value.threads.some((thread) => thread.id === threadId)) {
      activeThreadId.value = threadId;
    }
  }

  return {
    threads,
    activeThread,
    activeThreadId,
    createThread,
    updateThread,
    renameThread,
    deleteThread,
    activateThread,
  };
}
