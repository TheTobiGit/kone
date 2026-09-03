import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow, globalShortcut, nativeTheme, net, protocol, shell } from "electron";

import { getAgentService, registerAgentIpc, shutdownAgents } from "./agent/agent-ipc.js";
import { setUserDataDir } from "@kone/agent-core/userDataDir.js";
import { resolveAppProtocolPath } from "./appProtocol.js";
import { resolveAttachmentProtocolPath } from "./attachmentProtocol.js";
import { isRendererOriginNavigation, parseSafeExternalUrl } from "./lib/safeExternalUrl.js";
import { titleBarOptions } from "./chrome.js";
import { registerFsIpc } from "./modules/fs/fs.js";
import { cancelAllClones, registerGitIpc } from "./modules/git/index.js";
import { registerSystemIpc } from "./modules/system/system.js";
import { registerStudioIpc } from "./modules/studio/index.js";
import { registerRosterIpc } from "./modules/roster/index.js";
import { registerAvatarsIpc } from "./modules/avatars/index.js";
import { registerPresetsIpc } from "./modules/presets/index.js";
import { registerAppStateIpc } from "./modules/appState/index.js";
import { registerScratchpadIpc } from "./modules/scratchpad/index.js";
import { registerTerminalIpc, shutdownTerminals } from "./modules/terminal/index.js";
import {
  bindWindowChromeEvents,
  registerWindowControlsIpc,
} from "./windowControls.js";
import {
  createRendererRecoveryGate,
  getInitialWindowState,
  manageWindowState,
  RENDERER_RECOVERY_MAX_ATTEMPTS,
  RENDERER_RECOVERY_RELOAD_DELAY_MS,
  RENDERER_RECOVERY_WINDOW_MS,
} from "./windowState.js";

// The agent layer takes its state directory by injection rather than importing
// electron itself, so main resolves it once here — before any store is touched.
// (`userData` is available pre-`whenReady`.)
setUserDataDir(app.getPath("userData"));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.KONE_DEV === "1";
const devServerUrl = process.env.KONE_DEV_SERVER_URL ?? "http://localhost:3001";
/** Upper bound for the quit teardown (agent CLIs, terminals, …). If a provider
 *  child refuses to die in time, the app quits anyway — escalation, in the
 */
const QUIT_TEARDOWN_TIMEOUT_MS = 3_000;

let mainWindow: BrowserWindow | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: "attachment",
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function getResourcesPath(...segments: string[]) {
  if (isDev) {
    return path.resolve(__dirname, "..", "..", "..", ...segments);
  }

  return path.join(process.resourcesPath, ...segments);
}

function getRendererPath() {
  return getResourcesPath("renderer");
}

// Packaged builds carry the icon in the bundle itself (electron-builder writes
// it from `build.mac.icon` / `build.linux.icon`), so only a run from source
// needs to set one — otherwise dev shows Electron's own logo in the dock and
// the alt-tab switcher, which makes it hard to tell kone from any other
// Electron app you have open.
function getDevIconPath() {
  return isDev ? path.resolve(__dirname, "..", "icons", "icon.png") : null;
}

function registerAppProtocol() {
  const rendererRoot = getRendererPath();

  protocol.handle("app", (request) => {
    const filePath = resolveAppProtocolPath(rendererRoot, request.url);

    if (filePath === null) {
      // 404 instead of fetching: a request we cannot prove resolves inside the
      // renderer must not be served.
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function registerAttachmentProtocol() {
  protocol.handle("attachment", async (request) => {
    const filePath = await resolveAttachmentProtocolPath(request.url);

    if (filePath === null) {
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}
// One kone at a time. A second launch must not open a fresh process: every
// fresh process runs the conversation store's recovery pass on its first DB
// open, which seals the first instance's live turns as orphaned
// (ConversationStore.handle → sealOrphanedTurns) — the second window would
// quietly kill the first's sessions. The loser quits immediately; the winner
// focuses the existing window instead (second-instance below).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function registerIpc() {
  // Directory browsing for the in-app folder picker.
  registerFsIpc();

  // Git inspection (recognize repos, read status / branches / commits).
  registerGitIpc();

  // Host-machine facts (the signed-in account's username, …).
  registerSystemIpc();

  // Agent layer: discover the user's installed agent CLIs and drive them
  // (Codex first). Streams runtime events on the "agent:event" channel.
  registerAgentIpc();

  // Integrated terminal: node-pty shells, streamed on "terminal:event".
  registerTerminalIpc();

  // Per-project scratchpad documents (markdown notes).
  registerScratchpadIpc();

  // The studio plane: one row of panes per project (order, kinds, widths, focus).
  registerStudioIpc();

  // The roster: the agents you can hand work to, and each project's team.
  registerRosterIpc();

  // Preset sub-agents: reusable definitions a spawn is cut from.
  registerPresetsIpc();

  // What the renderer knows about itself and the main process does not — the
  // resolved agent roster and the thread strip's settings — mirrored so the
  // agent gateway can read the app the user is actually looking at.
  registerAppStateIpc();

  // Pictures for agents: one network read the renderer isn't allowed to do.
  registerAvatarsIpc();

  // Window chrome: minimize/maximize/close for the renderer's caption buttons.
  registerWindowControlsIpc(() => mainWindow);
}

async function createWindow() {
  const windowState = getInitialWindowState();
  // Windows and Linux take the icon per-window; macOS takes it on the dock.
  const devIcon = getDevIconPath();

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    ...titleBarOptions(process.platform),
    title: "Kone",
    // Created before the renderer paints — give the frame the scheme-correct
    // ground so a fresh window never flashes the opposite theme.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#070708" : "#f6f5f3",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (devIcon && process.platform !== "darwin") windowOptions.icon = devIcon;

  mainWindow = new BrowserWindow(windowOptions);

  // Remember size / position between launches.
  if (windowState.isMaximized) {
    mainWindow.maximize();
  }
  // Pass persistEnabled: when restore centered the window because the saved
  // coordinates sat on an unplugged display, close must not rewrite those
  // coordinates until the user actually moves the window — otherwise plugging
  // the monitor back in can never restore the original placement.
  manageWindowState(mainWindow, { persistEnabled: windowState.persistEnabled });

  // Push maximize/fullscreen transitions to the renderer's caption buttons.
  bindWindowChromeEvents(mainWindow);

  // Renderer crash (usually V8 OOM on long sessions) recovery: reload after a
  // short delay, bounded to 3 attempts per rolling 60s window (gate in
  // windowState.ts) so a renderer that dies on boot cannot reload-loop. The
  // agent layer and terminal PTYs live in this process and survive the
  // renderer's death, so a reload rehydrates the UI from state that never
  // died — no user action needed.
  const win = mainWindow;
  const rendererRecovery = createRendererRecoveryGate();
  win.webContents.on("render-process-gone", (_event, details) => {
    const recoverable =
      details.reason === "crashed" ||
      details.reason === "oom" ||
      details.reason === "abnormal-exit";
    const recovering =
      recoverable &&
      !win.isDestroyed() &&
      rendererRecovery.requestRecovery(Date.now());

    console.warn(
      `[main] renderer process gone (reason: ${details.reason}, exitCode: ${details.exitCode})` +
        (recovering
          ? ` — reloading in ${RENDERER_RECOVERY_RELOAD_DELAY_MS}ms` +
            ` (at most ${RENDERER_RECOVERY_MAX_ATTEMPTS} attempts per ${RENDERER_RECOVERY_WINDOW_MS}ms)`
          : recoverable
            ? " — recovery exhausted for this window, not reloading"
            : " — not a recoverable crash"),
    );
    if (!recovering) return;

    setTimeout(() => {
      if (!win.isDestroyed()) {
        void win.webContents.reload();
      }
    }, RENDERER_RECOVERY_RELOAD_DELAY_MS);
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();

    // Warm the agent layer a beat after first paint — not at IPC registration.
    // Registration runs before the window exists, so firing the four CLI probes
    // (`codex --version`, …) plus the app-server handshake there made them
    // compete with window creation and the renderer's first frame for CPU and
    // process slots, slowing first paint. Warming after show leaves first
    // paint and hydration the machine to themselves; the ~250ms beat guarantees
    // this no longer runs mid-paint. Fire-and-forget: `warm()` dedupes and
    // never rejects, and the renderer's own warmup (`agent:surface` →
    // `agent:warm`) coalesces onto this run, so nothing waits on the send path.
    setTimeout(() => {
      void getAgentService().warm().catch(() => {});
    }, 250);
  });

  // Window-open and in-window navigations must use the same http(s)-only gate
  // as github.open. will-navigate also has to let the renderer's own origin
  // (dev server or app://) through so the initial loadURL and client routes
  // still work, while anything else is kept out of the BrowserWindow.
  const applicationUrl = isDev ? devServerUrl : "app://./";

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = parseSafeExternalUrl(url);
    if (externalUrl) void shell.openExternal(externalUrl);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isRendererOriginNavigation(applicationUrl, url)) return;
    event.preventDefault();
    const externalUrl = parseSafeExternalUrl(url);
    if (externalUrl) void shell.openExternal(externalUrl);
  });

  if (isDev) {
    await mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  // Load the root path (not "/index.html") so Nuxt's client router matches the
  // home route. The app:// handler maps "/" to the index.html file on disk;
  // pointing the router at "/index.html" makes it 404 against its own routes.
  await mainWindow.loadURL("app://./");
}

if (gotSingleInstanceLock) {
  // A second launch (or dock click on macOS while running) focuses the
  // existing window instead of starting a second instance.
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      // All windows closed but the app still running (macOS convention) — the
      // launcher asked us to open again, so recreate the window.
      void createWindow();
    }
  });

  app.whenReady().then(async () => {
    if (!isDev) {
      registerAppProtocol();
    }
    registerAttachmentProtocol();

    const devIcon = getDevIconPath();
    if (devIcon) {
      app.dock?.setIcon(devIcon);
    }

    registerIpc();
    await createWindow();

    globalShortcut.register("CommandOrControl+E", () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("assistant:toggle");
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // Quit path: don't leave `git clone` processes running (each would keep a
  // half-written folder behind), and don't orphan agent CLI subprocesses or
  // terminal PTY shells. Every in-flight clone — the user's GitHub clone and a
  // concurrent skill-install clone alike — must be aborted, so this is the
  // all-clones sweep, not a single slot. before-quit is the only hook that can
  // await: preventDefault, run the teardown, then quit again. A hard timeout
  // stops the app even if a provider child refuses to die. Re-entry guard: the
  // app.quit() below fires before-quit again, which must pass straight through.
  let teardownStarted = false;
  app.on("before-quit", (event) => {
    if (teardownStarted) return;
    event.preventDefault();
    teardownStarted = true;
    cancelAllClones();
    const teardown = Promise.allSettled([shutdownAgents(), shutdownTerminals()]);
    const hardStop = new Promise<void>((resolve) =>
      setTimeout(resolve, QUIT_TEARDOWN_TIMEOUT_MS),
    );
    void Promise.race([teardown, hardStop]).finally(() => app.quit());
  });
}

console.log(
  isDev
    ? `Kone desktop dev shell (renderer: ${devServerUrl})`
    : "Kone desktop shell",
);
