#!/usr/bin/env node
/**
 * Publish the desktop client to GitCode in one command:
 *   1. (optional) push the current `master` branch to the GitCode remote.
 *   2. Replace the two exe assets on the v0.3.0 release.
 *
 * Token resolution order: $GITCODE_TOKEN -> Windows/macOS credential manager
 * (via `git credential fill` for host=gitcode.com) -> error. The token is
 * never written into this script or the repository.
 *
 * Usage:
 *   node scripts/publish-gitcode-release.mjs            # assets only
 *   node scripts/publish-gitcode-release.mjs --push     # push code, then assets
 *   GITCODE_TOKEN=xxx node scripts/publish-gitcode-release.mjs --push
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({
  options: {
    push: { type: 'boolean', default: false },
    remote: { type: 'string', default: 'gitcode' },
    owner: { type: 'string', default: 'dongdong_200ok' },
    repo: { type: 'string', default: 'deepseek-harness-desktop' },
    tag: { type: 'string', default: 'v0.3.0' },
    'exe-dir': { type: 'string', default: join(ROOT, 'dist-exe', 'desktop') },
  },
})

const ASSETS = [
  'DeepSeek Harness 0.3.0.exe',
  'DeepSeek Harness Setup 0.3.0.exe',
]

function getToken() {
  if (process.env.GITCODE_TOKEN) {
    return process.env.GITCODE_TOKEN.trim()
  }
  const result = spawnSync(
    'git',
    ['credential', 'fill'],
    { input: 'protocol=https\nhost=gitcode.com\n\n', encoding: 'utf8' },
  )
  if (result.status !== 0) return undefined
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith('password=')) {
      const token = line.slice('password='.length).trim()
      if (token.length > 0) return token
    }
  }
  return undefined
}

function apiUrl(path) {
  return `https://api.gitcode.com/api/v5${path}`
}

async function getUploadUrl(token, fileName) {
  const url = apiUrl(
    `/repos/${values.owner}/${values.repo}/releases/${values.tag}/upload_url`
    + `?access_token=${encodeURIComponent(token)}`
    + `&file_name=${encodeURIComponent(fileName)}`,
  )
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`get upload_url failed (HTTP ${response.status}): ${await response.text()}`)
  }
  return response.json()
}

async function listAttachments(token) {
  const url = apiUrl(
    `/repos/${values.owner}/${values.repo}/releases/${values.tag}/attach_files`
    + `?access_token=${encodeURIComponent(token)}`,
  )
  const response = await fetch(url)
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw new Error(`list attachments failed (HTTP ${response.status}): ${await response.text()}`)
  }
  return response.json()
}

async function ensureRelease(token) {
  const url = apiUrl(`/repos/${values.owner}/${values.repo}/releases`)
    + `?access_token=${encodeURIComponent(token)}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: values.tag,
      name: `DeepSeek Harness Desktop ${values.tag}`,
      body: `DeepSeek Harness 桌面客户端 ${values.tag}\n\n- 便携版：直接解压运行\n- 安装版：安装到系统`,
      target_commitish: 'master',
      prerelease: false,
    }),
  })
  if (!response.ok && response.status !== 201) {
    throw new Error(`create release failed (HTTP ${response.status}): ${await response.text()}`)
  }
}

async function deleteAttachment(token, id) {
  const url = apiUrl(
    `/repos/${values.owner}/${values.repo}/releases/${values.tag}/attach_files/${id}`
    + `?access_token=${encodeURIComponent(token)}`,
  )
  const response = await fetch(url, { method: 'DELETE' })
  if (!response.ok && response.status !== 204) {
    throw new Error(`delete attachment ${id} failed (HTTP ${response.status}): ${await response.text()}`)
  }
}

async function uploadAsset(token, fileName) {
  const file = join(values['exe-dir'], fileName)
  if (!existsSync(file)) {
    throw new Error(`asset not found: ${file}`)
  }
  const { url, headers } = await getUploadUrl(token, fileName)
  const data = await readFileAsBuffer(file)
  console.log(`uploading ${fileName} (${(data.length / 1024 / 1024).toFixed(1)} MB)...`)
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'x-obs-meta-project-id': headers['x-obs-meta-project-id'],
      'x-obs-acl': headers['x-obs-acl'],
      'x-obs-callback': headers['x-obs-callback'],
      'content-type': headers['Content-Type'] ?? 'application/octet-stream',
    },
    body: data,
  })
  if (!response.ok && response.status !== 203) {
    throw new Error(`upload failed (HTTP ${response.status}): ${await response.text()}`)
  }
  console.log(`  done (HTTP ${response.status})`)
}

async function readFileAsBuffer(file) {
  const { readFile } = await import('node:fs/promises')
  return readFile(file)
}

function pushCode() {
  const result = spawnSync(
    'git',
    ['push', values.remote, 'master', '--no-verify'],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  )
  if (result.status !== 0) {
    throw new Error(`git push failed with exit code ${result.status}`)
  }
  console.log('git push: ok')
}

async function main() {
  const token = getToken()
  if (!token) {
    throw new Error(
      'no GitCode token: set $GITCODE_TOKEN or store one with '
      + '`git credential approve` for host=gitcode.com',
    )
  }
  if (values.push) pushCode()
  let attachments = await listAttachments(token)
  if (attachments === undefined) {
    console.log(`release ${values.tag} not found, creating it...`)
    await ensureRelease(token)
    attachments = await listAttachments(token) ?? []
  }
  const byName = new Map((attachments ?? []).map((item) => [item.name, item.id]))
  for (const fileName of ASSETS) {
    const existingId = byName.get(fileName)
    if (existingId != null) {
      console.log(`removing stale asset ${fileName} (id=${existingId})...`)
      await deleteAttachment(token, existingId)
    }
    await uploadAsset(token, fileName)
  }
  console.log(
    `published to https://gitcode.com/${values.owner}/${values.repo}/releases/tag/${values.tag}`,
  )
}

main().catch((error) => {
  console.error(`publish-gitcode-release: ${error?.message ?? error}`)
  process.exit(1)
})
