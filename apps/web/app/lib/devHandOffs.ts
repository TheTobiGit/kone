// Threads the scripted demo hands work to, so the demo world can answer for
// them like stored threads: a contractor's origin mark reads its terms through
// history.threadPage, and the inbox lists delegates beside their delegators.
// Dev-only, like the rest of lib/.

import type { StoredThreadMeta } from "~/types/desktop";

export const devHandOffThreads = new Map<string, StoredThreadMeta>();

export function registerDevHandOff(meta: StoredThreadMeta): void {
  devHandOffThreads.set(meta.threadId, meta);
}
