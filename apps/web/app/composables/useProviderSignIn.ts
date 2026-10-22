import { readonly, ref } from "vue";
import type { ProviderKind } from "~/types/desktop";

// Which provider the sign-in modal is open for, app-wide, and which surface
// hosts it. Every entry point — the provider deck's pill and the provider
// detail's Sign-in block, the composer's status tray — calls `open`; the one
// ProviderSignInModal reads `target` and owns everything that happens after (the
// login PTY, Check authentication, cleanup on close). Module-scoped, so every
// caller shares one modal rather than each mounting its own.
//
// Two hosts, because the card must sit where it was asked for: "app" is the one
// mounted in the page shell (window-anchored, over everything — the composer's
// tray, which is not inside settings); "pane" is the one the providers pane
// mounts inside its own page frame, so the card stays in the pane that opened
// it. `release` is the pane's half of that: a pane that goes away takes its
// hosted modal with it.
//
// Every open gets a ticket. A card closes with the ticket it was opened under,
// so a card whose exit lands after its pane released it (and something else
// opened) cannot close the modal that replaced it.

export type SignInHost = "app" | "pane";

const target = ref<ProviderKind | null>(null);
const host = ref<SignInHost>("app");
let current = 0;
/** The element focused when the modal was asked for, so closing hands focus back. */
let opener: HTMLElement | null = null;

/** The opener, or none when there is no browser to ask — SSR and the DOM-less
 *  unit tests both spell that as no `document`. */
function currentOpener(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  return active instanceof HTMLElement ? active : null;
}

export function useProviderSignIn() {
  /** Open the sign-in modal for `provider`, hosted by `where`. A modal already
   *  open stays on its own provider — it may be mid-login, and swapping it out
   *  from under the user would kill a run they started. */
  function open(provider: ProviderKind, where: SignInHost = "app"): void {
    if (target.value) return;
    opener = currentOpener();
    current++;
    target.value = provider;
    host.value = where;
  }

  /** The ticket of the modal open now; a card reads it as it mounts. */
  function ticket(): number {
    return current;
  }

  /** Called by the modal once its exit has played, with its own ticket. A
   *  stale ticket is a card that was already released: ignore it. */
  function closed(ticketOfCard: number = current): void {
    if (ticketOfCard !== current) return;
    target.value = null;
    host.value = "app";
    const el = opener;
    opener = null;
    el?.focus();
  }

  /** Called by a host that is going away (the providers pane unmounting with its
   *  modal still up). Clears the modal it hosts without handing focus back —
   *  the opener is inside the surface that is disappearing. */
  function release(where: SignInHost): void {
    if (host.value !== where) return;
    target.value = null;
    host.value = "app";
    opener = null;
  }

  return { target: readonly(target), host: readonly(host), open, ticket, closed, release };
}
