#!/usr/bin/env node
/** Verify the wallpaper fix: preset an image, launch, and confirm the page
 *  loads it through the custom scheme and the button sits bottom-left. */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'dist-exe', 'desktop', 'win-unpacked', 'DeepSeek Harness.exe')
const DEBUG_PORT = 9226
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
const expression = `(async () => {
  const style = getComputedStyle(document.body).backgroundImage
  let fetchOk = false
  try { fetchOk = (await fetch('dsh-wallpaper://local/wallpaper')).ok } catch (e) { fetchOk = 'ERR ' + e.message }
  const btn = document.getElementById('dsh-wallpaper-btn')
  const btnStyle = btn ? getComputedStyle(btn) : null
  return JSON.stringify({ style, fetchOk, button: !!btn, left: btnStyle?.left, bottom: btnStyle?.bottom, text: btn?.innerText })
})()`

let result = '(no result)'
await new Promise((resolvePromise) => {
  const timer = setTimeout(() => { ws.close(); resolvePromise() }, 15_000)
  ws.onopen = () => ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true },
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
