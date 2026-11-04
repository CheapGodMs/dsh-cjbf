/**
 * Host half of `dsh-cjbf`.
 *
 * Backs the Plugins-page tab and the `plugin_backup` agent tool with one HTTP
 * surface under `/dsh-cjbf/api` (the same fenced-route pattern other
 * profile bundles use): the browser half cannot reach the file system or the
 * directory-picker service directly.
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Package name; also the module-loader id of the browser half. */
const NAME = 'dsh-cjbf'
/** Backup format marker written into every manifest. */
const FORMAT = 'dsh-plugin-backup'
/** Host-half code revision, surfaced on the page so a stale load is visible. */
const CODE_REVISION = '2026-11-04-1725'
const SCHEMA_VERSION = 1
/** Route the browser half posts to. */
const API_PREFIX = '/dsh-cjbf/api'
/** Profile files copied into a backup; `cordis.yml` is kept for reference only. */
const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'cordis.yml']
/** Profile files written back on restore: the composed root is machine-specific. */
const RESTORE_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']
/** `node_modules` entries never worth copying. */
const SKIP_NODE_ENTRIES = new Set(['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json'])
/** Top-level package skipped while restoring: it is the half doing the restore. */
const SELF_PACKAGE = NAME
/** This plugin's own package directory, so a backup can carry it. */
const SELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
/** Package files copied into `<backup>/tool/` for a machine that lacks the plugin. */
const SELF_FILES = ['package.json', 'cordis.patch.yml', 'index.js', 'client.js', 'icon.svg', 'locale']

export const name = NAME
/** `webServer` is mandatory; `tools` and `directoryPicker` are read with `ctx.get`. */
export const inject = ['webServer']

/** Resolve the DSH home directory. */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/** Resolve this profile's directory. */
function profileDir() {
  return process.env.DSH_PROFILE_DIR ?? path.join(dshHome(), 'profiles', process.env.DSH_PROFILE ?? 'desktop')
}

/** Read one JSON file, or `undefined` when absent or malformed. */
async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Read the profile manifest. */
async function readProfile() {
  return (await readJson(path.join(profileDir(), 'package.json')) ?? {})
}

/** Declared dependencies of a manifest. */
function dependenciesOf(manifest) {
  return manifest?.dependencies ?? {}
}

/** Selected bundle layers of a manifest. */
function bundlesOf(manifest) {
  return manifest?.dsh?.profile?.bundles ?? []
}

/** Format bytes for user-facing text. */
function humanBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = value / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1 }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`
}

/** Timestamp for directory names: YYYYMMDD-HHMMSS. */
function stamp(date = new Date()) {
  const p = (v) => String(v).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** Whether a path exists as a directory. */
async function isDir(target) {
  try {
    return (await fsp.stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** List one directory; unreadable entries are skipped. */
async function readDirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Sum file count and bytes of a tree, ignoring skipped node_modules entries. */
async function measureTree(root, options = {}) {
  const counter = { files: 0, bytes: 0 }
  const walk = async (dir, top) => {
    for (const entry of await readDirSafe(dir)) {
      if (entry.name.startsWith('.') && top && entry.name !== '.dsh') continue
      if (top && SKIP_NODE_ENTRIES.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, false)
      else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(full)
          counter.files += 1
          counter.bytes += stat.size
        } catch { /* vanished mid-walk */ }
      }
    }
  }
  await walk(root, true)
  return counter
}

/** Package directories of declared dependencies, with their versions. */
async function describePackages(manifest) {
  const deps = dependenciesOf(manifest)
  const rows = []
  for (const dep of Object.keys(deps)) {
    const dir = path.join(profileDir(), 'node_modules', ...dep.split('/'))
    const pkg = await readJson(path.join(dir, 'package.json'))
    if (pkg === undefined) continue
    rows.push({ name: dep, version: String(pkg.version ?? ''), declared: String(deps[dep]) })
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

/**
 * Copy one tree with progress accounting. Symlinks are copied as links and
 * never followed, so no destination file can escape the backup folder.
 */
async function copyTree(source, target, options, progress) {
  await fsp.mkdir(target, { recursive: true })
  const entries = await readDirSafe(source)
  const top = options.top === true
  for (const entry of entries) {
    if (top && SKIP_NODE_ENTRIES.has(entry.name)) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) {
      await copyTree(from, to, { top: false }, progress)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    try {
      const stat = await fsp.lstat(from)
      if (entry.isSymbolicLink()) {
        const link = await fsp.readlink(from)
        await fsp.symlink(link, to).catch(() => {})
        continue
      }
      await fsp.copyFile(from, to)
      progress.copiedBytes += stat.size
      progress.copiedFiles += 1
      if (progress.onProgress !== undefined && progress.copiedFiles % 200 === 0) progress.onProgress()
    } catch (error) {
      progress.warnings.push(`${from}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Best-effort DSH desktop version, if the launcher exposed one. */
function dshVersion() {
  return process.env.DSH_DESKTOP_VERSION ?? process.env.DSH_VERSION ?? ''
}

/** Build a machine-readable manifest for a written backup. */
function buildManifest(details) {
  return {
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    producer: { name: NAME, version: '1.0.0' },
    profile: process.env.DSH_PROFILE ?? '',
    profileDir: profileDir(),
    dshVersion: dshVersion(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    host: os.hostname(),
    bundles: details.bundles,
    dependencies: details.dependencies,
    packages: details.packages,
    files: { count: details.files, bytes: details.bytes },
    includesNodeModules: true,
  }
}

/** Chinese instructions written beside the manifest. */
function readmeText(manifestPath) {
  return [
    'DSH 插件备份',
    '',
    '这个文件夹是「DSH 插件备份」插件的备份产物，换电脑后按下面步骤恢复：',
    '',
    '如果新电脑已经装了 DSH 插件备份：',
    '  1. 打开 DSH → 插件页面 → 「备份」标签；',
    '  2. 点「选择目录」，选中本文件夹；',
    '  3. 选中这一份备份，点「恢复这份备份」并确认；',
    '  4. 重启 DSH，老电脑上的插件就都回来了。',
    '',
    '如果新电脑还没装 DSH 插件备份：',
    '  1. 先装 DSH（版本最好与备份时一致）；',
    '  2. 用这份备份里的 tool 文件夹装一次本插件：在插件页面的安装入口选这个 tool 文件夹，',
    '     或者在命令行执行  dsh plugin --profile desktop add "<备份文件夹的完整路径>/tool"；',
    '  3. 再按上面的步骤恢复；',
    '  4. 重启 DSH。',
    '',
    '备份内容：',
    '  profile/      老电脑的 profile 配置文件（package.json、cordis.patch.yml、锁文件等）',
    '  packages/     插件本体和依赖（node_modules 的内容，已去掉 .bin / .pnpm 缓存）',
    '  tool/         本插件自己的副本，供新电脑先安装它',
    '  manifest.json 这份备份的清单（时间、插件列表、大小、平台）',
    '',
    '说明：',
    '  - 恢复会覆盖新电脑的插件配置；覆盖前会把新电脑原来的配置另存到 profile 目录的 .plugin-backup-restore-<时间>；',
    '  - 本插件自身的包不会被覆盖（正在运行的它要负责这次恢复）；',
    '  - 插件配置（cordis.patch.yml）一并恢复，因此各插件原来的设置也回来了；',
    '  - 若某插件原本是从本机某个文件夹装的、而新电脑没有那个文件夹，该插件会跳过恢复，结果里会写明；',
    '  - 如果恢复后 DSH 起不来，把 .plugin-backup-restore-<时间> 里的文件拷回 profile 目录即可还原。',
    '',
    `备份时间：${new Date().toLocaleString()}`,
    `manifest：${path.basename(manifestPath)}`,
  ].join('\n')
}

/** Copy the profile's own config files into the snapshot folder. */
async function snapshotProfileConfig(targetDir) {
  await fsp.mkdir(targetDir, { recursive: true })
  const written = []
  for (const file of PROFILE_FILES) {
    const from = path.join(profileDir(), file)
    try {
      await fsp.copyFile(from, path.join(targetDir, file))
      written.push(file)
    } catch { /* absent file */ }
  }
  return written
}

/** Locate backup manifests under one directory (the directory itself, or one level down). */
async function findBackups(dir) {
  const candidates = []
  const consider = async (full) => {
    const manifest = await readJson(path.join(full, 'manifest.json'))
    if (manifest === undefined || manifest.format !== FORMAT) return
    candidates.push({
      path: full,
      name: path.basename(full),
      createdAt: String(manifest.createdAt ?? ''),
      createdAtLocal: manifest.createdAt === undefined ? '' : new Date(manifest.createdAt).toLocaleString(),
      bundles: Array.isArray(manifest.bundles) ? manifest.bundles : [],
      packageCount: Array.isArray(manifest.packages) ? manifest.packages.length : 0,
      bytes: manifest.files?.bytes ?? 0,
      files: manifest.files?.count ?? 0,
      platform: String(manifest.platform ?? ''),
      dshVersion: String(manifest.dshVersion ?? ''),
      profile: String(manifest.profile ?? ''),
      schemaVersion: manifest.schemaVersion,
    })
  }
  if (await isDir(dir)) await consider(dir)
  const entries = await readDirSafe(dir)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    await consider(path.join(dir, entry.name))
  }
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return candidates
}

/**
 * Drop dependencies whose spec names a path that does not exist here.
 *
 * A machine that installed plugins from a local folder records `link:` or
 * `file:` specs pointing at that folder; copying that spec to a new machine
 * yields a dependency pnpm can never resolve. Such a dependency is removed
 * and reported, so the restored profile still boots.
 */
async function pruneBrokenLocalDeps(manifest, profileRoot) {
  const deps = manifest.dependencies ?? {}
  const dropped = []
  for (const [name, spec] of Object.entries(deps)) {
    const text = String(spec)
    const local = /^(?:link|file):/.exec(text)
    if (local === null) continue
    const target = text.slice(local[0].length)
    const resolved = path.isAbsolute(target) ? target : path.join(profileRoot, target)
    try {
      await fsp.access(resolved)
    } catch {
      delete deps[name]
      dropped.push(name)
    }
  }
  return dropped
}

/** Copy this plugin's own package into the backup, so a new machine can install it. */
async function snapshotSelf(targetDir) {
  await fsp.mkdir(targetDir, { recursive: true })
  const written = []
  for (const file of SELF_FILES) {
    const from = path.join(SELF_DIR, file)
    const to = path.join(targetDir, file)
    try {
      const stat = await fsp.lstat(from)
      if (stat.isDirectory()) await fsp.cp(from, to, { recursive: true })
      else await fsp.copyFile(from, to)
      written.push(file)
    } catch { /* optional file */ }
  }
  return written
}

/** One shared job record: only one long operation runs at a time. */
function createJobs() {
  const state = {
    running: false,
    kind: '',
    phase: '',
    totalBytes: 0,
    copiedBytes: 0,
    totalFiles: 0,
    copiedFiles: 0,
    startedAt: 0,
    finishedAt: 0,
    result: null,
    error: null,
    warnings: [],
  }
  return {
    snapshot() {
      return {
        running: state.running,
        kind: state.kind,
        phase: state.phase,
        totalBytes: state.totalBytes,
        copiedBytes: state.copiedBytes,
        totalFiles: state.totalFiles,
        copiedFiles: state.copiedFiles,
        elapsedMs: state.startedAt === 0 ? 0 : (state.running ? Date.now() : state.finishedAt) - state.startedAt,
        result: state.result,
        error: state.error,
        warnings: state.warnings.slice(0, 50),
      }
    },
    start(kind, work) {
      if (state.running) throw new Error('已有备份或恢复任务在进行，请稍候')
      state.running = true
      state.kind = kind
      state.phase = 'scanning'
      state.totalBytes = 0
      state.copiedBytes = 0
      state.totalFiles = 0
      state.copiedFiles = 0
      state.startedAt = Date.now()
      state.finishedAt = 0
      state.result = null
      state.error = null
      state.warnings = []
      const progress = {
        copiedBytes: 0,
        copiedFiles: 0,
        warnings: state.warnings,
        onProgress: () => {
          state.copiedBytes = progress.copiedBytes
          state.copiedFiles = progress.copiedFiles
        },
      }
      void (async () => {
        try {
          state.phase = 'running'
          const result = await work(progress, state)
          state.result = result
          state.phase = 'done'
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error)
          state.phase = 'failed'
        } finally {
          state.running = false
          state.finishedAt = Date.now()
        }
      })()
      return this.snapshot()
    },
  }
}

/** Fence identical to the shared API gateway: loopback host or trusted authority. */
function parseAuthority(authority) {
  try { return new URL(`http://${authority}`) } catch { return undefined }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isTrustedRequest(req, trustedHosts) {
  const host = req.headers.host
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  const trusted = Array.isArray(trustedHosts) && trustedHosts.length > 0 && trustedHosts.some((entry) => {
    const candidate = parseAuthority(entry)
    if (candidate === undefined) return false
    return (candidate.port === '' ? candidate.hostname : candidate.host) === hostUrl.host
  })
  if (!isLoopbackHostname(hostUrl.hostname) && !trusted) return false
  if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

/** Read and parse a bounded JSON body. */
function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limitBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try { resolve(JSON.parse(text)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Perform a backup into `destRoot`, returning a user-facing result. */
async function runBackup(destRoot, progress, state) {
  const root = path.resolve(destRoot)
  try {
    await fsp.mkdir(root, { recursive: true })
  } catch (error) {
    throw new Error(`备份目录无法创建：${root}（${error instanceof Error ? error.message : String(error)}）`)
  }
  const profile = await readProfile()
  const packages = await describePackages(profile)
  const bundles = bundlesOf(profile)
  const stampText = stamp()

  const measure = await measureTree(path.join(profileDir(), 'node_modules'), { top: true })
  state.totalBytes = measure.bytes
  state.totalFiles = measure.files

  const target = path.join(root, `DSH插件备份-${stampText}`)
  await fsp.mkdir(target, { recursive: true })
  const profileOut = path.join(target, 'profile')
  const packagesOut = path.join(target, 'packages')
  await fsp.mkdir(profileOut, { recursive: true })

  const copiedProfile = await snapshotProfileConfig(profileOut)
  // The tool that restores this backup must exist on the new machine, so it
  // travels inside the backup: restoring by hand means installing `tool/` first.
  const copiedSelf = await snapshotSelf(path.join(target, 'tool'))
  await copyTree(path.join(profileDir(), 'node_modules'), packagesOut, { top: true }, progress)

  const manifest = buildManifest({
    bundles,
    dependencies: dependenciesOf(profile),
    packages,
    files: progress.copiedFiles,
    bytes: progress.copiedBytes,
  })
  const manifestPath = path.join(target, 'manifest.json')
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await fsp.writeFile(path.join(target, 'README.txt'), readmeText(manifestPath), 'utf8')
  await fsp.writeFile(path.join(target, '.dsh-plugin-backup'), '1\n', 'utf8').catch(() => {})

  return {
    action: 'backup',
    path: target,
    name: path.basename(target),
    bundles,
    packages: packages.map((row) => row.name),
    files: progress.copiedFiles,
    bytes: progress.copiedBytes,
    profileFiles: copiedProfile,
    toolFiles: copiedSelf,
    warnings: progress.warnings.slice(0, 20),
  }
}

/** Restore one backup folder over this profile. */
async function runRestore(sourceDir, progress, state) {
  const root = path.resolve(sourceDir)
  const manifest = await readJson(path.join(root, 'manifest.json'))
  if (manifest === undefined) throw new Error('这个文件夹里没有 manifest.json，不是本插件生成的备份')
  if (manifest.format !== FORMAT) throw new Error(`不认识的备份格式：${String(manifest.format)}`)
  if (Number(manifest.schemaVersion) > SCHEMA_VERSION) throw new Error('这份备份来自更新的插件版本，请先升级 dsh-cjbf')

  const profile = profileDir()
  const packagesSource = path.join(root, 'packages')
  if (!(await isDir(packagesSource))) throw new Error('备份里的 packages 文件夹不见了')

  const snapshotDir = path.join(profile, `.plugin-backup-restore-${stamp()}`)
  const previousFiles = await snapshotProfileConfig(snapshotDir)

  const measure = await measureTree(packagesSource, { top: true })
  state.totalBytes = measure.bytes
  state.totalFiles = measure.files

  // Package bodies land in this profile's node_modules, except the running plugin.
  const copied = { files: 0, bytes: 0, warnings: [], skippedSelf: [] }
  const entries = await readDirSafe(packagesSource)
  for (const entry of entries) {
    if (entry.name === '.bin' || entry.name === '.pnpm' || entry.name === '.modules.yaml' || entry.name === '.pnpm-workspace-state-v1.json') continue
    const from = path.join(packagesSource, entry.name)
    const to = path.join(profile, 'node_modules', entry.name)
    if (entry.isDirectory() && entry.name !== SELF_PACKAGE) {
      await copyTree(from, to, { top: false }, progress)
      copied.files = progress.copiedFiles
      copied.bytes = progress.copiedBytes
    } else if (entry.isFile()) {
      await fsp.copyFile(from, to).catch((error) => progress.warnings.push(`${entry.name}: ${error.message}`))
    } else if (entry.isDirectory() && entry.name === SELF_PACKAGE) {
      copied.skippedSelf.push(entry.name)
    }
  }
  void measure

  // Profile config files come back verbatim, with this plugin kept installed.
  const profileSource = path.join(root, 'profile')
  const restoredConfig = []
  const droppedDeps = []
  for (const file of RESTORE_FILES) {
    const from = path.join(profileSource, file)
    try {
      await fsp.access(from)
    } catch { continue }
    const to = path.join(profile, file)
    if (file === 'package.json') {
      const incoming = await readJson(from)
      const current = await readJson(to)
      if (incoming !== undefined) {
        incoming.dependencies = incoming.dependencies ?? {}
        if (current?.dependencies?.[SELF_PACKAGE] !== undefined) incoming.dependencies[SELF_PACKAGE] = current.dependencies[SELF_PACKAGE]
        const dropped = await pruneBrokenLocalDeps(incoming, profile)
        incoming.dsh = incoming.dsh ?? {}
        incoming.dsh.profile = incoming.dsh.profile ?? {}
        const bundles = Array.isArray(incoming.dsh.profile.bundles) ? incoming.dsh.profile.bundles : []
        // A bundle whose package is not present here would fail the whole boot.
        const kept = bundles.filter((bundle) => !dropped.includes(String(bundle)))
        if (!kept.includes(SELF_PACKAGE)) kept.push(SELF_PACKAGE)
        incoming.dsh.profile.bundles = kept
        await fsp.writeFile(to, `${JSON.stringify(incoming, null, 2)}\n`, 'utf8')
        restoredConfig.push(file)
        for (const name of dropped) droppedDeps.push(name)
        continue
      }
    }
    await fsp.copyFile(from, to)
    restoredConfig.push(file)
  }

  const verify = []
  for (const bundle of manifest.bundles ?? []) {
    const name = String(bundle)
    if (droppedDeps.includes(name)) {
      verify.push({ bundle: name, status: 'dropped' })
      continue
    }
    // This plugin is never overwritten by its own restore; report it as kept.
    if (name === SELF_PACKAGE) {
      verify.push({ bundle: name, status: 'self' })
      continue
    }
    const dir = path.join(profile, 'node_modules', ...name.split('/'))
    if (await isDir(dir)) {
      verify.push({ bundle: name, status: 'present' })
    } else {
      // Declared but not copied: keeping it would fail the next boot.
      const manifestFile = path.join(profile, 'package.json')
      try {
        const live = await readJson(manifestFile)
        if (live?.dependencies?.[name] !== undefined) {
          delete live.dependencies[name]
          const bundles = live?.dsh?.profile?.bundles
          if (Array.isArray(bundles)) live.dsh.profile.bundles = bundles.filter((item) => String(item) !== name)
          await fsp.writeFile(manifestFile, `${JSON.stringify(live, null, 2)}\n`, 'utf8')
        }
      } catch { /* report only */ }
      verify.push({ bundle: name, status: 'missing' })
    }
  }

  return {
    action: 'restore',
    source: root,
    restoredFiles: copied.files,
    restoredBytes: copied.bytes,
    packages: Number(manifest.packages?.length ?? 0),
    bundles: manifest.bundles ?? [],
    restoredConfig,
    snapshotDir,
    previousFiles,
    verify,
    restartRequired: true,
    warnings: progress.warnings.slice(0, 20),
    skippedSelf: copied.skippedSelf,
    droppedDependencies: droppedDeps,
    backupCreatedAt: String(manifest.createdAt ?? ''),
  }
}

/** Open a folder in the platform file manager. */
function openFolder(target) {
  const dir = path.resolve(target)
  if (process.platform === 'win32') spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
  else if (process.platform === 'darwin') spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref()
  else spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref()
}

/** Pick one directory through the composed directory-picker seam, if it can. */
async function pickDirectory(directoryPicker) {
  const capability = directoryPicker?.capability?.()
  if (capability?.kind === 'native') {
    const picked = await capability.pick(new AbortController().signal)
    return { kind: 'native', path: picked ?? null }
  }
  return { kind: 'browse', path: null }
}

/** List one directory for the in-app browser. */
async function browseDirectory(target) {
  const home = os.homedir()
  const dir = path.resolve(target ?? profileDir())
  const entries = []
  for (const entry of await readDirSafe(dir)) {
    if (entry.isDirectory()) entries.push({ name: entry.name, path: path.join(dir, entry.name), kind: 'dir' })
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) entries.push({ name: entry.name, path: path.join(dir, entry.name), kind: 'file' })
  }
  entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  const manifest = await readJson(path.join(dir, 'manifest.json'))
  return {
    path: dir,
    home,
    parent: path.dirname(dir) === dir ? null : path.dirname(dir),
    exists: await isDir(dir),
    isBackup: manifest?.format === FORMAT,
    entries,
  }
}

/** Current profile facts for the page header. */
async function profileStatus() {
  const manifest = await readProfile()
  const packages = await describePackages(manifest)
  return {
    profileDir: profileDir(),
    dshHome: dshHome(),
    profile: process.env.DSH_PROFILE ?? '',
    bundles: bundlesOf(manifest),
    dependencies: dependenciesOf(manifest),
    packages,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    dshVersion: dshVersion(),
    pluginVersion: '1.0.0',
    codeRevision: CODE_REVISION,
    backupDirHint: path.join(dshHome(), 'plugin-backups'),
  }
}

/** One dispatcher for the browser route and the agent tool. */
function createApi(ctx, jobs) {
  const directoryPicker = () => ctx.get('directoryPicker')

  const handle = async (method, body) => {
    const input = body ?? {}
    switch (method) {
      case 'status':
        return { ok: true, status: await profileStatus() }
      case 'scan': {
        const measure = await measureTree(path.join(profileDir(), 'node_modules'), { top: true })
        return { ok: true, scan: { bytes: measure.bytes, files: measure.files, human: humanBytes(measure.bytes) } }
      }
      case 'job':
        return { ok: true, job: jobs.snapshot() }
      case 'pick': {
        const picked = await pickDirectory(directoryPicker())
        return { ok: true, ...picked }
      }
      case 'browse':
        return { ok: true, listing: await browseDirectory(input.path) }
      case 'backup':
        if (typeof input.dest !== 'string' || input.dest.trim() === '') throw new Error('请先选择备份目录')
        jobs.start('backup', (progress, state) => runBackup(input.dest, progress, state))
        return { ok: true, started: true, job: jobs.snapshot() }
      case 'find-backups':
        if (typeof input.dir !== 'string') throw new Error('请先选择备份文件夹')
        return { ok: true, candidates: await findBackups(input.dir) }
      case 'restore':
        if (typeof input.dir !== 'string' || input.dir.trim() === '') throw new Error('请先选择要恢复的备份')
        if (!(await isDir(path.join(path.resolve(input.dir), 'packages'))) && !(await isDir(path.join(path.resolve(input.dir), 'profile')))) {
          throw new Error('这个文件夹不是完整的备份（缺少 packages 或 profile）')
        }
        jobs.start('restore', (progress, state) => runRestore(input.dir, progress, state))
        return { ok: true, started: true, job: jobs.snapshot() }
      case 'open-folder':
        if (typeof input.dir !== 'string') throw new Error('缺少目录')
        openFolder(input.dir)
        return { ok: true }
      default:
        throw new Error(`未知操作：${String(method)}`)
    }
  }
  return handle
}

/** Agent tool: read-only inspection plus a backup into a chosen folder.
*
* Restoring overwrites this profile's plugin configuration, which stays a
* user action on the page: the tool never writes the profile.
*/
function registerTool(ctx, handle, jobs) {
  const tools = ctx.get('tools')
  if (tools === undefined) return () => {}
  return tools.register({
    name: 'plugin_backup',
    description: '备份本机 DSH 已安装插件到指定文件夹（action=backup），或查看可备份的插件与已有备份（status/scan/find）。备份会复制 profile 配置与 node_modules 里的插件本体，可直接拷到新电脑离线恢复。从备份恢复会覆盖本机插件配置，只能由用户在「插件」页面的「备份」标签里确认执行。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'scan', 'backup', 'find'], description: '要执行的操作' },
        dir: { type: 'string', description: 'backup 时的目标目录；find 时的备份文件夹' },
      },
      required: ['action'],
    },
    output: {
      schema: { description: '操作结果' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const action = String(args?.action ?? '')
      const dir = typeof args?.dir === 'string' ? args.dir : undefined
      if (action === 'backup') {
        const state = jobs.snapshot()
        if (state.running) throw new Error('已有备份或恢复任务在进行')
        await handle('backup', { dest: dir })
        const deadLine = Date.now() + 30 * 60 * 1000
        while (Date.now() < deadLine) {
          await new Promise((resolve) => setTimeout(resolve, 300))
          const snapshot = jobs.snapshot()
          if (!snapshot.running) {
            if (snapshot.error !== null) throw new Error(snapshot.error)
            return snapshot.result
          }
        }
        throw new Error('备份仍在进行，请在插件页面查看进度')
      }
      if (action === 'status') return (await handle('status', {})).status
      if (action === 'scan') return (await handle('scan', {})).scan
      if (action === 'find') {
        const result = await handle('find-backups', { dir })
        return result.candidates
      }
      throw new Error(`未知 action：${action}（恢复请在插件页面的「备份」标签里操作）`)
    },
  })
}

/** Mount the route, the tool, and the cleanup. */
function mountPlugin(ctx) {
  const jobs = createJobs()
  const handle = createApi(ctx, jobs)
  const trusted = () => (ctx.get('webStartup') ?? ctx.get('webRuntime'))?.trustedHosts

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedRequest(req, trusted())) return writeJson(res, 403, { ok: false, error: 'forbidden' })
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : ''
      if (method === '' || method.includes('/')) return writeJson(res, 404, { ok: false, error: 'unknown method' })
      try {
        const body = await readBody(req)
        writeJson(res, 200, await handle(method, body))
      } catch (error) {
        writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-cjbf: api route')

  ctx.effect(() => registerTool(ctx, handle, jobs), 'dsh-cjbf: tool')
}

export function apply(ctx) {
  mountPlugin(ctx)
}
