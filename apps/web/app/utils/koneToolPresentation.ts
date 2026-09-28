// How kone's own tools read in a thread: an icon, a pill label, and the
// sentence a step row says while the call runs, once it lands, and if it fails.
//
// kone's tools act on the app rather than on the project — the scratchpad, the
// workers a thread opened, the other agents on the project, the window — so
// there is no file or command to show next to them. The generic fallback made
// that read as "Ran worker wait"; each tool says what it did instead. Their
// arguments and results stay one click away in the row's detail.

import {
  BubbleChatIcon,
  Cancel01Icon,
  ChartLineData01Icon,
  ComputerTerminal01Icon,
  DashboardSquare01Icon,
  Delete02Icon,
  Folder01Icon,
  HourglassIcon,
  InboxIcon,
  Note01Icon,
  NoteEditIcon,
  PaintBoardIcon,
  Settings02Icon,
  SourceCodeIcon,
  TextFontIcon,
  UserGroupIcon,
  UserMultiple02Icon,
  WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import type { ToolOrbFamily } from "~/utils/toolOrbDraw";

type HugeIcon = typeof Note01Icon;

export type KoneToolPresentation = {
  icon: HugeIcon;
  label: string;
  family: ToolOrbFamily;
  /** The row while the call is in flight, once it lands, and if it fails. */
  running: string;
  done: string;
  failed: string;
};

function kone(
  icon: HugeIcon,
  label: string,
  family: ToolOrbFamily,
  [running, done, failed]: [string, string, string],
): KoneToolPresentation {
  return { icon, label, family, running, done, failed };
}

const KONE_TOOLS: ReadonlyMap<string, KoneToolPresentation> = new Map(Object.entries({
  // scratchpad
  scratchpad_read: kone(Note01Icon, "Scratchpad", "read", [
    "Reading the scratchpad",
    "Read the scratchpad",
    "Couldn't read the scratchpad",
  ]),
  scratchpad_write: kone(NoteEditIcon, "Scratchpad", "write", [
    "Updating the scratchpad",
    "Updated the scratchpad",
    "Couldn't update the scratchpad",
  ]),

  // workers
  worker_targets: kone(UserGroupIcon, "Workers", "agent", [
    "Checking who can take work",
    "Checked who can take work",
    "Couldn't check who can take work",
  ]),
  worker_spawn: kone(WorkflowSquare01Icon, "Worker", "agent", [
    "Starting a worker",
    "Started a worker",
    "Couldn't start a worker",
  ]),
  worker_spawn_preset: kone(WorkflowSquare01Icon, "Worker", "agent", [
    "Starting a specialist",
    "Started a specialist",
    "Couldn't start a specialist",
  ]),
  worker_spawn_batch: kone(WorkflowSquare01Icon, "Workers", "agent", [
    "Starting workers",
    "Started workers",
    "Couldn't start workers",
  ]),
  worker_delegate: kone(UserMultiple02Icon, "Teammate", "agent", [
    "Handing work to a teammate",
    "Handed work to a teammate",
    "Couldn't hand work to a teammate",
  ]),
  worker_continue: kone(BubbleChatIcon, "Follow-up", "agent", [
    "Following up with a worker",
    "Followed up with a worker",
    "Couldn't follow up with a worker",
  ]),
  worker_wait: kone(HourglassIcon, "Waiting", "agent", [
    "Waiting on workers",
    "Collected worker replies",
    "Stopped waiting on workers",
  ]),
  worker_read: kone(Note01Icon, "Worker thread", "read", [
    "Reading a worker's thread",
    "Read a worker's thread",
    "Couldn't read a worker's thread",
  ]),
  worker_cancel: kone(Cancel01Icon, "Stop worker", "del", [
    "Stopping a worker",
    "Stopped a worker",
    "Couldn't stop a worker",
  ]),
  worker_decline: kone(Cancel01Icon, "Decline", "agent", [
    "Declining a worker's request",
    "Declined a worker's request",
    "Couldn't decline a worker's request",
  ]),
  worker_answer: kone(BubbleChatIcon, "Answer", "agent", [
    "Answering a worker's question",
    "Answered a worker's question",
    "Couldn't answer a worker's question",
  ]),

  // peers
  peer_send: kone(BubbleChatIcon, "Message", "agent", [
    "Messaging another agent",
    "Messaged another agent",
    "Couldn't message another agent",
  ]),
  peer_list: kone(UserGroupIcon, "Agents", "agent", [
    "Checking who else is working",
    "Checked who else is working",
    "Couldn't check who else is working",
  ]),
  peer_inbox: kone(InboxIcon, "Inbox", "agent", [
    "Reading messages",
    "Read messages",
    "Couldn't read messages",
  ]),

  // processes & code
  process_control: kone(ComputerTerminal01Icon, "Process", "run", [
    "Managing a background process",
    "Managed a background process",
    "Background process failed",
  ]),
  code_lsp: kone(SourceCodeIcon, "Code intel", "intel", [
    "Asking the language server",
    "Asked the language server",
    "Language server failed",
  ]),
  code_find_calls: kone(SourceCodeIcon, "Find calls", "intel", [
    "Finding calls",
    "Found calls",
    "Couldn't find calls",
  ]),
  code_preview_rewrite: kone(SourceCodeIcon, "Rewrite preview", "intel", [
    "Previewing a rewrite",
    "Previewed a rewrite",
    "Couldn't preview a rewrite",
  ]),

  // app — agents
  app_list_agents: kone(UserGroupIcon, "Agents", "agent", ["Listing agents", "Listed agents", "Couldn't list agents"]),
  app_create_agent: kone(UserGroupIcon, "New agent", "agent", [
    "Creating an agent",
    "Created an agent",
    "Couldn't create an agent",
  ]),
  app_update_agent: kone(UserGroupIcon, "Agent", "agent", [
    "Updating an agent",
    "Updated an agent",
    "Couldn't update an agent",
  ]),
  app_delete_agent: kone(Delete02Icon, "Agent", "del", [
    "Removing an agent",
    "Removed an agent",
    "Couldn't remove an agent",
  ]),
  app_set_active_agent: kone(UserGroupIcon, "Agent", "agent", [
    "Switching the active agent",
    "Switched the active agent",
    "Couldn't switch the active agent",
  ]),
  // app — projects & providers
  app_list_projects: kone(Folder01Icon, "Projects", "read", [
    "Listing projects",
    "Listed projects",
    "Couldn't list projects",
  ]),
  app_get_project: kone(Folder01Icon, "Project", "read", [
    "Looking at a project",
    "Looked at a project",
    "Couldn't look at the project",
  ]),
  app_get_provider_status: kone(Settings02Icon, "Providers", "read", [
    "Checking providers",
    "Checked providers",
    "Couldn't check providers",
  ]),
  app_set_provider_enabled: kone(Settings02Icon, "Provider", "agent", [
    "Changing a provider",
    "Changed a provider",
    "Couldn't change the provider",
  ]),
  app_update_provider: kone(Settings02Icon, "Provider", "agent", [
    "Updating a provider",
    "Updated a provider",
    "Couldn't update the provider",
  ]),
  app_get_usage_report: kone(ChartLineData01Icon, "Usage", "read", [
    "Checking usage",
    "Checked usage",
    "Couldn't check usage",
  ]),
  // app — studio & view
  app_get_strip_settings: kone(DashboardSquare01Icon, "Studio", "read", [
    "Checking studio settings",
    "Checked studio settings",
    "Couldn't check studio settings",
  ]),
  app_set_strip_settings: kone(DashboardSquare01Icon, "Studio", "agent", [
    "Changing studio settings",
    "Changed studio settings",
    "Couldn't change studio settings",
  ]),
  app_get_view: kone(DashboardSquare01Icon, "View", "read", [
    "Looking at your screen",
    "Looked at your screen",
    "Couldn't see your screen",
  ]),
  // app — presets
  app_list_subagent_presets: kone(WorkflowSquare01Icon, "Presets", "read", [
    "Listing presets",
    "Listed presets",
    "Couldn't list presets",
  ]),
  app_create_subagent_preset: kone(WorkflowSquare01Icon, "New preset", "agent", [
    "Creating a preset",
    "Created a preset",
    "Couldn't create a preset",
  ]),
  app_update_subagent_preset: kone(WorkflowSquare01Icon, "Preset", "agent", [
    "Updating a preset",
    "Updated a preset",
    "Couldn't update the preset",
  ]),
  app_delete_subagent_preset: kone(Delete02Icon, "Preset", "del", [
    "Removing a preset",
    "Removed a preset",
    "Couldn't remove the preset",
  ]),
  // app — appearance
  app_get_theme_state: kone(PaintBoardIcon, "Appearance", "read", [
    "Checking the appearance",
    "Checked the appearance",
    "Couldn't check the appearance",
  ]),
  app_list_available_themes: kone(PaintBoardIcon, "Themes", "read", [
    "Listing themes",
    "Listed themes",
    "Couldn't list themes",
  ]),
  app_set_theme: kone(PaintBoardIcon, "Theme", "agent", [
    "Changing the theme",
    "Changed the theme",
    "Couldn't change the theme",
  ]),
  app_preview_theme_override: kone(PaintBoardIcon, "Theme preview", "agent", [
    "Previewing a theme",
    "Previewed a theme",
    "Couldn't preview the theme",
  ]),
  app_create_custom_theme: kone(PaintBoardIcon, "New theme", "agent", [
    "Creating a theme",
    "Created a theme",
    "Couldn't create the theme",
  ]),
  app_get_typography: kone(TextFontIcon, "Typography", "read", [
    "Checking typography",
    "Checked typography",
    "Couldn't check typography",
  ]),
  app_set_typography: kone(TextFontIcon, "Typography", "agent", [
    "Changing typography",
    "Changed typography",
    "Couldn't change typography",
  ]),
  // app — threads
  app_list_threads: kone(BubbleChatIcon, "Threads", "read", [
    "Listing threads",
    "Listed threads",
    "Couldn't list threads",
  ]),
  app_read_thread: kone(BubbleChatIcon, "Thread", "read", [
    "Reading a thread",
    "Read a thread",
    "Couldn't read the thread",
  ]),
  app_start_thread: kone(BubbleChatIcon, "New thread", "agent", [
    "Starting a thread",
    "Started a thread",
    "Couldn't start a thread",
  ]),
  app_send_to_thread: kone(BubbleChatIcon, "Thread", "agent", [
    "Sending to a thread",
    "Sent to a thread",
    "Couldn't send to the thread",
  ]),
  app_stop_thread: kone(Cancel01Icon, "Thread", "del", [
    "Stopping a thread",
    "Stopped a thread",
    "Couldn't stop the thread",
  ]),
  app_archive_thread: kone(BubbleChatIcon, "Thread", "agent", [
    "Archiving a thread",
    "Archived a thread",
    "Couldn't archive the thread",
  ]),
  app_delete_thread: kone(Delete02Icon, "Thread", "del", [
    "Deleting a thread",
    "Deleted a thread",
    "Couldn't delete the thread",
  ]),
  app_rename_thread: kone(BubbleChatIcon, "Thread", "agent", [
    "Renaming a thread",
    "Renamed a thread",
    "Couldn't rename the thread",
  ]),
}));

/** How a kone tool reads in a thread, by canonical name — undefined for a tool
 *  that is not kone's. */
export function koneToolPresentation(name: string): KoneToolPresentation | undefined {
  return KONE_TOOLS.get(name);
}
