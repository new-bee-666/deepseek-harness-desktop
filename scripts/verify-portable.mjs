#!/usr/bin/env node
/** End-to-end portable verification: launch, measure boot, check server,
 *  inner-app window, and the wallpaper bridge/button. */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORTABLE = join(ROOT, 'dist-exe', 'desktop', 'DeepSeek Harness 0.3.0.exe')
const DEBUG_PORT = 9224

if (!existsSync(PORTABLE)) {
  console.error(`missing portable exe: ${PORTABLE}`)
  process.exit(1)
}

for (const name of ['DeepSeek Harness 0.3.0', 'DeepSeek Harness']) {
  spawnSync('taskkill.exe', ['/IM', `${name}.exe`, '/T', '/F'], { stdio: 'ignore' })
}

const started = Date.now()
const child = spawn(PORTABLE, [`--remote-debugging-port=${DEBUG_PORT}`], { stdio: 'ignore' })
console.log(`launched portable pid=${child.pid}`)

let serverOk = false
const deadline = Date.now() + 120_000
while (Date.now() < deadline && child.exitCode === null) {
  try {
    serverOk = (await fetch('http://127.0.0.1:3080/')).ok
    if (serverOk) break
  } catch {
    // Extracting / booting.
  }
  await new Promise(r => setTimeout(r, 1000))
}
console.log(`server_ok=${serverOk} boot_seconds=${((Date.now() - started) / 1000).toFixed(1)}`)

const list = spawnSync('tasklist.exe', ['/fo', 'csv'], { encoding: 'utf8' }).stdout
  .split(/\r?\n/).filter(l => /DeepSeek|node/i.test(l))
console.log('--- processes ---')
console.log(list.join('\n') || '(none)')

const titled = spawnSync('tasklist.exe', ['/v', '/fo', 'csv', '/fi', 'IMAGENAME eq DeepSeek Harness.exe'], { encoding: 'utf8' }).stdout
  .split(/\r?\n/).some(l => l.includes('DeepSeek Harness') && !l.includes('N/A'))
console.log(`main_window_shown=${titled}`)

// Wallpaper bridge + button through the debug port.
let wallpaper = '(no result)'
try {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:3080'))
  if (page) {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    wallpaper = await new Promise((resolvePromise) => {
      const timer = setTimeout(() => { ws.close(); resolvePromise('(timeout)') }, 8000)
      ws.onopen = () => ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: 'JSON.stringify({ bridge: typeof window.dshDesktop, button: !!document.getElementById("dsh-wallpaper-btn") })',
          returnByValue: true,
        },
      }))
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.id === 1) {
          clearTimeout(timer)
          resolvePromise(msg.result?.result?.value ?? '(no value)')
          ws.close()
        }
      }
      ws.onerror = () => { clearTimeout(timer); resolvePromise('(ws error)') }
    })
  }
} catch (error) {
  wallpaper = `(cdp failed: ${error.message})`
}
console.log(`wallpaper_feature=${wallpaper}`)

spawnSync('taskkill.exe', ['/IM', 'DeepSeek Harness 0.3.0.exe', '/T', '/F'], { stdio: 'ignore' })
spawnSync('taskkill.exe', ['/IM', 'DeepSeek Harness.exe', '/T', '/F'], { stdio: 'ignore' })
