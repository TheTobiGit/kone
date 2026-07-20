import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow, net, protocol, shell } from "electron";

import { registerFsIpc } from "./fs.js";
import { cancelClone, registerGitIpc } from "./git/index.js";
import { registerSystemIpc } from "./system.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.KONE_DEV === "1";
const devServerUrl = process.env.KONE_DEV_SERVER_URL ?? "http://localhost:3001";

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

function registerAppProtocol() {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === "/" || pathname === "") {
      pathname = "/index.html";
    }

    const filePath = path.join(getRendererPath(), pathname);
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function registerIpc() {
  // Directory browsing for the in-app folder picker.
  registerFsIpc();

  // Git inspection (recognize repos, read status / branches / commits).
  registerGitIpc();

  // Host-machine facts (the signed-in account's username, …).
  registerSystemIpc();
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false,
    title: "Kone",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    await mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  await mainWindow.loadURL("app://./index.html");
}

app.whenReady().then(async () => {
  if (!isDev) {
    registerAppProtocol();
  }

  registerIpc();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Don't leave a `git clone` running (and a half-written folder behind) if the
// app quits mid-clone.
app.on("before-quit", () => cancelClone());

console.log(
  isDev
    ? `Kone desktop dev shell (renderer: ${devServerUrl})`
    : "Kone desktop shell",
);
