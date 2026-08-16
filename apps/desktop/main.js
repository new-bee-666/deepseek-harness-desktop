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
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const PORT = 3080
const SERVER_URL = `http://127.0.0.1:${PORT}`
const SERVER_WAIT_MS = 90_000
const MAX_LOG_TAIL = 200_000
const BOUNDS_FILE = 'window-state.json'
const BALANCE_REFRESH_MS = 60_000

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

// ---- Multi-provider API balance (real-time) ----

/**
 * Balance query contract per provider: which credential key to read, which
 * endpoint answers, and how to normalize the response into a displayable
 * { balance, currency, note } triple. Only providers with a documented
 * public balance endpoint are listed; console-only providers are omitted.
 */
const BALANCE_PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    key: 'DEEPSEEK_API_KEY',
    url: 'https://api.deepseek.com/user/balance',
    normalize(data) {
      const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : undefined
      return {
        balance: info?.total_balance ?? '0.00',
        currency: info?.currency ?? 'CNY',
        note: data?.is_available === false ? '不可用' : undefined,
      }
    },
  },
  {
    id: 'kimi',
    label: 'Kimi',
    key: 'MOONSHOT_API_KEY',
    url: 'https://api.moonshot.cn/v1/users/me/balance',
    normalize(data) {
      return {
        balance: String(data?.data?.available_balance ?? '0'),
        currency: 'CNY',
      }
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    key: 'OPENAI_API_KEY',
    url: 'https://api.openai.com/v1/dashboard/billing/credit_grants',
    normalize(data) {
      const available = Number(data?.total_available ?? 0)
      return {
        balance: available.toFixed(2),
        currency: 'USD',
        note: data?.total_used != null ? `已用 $${Number(data.total_used).toFixed(2)}` : undefined,
      }
    },
  },
  {
    id: 'claude',
    label: 'Claude',
    key: 'ANTHROPIC_ADMIN_KEY',
    url: 'https://api.anthropic.com/v1/organizations/usage_report/messages',
    auth: 'x-api-key',
    headers: { 'anthropic-version': '2023-06-01' },
    validateKey(apiKey) {
      return apiKey.startsWith('sk-ant-admin') ? undefined : 'no-admin'
    },
    normalize(data) {
      let inputTokens = 0
      let outputTokens = 0
      for (const day of data?.data ?? []) {
        for (const result of day.results ?? []) {
          for (const usage of Object.values(result.usage ?? {})) {
            inputTokens += Number(usage?.input_tokens ?? 0)
            outputTokens += Number(usage?.output_tokens ?? 0)
          }
        }
      }
      const total = inputTokens + outputTokens
      const text = total >= 1_000_000
        ? `${(total / 1_000_000).toFixed(1)}M`
        : total >= 1_000
          ? `${(total / 1_000).toFixed(1)}K`
          : String(total)
      return {
        balance: text,
        currency: 'tokens',
        note: '本月用量（非余额）',
      }
    },
  },
]

/**
 * Read all credential values the providers care about from the same file the
 * harness uses ($DSH_HOME/.credentials.yaml, defaulting to ~/.dsh), so the
 * balance shown always matches the keys the client actually calls with.
 */
function readCredentialValues() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = join(home, '.credentials.yaml')
  const values = new Map()
  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.+?)\s*$/.exec(line)
      if (match) {
        const value = match[2].replace(/^["']|["']$/g, '')
        if (value.length > 0) values.set(match[1], value)
      }
    }
  } catch {
    // No credential file yet: every provider reports as unconfigured.
  }
  return values
}

async function fetchProviderBalance(provider, apiKey) {
    try {
      const headers = { ...(provider.headers ?? {}) }
      if (provider.auth === 'x-api-key') {
        headers['x-api-key'] = apiKey
      } else {
        headers.Authorization = `Bearer ${apiKey}`
      }
      const response = await fetch(provider.url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      })
    if (!response.ok) {
      return { id: provider.id, label: provider.label, ok: false, reason: 'http', status: response.status }
    }
    const data = await response.json()
    return {
      id: provider.id,
      label: provider.label,
      ok: true,
      ...provider.normalize(data),
    }
  } catch (error) {
    return { id: provider.id, label: provider.label, ok: false, reason: 'network' }
  }
}

async function fetchApiBalance() {
  const values = readCredentialValues()
  return Promise.all(BALANCE_PROVIDERS.map((provider) => {
    const apiKey = values.get(provider.key)
    if (apiKey === undefined) {
      return Promise.resolve({ id: provider.id, label: provider.label, ok: false, reason: 'no-key' })
    }
    const validation = provider.validateKey?.(apiKey)
    if (validation !== undefined) {
      return Promise.resolve({ id: provider.id, label: provider.label, ok: false, reason: validation })
    }
    return fetchProviderBalance(provider, apiKey)
  }))
}

/**
 * Inject the wallpaper entry into the settings panel's General section. The
 * panel is a React modal that remounts its content per open and per section
 * switch, so a MutationObserver re-applies the row whenever the General
 * section is visible and the row is not already present.
 */
function injectSettingsWallpaperEntry() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  const script = `(() => {
    if (window.__dshWallpaperObserver) return
    if (!window.dshDesktop) return
    const ROW_ID = 'dsh-settings-wallpaper-row'
    function isGeneralActive(dialog) {
      const active = dialog.querySelector('nav button[aria-current="true"]')
      if (active) return /通用|General/i.test(active.textContent ?? '')
      const first = dialog.querySelector('nav button')
      return first !== null
    }
    function sectionContainer(dialog) {
      const options = dialog.querySelector('.options') ?? dialog.querySelector('[class*="options"]')
      if (!options) return undefined
      return options.firstElementChild ?? options
    }
    function makeRow() {
      const row = document.createElement('div')
      row.id = ROW_ID
      Object.assign(row.style, {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '12px', padding: '14px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08))',
        fontFamily: 'inherit',
      })
      const label = document.createElement('div')
      label.textContent = '更换背景'
      Object.assign(label.style, {
        fontSize: '14px', lineHeight: '22px', color: 'var(--dsw-alias-label-primary, #e8eaf2)',
      })
      const actions = document.createElement('div')
      actions.style.cssText = 'display:flex;gap:8px'
      const change = document.createElement('button')
      change.type = 'button'
      change.textContent = '选择图片…'
      change.addEventListener('click', () => { void window.dshDesktop.changeBackground() })
      const clear = document.createElement('button')
      clear.type = 'button'
      clear.textContent = '清除背景'
      clear.addEventListener('click', () => { void window.dshDesktop.clearBackground() })
      for (const btn of [change, clear]) {
        Object.assign(btn.style, {
          padding: '6px 14px', borderRadius: '10px', cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
          background: 'transparent', color: 'var(--dsw-alias-label-primary, #e8eaf2)',
          fontSize: '13px', fontFamily: 'inherit',
        })
        btn.addEventListener('mouseenter', () => {
          btn.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08))'
        })
        btn.addEventListener('mouseleave', () => {
          btn.style.background = 'transparent'
        })
      }
      actions.appendChild(change)
      actions.appendChild(clear)
      row.appendChild(label)
      row.appendChild(actions)
      return row
    }
    function apply() {
      const dialog = document.querySelector('[role="dialog"]')
      if (!dialog || !isGeneralActive(dialog)) return
      const container = sectionContainer(dialog)
      if (!container || container.querySelector('#' + ROW_ID)) return
      container.prepend(makeRow())
    }
    const observer = new MutationObserver(apply)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-current'] })
    window.__dshWallpaperObserver = observer
    apply()
  })()`
  mainWindow.webContents.executeJavaScript(script).catch(() => {})
}

function injectBalanceButton() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  const script = `(() => {
    if (document.getElementById('dsh-balance-btn')) return
    if (!window.dshDesktop) return
    const btn = document.createElement('button')
    btn.id = 'dsh-balance-btn'
    btn.type = 'button'
    btn.innerHTML = '<span style="font-size:14px;line-height:1">💳</span><span id="dsh-balance-label">余额</span>'
    btn.title = '点击查看各模型 API 余额'
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
    const panel = document.createElement('div')
    panel.id = 'dsh-balance-panel'
    Object.assign(panel.style, {
      position: 'fixed', left: '16px', bottom: '128px', zIndex: '2147483000',
      minWidth: '240px', display: 'none', flexDirection: 'column', gap: '6px',
      padding: '12px 14px', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.14)',
      background: 'rgba(18,22,36,0.92)', color: '#e8eaf2',
      fontSize: '13px', fontFamily: 'inherit', boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
      backdropFilter: 'blur(14px)',
    })
    const title = document.createElement('div')
    title.textContent = '模型 API 余额'
    Object.assign(title.style, {
      fontSize: '12px', fontWeight: '600', color: '#9aa3bf',
      marginBottom: '2px', letterSpacing: '.3px',
    })
    panel.appendChild(title)
    const list = document.createElement('div')
    list.id = 'dsh-balance-list'
    Object.assign(list.style, { display: 'flex', flexDirection: 'column', gap: '8px' })
    panel.appendChild(list)
    const footer = document.createElement('div')
    footer.id = 'dsh-balance-updated'
    Object.assign(footer.style, { fontSize: '11px', color: '#7c869f', marginTop: '2px' })
    panel.appendChild(footer)
    document.body.appendChild(panel)
    let open = false
    function toggle() {
      open = !open
      panel.style.display = open ? 'flex' : 'none'
      if (open) void refresh()
    }
    function rowHtml(provider) {
      const name = document.createElement('div')
      name.textContent = provider.label
      name.style.cssText = 'min-width:84px;color:#c7cede'
      const value = document.createElement('div')
      value.textContent = provider.balance + ' ' + provider.currency
      if (provider.note) {
        value.title = provider.note
      }
      value.style.cssText = 'text-align:right;font-weight:600;flex:1;color:#7c93ff'
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px'
      row.appendChild(name)
      row.appendChild(value)
      return row
    }
    async function refresh() {
      list.textContent = '查询中…'
      const result = await window.dshDesktop.getBalance()
      if (!Array.isArray(result)) {
        list.textContent = '查询失败'
        return
      }
      list.textContent = ''
      const visible = result.filter((provider) => provider.ok)
      if (visible.length === 0) {
        const empty = document.createElement('div')
        empty.textContent = '暂无可用余额信息'
        empty.style.color = '#7c869f'
        list.appendChild(empty)
      }
      for (const provider of visible) list.appendChild(rowHtml(provider))
      footer.textContent = '更新于 ' + new Date().toLocaleTimeString()
    }
    btn.addEventListener('click', toggle)
    document.body.appendChild(btn)
    setInterval(() => { if (open) void refresh() }, ${BALANCE_REFRESH_MS})
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
    injectSettingsWallpaperEntry()
    injectBalanceButton()
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
  ipcMain.handle('desktop:get-balance', () => fetchApiBalance())
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
