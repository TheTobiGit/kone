// What the user is looking at, as a gateway tool.
//
// Every assistant turn already starts with a `<kone_view>` block describing
// the screen (see ../viewPreamble.ts). This is the closer look behind it: the
// same description, fresh at call time rather than as of the message, plus —
// on request — what the focused thing actually says. The latest messages of
// the thread the user is on, and the text the focused terminal is showing,
// because "why did that fail?" is usually a question about one of those two.
//
// The view itself is the renderer's; the shell mirrors it (the app:state push)
// and this reads the mirror. The thread is read from the store and the
// terminal from the shell's PTY manager, never from the renderer: both are
// authoritative there, and neither goes stale between pushes.

import {
  focusedTerminalOf,
  focusedThreadOf,
  renderViewSnapshot,
  type ViewSnapshot,
} from "@kone/protocol/view-context";
import type { StoredThread } from "../../types.js";
import {
  GetViewInputSchema,
  GET_VIEW_JSON_SCHEMA,
  type GetViewInput,
  type GatewayRecord,
} from "../schemas.js";
import type { GatewayToolContext, GatewayToolResult, ToolEntry } from "../registry.js";
import { blockText, truncateTo } from "./appThreadsFormatting.js";

/** What the shell can read off one terminal. */
export interface TerminalScreenReading {
  cwd: string;
  status: string;
  running: string | null;
  exitCode: number | null;
  lines: string[];
}

export interface AppViewToolOptions {
  /** The view the renderer last reported. Absent (or null), the tool says the
   *  screen is unknown rather than describing a default one. */
  readView?: () => ViewSnapshot | null;
  /** Reads what a terminal is showing. Absent, a terminal look is refused. */
  readTerminalScreen?: (terminalId: string, maxLines: number) => Promise<TerminalScreenReading | null>;
  store: { loadThread(threadId: string): StoredThread | null };
}

/** One closer look, as prose for the model and as a structured record. */
interface ViewSection {
  text: string;
  data: GatewayRecord;
}

const DEFAULT_MESSAGES = 6;
const DEFAULT_LINES = 80;
/** Per message, so one long reply cannot crowd out the rest of the tail. */
const MESSAGE_CHAR_MAX = 2_000;

const UNKNOWN_VIEW =
  "kone has not reported what is on screen yet. Try again once the app window has finished loading.";

function threadSection(
  store: AppViewToolOptions["store"],
  view: ViewSnapshot,
  count: number,
): ViewSection {
  const focused = focusedThreadOf(view);
  if (!focused) {
    return {
      text: "No thread has focus on screen, so there is no thread to read. app_read_thread reads any thread by id.",
      data: { focused: false },
    };
  }
  const thread = store.loadThread(focused.threadId);
  if (!thread) {
    return {
      text: `The focused thread (${focused.threadId}) is not in the store yet; it may not have been sent a message.`,
      data: { focused: true, threadId: focused.threadId, found: false },
    };
  }
  const messages = thread.blocks
    .map((block) => ({ role: block.role, text: blockText(block).trim() }))
    .filter((m) => m.text.length > 0)
    .slice(-count);
  const body = messages.length
    ? messages
        .map((m) => `[${m.role === "user" ? "user" : "agent"}]\n${truncateTo(m.text, MESSAGE_CHAR_MAX)}`)
        .join("\n\n")
    : "(nothing said in it yet)";
  return {
    text:
      `Focused thread "${thread.title || focused.title || "Untitled"}" (id ${focused.threadId}), ` +
      `its last ${messages.length} message${messages.length === 1 ? "" : "s"}:\n\n${body}`,
    data: {
      focused: true,
      threadId: focused.threadId,
      found: true,
      messages: messages.map((m) => ({ role: m.role, text: truncateTo(m.text, MESSAGE_CHAR_MAX) })),
    },
  };
}

async function terminalSection(
  read: AppViewToolOptions["readTerminalScreen"],
  view: ViewSnapshot,
  count: number,
): Promise<ViewSection> {
  const focused = focusedTerminalOf(view);
  if (!focused) {
    return { text: "No terminal has focus on screen.", data: { focused: false } };
  }
  if (!read) {
    return {
      text: "kone cannot read terminals in this session.",
      data: { focused: true, terminalId: focused.terminalId, readable: false },
    };
  }
  const screen = await read(focused.terminalId, count);
  if (!screen) {
    return {
      text: `The focused terminal (${focused.terminalId}) is no longer running, so there is nothing to read.`,
      data: { focused: true, terminalId: focused.terminalId, found: false },
    };
  }
  const state =
    screen.status === "exited"
      ? `exited${screen.exitCode === null ? "" : ` with code ${screen.exitCode}`}`
      : screen.running
        ? `running "${screen.running}"`
        : "at the prompt";
  return {
    text:
      `Focused terminal in ${screen.cwd}, ${state}. Its last ${screen.lines.length} line${screen.lines.length === 1 ? "" : "s"}:\n` +
      "```\n" +
      screen.lines.join("\n") +
      "\n```",
    data: {
      focused: true,
      terminalId: focused.terminalId,
      found: true,
      cwd: screen.cwd,
      status: screen.status,
      running: screen.running,
      exitCode: screen.exitCode,
      lines: screen.lines,
    },
  };
}

export function createAppViewTools(options: AppViewToolOptions): ToolEntry[] {
  const handler = async (_ctx: GatewayToolContext, params: GetViewInput): Promise<GatewayToolResult> => {
    const view = options.readView?.() ?? null;
    if (!view) {
      return { content: [{ type: "text", text: UNKNOWN_VIEW }], structuredContent: { known: false } };
    }

    const include = new Set(params.include ?? []);
    const sections = [renderViewSnapshot(view)];
    const structured: GatewayRecord = {
      known: true,
      at: new Date(view.at).toISOString(),
      layers: JSON.parse(JSON.stringify(view.layers)),
      selection: view.selection ? { ...view.selection } : null,
    };

    if (include.has("thread")) {
      const section = threadSection(options.store, view, params.messages ?? DEFAULT_MESSAGES);
      sections.push(section.text);
      structured.thread = section.data;
    }
    if (include.has("terminal")) {
      const section = await terminalSection(options.readTerminalScreen, view, params.lines ?? DEFAULT_LINES);
      sections.push(section.text);
      structured.terminal = section.data;
    }

    return {
      content: [{ type: "text", text: sections.join("\n\n") }],
      structuredContent: structured,
    };
  };

  return [
    {
      name: "app_get_view",
      description:
        "See what the user is looking at in kone right now: which surfaces are open front to back (the launcher, a project page, the studio and its columns, the inbox, the bench, settings, a dialog), what each one holds, each thread's live status and what a parked one is waiting on, and any text the user selected. Include 'thread' to read the latest messages of the thread that has focus, or 'terminal' to read what the focused terminal is showing. Ids in the answer are the ones the other app tools take.",
      inputSchema: GetViewInputSchema,
      jsonSchema: GET_VIEW_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      promptSnippet:
        "see what is on the user's screen right now, and read the focused thread's latest messages or the focused terminal's output.",
      promptGuidelines: [
        "Each user message may open with a <kone_view> block. kone attaches it to every message automatically: it describes the user's screen at the moment they sent it, briefly (the front surface, the focused studio column and a count of the others, and any selected text). The user did not write it and never sees it, so do not quote it, mention the tag, or narrate it back (\"I can see you're on...\"). Its presence says nothing about what the message wants. Draw on it only when the message refers to something on screen (\"this\", \"here\", \"that thread\", \"the error\") or cannot be answered without it; otherwise answer the message as if it were not there.",
        "The block leaves detail out on purpose. When the message is about the other studio columns, what is open behind the front surface, or what the focused thread or terminal actually says, call app_get_view (with include for the thread or terminal) before answering instead of guessing from the block.",
      ],
      handler,
    },
  ];
}
