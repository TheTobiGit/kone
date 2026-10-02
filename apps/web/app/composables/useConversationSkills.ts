import { ref, watch } from "vue";
import type { InvokableSkill, KoneAgentSkillsApi, ProviderKind } from "~/types/desktop";

export type UseConversationSkillsOptions = {
  /** The skills slice of the bridge. Injectable so the composable runs
   *  without a desktop window; absent means nothing can be invoked. */
  bridge?: () => Pick<KoneAgentSkillsApi, "listInvokable"> | undefined;
};

/** The skills the focused conversation's provider can invoke from where it
 *  runs. The list belongs to a (provider, cwd) pair — skills are installed per
 *  CLI and per project — so either changing refetches it, and an answer for a
 *  pair that is no longer current is dropped rather than shown.
 *
 *  `ready` is false until the current pair has answered once. Until then an
 *  empty list means "not known yet", not "this provider has no skills", so a
 *  caller must not treat a picked skill as gone on the strength of it. */
export function useConversationSkills(
  provider: () => ProviderKind | null | undefined,
  cwd: () => string | null,
  options?: UseConversationSkillsOptions,
) {
  const bridge = options?.bridge
    ?? (() => (import.meta.client ? window.koneDesktop?.agent?.skills : undefined));

  const skills = ref<InvokableSkill[]>([]);
  const ready = ref(false);
  let generation = 0;

  async function refresh(): Promise<void> {
    const ask = ++generation;
    const kind = provider();
    const api = bridge();
    if (!kind || !api?.listInvokable) {
      skills.value = [];
      ready.value = true;
      return;
    }
    const where = cwd();
    let next: InvokableSkill[] = [];
    try {
      next = await api.listInvokable(kind, where);
    } catch {
      // The channel answers [] rather than rejecting; a throw here is an
      // older or broken bridge, which can invoke nothing either.
    }
    if (ask !== generation) return;
    skills.value = next;
    ready.value = true;
  }

  // A different pair's list says nothing about this one. A plain refresh()
  // for the same pair keeps `ready`: the old answer stays true until the new
  // one replaces it.
  watch(
    [provider, cwd],
    () => {
      ready.value = false;
      void refresh();
    },
    { immediate: true },
  );

  return { skills, ready, refresh };
}
