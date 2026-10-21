import type { TerminalManager } from "./TerminalManager.js";
import { canUseTerminal, releaseTerminal, terminalOwner } from "./ownership.js";
import type {
  TerminalAckInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./types.js";

// The terminal IPC handlers, kept free of Electron so their authorization
// boundary is testable. ipc.ts is the thin adapter that registers these on
// ipcMain; tests call them with fake senders.

/** The slice of WebContents the terminal transport uses. `send` is narrowed to
 *  the one channel so a fake cannot pretend to be a general IPC sink. */
export type TerminalSender = {
  isDestroyed(): boolean;
  send(channel: "terminal:event", event: TerminalEvent): void;
  once(event: "destroyed", listener: () => void): void;
};

export type TerminalIpcHandlers = {
  open(sender: TerminalSender, input: TerminalOpenInput): Promise<TerminalSessionSnapshot>;
  write(sender: TerminalSender, input: TerminalWriteInput): void;
  resize(sender: TerminalSender, input: TerminalResizeInput): void;
  close(sender: TerminalSender, input: TerminalCloseInput): Promise<void>;
  restart(sender: TerminalSender, input: TerminalRestartInput): Promise<TerminalSessionSnapshot>;
  ack(sender: TerminalSender, input: TerminalAckInput): void;
  subscribe(sender: TerminalSender): void;
  unsubscribe(sender: TerminalSender): void;
};

export type TerminalIpc = {
  handlers: TerminalIpcHandlers;
  /** Stop sending to a page whose WebContents is going away. */
  forget(sender: TerminalSender): void;
};

/** Build the handler set for `manager`. Registers the manager's one event sink:
 *  ordinary terminals fan out to every subscriber; an owned (sign-in) terminal
 *  goes only to the window that claimed it. */
export function createTerminalIpc(manager: TerminalManager): TerminalIpc {
  const subscribers = new Set<TerminalSender>();

  manager.onEvent((event: TerminalEvent) => {
    const owner = terminalOwner(event.terminalId);
    for (const sender of subscribers) {
      if (owner !== null && sender !== owner) continue;
      if (!sender.isDestroyed()) sender.send("terminal:event", event);
    }
  });

  /** Refuse every operation on a terminal another window claimed. Ordinary
   *  terminals have no owner and stay shared, as they always were. */
  const assertCanUse = (sender: TerminalSender, terminalId: string): void => {
    if (canUseTerminal(terminalId, sender)) return;
    throw new Error(`Terminal '${terminalId}' belongs to another window.`);
  };

  const forget = (sender: TerminalSender): void => {
    subscribers.delete(sender);
  };

  const handlers: TerminalIpcHandlers = {
    open: (sender, input) => {
      assertCanUse(sender, input.terminalId);
      return manager.open({
        terminalId: input.terminalId,
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
        env: input.env,
      });
    },
    write: (sender, input) => {
      assertCanUse(sender, input.terminalId);
      manager.write(input);
    },
    resize: (sender, input) => {
      assertCanUse(sender, input.terminalId);
      manager.resize(input);
    },
    close: async (sender, input) => {
      assertCanUse(sender, input.terminalId);
      await manager.close(input);
      // The transcript is gone with the session; drop the claim so the id is
      // an ordinary one again (and no WebContents reference is retained).
      releaseTerminal(input.terminalId, sender);
    },
    restart: (sender, input) => {
      assertCanUse(sender, input.terminalId);
      return manager.restart(input);
    },
    ack: (sender, input) => {
      assertCanUse(sender, input.terminalId);
      manager.ack(input);
    },
    subscribe: (sender) => {
      if (subscribers.has(sender)) return;
      subscribers.add(sender);
      sender.once("destroyed", () => forget(sender));
    },
    unsubscribe: (sender) => {
      forget(sender);
    },
  };

  return { handlers, forget };
}
