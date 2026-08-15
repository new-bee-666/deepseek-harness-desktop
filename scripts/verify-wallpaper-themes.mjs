#!/usr/bin/env node
/** Preset a wallpaper, launch, and verify the theme tokens resolve to light
 *  translucent surfaces in light mode and dark translucent in dark mode. */

import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'dist-exe', 'desktop', 'win-unpacked', 'DeepSeek Harness.exe')
const DEBUG_PORT = 9228
const TEST_IMAGE = join(ROOT, 'apps', 'desktop', 'build', 'icon.png')
const userData = join(process.env.APPDATA, 'DeepSeek Harness')

for (const name of ['DeepSeek Harness', 'DeepSeek Harness 0.1.0-rc.5']) {
  spawnSync('taskkill.exe', ['/IM', `${name}.exe`, '/T', '/F'], { stdio: 'ignore' })
}

writeFileSync(join(userData, 'wallpaper.json'), JSON.stringify({ path: TEST_IMAGE }))
const child = spawn(EXE, [`--remote-debugging-port=${DEBUG_PORT}`], { stdio: 'ignore' })

async function pageTarget() {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
      const page = targets.find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:3080'))
      if (page) return page
    } catch {}
    await new Promise(r => setTimeout(r, 1000))
  }
}

const page = await pageTarget()
if (!page) {
  console.log('no page target')
  rmSync(join(userData, 'wallpaper.json'), { force: true })
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  process.exit(1)
}
await new Promise(r => setTimeout(r, 6000))

const ws = new WebSocket(page.webSocketDebuggerUrl)
const expression = `(() => {
  const read = () => {
    const cs = getComputedStyle(document.body)
    return {
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      bubble: cs.getPropertyValue('--dsw-specific-bubble').trim(),
      input: cs.getPropertyValue('--dsw-specific-input-major').trim(),
      sidebar: cs.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
    }
  }
  const light = read()
  document.body.setAttribute('data-ds-dark-theme', '')
  const dark = read()
  document.body.removeAttribute('data-ds-dark-theme')
  return JSON.stringify({ light, dark })
})()`

let result = '(no result)'
await new Promise((resolvePromise) => {
  const timer = setTimeout(() => { ws.close(); resolvePromise() }, 15_000)
  ws.onopen = () => ws.send(JSON.stringify({
    id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true },
  }))
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id === 1) {
      clearTimeout(timer)
      result = msg.result?.result?.value ?? JSON.stringify(msg.result?.exceptionDetails ?? '(no value)')
      ws.close()
      resolvePromise()
    }
  }
  ws.onerror = () => { clearTimeout(timer); resolvePromise() }
})

console.log(result)
rmSync(join(userData, 'wallpaper.json'), { force: true })
spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
