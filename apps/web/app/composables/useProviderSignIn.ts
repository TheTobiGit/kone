import { readonly, ref } from "vue";
import type { ProviderKind } from "~/types/desktop";

// Which provider the sign-in modal is open for, app-wide. Every entry point —
// the provider deck's pill, the provider detail's Sign-in block, the composer's
// status tray — calls `open`; the one ProviderSignInModal mounted in the page
// shell reads `target` and owns everything that happens after (the login PTY,
// Check authentication, cleanup on close). Module-scoped, so every caller shares
// one modal rather than each mounting its own.

const target = ref<ProviderKind | null>(null);
/** The element focused when the modal was asked for, so closing hands focus back. */
let opener: HTMLElement | null = null;

export function useProviderSignIn() {
  /** Open the sign-in modal for `provider`. A modal already open stays on its
   *  own provider — it may be mid-login, and swapping it out from under the
   *  user would kill a run they started. */
  function open(provider: ProviderKind): void {
    if (target.value) return;
    const active = import.meta.client ? document.activeElement : null;
    opener = active instanceof HTMLElement ? active : null;
    target.value = provider;
  }

  /** Called by the modal once its exit has played. */
  function closed(): void {
    target.value = null;
    const el = opener;
    opener = null;
    el?.focus();
  }

  return { target: readonly(target), open, closed };
}
