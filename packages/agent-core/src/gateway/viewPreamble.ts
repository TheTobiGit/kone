// The view block that rides in front of every assistant turn.
//
// The assistant is summoned over whatever the user is doing, and the first
// thing most messages lean on is the screen: "why is this stuck", "summarise
// that thread", "what does this error mean". A tool the model has to remember
// to call answers that one turn late, and only when the model guesses right
// that it should look. So the description travels with the message instead: the
// shell reads the renderer's latest snapshot at dispatch and puts it in a
// `<kone_view>` block ahead of the user's words.
//
// Only the provider sees it. The transcript is journaled from the renderer's
// own user block before this runs, so the thread the user reads shows what
// they typed and nothing else — the same arrangement a side chat's bootstrap
// relies on.
//
// The block is the brief wording: what is in front, the focused studio column
// and a count of the rest, and the selection. Nothing hidden behind the front
// surface. It rides on every message, most of which are not about the screen,
// so it carries enough to resolve "this" and leaves the detail to app_get_view.
//
// A screen that has not moved since the last turn is not described twice: the
// block says so in a line, which keeps a long back-and-forth about one thread
// from paying for the same description every message. The full description is
// sent again after a quiet spell anyway, because the one it would point back to
// may have been compacted away by then.

import {
  renderViewSnapshot,
  viewSignature,
  type ViewSnapshot,
} from "@kone/protocol/view-context";

/** After this long, an unchanged screen is described in full again rather than
 *  pointed back to. */
const RESEND_AFTER_MS = 15 * 60 * 1000;

export const VIEW_BLOCK_OPEN = "<kone_view>";
export const VIEW_BLOCK_CLOSE = "</kone_view>";

export interface ViewPreambleOptions {
  readView: () => ViewSnapshot | null;
  /** Whether a thread is one of the assistant's. Every other thread's turns go
   *  out untouched: a worker on a repo has no business with the user's screen. */
  isAssistantThread: (threadId: string) => boolean;
  now?: () => number;
}

export interface ViewPreamble {
  /** The block to put ahead of this thread's next turn, or null for none. */
  blockFor(threadId: string): string | null;
  /** Drop what was last sent to a thread, so its next turn describes the screen
   *  in full — for a session that is starting over. */
  forget(threadId: string): void;
}

export function createViewPreamble(options: ViewPreambleOptions): ViewPreamble {
  const now = options.now ?? Date.now;
  const lastSent = new Map<string, { signature: string; at: number }>();

  return {
    blockFor(threadId) {
      if (!options.isAssistantThread(threadId)) return null;
      const view = options.readView();
      // No push yet (the window is still loading): say nothing rather than
      // describe a screen nobody reported.
      if (!view) return null;

      const signature = viewSignature(view, { brief: true });
      const at = now();
      const previous = lastSent.get(threadId);
      if (previous && previous.signature === signature && at - previous.at < RESEND_AFTER_MS) {
        return `${VIEW_BLOCK_OPEN}The screen is unchanged since the user's previous message.${VIEW_BLOCK_CLOSE}`;
      }
      lastSent.set(threadId, { signature, at });
      return `${VIEW_BLOCK_OPEN}\n${renderViewSnapshot(view, at, { brief: true })}\n${VIEW_BLOCK_CLOSE}`;
    },
    forget(threadId) {
      lastSent.delete(threadId);
    },
  };
}

/** A turn's input with the block in front of it. */
export function withViewBlock(input: string, block: string | null): string {
  if (!block) return input;
  return input ? `${block}\n\n${input}` : block;
}
