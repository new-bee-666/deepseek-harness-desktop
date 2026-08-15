#!/usr/bin/env node
/**
 * Verify a packaged desktop client: launch the win-unpacked executable, wait
 * for the bundled harness to answer on 3080, confirm the app process stays
 * alive, then tear the process tree down and print the harness log tail.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'dist-exe', 'desktop', 'win-unpacked', 'DeepSeek Harness.exe')
const VERIFY_HOME = join(ROOT, 'dist-exe', 'verify-home')
const SERVER_URL = 'http://127.0.0.1:3080/'
const WAIT_MS = 120_000

if (!existsSync(EXE)) {
  console.error(`missing packaged executable: ${EXE}`)
  process.exit(1)
}

mkdirSync(VERIFY_HOME, { recursive: true })
const child = spawn(EXE, [], {
  detached: false,
  env: { ...process.env, DSH_HOME: VERIFY_HOME },
  stdio: 'ignore',
})
console.log(`launched pid=${child.pid}`)

const deadline = Date.now() + WAIT_MS
let ok = false
let pageBytes = 0
while (Date.now() < deadline) {
  if (child.exitCode !== null) {
    console.log(`app exited early code=${child.exitCode}`)
    break
  }
  try {
    const response = await fetch(SERVER_URL)
    if (response.ok) {
      ok = true
      pageBytes = (await response.text()).length
      break
    }
  } catch {
    // Not up yet.
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2000))
}

console.log(`server_ok=${ok}`)
if (ok) console.log(`page_bytes=${pageBytes}`)
console.log(`app_alive=${child.exitCode === null}`)

const tasklist = spawnSync('tasklist.exe', ['/v', '/fo', 'csv', '/fi', 'IMAGENAME eq DeepSeek Harness.exe'], { encoding: 'utf8' })
const hasTitledWindow = tasklist.stdout.split(/\r?\n/).some(line => line.includes('DeepSeek Harness') && !line.includes('N/A'))
console.log(`main_window_shown=${hasTitledWindow}`)

const log = join(process.env.APPDATA ?? '', 'DeepSeek Harness', 'harness.log')
console.log(`log=${log} exists=${existsSync(log)}`)
if (existsSync(log)) {
  console.log('--- harness log tail ---')
  console.log(readFileSync(log, 'utf8').split('\n').slice(-20).join('\n'))
}

if (child.exitCode === null) {
  const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'])
  console.log(`taskkill status=${result.status}`)
}
