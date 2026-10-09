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

import { existsSync, readFileSync } from 'node:fs'
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
  if (options.liveBridge === false) return undefined
  const path = options.bridgePath ?? defaultBridgePath(options.home ?? homedir())
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
