import { computed, shallowRef } from "vue";
import type { ApprovalDecision, StoredThread } from "~/types/desktop";
import type { AssistantBlock, PendingApproval, ThreadBlock } from "./useAgentTypes.js";

// ── transcript prefetch ───────────────────────────────────────────────────────
// A thread's transcript read is the one unavoidable round-trip left on the open
// path — everything else (the CLI spawn, the pane binding) is now deferred or
// synchronous. But the user tells us which thread they want a beat before they
// click it: they point at it. Hovering a recent-session row starts the read, so
// by the time the click lands the rows are usually already in hand.
//
// Deliberately small and short-lived. A prefetch is a *snapshot*, and a thread
// the agent is still writing to moves on without it, so an entry that isn't
// consumed almost immediately is thrown away rather than served stale. (The live
// case can't reach here anyway — openThreadHandle hands back the resident
// session before openStored is ever called.)
export const PREFETCH_TTL_MS = 20_000;
export const PREFETCH_MAX = 6;
export const prefetched = new Map<string, { at: number; load: Promise<StoredThread | null> }>();

/** Start reading a stored thread's transcript now, so opening it later is free.
 *  Fire-and-forget and idempotent — safe to call on every pointerenter. */
export function prefetchThread(id: string): void {
  if (!import.meta.client || !id) return;
  const api = window.koneDesktop?.agent;
  if (!api) return;
  const hit = prefetched.get(id);
  if (hit && Date.now() - hit.at < PREFETCH_TTL_MS) return;
  // Never let a rejected read reach an unhandled-rejection: the consumer may
  // never come, and a failed prefetch just means openStored does the read itself.
  const load = api.history.thread(id).catch(() => null);
  prefetched.delete(id); // re-insert, so this id is now the newest in Map order
  prefetched.set(id, { at: Date.now(), load });
  while (prefetched.size > PREFETCH_MAX) {
    const oldest = prefetched.keys().next().value;
    if (oldest === undefined) break;
    prefetched.delete(oldest);
  }
}

/** Consume a prefetched transcript, if one is in hand and still fresh. Always
 *  removes the entry — a transcript is read once, on open. */
export function takePrefetched(id: string): Promise<StoredThread | null> | null {
  const hit = prefetched.get(id);
  if (!hit) return null;
  prefetched.delete(id);
  return Date.now() - hit.at < PREFETCH_TTL_MS ? hit.load : null;
}

export function markHistorical(blocks: ThreadBlock[]): ThreadBlock[] {
  return blocks.map((b) => ({ ...b, historical: true }));
}

export function uid(): string {
  return import.meta.client && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/** Read a File's bytes as base64 (no `data:` prefix) for upload over IPC.
 *  Uses FileReader.readAsDataURL — safe for multi-MB files, unlike btoa on a
 *  giant char string — then strips the data-URL header. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result;
      if (!res || res instanceof ArrayBuffer) return reject(new Error("Unexpected file read result"));
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

/** The latest assistant turn in a timeline, or null. */
export function latestAssistant(blocks: ThreadBlock[]): AssistantBlock | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.role === "assistant") return b;
  }
  return null;
}

// ── spawned children's approvals (the registry-level inbox) ──────────────────
const childApprovals = shallowRef(new Map<string, PendingApproval>());
/** The inbox as a read-only computed — the dock/panel bind to it so a child's
 *  parked ask appears (and its decide buttons work) without a resident session. */
export const childApprovalsInbox = computed(() => childApprovals.value);

export function setChildApproval(childThreadId: string, pending: PendingApproval): void {
  childApprovals.value = new Map(childApprovals.value).set(childThreadId, pending);
}

/** Clear the inbox entry for a child — a resolved request, or a newer request
 *  that replaced it. Only removes when the parked requestId matches, so a stale
 *  resolve can't wipe a fresher ask. */
export function clearChildApproval(childThreadId: string, requestId: string): void {
  const current = childApprovals.value.get(childThreadId);
  if (!current || current.requestId !== requestId) return;
  const next = new Map(childApprovals.value);
  next.delete(childThreadId);
  childApprovals.value = next;
}

/** Drop the inbox entry for a child regardless of requestId — used when the
 *  child's projection settles out of an approval gate (its turn ended, so no
 *  `approval.resolved` ever arrives). */
export function clearChildApprovalFor(childThreadId: string): void {
  if (!childApprovals.value.has(childThreadId)) return;
  const next = new Map(childApprovals.value);
  next.delete(childThreadId);
  childApprovals.value = next;
}

/** Decide a spawned child's parked approval. The child has no session here, so
 *  the response goes straight over the bridge to the existing agent:respond IPC
 *  (the child's own thread id + the parked requestId) — no gateway tool, no
 *  parent session involved. Cleared optimistically; the adapter's
 *  `approval.resolved` is the belt-and-braces re-clear. */
export async function decideChildApproval(
  childThreadId: string,
  requestId: string,
  decision: ApprovalDecision,
): Promise<void> {
  clearChildApproval(childThreadId, requestId);
  const api = import.meta.client ? window.koneDesktop?.agent : undefined;
  if (!api) return;
  try {
    await api.respond(childThreadId, requestId, decision);
  } catch {
    // If the send fails the child's turn will abort and settle the gate anyway.
  }
}

/** The one nested run still working inside a turn — the only run an approval
 *  landing right now could have come from — else undefined (the parent asked,
 *  or several runs were live at once and the ask can't be pinned to one).
 *  Approvals carry no subagent attribution upstream, so this is the honest
 *  best available read: it lets a single live child's ask render inline in
 *  its shell without ever guessing wrong on a concurrent batch. */
export function originSubagentOfApproval(block: AssistantBlock | undefined): string | undefined {
  if (!block) return undefined;
  const live: string[] = [];
  for (const item of block.items) {
    const run = item.subagent;
    if (run && (run.status === "starting" || run.status === "running")) {
      live.push(run.toolUseId);
    }
  }
  return live.length === 1 ? live[0] : undefined;
}

/** First-turn word-cap fallback — mirrors desktop `buildPromptThreadTitleFallback`
 *  so browser-dev / the instant before the agent rename lands still has a label. */
export function titleFromPrompt(message: string): string {
  const words = message
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 6);
  if (words.length === 0) return "New thread";
  const joined = words.join(" ");
  return joined.length > 60 ? `${joined.slice(0, 60)}...` : joined;
}
