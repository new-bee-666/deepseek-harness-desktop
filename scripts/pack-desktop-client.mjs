#!/usr/bin/env node
/**
 * Stage and package the Windows desktop client for DeepSeek Harness.
 *
 * Pipeline: deploy the `dsh-desktop-client-deploy` closure with pnpm's legacy
 * hoister, restore the peer/override packages legacy deploy omits (the same
 * problem the Python single-exe pipeline solves with
 * `restoreLegacyHoists`), materialize every remaining link so the payload is
 * portable, bundle a Windows Node runtime next to the closure, then hand the
 * app directory to electron-builder for the NSIS installer and the portable
 * executable. Products land in `dist-exe/`.
 *
 * Windows only: the bundled Node carrier and the NSIS/portable targets are
 * Windows artifacts.
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { parseArgs } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEPLOY_ROOT_PACKAGE = 'dsh-desktop-client-deploy'
const DEPLOY_SOURCE_NODE_MODULES = join(ROOT, 'apps', 'desktop', 'deploy', 'node_modules')
const STAGING = join(ROOT, 'dist-exe', 'staging', 'harness')
const NODE_CACHE_DIR = join(ROOT, 'dist-exe', 'node-cache')

/** Bundled Node major; native addons in the closure are built for this ABI. */
const NODE_VERSION = 'v24.17.0'
const NODE_ZIP = `node-v${NODE_VERSION.slice(1)}-win-x64.zip`
const NODE_MIRRORS = [
  `https://npmmirror.com/mirrors/node/${NODE_VERSION}/${NODE_ZIP}`,
  `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP}`,
]

const { values } = parseArgs({
  options: {
    'skip-build': { type: 'boolean', default: false },
    'skip-pack': { type: 'boolean', default: false },
    smoke: { type: 'boolean', default: false },
  },
})

function run(command, args, options = {}) {
  const shell = process.platform === 'win32' && command.endsWith('.cmd')
  const result = spawnSync(command, args, { stdio: 'inherit', shell, ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`)
  }
}

function pnpmBin() {
  const local = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  return existsSync(local) ? local : process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function ensureInsideRepo(target) {
  const resolved = resolve(target)
  if (!resolved.startsWith(ROOT + sep)) {
    throw new Error(`refusing to touch ${resolved}: outside ${ROOT}`)
  }
  return resolved
}

function ensureBuiltArtifacts() {
  const required = [
    join(ROOT, 'apps', 'cli', 'lib', 'bin.js'),
    join(ROOT, 'apps', 'web', 'dist', 'index.html'),
  ]
  const missing = required.filter(path => !existsSync(path))
  if (missing.length > 0) {
    if (values['skip-build']) {
      throw new Error(`pack-desktop-client: missing built artifacts: ${missing.join(', ')}`)
    }
    console.log('pack-desktop-client: building repository artifacts...')
    run(pnpmBin(), ['run', 'build'], { cwd: ROOT })
  }
}

function clearStaging() {
  const target = ensureInsideRepo(STAGING)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
}

function deployClosure() {
  run(pnpmBin(), [
    '--filter',
    DEPLOY_ROOT_PACKAGE,
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    STAGING,
  ], { cwd: ROOT })
}

/**
 * Restore direct dependencies that pnpm's legacy hoister places beside the
 * deploy source instead of in the target. Mirrors the Python single-exe
 * pipeline's `restoreLegacyHoists`.
 */
function restoreLegacyHoists() {
  const manifest = JSON.parse(readFileSync(join(STAGING, 'package.json'), 'utf8')) ?? {}
  const restored = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(STAGING, 'node_modules', ...dependency.split('/'))
    if (existsSync(join(destination, 'package.json'))) continue
    const source = join(DEPLOY_SOURCE_NODE_MODULES, ...dependency.split('/'))
    if (!existsSync(join(source, 'package.json'))) {
      throw new Error(
        `pack-desktop-client: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`,
      )
    }
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true, dereference: true })
    restored.push(dependency)
  }
  if (restored.length > 0) {
    console.log(`pack-desktop-client: restored legacy deploy hoists: ${restored.join(', ')}`)
  }
}

/** Replace every link below a directory with a real copy; drop `.bin` shims. */
function materializeLinks(directory) {
  let links = 0
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.name === '.bin' && entry.isDirectory()) {
        rmSync(path, { recursive: true, force: true })
        continue
      }
      const metadata = lstatSync(path)
      if (metadata.isSymbolicLink()) {
        const source = realpathSync(path)
        rmSync(path, { recursive: true, force: true })
        cpSync(source, path, { recursive: true, dereference: true })
        links += 1
        visit(path)
      } else if (metadata.isDirectory()) {
        visit(path)
      }
    }
  }
  visit(directory)
  if (links > 0) console.log(`pack-desktop-client: materialized ${links} links`)
}

/** Drop runtime-irrelevant files and non-Windows native packages from the closure. */
function pruneClosure(directory) {
  const removed = { files: 0, dirs: 0 }
  const BLOAT_EXT = new Set(['.map', '.ts', '.mts', '.cts', '.md', '.mdx', '.d.ts'])
  const BLOAT_NAME = /^(readme|license|licence|changelog|authors|contributing)(\..*)?$/i
  const NON_WIN32 = /darwin|linux|linuxmusl|freebsd|openbsd|wasm32|riscv64|s390x|ppc64|loong64|arm64|ia32|musl/i

  const isNonWindowsPlatformDir = (path) => {
    const norm = path.replaceAll('\\', '/')
    // Scoped native-carrier families: strip per-platform packages but keep the
    // plain JS wrapper and the win32-x64 carrier.
    const scoped = norm.match(/\/node_modules\/(@img|@vscode|@koromix)\/([^/]+)$/)
    if (scoped !== null) {
      const family = scoped[1]
      const name = scoped[2]
      const prefix = { '@img': 'sharp', '@vscode': 'ripgrep', '@koromix': 'koffi' }[family]
      if (prefix === undefined || !name.startsWith(prefix)) return false
      if (name === `${prefix}-win32-x64` || name === `${prefix}-libvips-win32-x64`) return false
      return NON_WIN32.test(name)
    }
    if (/\/node-pty\/prebuilds\/[^/]+$/.test(norm) && norm.split('/').pop() !== 'win32-x64') return true
    if (/\/node_modules\/@deepseek-ai\/node-addon-landlock-run-[^/]+$/.test(norm)) return true
    if (/\/node_modules\/node-addon-require-builtin-[^/]+$/.test(norm) && !norm.includes('win32-x64')) return true
    return false
  }

  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (isNonWindowsPlatformDir(path)) {
          rmSync(path, { recursive: true, force: true }); removed.dirs += 1; continue
        }
        visit(path)
      } else {
        const ext = entry.name.slice(entry.name.lastIndexOf('.'))
        if (BLOAT_EXT.has(ext) || BLOAT_NAME.test(entry.name)) {
          rmSync(path, { force: true })
          removed.files += 1
        }
      }
    }
  }
  visit(directory)
  console.log(`pack-desktop-client: pruned ${removed.files} files and ${removed.dirs} platform dirs`)
}

async function downloadNode() {
  const nodeExe = join(STAGING, 'node.exe')
  if (existsSync(nodeExe)) return
  mkdirSync(NODE_CACHE_DIR, { recursive: true })
  const zip = join(NODE_CACHE_DIR, NODE_ZIP)
  if (!existsSync(zip) || statSync(zip).size < 20_000_000) {
    let downloaded = false
    for (const url of NODE_MIRRORS) {
      try {
        console.log(`pack-desktop-client: downloading ${url}`)
        const response = await fetch(url)
        if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
        await pipeline(Readable.fromWeb(response.body), (await import('node:fs')).createWriteStream(zip))
        downloaded = true
        break
      } catch (error) {
        console.warn(`pack-desktop-client: download failed from ${url}: ${error.message}`)
      }
    }
    if (!downloaded) throw new Error(`pack-desktop-client: could not download ${NODE_ZIP}`)
  }
  const extractDir = join(NODE_CACHE_DIR, 'extract')
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${extractDir}' -Force`])
  const extractedNode = join(extractDir, `node-v${NODE_VERSION.slice(1)}-win-x64`, 'node.exe')
  if (!existsSync(extractedNode)) throw new Error(`pack-desktop-client: node.exe not found in ${extractDir}`)
  cpSync(extractedNode, nodeExe)
  rmSync(extractDir, { recursive: true, force: true })
  console.log(`pack-desktop-client: bundled ${nodeExe}`)
}

function verifyStagedNode() {
  const result = spawnSync(join(STAGING, 'node.exe'), ['--version'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('pack-desktop-client: bundled node.exe does not run')
  console.log(`pack-desktop-client: bundled node ${result.stdout.trim()}`)
}

/**
 * Pack the harness closure into one tar archive: the NSIS portable wrapper
 * extracts tens of thousands of small files per launch, which dominates its
 * startup time. Shipping one archive moves that per-file cost to a single fast
 * `tar -xf` on first run (the desktop shell extracts it into a stable cache).
 */
function createHarnessArchive() {
  const archive = join(ROOT, 'dist-exe', 'staging', 'harness.tar')
  rmSync(archive, { force: true })
  const result = spawnSync('tar.exe', ['-cf', archive, '-C', STAGING, '.'], { stdio: 'ignore' })
  if (result.status !== 0 || !existsSync(archive)) {
    throw new Error(`pack-desktop-client: failed to create ${archive} (status ${result.status})`)
  }
  console.log(`pack-desktop-client: created ${archive}`)
}

/** Boot the staged harness and require the web profile to answer on 3080. */
async function smokeTest() {
  const nodeExe = join(STAGING, 'node.exe')
  const entry = join(STAGING, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const home = join(ROOT, 'dist-exe', 'staging', 'dsh-home')
  mkdirSync(home, { recursive: true })
  const child = spawn(nodeExe, [entry, 'web'], {
    cwd: STAGING,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let log = ''
  child.stdout.on('data', chunk => { log += chunk })
  child.stderr.on('data', chunk => { log += chunk })
  const deadline = Date.now() + 90_000
  let ok = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break
    try {
      const response = await fetch('http://127.0.0.1:3080/')
      if (response.ok) {
        ok = true
        break
      }
    } catch {
      // Not up yet.
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (child.exitCode === null) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'])
  }
  if (!ok) {
    throw new Error(`pack-desktop-client: smoke test failed.\n${log.slice(-4000)}`)
  }
  console.log('pack-desktop-client: smoke test passed (http://127.0.0.1:3080 answered)')
}

async function packElectron() {
  const env = {
    ...process.env,
    // electron-builder prunes app devDependencies with `pnpm install
    // --production`; without a TTY pnpm asks before removing the modules
    // directory, so mark the run as CI to keep the purge non-interactive.
    CI: 'true',
    ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  }
  // Invoke electron-builder's CLI directly through Node instead of `pnpm
  // exec`: inside this pnpm workspace a package-manager invocation replays the
  // last install mode from node_modules/.modules.yaml, which would prune the
  // whole workspace's devDependencies. The desktop app has no production
  // dependencies, so `npmRebuild: false` also stops electron-builder's own
  // dependency step entirely.
  const pnpmDir = readdirSync(join(ROOT, 'node_modules', '.pnpm'))
    .find(name => name.startsWith('electron-builder@'))
  if (pnpmDir === undefined) {
    throw new Error('pack-desktop-client: electron-builder is not installed')
  }
  const cli = join(ROOT, 'node_modules', '.pnpm', pnpmDir, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      cli,
      '--win',
      'nsis',
      'portable',
      '--config.npmRebuild=false',
    ], {
      cwd: join(ROOT, 'apps', 'desktop'),
      env,
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`electron-builder exited with code ${code}`))
    })
  })
}

async function main() {
  ensureBuiltArtifacts()
  clearStaging()
  deployClosure()
  restoreLegacyHoists()
  materializeLinks(join(STAGING, 'node_modules'))
  pruneClosure(join(STAGING, 'node_modules'))
  await downloadNode()
  verifyStagedNode()
  createHarnessArchive()
  if (values.smoke) await smokeTest()
  if (!values['skip-pack']) await packElectron()
  console.log('pack-desktop-client: done')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
