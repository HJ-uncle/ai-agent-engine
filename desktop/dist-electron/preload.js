"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("electronAPI", {
  windowMinimize: () => electron.ipcRenderer.send("window:minimize"),
  windowMaximize: () => electron.ipcRenderer.send("window:maximize"),
  windowClose: () => electron.ipcRenderer.send("window:close")
});
