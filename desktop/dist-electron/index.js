"use strict";
const electron = require("electron");
const path = require("path");
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const isDev = !!VITE_DEV_SERVER_URL;
let mainWindow = null;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    // 无边框，使用自定义标题栏
    titleBarStyle: "hidden",
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true
    },
    show: false
  });
  if (isDev) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
  mainWindow.once("ready-to-show", () => mainWindow == null ? void 0 : mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    electron.shell.openExternal(url);
    return { action: "deny" };
  });
}
electron.ipcMain.on("window:minimize", () => mainWindow == null ? void 0 : mainWindow.minimize());
electron.ipcMain.on("window:maximize", () => {
  if (mainWindow == null ? void 0 : mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow == null ? void 0 : mainWindow.maximize();
});
electron.ipcMain.on("window:close", () => mainWindow == null ? void 0 : mainWindow.close());
electron.app.whenReady().then(createWindow);
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
electron.app.on("activate", () => {
  if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
});
