import { onBeforeUnmount, shallowRef } from "vue";
import type { TerminalEvent, TerminalStatus } from "~/types/desktop";

// ── The project's terminal manager ───────────────────────────────────────────
// A project-scoped registry of live PTY terminals, the sibling of useAgent.
// ProjectView merges its `sessions` with the agent threads to drive the strip.
//
// Design: xterm.js is the source
// of truth for what's on screen. This composable keeps, per terminal, a capped
// *replay buffer* (for cold (re)attach) that is deliberately NON-reactive, plus
// a set of live *sinks* that receive each output delta directly. Live PTY output
// therefore never triggers Vue reactivity — a noisy `npm install` can't stall
// the renderer by cloning a reactive array on every chunk (the old bug). Only
// lifecycle transitions (started/exited/error/closed) touch reactive state.

/** How an xterm view plugs into a terminal: `write` streams live bytes, `reset`
 *  clears the screen before a fresh replay (RIS). */
export type TerminalSink = {
  write: (data: string) => void;
  reset: () => void;
};

/** A live terminal session, as the strip sees it. */
export type TerminalSession = {
  /** Stable strip-column key (never changes). */
  key: string;
  /** Backend PTY id (what crosses IPC). */
  terminalId: string;
  cwd: string;
  status: TerminalStatus;
  /** True while a non-shell subprocess (vim, `npm run dev`) is alive under the
   *  PTY — drives the strip's busy indicator. */
  hasRunningSubprocess: boolean;
  /** Normalized command name of that subprocess, when known. */
  childCommandLabel: string | null;
  /** Attach an xterm sink: immediately replays the current buffer, then streams
   *  live output until the returned detach fn is called. */
  attach: (sink: TerminalSink) => () => void;
};

export type UseTerminalOptions = {
  cwd: string | (() => string);
};

/** Cap the client replay buffer. Slightly above the backend's 512KB history so
 *  a fresh attach shows the full server scrollback; live sinks get every delta
 *  regardless, so this only bounds cold replay. */
const BUFFER_CAP = 768 * 1024;

/** Trim the front to the cap without splitting a UTF-16 surrogate pair. */
function capBuffer(s: string): string {
  if (s.length <= BUFFER_CAP) return s;
  let cut = s.length - BUFFER_CAP;
  // If we'd start on a low surrogate, drop one more so replay is well-formed.
  const code = s.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
  return s.slice(cut);
}

function uid(): string {
  return import.meta.client && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

export function useTerminal(options: UseTerminalOptions) {
  const resolveCwd = () => (options.cwd instanceof Function ? options.cwd() : options.cwd);
  const bridge = () => (import.meta.client ? window.koneDesktop?.terminal : undefined);

  // Reactive list (status only). Buffers + sinks are kept off to the side, keyed
  // by terminalId, so streaming output never mutates reactive state.
  const sessions = shallowRef<TerminalSession[]>([]);
  const buffers = new Map<string, string>();
  const sinks = new Map<string, Set<TerminalSink>>();
  // Last event sequence that seeded each terminal's replay buffer. The manager
  // re-emits `started` on every re-attach; a stale re-seed would clobber a live
  // buffer mid-stream, so re-seeds only happen when the sequence has advanced.
  const lastSeededSequence = new Map<string, number>();

  function setStatus(terminalId: string, status: TerminalStatus): void {
    const s = sessions.value.find((x) => x.terminalId === terminalId);
    if (!s || s.status === status) return;
    s.status = status;
    sessions.value = [...sessions.value]; // one clone per transition, not per chunk
  }

  function setActivity(terminalId: string, hasRunningSubprocess: boolean, childCommandLabel: string | null): void {
    const s = sessions.value.find((x) => x.terminalId === terminalId);
    if (!s) return;
    if (s.hasRunningSubprocess === hasRunningSubprocess && s.childCommandLabel === childCommandLabel) return;
    s.hasRunningSubprocess = hasRunningSubprocess;
    s.childCommandLabel = childCommandLabel;
    sessions.value = [...sessions.value]; // one clone per transition, not per chunk
  }

  function seedBuffer(terminalId: string, history: string): void {
    buffers.set(terminalId, capBuffer(history));
    const set = sinks.get(terminalId);
    if (!set) return;
    for (const sink of set) {
      sink.reset();
      if (history) sink.write(history);
    }
  }

  function appendOutput(terminalId: string, data: string): void {
    buffers.set(terminalId, capBuffer((buffers.get(terminalId) ?? "") + data));
    const set = sinks.get(terminalId);
    if (!set) return;
    for (const sink of set) sink.write(data);
  }

  // ── The single event listener, routed by terminalId ────────────────────────
  let detach: (() => void) | null = null;
  if (import.meta.client) {
    const api = bridge();
    if (api) {
      detach = api.onEvent((event: TerminalEvent) => {
        switch (event.type) {
          case "started":
            // The manager re-emits `started` on every re-attach; only re-seed
            // when this snapshot is newer than the one already in the buffer.
            if ((lastSeededSequence.get(event.terminalId) ?? -1) < event.sequence) {
              seedBuffer(event.terminalId, event.snapshot.history);
            }
            lastSeededSequence.set(event.terminalId, event.sequence);
            setActivity(event.terminalId, event.snapshot.hasRunningSubprocess, event.snapshot.childCommandLabel);
            setStatus(event.terminalId, event.snapshot.status);
            break;
          case "restarted":
            // Explicit reset — always re-seed, whatever the buffer holds.
            seedBuffer(event.terminalId, event.snapshot.history);
            lastSeededSequence.set(event.terminalId, event.sequence);
            setActivity(event.terminalId, event.snapshot.hasRunningSubprocess, event.snapshot.childCommandLabel);
            setStatus(event.terminalId, event.snapshot.status);
            break;
          case "output":
            appendOutput(event.terminalId, event.data);
            // Flow-control ack: the main process pauses/resumes the PTY at
            // 100KB/5KB watermarks. Fire-and-forget — a lost ack must never
            // break the stream, so no await and no throw.
            void api.ack({ terminalId: event.terminalId, byteCount: event.data.length });
            break;
          case "exited":
            setStatus(event.terminalId, "exited");
            break;
          case "error":
            setStatus(event.terminalId, "error");
            break;
          case "activity":
            setActivity(event.terminalId, event.hasRunningSubprocess, event.childCommandLabel);
            break;
          case "closed":
            setStatus(event.terminalId, "closed");
            break;
        }
      });
    }
  }

  function makeAttach(terminalId: string) {
    return (sink: TerminalSink): (() => void) => {
      let set = sinks.get(terminalId);
      if (!set) {
        set = new Set();
        sinks.set(terminalId, set);
      }
      set.add(sink);
      // Cold replay of whatever we already have.
      const buf = buffers.get(terminalId);
      sink.reset();
      if (buf) sink.write(buf);
      return () => {
        sinks.get(terminalId)?.delete(sink);
      };
    };
  }

  /** Spawn a new terminal and return its stable strip key. */
  async function spawn(): Promise<string> {
    const terminalId = uid();
    const key = uid();
    const session: TerminalSession = {
      key,
      terminalId,
      cwd: resolveCwd(),
      status: "starting",
      hasRunningSubprocess: false,
      childCommandLabel: null,
      attach: makeAttach(terminalId),
    };
    buffers.set(terminalId, "");
    sessions.value = [...sessions.value, session];

    const api = bridge();
    if (api) {
      try {
        const snapshot = await api.open({ terminalId, cwd: session.cwd });
        // `started` usually seeds the buffer first; only seed here if it hasn't
        // arrived yet (avoid clobbering already-streamed output).
        if (!buffers.get(terminalId)) {
          seedBuffer(terminalId, snapshot.history);
          lastSeededSequence.set(terminalId, snapshot.sequence);
        }
        setActivity(terminalId, snapshot.hasRunningSubprocess, snapshot.childCommandLabel);
        setStatus(terminalId, snapshot.status);
      } catch {
        setStatus(terminalId, "error");
      }
    } else {
      // Browser dev mock (no Electron bridge): a tiny echo shell.
      setStatus(terminalId, "ready");
      seedBuffer(terminalId, "kone terminal (dev mock)\r\n$ ");
    }

    return key;
  }

  /** Write user input to a terminal. */
  function write(key: string, data: string): void {
    const s = sessions.value.find((x) => x.key === key);
    if (!s) return;
    const api = bridge();
    if (api) {
      void api.write({ terminalId: s.terminalId, data });
    } else {
      // Dev mock: local echo.
      appendOutput(s.terminalId, data === "\r" ? "\r\n$ " : data);
    }
  }

  /** Resize a terminal's PTY. */
  function resize(key: string, cols: number, rows: number): void {
    const s = sessions.value.find((x) => x.key === key);
    if (!s) return;
    void bridge()?.resize({ terminalId: s.terminalId, cols, rows });
  }

  /** Restart a terminal in place: tree-kill the process, reset history, spawn a
   *  fresh shell. Resolves when the manager returns the new snapshot; the
   *  `restarted` event always re-seeds, so the snapshot here only seeds if the
   *  event hasn't arrived yet (same guard pattern as `spawn`). */
  async function restart(key: string): Promise<void> {
    const s = sessions.value.find((x) => x.key === key);
    if (!s) return;
    const api = bridge();
    if (!api) {
      // Browser dev mock: there is no PTY to restart — the echo shell restarts
      // by just re-seeding the prompt.
      seedBuffer(s.terminalId, "kone terminal (dev mock)\r\n$ ");
      lastSeededSequence.set(s.terminalId, (lastSeededSequence.get(s.terminalId) ?? 0) + 1);
      setStatus(s.terminalId, "ready");
      return;
    }
    try {
      const snapshot = await api.restart({ terminalId: s.terminalId });
      if ((lastSeededSequence.get(s.terminalId) ?? -1) < snapshot.sequence) {
        seedBuffer(s.terminalId, snapshot.history);
        lastSeededSequence.set(s.terminalId, snapshot.sequence);
      }
      setActivity(s.terminalId, snapshot.hasRunningSubprocess, snapshot.childCommandLabel);
      setStatus(s.terminalId, snapshot.status);
    } catch {
      setStatus(s.terminalId, "error");
    }
  }

  /** Close a terminal and drop it from the registry. */
  async function close(key: string): Promise<void> {
    const s = sessions.value.find((x) => x.key === key);
    if (!s) return;
    try {
      await bridge()?.close({ terminalId: s.terminalId, deleteHistory: true });
    } catch {
      // best effort
    }
    buffers.delete(s.terminalId);
    sinks.delete(s.terminalId);
    lastSeededSequence.delete(s.terminalId);
    sessions.value = sessions.value.filter((x) => x.key !== key);
  }

  onBeforeUnmount(() => {
    detach?.();
  });

  return { sessions, spawn, write, resize, restart, close };
}
