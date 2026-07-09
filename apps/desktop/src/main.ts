import { BRIDGE_WS_PORT } from "@kone/bridge-protocol";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow, net, protocol, shell } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.KONE_DEV === "1";
const devServerUrl = process.env.KONE_DEV_SERVER_URL ?? "http://localhost:3001";

let mainWindow: BrowserWindow | null = null;
let bridgeProcess: ChildProcessWithoutNullStreams | null = null;

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

function getBridgeSpawnSpec(): { command: string; args: string[]; cwd: string } | null {
  const bridgeDir = getResourcesPath("bridge");
  const compiledBridge = path.join(bridgeDir, process.platform === "win32" ? "kone-bridge.exe" : "kone-bridge");
  const bridgeEntry = path.join(bridgeDir, "src", "index.ts");

  if (existsSync(compiledBridge)) {
    return { command: compiledBridge, args: [], cwd: bridgeDir };
  }

  if (existsSync(bridgeEntry)) {
    return { command: "bun", args: ["run", "src/index.ts"], cwd: bridgeDir };
  }

  if (isDev) {
    const monorepoBridge = path.resolve(__dirname, "..", "..", "bridge");
    return { command: "bun", args: ["run", "src/index.ts"], cwd: monorepoBridge };
  }

  return null;
}

function startBridge() {
  if (isDev) return;

  const spec = getBridgeSpawnSpec();
  if (!spec) {
    console.warn("Bridge runtime not found in packaged resources.");
    return;
  }

  bridgeProcess = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: {
      ...process.env,
      KONE_CWD: process.env.KONE_CWD ?? app.getPath("home"),
    },
    stdio: "pipe",
  });

  bridgeProcess.stdout.on("data", (chunk) => {
    console.log(`[bridge] ${String(chunk)}`.trimEnd());
  });

  bridgeProcess.stderr.on("data", (chunk) => {
    console.error(`[bridge] ${String(chunk)}`.trimEnd());
  });

  bridgeProcess.on("exit", (code) => {
    console.log(`Bridge exited with code ${code ?? "unknown"}`);
    bridgeProcess = null;
  });
}

function stopBridge() {
  if (!bridgeProcess) return;
  bridgeProcess.kill();
  bridgeProcess = null;
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
      preload: path.join(__dirname, "preload.js"),
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
    startBridge();
  }

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

app.on("before-quit", () => {
  stopBridge();
});

process.on("exit", () => {
  stopBridge();
});

console.log(
  isDev
    ? `Kone desktop dev shell (renderer: ${devServerUrl}, bridge ws port: ${BRIDGE_WS_PORT})`
    : `Kone desktop shell (bridge ws port: ${BRIDGE_WS_PORT})`,
);
