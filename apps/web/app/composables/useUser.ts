// The machine's signed-in user — the name the Home greeting addresses. Two
// sources, tried in order:
//   1. the Electron bridge (`system.username`) — authoritative in the packaged
//      desktop app, where there's no runtime server;
//   2. the `/api/username` Nitro route — the `nuxt dev` fallback, which reads
//      the real account name off the dev machine.
// Resolved once and cached in shared state so the greeting doesn't re-fetch.

export function useUser() {
  const username = useState<string | null>("kone:username", () => null);
  const resolved = useState<boolean>("kone:username:resolved", () => false);

  async function resolve(): Promise<void> {
    if (resolved.value) return;
    resolved.value = true;

    const bridge = import.meta.client ? window.koneDesktop : undefined;
    if (bridge?.system?.username) {
      try {
        const name = await bridge.system.username();
        if (name) {
          username.value = name;
          return;
        }
      } catch {
        // fall through to the server route
      }
    }

    try {
      const res = await $fetch<{ username: string | null }>("/api/username");
      username.value = res?.username ?? null;
    } catch {
      // No source available — the greeting falls back to a generic address.
    }
  }

  // "gideon.sarfo" → "Gideon Sarfo"; "gideonsarfo" → "Gideonsarfo". Null while
  // unresolved; the greeting treats that as an anonymous "there".
  const displayName = computed(() => {
    const raw = username.value?.trim();
    if (!raw) return null;
    return raw
      .split(/[._\-\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  });

  const initial = computed(
    () => displayName.value?.charAt(0).toUpperCase() ?? "",
  );

  return { username, displayName, initial, resolve };
}
