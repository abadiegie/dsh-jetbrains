/**
 * Discovery of the JetBrains IDE workspace open on this machine.
 *
 * A JetBrains IDE keeps the state this module reads in two places: its configuration directory
 * (`options/recentProjects.xml` for the recent-project list and the per-project workspace state
 * beside it, `.lock` for the running process id) and each project's own `.idea` directory
 * (`modules.xml` for project modules, `vcs.xml` for the VCS roots registered in this window).
 * Projects attached to one window live in their own directories rather than under the root project,
 * and they appear as module or VCS mappings whose path escapes `$PROJECT_DIR$`; the workspace root
 * list is the union of those mappings, the state file's own project roots, and the nearest project
 * directory of every file open in the editor.
 *
 * Reported paths are canonical where the filesystem can resolve them, so a tool consumer can use
 * them directly even when the IDE spells the project through a symlink.
 *
 * Every reader is best-effort: an unreadable or absent state file removes one source and records a
 * warning instead of failing the discovery.
 *
 * @module discovery
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** Directory names that mark a project root when climbing up from an open file. */
const PROJECT_MARKER_NAMES = [
  '.idea', '.git', '.hg', '.svn', 'composer.json', 'package.json', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'settings.gradle', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'Gemfile',
  'mix.exs', 'CMakeLists.txt',
]

/** File suffixes that mark a project root when climbing up from an open file. */
const PROJECT_MARKER_SUFFIXES = ['.iml', '.ipr', '.csproj', '.sln']

/** Deepest climb from an open file towards its project root. */
const MARKER_CLIMB_LIMIT = 8

/** Ports the IDE built-in web server binds, in the order several running IDEs take them. */
export const DEFAULT_SERVER_PORTS = [63342, 63343, 63344, 63345]

/**
 * JetBrains configuration roots for this platform.
 * @param home - user home directory; defaults to the current user's.
 * @returns existing candidate configuration directories.
 */
export function defaultConfigRoots(home = homedir()) {
  const roots = []
  if (process.platform === 'darwin') {
    roots.push(join(home, 'Library', 'Application Support', 'JetBrains'))
  } else if (process.platform === 'win32' && process.env.APPDATA) {
    roots.push(join(process.env.APPDATA, 'JetBrains'))
  }
  const xdg = process.env.XDG_CONFIG_HOME
  roots.push(join(xdg !== undefined && xdg !== '' ? xdg : join(home, '.config'), 'JetBrains'))
  // A Linux-style home on another platform (containers, WSL, dotfile-synced setups).
  roots.push(join(home, '.config', 'JetBrains'))
  return [...new Set(roots)].filter(root => existsSync(root))
}

/**
 * Read the current JetBrains workspace from local state files only.
 * @param options - discovery inputs.
 * @param options.home - user home for `$USER_HOME$` and the default configuration roots.
 * @param options.configRoots - configuration directories to scan instead of the platform defaults.
 * @param options.openFileLimit - maximum editor files reported per workspace.
 * @returns the report the `jetbrains_workspace` tool renders: every detected IDE, the selected one,
 * and the warnings of the selected one.
 */
export function discoverWorkspaceSync(options = {}) {
  const home = options.home ?? homedir()
  const configRoots = options.configRoots !== undefined && options.configRoots.length > 0
    ? options.configRoots.map(root => resolve(root))
    : defaultConfigRoots(home)
  const openFileLimit = options.openFileLimit ?? 25
  const scanned = []
  for (const configRoot of configRoots) {
    for (const configDir of listProductDirs(configRoot)) {
      const warnings = []
      try {
        const ide = readIde(configDir, home, openFileLimit, warnings)
        if (ide !== undefined) scanned.push({ ...ide, warnings })
      } catch (error) {
        warnings.push(`could not read ${configDir}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  scanned.sort((left, right) => rank(right) - rank(left) || right.updatedAt - left.updatedAt)
  const current = scanned.find(ide => ide.workspace !== undefined && ide.running)
    ?? scanned.find(ide => ide.workspace !== undefined)
  const warnings = current !== undefined
    ? current.warnings
    : scanned.length === 0
      ? [`no JetBrains IDE configuration found in: ${configRoots.join(', ')}`]
      : scanned[0].warnings
  return { ides: scanned, current, warnings }
}

/**
 * {@link discoverWorkspaceSync} plus the IDE built-in web server identity probe, which reports the
 * product name and build of the running IDE.
 * @param options - discovery inputs, plus `serverPorts`, `probeTimeoutMs`, and `probe` (false skips
 * the network probe).
 * @returns the report, with the probed identity on the selected IDE.
 */
export async function discoverWorkspace(options = {}) {
  const report = discoverWorkspaceSync(options)
  if (options.probe === false) return report
  const server = await probeBuiltInServer(
    options.serverPorts ?? DEFAULT_SERVER_PORTS,
    options.probeTimeoutMs ?? 700,
  )
  if (server === undefined) return report
  const target = report.current ?? report.ides[0]
  if (target !== undefined) target.server = server
  return report
}

/**
 * Ask the IDE built-in web server for its identity.
 * @param ports - candidate ports, in the order several running IDEs take them.
 * @param timeoutMs - per-port deadline.
 * @returns the first answering server's identity, or `undefined` when none answers.
 */
async function probeBuiltInServer(ports, timeoutMs) {
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/about`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) continue
      const body = await response.json()
      if (typeof body?.name !== 'string') continue
      return {
        port,
        name: body.name,
        ...typeof body.productName === 'string' ? { productName: body.productName } : {},
        ...typeof body.buildNumber === 'string' ? { buildNumber: body.buildNumber } : {},
      }
    } catch {
      /* this port has no answering IDE built-in server; try the next candidate */
    }
  }
  return undefined
}

/** Product configuration directories that hold a recent-project list. */
function listProductDirs(configRoot) {
  let entries
  try {
    entries = readdirSync(configRoot, { withFileTypes: true })
  } catch {
    /* an unreadable configuration root contributes no IDE */
    return []
  }
  const dirs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(configRoot, entry.name)
    if (existsSync(join(dir, 'options', 'recentProjects.xml'))) dirs.push(dir)
  }
  return dirs
}

/** Rank one IDE by how likely it owns the window the user is looking at. */
function rank(ide) {
  let score = 0
  if (ide.running) score += 4
  if (ide.projects.some(project => project.opened)) score += 2
  if (ide.workspace !== undefined) score += 1
  return score
}

/** Read one product configuration directory. */
function readIde(configDir, home, openFileLimit, warnings) {
  const { projects, lastOpened } = readRecentProjects(configDir, home)
  if (projects.length === 0 && lastOpened === undefined) return undefined
  const project = selectProject(projects, lastOpened)
  return {
    key: basename(configDir),
    configDir,
    running: runningPid(configDir) !== undefined,
    projects,
    ...lastOpened !== undefined ? { lastOpened } : {},
    updatedAt: mtimeMs(join(configDir, 'options', 'recentProjects.xml')),
    ...project === undefined ? {} : { workspace: readWorkspace(project, configDir, home, openFileLimit, warnings) },
  }
}

/** The project whose workspace this process most likely shows, preferring directories that exist. */
function selectProject(projects, lastOpened) {
  const existing = projects.filter(project => existsSync(project.path))
  const pool = existing.length > 0 ? existing : projects
  const opened = pool.filter(project => project.opened)
  if (opened.length > 0) return mostRecent(opened)
  const last = pool.find(project => project.path === lastOpened)
  if (last !== undefined) return last
  return pool.length === 0 ? undefined : mostRecent(pool)
}

/** The project with the newest activation timestamp. */
function mostRecent(projects) {
  return [...projects].sort((left, right) => (right.activatedAt ?? 0) - (left.activatedAt ?? 0))[0]
}

/**
 * Resolve one project's workspace: its root, every attached project directory, and the editor tabs.
 * @returns the workspace report, or `undefined` when the project directory no longer exists.
 */
function readWorkspace(project, configDir, home, openFileLimit, warnings) {
  const projectPath = canonicalPath(project.path)
  if (!existsSync(projectPath)) {
    warnings.push(`project directory no longer exists: ${project.path}`)
    return undefined
  }
  const macros = { USER_HOME: home, PROJECT_DIR: projectPath }
  const roots = new Map([[projectPath, 'project']])
  /** Add one attached-project candidate, keeping the first role that names it. */
  const addRoot = (candidate, role) => {
    if (candidate === undefined || candidate === '') return
    const path = canonicalPath(candidate)
    if (path === projectPath || roots.has(path) || !existsSync(path)) return
    roots.set(path, role)
  }
  for (const moduleEntry of externalModuleRoots(projectPath, macros)) addRoot(moduleEntry.path, moduleEntry.role)
  for (const vcsRoot of externalVcsRoots(projectPath, macros)) addRoot(vcsRoot, 'vcs')

  const stateFile = projectStateFile(configDir, project, projectPath)
  const files = []
  let activeFile
  if (stateFile !== undefined) {
    const xml = readText(stateFile)
    if (xml !== undefined) {
      for (const root of externalStateRoots(xml, projectPath, macros)) addRoot(root, 'project-root')
      for (const entry of readOpenFiles(xml, macros)) {
        files.push(entry.path)
        if (entry.active) activeFile = entry.path
        if (isOutside(entry.path, projectPath)) addRoot(nearestProjectRoot(entry.path, projectPath), 'editor')
      }
    }
  }
  const ordered = [projectPath, ...[...roots.keys()].filter(root => root !== projectPath).sort()]
  const commonParent = commonParentOf(ordered)
  return {
    project: projectPath,
    roots: ordered.map(root => ({
      path: root,
      role: roots.get(root),
      exists: existsSync(root),
      git: existsSync(join(root, '.git')),
      idea: existsSync(join(root, '.idea')),
    })),
    ...commonParent === undefined ? {} : { commonParent },
    files,
    ...activeFile === undefined ? {} : { activeFile },
    totalOpenFiles: files.length,
    openFiles: files.slice(0, openFileLimit),
    ...stateFile === undefined ? {} : { stateFile, stateUpdatedAt: new Date(mtimeMs(stateFile)).toISOString() },
  }
}

/** The state file holding this project's editor tabs: the shared workspace file, else `.idea`. */
function projectStateFile(configDir, project, projectPath) {
  if (project.workspaceId !== undefined && /^[A-Za-z0-9_-]+$/.test(project.workspaceId)) {
    const shared = join(configDir, 'workspace', `${project.workspaceId}.xml`)
    if (existsSync(shared)) return shared
  }
  const legacy = join(projectPath, '.idea', 'workspace.xml')
  return existsSync(legacy) ? legacy : undefined
}

/**
 * Directories one module contributes: the content roots its module file declares, else the module
 * file's own directory.
 *
 * A JetBrains module can hold several content roots in unrelated directories — the shape a
 * multi-project window uses — and those roots live in the module file itself, not in `modules.xml`,
 * which only names it. Inside the module file `$MODULE_DIR$` is that file's directory; below it
 * `$PROJECT_DIR$` and `$USER_HOME$` keep their usual meanings.
 * Each entry carries the role that names its source: `module` for a root the module file declares,
 * and `module-dir` for the module's own directory, which stands in only when the file declares no
 * content root at all — the same implicit root the IDE uses for such a module.
 * @param projectPath - root project directory.
 * @param macros - `PROJECT_DIR` and `USER_HOME` replacements.
 * @returns `{path, role}` entries for directories outside the root project.
 */
function externalModuleRoots(projectPath, macros) {
  const xml = readText(join(projectPath, '.idea', 'modules.xml'))
  if (xml === undefined) return []
  const roots = []
  for (const match of xml.matchAll(/<module\b[^>]*\bfileurl="([^"]*)"/g)) {
    const path = expandPath(decodeXml(match[1]), macros)
    if (path === undefined) continue
    const moduleDir = moduleDirOf(path)
    const declared = moduleContentRoots(path, moduleDir, projectPath, macros)
    for (const candidate of declared) {
      if (isOutside(candidate, projectPath)) roots.push({ path: candidate, role: 'module' })
    }
    if (declared.length === 0 && isOutside(moduleDir, projectPath)) {
      roots.push({ path: moduleDir, role: 'module-dir' })
    }
  }
  return roots
}

/**
 * The directory IntelliJ expands `$MODULE_DIR$` to for one module file.
 *
 * This is not a shortcut for the module file's directory: it is the platform's own rule, implemented
 * by `org.jetbrains.jps.model.serialization.PathMacroUtil.getModuleDir`, which takes the parent of a
 * module file but steps one level further up when that parent is named `.idea`. A module stored at
 * `<project>/.idea/x.iml` therefore writes its content roots as `$MODULE_DIR$/../attached`, naming a
 * sibling of the project; expanding those against `.idea` would name `<project>/attached`, a path the
 * IDE never uses.
 * @param moduleFile - absolute path of the module file.
 * @returns the base directory for that file's `$MODULE_DIR$`.
 */
function moduleDirOf(moduleFile) {
  const dir = dirname(moduleFile)
  return basename(dir) === '.idea' ? dirname(dir) : dir
}

/**
 * The content roots one module file declares.
 * @param moduleFile - absolute path of the module file (`.iml`).
 * @param moduleDir - its directory, which is the file's own `$MODULE_DIR$`.
 * @param projectPath - root project directory, which is never an attached project of its own.
 * @param macros - `PROJECT_DIR` and `USER_HOME` replacements.
 * @returns canonical content roots, without duplicates.
 */
function moduleContentRoots(moduleFile, moduleDir, projectPath, macros) {
  const xml = readText(moduleFile)
  if (xml === undefined) return []
  const moduleMacros = { ...macros, MODULE_DIR: moduleDir }
  const roots = []
  for (const match of xml.matchAll(/<content\b[^>]*\burl="([^"]*)"/g)) {
    const path = expandPath(decodeXml(match[1]), moduleMacros)
    if (path === undefined || path === '') continue
    const root = canonicalPath(path)
    if (root === projectPath || roots.includes(root)) continue
    roots.push(root)
  }
  return roots
}

/** VCS roots registered in this window that live outside the root project. */
function externalVcsRoots(projectPath, macros) {
  const xml = readText(join(projectPath, '.idea', 'vcs.xml'))
  if (xml === undefined) return []
  const roots = []
  for (const match of xml.matchAll(/<mapping\b[^>]*\bdirectory="([^"]*)"/g)) {
    const path = expandPath(decodeXml(match[1]), macros)
    if (path === undefined || path === '') continue
    const root = canonicalPath(path)
    if (isOutside(root, projectPath)) roots.push(root)
  }
  return roots
}

/** Project roots declared by the IDE's own workspace state file. */
function externalStateRoots(xml, projectPath, macros) {
  const block = componentBlock(xml, 'ProjectRoots')
  if (block === undefined) return []
  const roots = []
  for (const match of block.matchAll(/<project-root\b[^>]*\burl="([^"]*)"/g)) {
    const path = expandPath(decodeXml(match[1]), macros)
    if (path === undefined || path === '') continue
    const root = canonicalPath(path)
    if (isOutside(root, projectPath)) roots.push(root)
  }
  return roots
}

/** Editor tabs in the state file's `FileEditorManager`, in tab order. */
function readOpenFiles(xml, macros) {
  const block = componentBlock(xml, 'FileEditorManager')
  if (block === undefined) return []
  const files = []
  for (const match of block.matchAll(/<file\b([^>]*)>\s*<entry\b([^>]*?)\/?>/g)) {
    const url = attribute(match[2], 'file')
    if (url === undefined) continue
    const path = expandPath(decodeXml(url), macros)
    if (path === undefined || path === '') continue
    files.push({ path: canonicalPath(path), active: /\bcurrent-in-tab="true"/.test(match[1]) })
  }
  return files
}

/** One `<component name="...">` block, or `undefined` when the file has no such component. */
function componentBlock(xml, name) {
  const start = xml.indexOf(`<component name="${name}"`)
  if (start < 0) return undefined
  const end = xml.indexOf('</component>', start)
  return end < 0 ? xml.slice(start) : xml.slice(start, end)
}

/**
 * The nearest ancestor directory of an open file that carries a project marker, stopping at the
 * root project so an ancestor of the workspace is never reported as an attached project.
 * @returns the project directory, or `undefined` when the climb leaves the workspace.
 */
function nearestProjectRoot(filePath, projectPath) {
  let dir = dirname(filePath)
  for (let depth = 0; depth < MARKER_CLIMB_LIMIT; depth += 1) {
    const parent = dirname(dir)
    if (parent === dir) return undefined
    if (dir === projectPath || !isOutside(projectPath, dir)) return undefined
    if (hasProjectMarker(dir)) return dir
    dir = parent
  }
  return undefined
}

/** Whether a directory carries a project marker. */
function hasProjectMarker(dir) {
  for (const name of PROJECT_MARKER_NAMES) {
    if (existsSync(join(dir, name))) return true
  }
  try {
    for (const entry of readdirSync(dir)) {
      if (PROJECT_MARKER_SUFFIXES.some(suffix => entry.endsWith(suffix))) return true
    }
  } catch {
    /* an unreadable directory is not a project root */
  }
  return false
}

/** Whether `candidate` is neither `parent` nor inside it. */
function isOutside(candidate, parent) {
  const normalizedCandidate = resolve(candidate)
  const normalizedParent = resolve(parent)
  return normalizedCandidate !== normalizedParent
    && !normalizedCandidate.startsWith(normalizedParent.endsWith(sep) ? normalizedParent : normalizedParent + sep)
}

/**
 * Absolute path with `..` and symlinks resolved where the filesystem allows it.
 * @param path - path to resolve.
 * @returns the canonical path, or the normalized spelling when the path does not exist.
 */
export function canonicalPath(path) {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    /* a missing path keeps its normalized spelling */
    return absolute
  }
}

/**
 * Longest common directory prefix of several absolute paths.
 * @param paths - absolute directory paths.
 * @returns the shared parent, or `undefined` without one.
 */
export function commonParentOf(paths) {
  if (paths.length < 2) return undefined
  const parts = paths.map(path => resolve(path).split(sep))
  let index = 0
  while (index < parts[0].length && parts.every(entry => entry[index] === parts[0][index])) index += 1
  if (index === 0) return undefined
  const joined = parts[0].slice(0, index).join(sep)
  return joined === '' ? sep : joined
}

/** Read the recent-project list and last-opened project of one configuration directory. */
function readRecentProjects(configDir, home) {
  const xml = readText(join(configDir, 'options', 'recentProjects.xml'))
  if (xml === undefined) return { projects: [] }
  const projects = []
  for (const match of xml.matchAll(/<entry\s+key="([^"]*)">([\s\S]*?)<\/entry>/g)) {
    const path = expandPath(decodeXml(match[1]), { USER_HOME: home })
    if (path === undefined || path === '') continue
    const meta = /<RecentProjectMetaInfo\b([^>]*)>/.exec(match[2])
    const attributes = meta?.[1] ?? ''
    projects.push({
      path: resolve(path),
      opened: /\bopened="true"/.test(attributes),
      workspaceId: attribute(attributes, 'projectWorkspaceId'),
      title: attribute(attributes, 'frameTitle'),
      activatedAt: numberOption(match[2], 'activationTimestamp'),
    })
  }
  const last = /<option\s+name="lastOpenedProject"\s+value="([^"]*)"\s*\/>/.exec(xml)
  const lastPath = last === null ? undefined : expandPath(decodeXml(last[1]), { USER_HOME: home })
  return {
    projects,
    ...lastPath === undefined || lastPath === '' ? {} : { lastOpened: resolve(lastPath) },
  }
}

/** Expand JetBrains path macros and strip a `file://` scheme. */
function expandPath(value, macros) {
  let text = value
  for (const [name, replacement] of Object.entries(macros)) {
    text = text.split(`$${name}$`).join(replacement)
  }
  if (/\$[A-Za-z_]+\$/.test(text)) return undefined
  if (text.startsWith('file://')) text = decodeURIComponent(text.slice('file://'.length))
  if (/^\/[A-Za-z]:[\\/]/.test(text)) text = text.slice(1)
  return text
}

/** One attribute value from a tag's attribute text. */
function attribute(attributes, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)
  return match === null ? undefined : decodeXml(match[1])
}

/** One numeric `<option>` value from an XML fragment. */
function numberOption(xml, name) {
  const match = new RegExp(`<option\\s+name="${name}"\\s+value="(\\d+)"`).exec(xml)
  return match === null ? undefined : Number.parseInt(match[1], 10)
}

/** The five XML entities JetBrains writes into attribute values. */
function decodeXml(value) {
  return value
    .split('&quot;').join('"')
    .split('&apos;').join("'")
    .split('&lt;').join('<')
    .split('&gt;').join('>')
    .split('&amp;').join('&')
}

/** The process id recorded in one configuration directory's lock file, when it is still alive. */
function runningPid(configDir) {
  const lock = readText(join(configDir, '.lock'))
  const pid = lock === undefined ? Number.NaN : Number.parseInt(lock.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    /* the lock file outlived its IDE process */
    return undefined
  }
}

/** File contents, or `undefined` when the file is absent or unreadable. */
function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    /* an unreadable state file removes one discovery source */
    return undefined
  }
}

/** Modification time in milliseconds, or 0 when the file is absent. */
function mtimeMs(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    /* an absent file sorts last */
    return 0
  }
}
