/**
 * Client for the DSH Companion IDE plugin's loopback bridge.
 *
 * The companion publishes one descriptor document (`~/.dsh/jetbrains-companion.json` by default) that
 * carries the loopback port, the per-run bearer token, the owning process id, and the newest
 * workspace snapshot. This module reads that document, converts the snapshot into the same report
 * shape the disk reader produces, and calls the bridge's `POST /open` so a tool can put a file in
 * front of the user.
 *
 * A descriptor whose owning process is gone is ignored: the IDE deletes the file on a clean shutdown,
 * and a killed IDE leaves one behind.
 *
 * @module bridge
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { commonParentOf, canonicalPath } from './discovery.js'

/** Descriptor source marker this client accepts. */
const SOURCE = 'jetbrains-companion'

/** Descriptor version this client understands. */
const VERSION = 1

/**
 * Default descriptor location, the path the companion writes.
 * @param home - user home directory.
 * @returns the descriptor path.
 */
export function defaultBridgePath(home = homedir()) {
  return join(home, '.dsh', 'jetbrains-companion.json')
}

/**
 * Read a live companion descriptor.
 * @param options - `bridgePath` (default {@link defaultBridgePath}), `home`, and `liveBridge`
 * (false disables every bridge call).
 * @returns the descriptor with its parsed workspace, or `undefined` when no live IDE publishes one.
 */
export function readLiveBridge(options = {}) {
  return readLiveBridges(options)[0]
}

/**
 * The directory a per-window descriptor set lives in, beside the single descriptor older builds published.
 *
 * @param options - discovery options; `bridgePath` moves the whole set.
 * @returns the directory path.
 */
export function descriptorDirectory(options = {}) {
  const path = options.bridgePath ?? defaultBridgePath(options.home ?? homedir())
  return join(dirname(path), 'jetbrains-companion')
}

/**
 * Read one descriptor, if it is this companion's, live, and usable.
 *
 * @param path - the descriptor file.
 * @returns the descriptor, or undefined.
 */
function liveBridgeAt(path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    /* no descriptor, or one caught mid-write; the disk reader still answers */
    return undefined
  }
  if (parsed?.source !== SOURCE || parsed.version !== VERSION) return undefined
  if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string' || parsed.token === '') return undefined
  if (!isAlive(parsed.pid)) return undefined
  if (parsed.workspace === null || typeof parsed.workspace !== 'object') return undefined
  return { path, port: parsed.port, token: parsed.token, pid: parsed.pid, workspace: parsed.workspace }
}

/**
 * Every live companion, not just the one: two IDE windows publish one descriptor each into the directory
 * beside the single descriptor older builds wrote, and a Host that reads only the first would open a
 * window's diff in another window.
 *
 * @param options - discovery options: `liveBridge` (false reads nothing), `bridgePath`, `home`.
 * @returns the live descriptors, the single descriptor first so a single-window setup keeps its order.
 */
export function readLiveBridges(options = {}) {
  if (options.liveBridge === false) return []
  const single = options.bridgePath ?? defaultBridgePath(options.home ?? homedir())
  const found = []
  const seen = new Set()
  const add = (candidate) => {
    if (candidate === undefined) return
    const key = `${candidate.port}:${candidate.token}`
    if (seen.has(key)) return
    seen.add(key)
    found.push(candidate)
  }
  add(liveBridgeAt(single))
  let names = []
  try {
    names = readdirSync(descriptorDirectory(options))
  } catch {
    /* no per-window set yet: the single descriptor is all there is */
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    add(liveBridgeAt(join(descriptorDirectory(options), name)))
  }
  return found
}

/**
 * The companion whose window owns one directory, for a Host that has several.
 *
 * @param bridges - the live descriptors.
 * @param root - the workspace root, or any path inside it.
 * @returns the matching descriptor, or undefined when none claims that root.
 */
export function bridgeForWorkspace(bridges, root) {
  if (typeof root !== 'string' || root === '') return undefined
  const wanted = root.replace(/\\/g, '/').replace(/\/+$/, '')
  for (const bridge of bridges) {
    const workspace = bridge.workspace ?? {}
    const roots = []
    for (const project of Array.isArray(workspace.projects) ? workspace.projects : []) {
      if (typeof project?.path === 'string') roots.push(project.path)
      for (const entry of Array.isArray(project?.roots) ? project.roots : []) {
        if (typeof entry === 'string') roots.push(entry)
      }
    }
    for (const entry of Array.isArray(workspace.roots) ? workspace.roots : []) {
      if (typeof entry === 'string') roots.push(entry)
    }
    for (const candidate of roots) {
      const claimed = candidate.replace(/\\/g, '/').replace(/\/+$/, '')
      if (claimed === wanted || wanted.startsWith(`${claimed}/`) || claimed.startsWith(`${wanted}/`)) return bridge
    }
  }
  return undefined
}

/**
 * The companion to use for one workspace: the window that owns it, else the first live one.
 *
 * @param options - discovery options.
 * @param root - the workspace root, or any path inside it.
 * @returns the descriptor to use, or undefined when no IDE is live.
 */
export function readLiveBridgeFor(options, root) {
  const bridges = readLiveBridges(options)
  return bridgeForWorkspace(bridges, root) ?? bridges[0]
}

/** Whether one directory name belongs in the per-window descriptor set. */
export function descriptorFileName(key) {
  return `${key}.json`
}

/**
 * Put the live IDE in front of the disk-discovered report.
 * @param report - the report produced by the disk reader.
 * @param options - discovery options, including `liveBridge` (false skips the descriptor) and the
 * open-file bound.
 * @returns the report whose `current` entry is the live IDE when one is running.
 */
export function withLiveBridge(report, options = {}) {
  if (options.liveBridge === false) return report
  const bridge = readLiveBridge(options)
  if (bridge === undefined) return report
  const live = liveIdeEntry(bridge, options)
  if (live === undefined) return report
  mergeDiskRoots(live, report.current, options)
  return {
    ides: [live, ...report.ides],
    current: live,
    warnings: report.warnings,
  }
}

/**
 * Add the attached-project directories only the IDE's own state files reveal to a live snapshot.
 *
 * The live bridge reports the projects the IDE has open; a window that attaches projects through VCS
 * or module mappings can hide some of those directories from the platform's open-project list. When
 * the disk reader describes the same window, its roots are the missing evidence, so the live entry
 * adopts them. A disk entry that shares no directory with the live one describes another IDE and is
 * left alone.
 * @param live - the live IDE entry, updated in place.
 * @param diskIde - the disk report's selected IDE, when it has a workspace.
 * @param options - `home` for the disk reader's default configuration roots.
 */
function mergeDiskRoots(live, diskIde, options) {
  const diskRoots = Array.isArray(diskIde?.workspace?.roots) ? diskIde.workspace.roots : []
  if (diskRoots.length === 0) return
  const livePaths = live.workspace.roots.map(root => root.path)
  const sameWindow = diskRoots.some(root => livePaths.some(path => root.path === path
    || dirname(root.path) === dirname(path)
    || root.path.startsWith(`${path}/`)))
  if (!sameWindow) return
  const roles = new Map(live.workspace.roots.map(root => [root.path, root.role]))
  for (const root of diskRoots) {
    if (root.exists && !roles.has(root.path)) roles.set(root.path, root.role)
  }
  const ordered = [...roles.keys()].sort((left, right) => {
    const byRole = (roles.get(left) === 'project' ? 0 : 1) - (roles.get(right) === 'project' ? 0 : 1)
    return byRole !== 0 ? byRole : left.localeCompare(right)
  })
  live.workspace.roots = ordered.map(path => ({
    path,
    role: roles.get(path),
    exists: existsSync(path),
    git: existsSync(join(path, '.git')),
    idea: existsSync(join(path, '.idea')),
  }))
  live.workspace.project = ordered[0]
  const commonParent = commonParentOf(ordered)
  if (commonParent !== undefined) live.workspace.commonParent = commonParent
}

/**
 * Convert one live descriptor into the IDE entry the tool and the runtime context consume.
 * @param bridge - the descriptor returned by {@link readLiveBridge}.
 * @param options - `openFileLimit`.
 * @returns the IDE entry, or `undefined` when the snapshot names no directory.
 */
export function liveIdeEntry(bridge, options = {}) {
  const workspace = bridge.workspace
  const roles = new Map()
  /** Record one directory, keeping the first role that names it. */
  const addRoot = (candidate, role) => {
    if (typeof candidate !== 'string' || candidate === '') return
    const path = canonicalPath(candidate)
    if (!roles.has(path)) roles.set(path, role)
  }
  for (const project of asArray(workspace.projects)) {
    addRoot(project?.path, 'project')
    for (const root of asArray(project?.roots)) addRoot(root, 'module')
  }
  if (roles.size === 0) return undefined

  const ordered = [...roles.keys()].sort((left, right) => {
    const byRole = (roles.get(left) === 'project' ? 0 : 1) - (roles.get(right) === 'project' ? 0 : 1)
    return byRole !== 0 ? byRole : left.localeCompare(right)
  })
  const files = asArray(workspace.openFiles).filter(file => typeof file === 'string').map(canonicalPath)
  const active = workspace.active
  const activePath = typeof active?.path === 'string' && active.path !== '' ? canonicalPath(active.path) : undefined
  const selection = typeof active?.selection === 'string' && active.selection !== '' ? active.selection : undefined
  const openFileLimit = options.openFileLimit ?? 25
  const commonParent = commonParentOf(ordered)
  return {
    key: typeof workspace.product === 'string' && workspace.product !== '' ? workspace.product : 'jetbrains-companion',
    configDir: `live bridge ${bridge.path}`,
    running: true,
    source: 'companion',
    server: {
      port: bridge.port,
      name: typeof workspace.productName === 'string' ? workspace.productName : 'JetBrains IDE',
      ...typeof workspace.build === 'string' ? { buildNumber: workspace.build } : {},
    },
    projects: [],
    workspace: {
      project: ordered[0],
      roots: ordered.map(path => ({
        path,
        role: roles.get(path),
        exists: existsSync(path),
        git: existsSync(join(path, '.git')),
        idea: existsSync(join(path, '.idea')),
      })),
      ...commonParent === undefined ? {} : { commonParent },
      files,
      ...activePath === undefined ? {} : {
        activeFile: activePath,
        activeLine: Number.isInteger(active.line) ? active.line : 0,
        activeColumn: Number.isInteger(active.column) ? active.column : 0,
      },
      ...selection === undefined ? {} : { selection },
      totalOpenFiles: files.length,
      openFiles: files.slice(0, openFileLimit),
      ...typeof workspace.updatedAt === 'string' ? { stateUpdatedAt: workspace.updatedAt } : {},
      bridge: { port: bridge.port, path: bridge.path },
    },
    warnings: [],
  }
}

/**
 * Ask the IDE to open one file, focused.
 * @param bridge - the descriptor returned by {@link readLiveBridge}.
 * @param request - `path`, plus optional `line` and `column`.
 * @param timeoutMs - request deadline.
 * @returns the bridge's acknowledgement.
 * @throws Error when the IDE refuses the request or does not answer.
 */
export async function openInIde(bridge, request, timeoutMs = 5_000) {
  const response = await fetch(`http://127.0.0.1:${bridge.port}/open`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bridge.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok || body?.ok !== true) {
    throw new Error(typeof body?.error === 'string' ? body.error : `the IDE bridge answered ${response.status}`)
  }
  return body
}

/**
 * Tell one IDE that a turn published changes, so it can show the diff on its own.
 *
 * @param bridge - the live bridge descriptor.
 * @param notice - what the IDE needs: session, sequence, turn, workspace root, and the changed files.
 * @param timeoutMs - how long the IDE may take.
 * @returns the IDE's answer.
 * @throws when the IDE refuses the notice.
 */
export async function notifyChanged(bridge, notice, timeoutMs = 5_000) {
  const response = await fetch(`http://127.0.0.1:${bridge.port}/changed`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bridge.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(notice),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `the IDE bridge answered ${response.status}`)
  }
  return body
}

/** Whether one recorded process id is still running. */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    /* the descriptor outlived its IDE */
    return false
  }
}

/** A JSON array field, or an empty array for any other value. */
function asArray(value) {
  return Array.isArray(value) ? value : []
}
