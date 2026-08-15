/**
 * DeepSeek Harness desktop client main process.
 *
 * Boots the bundled dsh web profile with the bundled Node runtime, hosts the
 * web UI in an Electron window, and supervises the harness process tree.
 * The shell adds a branded loading window, remembers window geometry, and
 * turns startup failures into actionable dialogs with the harness log.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from 'electron'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const PORT = 3080
const SERVER_URL = `http://127.0.0.1:${PORT}`
const SERVER_WAIT_MS = 90_000
const MAX_LOG_TAIL = 200_000
const BOUNDS_FILE = 'window-state.json'

// The wallpaper is served through a custom scheme: the web UI runs on an http
// origin, and Chromium blocks `file://` subresources from http pages.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dsh-wallpaper',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

let splashWindow = null
let mainWindow = null
let harnessProcess = null
let harnessLog = ''

function logDir() {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return dir
}

function crashLogPath() {
  return join(logDir(), 'desktop-crash.log')
}

function recordCrash(text) {
  try {
    appendFileSync(crashLogPath(), `\n[${new Date().toISOString()}] ${text}\n`)
  } catch {
    // Best-effort crash logging.
  }
}

// Never let an uncaught error in the shell die silently: the packaged window
// has no console, so persist it next to the harness log for diagnosis.
process.on('uncaughtException', (error) => recordCrash(`uncaughtException: ${error?.stack ?? error}`))
process.on('unhandledRejection', (reason) => recordCrash(`unhandledRejection: ${reason?.stack ?? reason}`))

/**
 * The harness closure must live at a stable path: the portable target extracts
 * to a fresh random directory under %TEMP% on every launch and deletes it on
 * exit, so junctions the harness heals into $DSH_HOME would dangle and the
 * backend can fail to boot. Materialize it once under %LOCALAPPDATA% and run
 * from there; the installed and portable targets then behave identically.
 */
function harnessDir() {
  const base = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'DeepSeek Harness')
    : app.getPath('userData')
  const stable = join(base, 'harness')
  const marker = join(stable, '.version')
  const version = app.getVersion()
  try {
    const current = readFileSync(marker, 'utf8').trim()
    if (current === version && existsSync(join(stable, 'node.exe'))) return stable
  } catch {
    // No marker yet; (re)materialize below.
  }
  mkdirSync(dirname(stable), { recursive: true })
  rmSync(stable, { recursive: true, force: true })
  mkdirSync(stable, { recursive: true })
  const archive = join(process.resourcesPath, 'harness.tar')
  if (existsSync(archive)) {
    // The closure ships as one archive so the NSIS wrapper extracts a single
    // file instead of tens of thousands; the OS tar unpacks it here once.
    const result = spawnSync('tar.exe', ['-xf', archive, '-C', stable], { stdio: 'ignore' })
    if (result.status !== 0 || !existsSync(join(stable, 'node.exe'))) {
      throw new Error(`failed to extract bundled harness (tar status ${result.status})`)
    }
  } else {
    const source = join(process.resourcesPath, 'harness')
    if (!existsSync(join(source, 'node.exe'))) {
      throw new Error(`bundled harness is missing from ${source}`)
    }
    cpSync(source, stable, { recursive: true })
  }
  writeFileSync(marker, version)
  return stable
}

function recordHarnessOutput(chunk) {
  harnessLog = (harnessLog + chunk.toString()).slice(-MAX_LOG_TAIL)
  try {
    appendFileSync(join(logDir(), 'harness.log'), chunk)
  } catch {
    // The in-memory tail survives for dialogs; on-disk logging is best-effort.
  }
}

function loadBounds() {
  try {
    const saved = JSON.parse(readFileSync(join(logDir(), BOUNDS_FILE), 'utf8'))
    const bounds = {
      width: Math.max(960, Number(saved.width) || 1440),
      height: Math.max(640, Number(saved.height) || 920),
    }
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      bounds.x = saved.x
      bounds.y = saved.y
    }
    return bounds
  } catch {
    return { width: 1440, height: 920 }
  }
}

function saveBounds(bounds) {
  try {
    writeFileSync(join(logDir(), BOUNDS_FILE), JSON.stringify(bounds))
  } catch {
    // Window geometry persistence is best-effort.
  }
}

// ---- Wallpaper (custom background image) ----

const WALLPAPER_META = 'wallpaper.json'
let wallpaperCssKey

function wallpaperMetaPath() {
  return join(logDir(), WALLPAPER_META)
}

function currentWallpaperPath() {
  try {
    const saved = JSON.parse(readFileSync(wallpaperMetaPath(), 'utf8'))
    return typeof saved.path === 'string' ? saved.path : undefined
  } catch {
    return undefined
  }
}

function wallpaperCss() {
  return [
    // Light mode surfaces stay light, just translucent.
    ':root, body {',
    '  --dsw-alias-bg-base: transparent !important;',
    '  --dsw-specific-sidebar-fill: rgba(255, 255, 255, 0.55) !important;',
    '  --dsw-specific-bubble: rgba(255, 255, 255, 0.55) !important;',
    '  --dsw-specific-input-major: rgba(255, 255, 255, 0.55) !important;',
    '  --dsw-alias-bg-module-platform: rgba(255, 255, 255, 0.55) !important;',
    '  --dsw-alias-bg-layer-2: rgba(255, 255, 255, 0.55) !important;',
    '}',
    // Dark mode surfaces stay dark, just translucent.
    'body[data-ds-dark-theme] {',
    '  --dsw-alias-bg-base: transparent !important;',
    '  --dsw-specific-sidebar-fill: rgba(27, 27, 28, 0.45) !important;',
    '  --dsw-specific-bubble: rgba(44, 44, 46, 0.5) !important;',
    '  --dsw-specific-input-major: rgba(44, 44, 46, 0.5) !important;',
    '  --dsw-alias-bg-module-platform: rgba(53, 54, 56, 0.5) !important;',
    '  --dsw-alias-bg-layer-2: rgba(44, 44, 46, 0.5) !important;',
    '}',
    // Wallpaper on the body; the blend tint follows the active theme.
    'body {',
    '  background-color: #dfe3ec !important;',
    '  background-image: url("dsh-wallpaper://local/wallpaper") !important;',
    '  background-size: cover !important;',
    '  background-position: center !important;',
    '  background-repeat: no-repeat !important;',
    '  background-attachment: fixed !important;',
    '  background-blend-mode: multiply !important;',
    '}',
    'body[data-ds-dark-theme] {',
    '  background-color: #1a1f2a !important;',
    '}',
    '#root { background: transparent !important; }',
    '#root > div { background: transparent !important; }',
    '#root > div > div { background: transparent !important; }',
  ].join('\n')
}

async function applyWallpaper() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (wallpaperCssKey !== undefined) {
    await mainWindow.webContents.removeInsertedCSS(wallpaperCssKey).catch(() => {})
    wallpaperCssKey = undefined
  }
  const path = currentWallpaperPath()
  if (path === undefined || !existsSync(path)) return
  wallpaperCssKey = await mainWindow.webContents.insertCSS(wallpaperCss(), { cssOrigin: 'author' }).catch(() => undefined)
}

async function changeWallpaper() {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: '选择背景图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return
  const source = result.filePaths[0]
  const ext = extname(source).slice(1).toLowerCase() || 'png'
  const dest = join(logDir(), `wallpaper.${ext}`)
  copyFileSync(source, dest)
  writeFileSync(wallpaperMetaPath(), JSON.stringify({ path: dest }))
  await applyWallpaper()
}

async function clearWallpaper() {
  const previous = currentWallpaperPath()
  rmSync(wallpaperMetaPath(), { force: true })
  if (previous !== undefined) rmSync(previous, { force: true })
  await applyWallpaper()
}

function injectWallpaperButton() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  const script = `(() => {
    if (document.getElementById('dsh-wallpaper-btn')) return
    if (!window.dshDesktop) return
    const btn = document.createElement('button')
    btn.id = 'dsh-wallpaper-btn'
    btn.type = 'button'
    btn.innerHTML = '<span style="font-size:14px;line-height:1">🖼</span><span>更换背景</span>'
    btn.title = '选择一张图片作为背景'
    Object.assign(btn.style, {
      position: 'fixed', left: '16px', bottom: '76px', zIndex: '2147483000',
      display: 'inline-flex', alignItems: 'center', gap: '8px',
      padding: '10px 16px', borderRadius: '999px', border: '1px solid rgba(255,255,255,0.14)',
      cursor: 'pointer', background: 'rgba(18,22,36,0.78)', color: '#e8eaf2',
      fontSize: '13px', fontFamily: 'inherit', boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
      backdropFilter: 'blur(10px)', transition: 'transform .15s ease, background .15s ease, box-shadow .15s ease',
    })
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'translateY(-2px)'
      btn.style.background = 'rgba(30,36,58,0.9)'
      btn.style.boxShadow = '0 6px 20px rgba(0,0,0,0.45)'
    })
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'translateY(0)'
      btn.style.background = 'rgba(18,22,36,0.78)'
      btn.style.boxShadow = '0 4px 16px rgba(0,0,0,0.35)'
    })
    btn.addEventListener('click', () => { void window.dshDesktop.changeBackground() })
    document.body.appendChild(btn)
  })()`
  mainWindow.webContents.executeJavaScript(script).catch(() => {})
}

function splashHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:18px;background:radial-gradient(1100px 560px at 50% -12%, #1c2450 0%, #0e1116 58%);
    color:#e8eaf2;font-family:'Segoe UI',system-ui,sans-serif;user-select:none}
  .logo{width:76px;height:76px;border-radius:22px;display:flex;align-items:center;justify-content:center;
    font-size:30px;font-weight:700;color:#fff;
    background:linear-gradient(135deg,#4d6bfe 0%,#2b3a8f 100%);
    box-shadow:0 12px 34px rgba(77,107,254,.38)}
  .spinner{width:26px;height:26px;border:3px solid rgba(255,255,255,.16);
    border-top-color:#7c93ff;border-radius:50%;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.2px}
  p{font-size:12px;margin:0;color:#9aa3bf;max-width:330px;text-align:center;line-height:1.5}
</style>
</head>
<body>
  <div class="logo">DS</div>
  <h1>DeepSeek Harness</h1>
  <div class="spinner"></div>
  <p id="status">正在启动本地引擎…</p>
  <script>
    window.setStatus = function (text) { document.getElementById('status').textContent = text }
  </script>
</body>
</html>`
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 320,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: '#0e1116',
    webPreferences: { sandbox: true },
  })
  void splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml())}`)
  splashWindow.once('ready-to-show', () => splashWindow?.show())
  splashWindow.on('closed', () => {
    splashWindow = null
  })
}

function setSplashStatus(text) {
  splashWindow?.webContents.executeJavaScript(`setStatus(${JSON.stringify(text)})`).catch(() => {})
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [{ label: '退出', accelerator: 'Alt+F4', click: () => app.quit() }],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'Ctrl+R', click: () => mainWindow?.webContents.reload() },
        {
          label: '开发者工具',
          accelerator: 'Ctrl+Shift+I',
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: '外观',
      submenu: [
        { label: '更换背景…', click: () => { void changeWallpaper() } },
        { label: '清除背景', click: () => { void clearWallpaper() } },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开日志目录', click: () => { void shell.openPath(logDir()) } },
        {
          label: '关于 DeepSeek Harness',
          click: () => {
            void dialog.showMessageBox(mainWindow ?? undefined, {
              type: 'info',
              title: '关于',
              message: `DeepSeek Harness ${app.getVersion()}`,
              detail: '本地运行的 agent harness 桌面客户端。',
            })
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function startHarness() {
  const dir = harnessDir()
  const entry = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entry)) {
    throw new Error(`bundled harness entry is missing: ${entry}`)
  }
  const nodePath = app.isPackaged ? join(dir, 'node.exe') : process.execPath
  harnessProcess = spawn(nodePath, [entry, 'web'], {
    cwd: dir,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  harnessProcess.on('error', (error) => {
    recordCrash(`failed to spawn harness: ${error?.stack ?? error}`)
    harnessProcess = null
    void dialog.showErrorBox('DeepSeek Harness 启动失败', `无法启动本地引擎：${error.message}`)
    app.exit(1)
  })
  harnessProcess.stdout.on('data', recordHarnessOutput)
  harnessProcess.stderr.on('data', recordHarnessOutput)
  harnessProcess.on('exit', (code, signal) => {
    harnessProcess = null
    if (mainWindow !== null) {
      void dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'DeepSeek Harness 已停止',
        message: '本地引擎意外退出。',
        detail: `退出码：${code ?? 'null'}，信号：${signal ?? 'null'}\n\n${harnessLog.slice(-3000)}`,
        buttons: ['退出', '打开日志目录'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 1) void shell.openPath(logDir())
        app.quit()
      })
    }
  })
}

async function portIsInUse() {
  try {
    const response = await fetch(SERVER_URL)
    return response.ok
  } catch {
    return false
  }
}

async function waitForServer(ms) {
  const deadline = Date.now() + ms
  let lastStatus = ''
  while (Date.now() < deadline) {
    if (harnessProcess === null) {
      throw new Error(`本地引擎在服务就绪前退出。\n\n${harnessLog.slice(-3000)}`)
    }
    try {
      const response = await fetch(SERVER_URL)
      if (response.ok) return
    } catch {
      // Server not up yet; keep polling.
    }
    const elapsed = Math.round((Date.now() - (deadline - ms)) / 1000)
    const status = `正在启动本地引擎… ${elapsed}s`
    if (status !== lastStatus) {
      lastStatus = status
      setSplashStatus(status)
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`本地引擎 ${SERVER_WAIT_MS / 1000}s 内未就绪。\n\n${harnessLog.slice(-3000)}`)
}

async function createMainWindow() {
  const bounds = loadBounds()
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'DeepSeek Harness',
    icon: join(moduleDir, 'build', 'icon.ico'),
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(moduleDir, 'preload.js'),
    },
  })
  // Show the main window and retire the splash exactly once. The
  // `ready-to-show` event can fire before `loadURL` resolves (a fast first
  // paint), so attach it first and also call it after `loadURL` plus a
  // fallback timer: the shell must never stay stuck on the loading window.
  let shown = false
  const showMain = () => {
    if (shown) return
    shown = true
    if (mainWindow !== null && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show()
    }
    splashWindow?.close()
  }
  mainWindow.once('ready-to-show', showMain)
  const fallback = setTimeout(showMain, 8000)
  mainWindow.once('closed', () => clearTimeout(fallback))
  let saveTimer = null
  const queueSave = () => {
    if (mainWindow === null) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveBounds(mainWindow.getBounds()), 400)
  }
  mainWindow.on('resize', queueSave)
  mainWindow.on('move', queueSave)
  mainWindow.webContents.on('did-finish-load', () => {
    void applyWallpaper()
    injectWallpaperButton()
  })
  await mainWindow.loadURL(SERVER_URL)
  showMain()
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function killHarnessTree() {
  if (harnessProcess === null || harnessProcess.pid === undefined) return
  const pid = harnessProcess.pid
  harnessProcess = null
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], () => {})
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
}

async function showStartupError(error) {
  splashWindow?.close()
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'DeepSeek Harness 启动失败',
    message: error instanceof Error ? error.message : String(error),
    detail: harnessLog.slice(-3000),
    buttons: ['退出', '打开日志目录'],
    defaultId: 0,
  })
  if (response === 1) void shell.openPath(logDir())
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.setAppUserModelId('ai.deepseek.harness.desktop')
  ipcMain.handle('desktop:change-background', () => changeWallpaper())
  ipcMain.handle('desktop:clear-background', () => clearWallpaper())
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    protocol.handle('dsh-wallpaper', async () => {
      const path = currentWallpaperPath()
      if (path === undefined || !existsSync(path)) return new Response('', { status: 404 })
      try {
        const data = await readFile(path)
        const ext = extname(path).slice(1).toLowerCase()
        const mime = ext === 'png' ? 'image/png'
          : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp'
          : ext === 'bmp' ? 'image/bmp'
          : 'application/octet-stream'
        return new Response(data, {
          headers: { 'content-type': mime, 'cache-control': 'no-store' },
        })
      } catch (error) {
        recordCrash(`wallpaper serve failed: ${error?.message ?? error}`)
        return new Response('', { status: 500 })
      }
    })
    createSplashWindow()
    buildMenu()
    try {
      // A leftover harness from a previous run may already be listening; reuse
      // it instead of erroring, then open the window against the same server.
      if (await portIsInUse()) {
        setSplashStatus('检测到本地引擎已在运行…')
      } else {
        startHarness()
        setSplashStatus('正在启动本地引擎…')
      }
      await waitForServer(SERVER_WAIT_MS)
      setSplashStatus('正在加载界面…')
      await createMainWindow()
    } catch (error) {
      await showStartupError(error)
      app.exit(1)
    }
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  killHarnessTree()
})
