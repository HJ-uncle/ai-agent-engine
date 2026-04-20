import { app, BrowserWindow, shell, ipcMain } from 'electron'
import path from 'path'

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const isDev = !!VITE_DEV_SERVER_URL

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,           // 无边框，使用自定义标题栏
    titleBarStyle: 'hidden',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  })

  // 加载页面
  if (isDev) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL!)
    // 开发模式下用内嵌 devtools，不弹独立黑屏窗口
    // mainWindow.webContents.openDevTools({ mode: 'detach' })  // 如需调试取消注释
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // 避免白屏闪烁
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // 外部链接用浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// ─── IPC 窗口控制 ────────────────────────────────────────────────────────────

ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('window:close', () => mainWindow?.close())

// ─── 生命周期 ────────────────────────────────────────────────────────────────

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
