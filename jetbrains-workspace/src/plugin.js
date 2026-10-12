/**
 * DSH host plugin: reads the JetBrains IDE workspace open on this machine and acts on the IDE.
 *
 * The plugin registers the `jetbrains_workspace` and `jetbrains_open_in_ide` tools, a short
 * runtime-context line naming the workspace directories, and one DSH workspace per detected project
 * directory. Discovery prefers the live bridge published by the DSH Companion IDE plugin and falls
 * back to the IDE's own state files, which works for any JetBrains IDE that keeps a recent-project
 * list and needs no cooperation from the IDE process.
 *
 * @module jetbrains-workspace
 */

import { homedir } from 'node:os'
import { basename } from 'node:path'
import { discoverWorkspace, discoverWorkspaceSync, defaultConfigRoots, commonParentOf, canonicalPath } from './discovery.js'
import { readLiveBridge, withLiveBridge, openInIde } from './bridge.js'
import { publishChanges } from './changes.js'
import { openPresentedDeliverables } from './deliverables.js'
import { openDesktopPathsInIde } from './desktop-open.js'

/** Loader entry name. */
export const name = 'jetbrains-workspace'

/** The tool registry is required; `systemPrompt` is used when the composition mounts it. */
export const inject = ['tools']

/** Directory roles a live companion snapshot can report. */
const ROLE_LABELS = {
  'project': 'root project',
  'module': 'attached project (module content root)',
  'module-dir': 'attached project (module directory, no content root declared)',
  'vcs': 'attached project (VCS root)',
  'project-root': 'attached project (workspace root)',
  'editor': 'attached project (from an open file)',
}

/**
 * Short source names for the runtime context. The tool result carries the longer labels; the context
 * only has to let a model tell a directory declared by a module file from one that came in through a
 * VCS root, an IDE workspace root, or an open file.
 */
const CONTEXT_ROLES = {
  'module': 'module content roots (declared in the module .iml)',
  'module-dir': 'module directories (no content root declared)',
  'vcs': 'VCS roots outside the root project',
  'project-root': 'IDE workspace roots',
  'editor': 'directories of open files',
}

/** Tool parameters: an implicit open object root, as the registry projects every first-party tool. */
const PARAMETERS = {
  type: 'object',
  properties: {
    ide: {
      type: 'string',
      description: 'Configuration key of the IDE to read, such as "IdeaIC2026.1". Omit it to read the current workspace.',
    },
    includeOpenFiles: {
      type: 'boolean',
      description: 'Include the editor tab list and the active file. Default true.',
    },
    allIdes: {
      type: 'boolean',
      description: 'Also report every other detected IDE configuration on this machine. Default false.',
    },
  },
}

/** One reported workspace root. */
const ROOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'role', 'exists', 'git', 'idea'],
  properties: {
    path: { type: 'string' },
    role: { type: 'string' },
    exists: { type: 'boolean' },
    git: { type: 'boolean' },
    idea: { type: 'boolean' },
  },
}

/** One detected IDE configuration, as reported by `allIdes`. */
const IDE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'configDir', 'running', 'openedProjects'],
  properties: {
    key: { type: 'string' },
    configDir: { type: 'string' },
    running: { type: 'boolean' },
    openedProjects: { type: 'array', items: { type: 'string' } },
  },
}

/** Tool result schema. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ide', 'workspace', 'warnings'],
  properties: {
    ide: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'configDir', 'running'],
      properties: {
        key: { type: 'string' },
        configDir: { type: 'string' },
        running: { type: 'boolean' },
        name: { type: 'string', description: 'Product name reported by the IDE built-in server.' },
        build: { type: 'string', description: 'Build number reported by the IDE built-in server.' },
      },
    },
    workspace: {
      type: 'object',
      additionalProperties: false,
      required: ['project', 'roots', 'files', 'totalOpenFiles'],
      properties: {
        project: { type: 'string' },
        roots: { type: 'array', items: ROOT_SCHEMA },
        commonParent: { type: 'string' },
        sessionRoot: {
          type: 'string',
          description: 'Directory one DSH session runs in to reach every root below it.',
        },
        activeFile: { type: 'string' },
        activeLine: { type: 'integer', description: 'Caret line in the active file; 0 when unknown.' },
        activeColumn: { type: 'integer', description: 'Caret column in the active file; 0 when unknown.' },
        selection: { type: 'string', description: 'Text selected in the active editor, bounded by the IDE.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Editor tabs, bounded by openFileLimit.' },
        totalOpenFiles: { type: 'integer' },
        stateFile: { type: 'string' },
        stateUpdatedAt: { type: 'string' },
      },
    },
    ides: { type: 'array', items: IDE_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

const TOOL_DESCRIPTION =
  'Read the JetBrains IDE workspace open on this machine: the root project directory, every attached '
  + 'project directory in its own filesystem location, and the files open in the editor. Use it before '
  + 'working across a multi-project IDE window, or to learn which file the user is currently editing.'

/** Parameters of the open-in-IDE tool. */
const OPEN_PARAMETERS = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path of the file to open.' },
    line: {
      type: 'integer',
      description: 'One-based line to place the caret on. Omit it to keep the caret where the IDE left it.',
    },
    column: {
      type: 'integer',
      description: 'One-based column to place the caret on. Default 1.',
    },
  },
  required: ['path'],
}

/** Result schema of the open-in-IDE tool. */
const OPEN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['opened', 'path', 'line'],
  properties: {
    opened: { type: 'boolean' },
    path: { type: 'string' },
    line: { type: 'integer' },
  },
}

const OPEN_TOOL_DESCRIPTION =
  'Open a file in the JetBrains IDE running on this machine, focused, with the caret on a line. '
  + 'Use it to put a file in front of the user, for example after explaining a defect found there.'

/**
 * Validate the row configuration and fill its defaults.
 * @param config - the loader row's `config`, or undefined.
 * @returns the resolved settings.
 */
function settingsFrom(config) {
  const settings = config ?? {}
  const home = optionalString(settings.home, 'home') ?? homedir()
  const configRoots = optionalStringArray(settings.configRoots, 'configRoots')
  return {
    home,
    configRoots: configRoots !== undefined && configRoots.length > 0 ? configRoots : defaultConfigRoots(home),
    serverPorts: optionalNumberArray(settings.serverPorts, 'serverPorts') ?? undefined,
    probeTimeoutMs: optionalPositiveNumber(settings.probeTimeoutMs, 'probeTimeoutMs') ?? 700,
    openFileLimit: optionalPositiveInteger(settings.openFileLimit, 'openFileLimit') ?? 25,
    probe: settings.probe !== false,
    context: settings.context !== false,
    registerWorkspaces: settings.registerWorkspaces !== false,
    workspaceMode: workspaceModeOf(settings.workspaceMode, settings.registerWorkspaces),
    junctionRoot: settings.junctionRoot === 'common-parent' ? 'common-parent' : 'root-project',
    // Opt-in only. A workspace's `sessionIds` is a filtered projection — it reads empty while the
    // session header index is being rebuilt, and while a stored path and a session's canonical cwd
    // disagree — so "the workspace reports no sessions" is not evidence that it holds none. An
    // automatic delete built on it can remove a registration the user still wants.
    pruneProjectWorkspaces: settings.pruneProjectWorkspaces === true,
    liveBridge: settings.liveBridge !== false,
    bridgePath: optionalString(settings.bridgePath, 'bridgePath'),
    changes: settings.changes !== false,
    changesPath: optionalString(settings.changesPath, 'changesPath'),
    autoOpenDeliverables: settings.autoOpenDeliverables === true,
    // Default on: a click in the DSH UI opening the artifact in the IDE is the point of this plugin, and
    // it costs a user nothing when no IDE is running.
    openInIde: settings.openInIde !== false,
    contextOrder: optionalPositiveNumber(settings.contextOrder, 'contextOrder') ?? 130,
    contextRootLimit: optionalPositiveInteger(settings.contextRootLimit, 'contextRootLimit') ?? 12,
    cacheTtlMs: optionalPositiveNumber(settings.cacheTtlMs, 'cacheTtlMs') ?? 3_000,
  }
}

/**
 * Resolve the workspace-registration mode. `workspaceMode` wins; the earlier boolean field stays
 * accepted so a row written before this field existed keeps working, and a row that sets both while
 * the previous generation is still loaded stops the old per-project behavior immediately.
 * @param mode - the `workspaceMode` row field.
 * @param legacyRegister - the `registerWorkspaces` row field.
 * @returns `single`, `per-project`, or `off`.
 */
function workspaceModeOf(mode, legacyRegister) {
  if (mode === undefined) return legacyRegister === false ? 'off' : 'single'
  if (mode === 'single' || mode === 'per-project' || mode === 'off') return mode
  throw new Error('jetbrains-workspace: workspaceMode must be "single", "per-project", or "off"')
}

/**
 * The one directory a single DSH session runs in to reach every root of the IDE workspace.
 *
 * DSH bounds a session's writes by its working directory, and a JetBrains window may hold projects
 * in unrelated directories, so "one session for the window" needs one directory above them all. The
 * shared parent of the detected roots is that directory; without one, or when a deployment prefers
 * the narrower boundary, the root project answers instead.
 * @param workspace - the reported workspace.
 * @param settings - resolved plugin settings.
 * @returns the session directory, or `undefined` when the workspace names none.
 */
function junctionRoot(workspace, settings) {
  if (workspace.project === '') return undefined
  // One DSH session per opened project is the shipped model: the session's directory is the root
  // project, which is also where the IDE companion creates the session. A deployment that wants
  // workspace-write to reach attached projects opts into the shared parent instead.
  if (settings.junctionRoot !== 'common-parent') return workspace.project
  const roots = workspace.roots.filter(root => root.exists).map(root => root.path)
  const shared = commonParentOf(roots)
  if (shared === undefined || shared === '/' || /^[A-Za-z]:[\\/]?$/.test(shared)) return workspace.project
  return shared
}

/**
 * DSH-side integration: one durable DSH workspace at the directory that reaches every project of the
 * IDE window, so a single session covers the whole window. In `per-project` mode each detected
 * directory is registered instead. Registration is idempotent per directory, so a repeated pass
 * reuses the existing workspace.
 * @param ctx - plugin context carrying the optional workspace registry.
 * @param settings - resolved plugin settings.
 * @returns the sync entry point, or `undefined` when this composition has no workspace registry.
 */
function createWorkspaceRegistrar(ctx, settings) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  let signature
  let inFlight
  return (report) => {
    if (report.current === undefined || inFlight !== undefined) return
    const workspace = report.current.workspace
    const paths = workspace.roots.filter(root => root.exists).map(root => root.path)
    const next = paths.join('\n')
    if (next === signature) return
    inFlight = (async () => {
      try {
        if (settings.workspaceMode === 'per-project') {
          for (const path of paths) await registry.create(path)
        } else {
          const junction = junctionRoot(workspace, settings)
          if (junction !== undefined) {
            await registry.create(junction, `JetBrains workspace (${basename(workspace.project)})`)
          }
          // The per-project entries an earlier generation created are the behavior this mode
          // replaces. Deletion is opt-in, and it is refused outright for a common-parent junction:
          // there every project workspace of the window is a candidate, so one misread turns into
          // the loss of a registration the user still wants. A workspace is otherwise the user's.
          if (settings.pruneProjectWorkspaces && settings.junctionRoot !== 'common-parent') {
            for (const path of paths) {
              if (path === junction) continue
              const existing = registry.list().find(entry => entry.path === path)
              if (existing !== undefined && existing.sessionIds.length === 0) await registry.delete(existing.id)
            }
          }
        }
        signature = next
      } catch {
        /* the registry refuses before its storage is ready; the next report retries */
      } finally {
        inFlight = undefined
      }
    })()
  }
}

/** Register the tool and the runtime context. */
export function apply(ctx, config) {
  const settings = settingsFrom(config)
  const discoveryOptions = {
    home: settings.home,
    configRoots: settings.configRoots,
    openFileLimit: settings.openFileLimit,
    ...settings.serverPorts !== undefined ? { serverPorts: settings.serverPorts } : {},
    probeTimeoutMs: settings.probeTimeoutMs,
    probe: settings.probe,
  }
  const bridgeOptions = {
    home: settings.home,
    liveBridge: settings.liveBridge,
    openFileLimit: settings.openFileLimit,
    ...settings.bridgePath !== undefined ? { bridgePath: settings.bridgePath } : {},
  }
  if (settings.changes) {
    ctx.effect(() => publishChanges(ctx, {
      home: settings.home,
      ...settings.changesPath !== undefined ? { changesPath: settings.changesPath } : {},
    }))
  }
  // `ctx.inject` inside owns the lifecycle: the wrap waits for the session controller and is undone with
  // this plugin, so no outer effect is needed.
  if (settings.openInIde) openDesktopPathsInIde(ctx, { bridgeOptions })
  if (settings.autoOpenDeliverables) {
    ctx.effect(() => openPresentedDeliverables(ctx, {
      bridgeOptions,
      // Only the session this IDE window owns: its working directory is the window's junction, the same
      // directory the companion creates that session in.
      belongs: (session) => {
        const workspace = report().current?.workspace
        const root = workspace === undefined ? undefined : junctionRoot(workspace, settings)
        const cwd = session?.header?.cwd
        return root !== undefined && typeof cwd === 'string' && canonicalPath(cwd) === canonicalPath(root)
      },
    }))
  }
  const registerWorkspaces = settings.workspaceMode === 'off'
    ? undefined
    : createWorkspaceRegistrar(ctx, settings)
  let cache
  /**
   * The cached synchronous report; the runtime context runs on every assembly, so it reuses a
   * report younger than `cacheTtlMs` instead of re-reading the IDE's state files.
   * @returns the current report.
   */
  const report = () => {
    const now = Date.now()
    if (cache === undefined || now - cache.at > settings.cacheTtlMs) {
      cache = { at: now, value: withLiveBridge(discoverWorkspaceSync(discoveryOptions), bridgeOptions) }
      registerWorkspaces?.(cache.value)
    }
    return cache.value
  }

  ctx.effect(() => ctx.tools.register({
    name: 'jetbrains_workspace',
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: summarize(value) }],
    },
    execute: async (args, exec) => {
      const input = args ?? {}
      if (typeof input.ide === 'string' && input.ide !== '') {
        const cached = report()
        const selected = cached.ides.find(ide => ide.key === input.ide)
        if (selected === undefined) {
          const known = cached.ides.map(ide => ide.key).join(', ')
          throw new Error(`no JetBrains IDE configuration "${input.ide}" (detected: ${known === '' ? 'none' : known})`)
        }
        if (selected.workspace === undefined) {
          throw new Error(`JetBrains IDE "${input.ide}" has a recent-project list but no readable project workspace`)
        }
        // The identity probe belongs to the current window; a named IDE reports its state only.
        const fresh = await discoverWorkspace({ ...discoveryOptions, probe: false })
        const probed = fresh.ides.find(ide => ide.key === input.ide)
        return toValue({ ides: [selected], current: probed ?? selected, warnings: cached.warnings }, input, settings)
      }
      // A live companion already names the product and proves the IDE is running, so the built-in
      // server probe is only needed for the disk reader.
      const live = readLiveBridge(bridgeOptions)
      const fresh = withLiveBridge(
        await discoverWorkspace({ ...discoveryOptions, probe: live === undefined }),
        bridgeOptions,
      )
      if (fresh.current === undefined) {
        const roots = discoveryOptions.configRoots.join(', ')
        throw new Error(`no JetBrains workspace state found in: ${roots === '' ? 'no configuration directory' : roots}`)
      }
      cache = { at: Date.now(), value: fresh }
      registerWorkspaces?.(fresh)
      return toValue(fresh, input, settings)
    },
    presentCall: () => ({ card: 'generic', title: 'Read JetBrains workspace', kind: 'read' }),
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'jetbrains_open_in_ide',
    description: OPEN_TOOL_DESCRIPTION,
    parameters: OPEN_PARAMETERS,
    output: {
      schema: OPEN_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `Opened ${value.path}${value.line > 0 ? `:${value.line}` : ''} in the JetBrains IDE.`,
      }],
    },
    execute: async (args, exec) => {
      const input = args ?? {}
      if (typeof input.path !== 'string' || input.path === '') {
        throw new Error('jetbrains_open_in_ide requires an absolute file path')
      }
      const bridge = readLiveBridge(bridgeOptions)
      if (bridge === undefined) {
        throw new Error(
          'no running JetBrains IDE publishes the DSH companion bridge; install and enable the '
          + 'DSH Companion IDE plugin, or restart the IDE after installing it',
        )
      }
      const line = Number.isInteger(input.line) ? input.line : 0
      const column = Number.isInteger(input.column) ? input.column : 0
      const opened = await openInIde(bridge, { path: input.path, line, column })
      return {
        opened: true,
        path: typeof opened.path === 'string' ? opened.path : input.path,
        line,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Open in JetBrains IDE', kind: 'read', rawInput: args }),
  }))

  const prompts = ctx.get('systemPrompt')
  if (settings.context && prompts !== undefined) {
    ctx.effect(() => prompts.context({
      name: 'jetbrains:workspace',
      order: settings.contextOrder,
      // Prompt assembly must never fail on IDE state: the tool reports trouble, the context stays silent.
      text: () => {
        try {
          return contextLine(report(), settings)
        } catch {
          return ''
        }
      },
    }))
  }
}

/**
 * Project one discovery report onto the tool's result value.
 * @param report - the discovery report.
 * @param input - the parsed tool arguments.
 * @param settings - resolved plugin settings, which decide the single-session directory.
 * @returns the schema-valid result value.
 */
function toValue(report, input, settings) {
  const ide = report.current
  const workspace = ide.workspace
  const includeOpenFiles = input.includeOpenFiles !== false
  const files = includeOpenFiles ? workspace.openFiles : []
  const sessionRoot = junctionRoot(workspace, settings)
  const value = {
    ide: {
      key: ide.key,
      configDir: ide.configDir,
      // The lock file proves the owning process; an answering built-in server proves the IDE
      // itself, which is the only signal available when the process table is out of reach.
      running: ide.running || ide.server !== undefined,
      ...ide.server === undefined ? {} : {
        name: ide.server.name,
        ...ide.server.buildNumber === undefined ? {} : { build: ide.server.buildNumber },
      },
    },
    workspace: {
      project: workspace.project,
      roots: workspace.roots,
      ...workspace.commonParent === undefined ? {} : { commonParent: workspace.commonParent },
      ...sessionRoot === undefined ? {} : { sessionRoot },
      ...includeOpenFiles && workspace.activeFile !== undefined ? { activeFile: workspace.activeFile } : {},
      ...includeOpenFiles && workspace.activeFile !== undefined ? {
        activeLine: workspace.activeLine ?? 0,
        activeColumn: workspace.activeColumn ?? 0,
      } : {},
      ...includeOpenFiles && workspace.selection !== undefined ? { selection: workspace.selection } : {},
      files,
      totalOpenFiles: includeOpenFiles ? workspace.totalOpenFiles : 0,
      ...workspace.stateFile === undefined ? {} : { stateFile: workspace.stateFile },
      ...workspace.stateUpdatedAt === undefined ? {} : { stateUpdatedAt: workspace.stateUpdatedAt },
    },
    ...input.allIdes === true ? {
      ides: report.ides.map(entry => ({
        key: entry.key,
        configDir: entry.configDir,
        running: entry.running,
        openedProjects: entry.projects.filter(project => project.opened).map(project => project.path),
      })),
    } : {},
    warnings: report.warnings,
  }
  return value
}

/**
 * Render the result for the model and the user.
 * @param value - the tool result value.
 * @returns one text block describing the workspace.
 */
function summarize(value) {
  const { ide, workspace } = value
  const identity = ide.name === undefined
    ? `${ide.key} (${ide.configDir})`
    : `${ide.name} [${ide.key}]`
  const lines = [`JetBrains IDE: ${identity}${ide.running ? ' — running' : ' — not currently running'}`]
  lines.push(`Workspace roots (${workspace.roots.length}):`)
  for (const root of workspace.roots) {
    const traits = [ROLE_LABELS[root.role] ?? root.role]
    if (root.git) traits.push('git')
    if (!root.exists) traits.push('MISSING')
    lines.push(`  - ${root.path} (${traits.join(', ')})`)
  }
  if (workspace.commonParent !== undefined) lines.push(`Common parent: ${workspace.commonParent}`)
  if (workspace.sessionRoot !== undefined && workspace.roots.length > 1) {
    lines.push(`Single session root: ${workspace.sessionRoot} — one session started here reaches every root above`)
  }
  if (workspace.activeFile !== undefined) {
    const position = workspace.activeLine > 0 ? `:${workspace.activeLine}:${workspace.activeColumn}` : ''
    lines.push(`Active file: ${workspace.activeFile}${position}`)
  }
  if (workspace.selection !== undefined) {
    const selection = workspace.selection.length > 200
      ? `${workspace.selection.slice(0, 200)}…`
      : workspace.selection
    lines.push(`Selected text (${workspace.selection.length} chars): ${JSON.stringify(selection)}`)
  }
  lines.push(`Open editor files: ${workspace.totalOpenFiles}`)
  for (const file of workspace.files) lines.push(`  - ${file}`)
  if (workspace.totalOpenFiles > workspace.files.length) {
    lines.push(`  … ${workspace.totalOpenFiles - workspace.files.length} more omitted`)
  }
  if (workspace.stateUpdatedAt !== undefined) lines.push(`IDE state updated: ${workspace.stateUpdatedAt}`)
  for (const warning of value.warnings) lines.push(`Warning: ${warning}`)
  return lines.join('\n')
}

/**
 * The runtime context: the window's project, its attached directories grouped by the source that
 * reported them, and the session root when it reaches beyond the project.
 *
 * It names only what changes when a project is attached or detached — never the active file, caret,
 * or selection — so switching tabs cannot invalidate the request prefix a provider has cached.
 * @param report - the discovery report.
 * @param settings - resolved plugin settings, whose junction rule and root limit shape the text.
 * @returns the context text, or an empty string when no workspace was found.
 */
function contextLine(report, settings) {
  const rootLimit = settings.contextRootLimit
  if (report.current === undefined) return ''
  const identity = report.current.server === undefined
    ? report.current.key
    : report.current.server.name
  const workspace = report.current.workspace
  const roots = workspace.roots
  // Only top-level attached directories are named; a VCS root nested inside another reported root
  // stays in the tool result, where its role label explains it.
  const attached = roots.filter(root => root.role !== 'project')
  const topLevel = attached.filter(root => !attached.some(other => other !== root && isInside(root.path, other.path)))
  // Grouped by source, so the model can tell a module's declared content root from a VCS root. The
  // text depends only on attach/detach, never on the caret or the active file.
  const groups = new Map()
  for (const root of topLevel) {
    const label = CONTEXT_ROLES[root.role] ?? root.role
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label).push(root.path)
  }
  const lines = [`Current JetBrains IDE workspace (${identity}): root project ${workspace.project}.`]
  let remaining = rootLimit
  for (const [label, paths] of groups) {
    if (remaining <= 0) break
    const named = paths.slice(0, remaining)
    remaining -= named.length
    const omitted = paths.length - named.length
    lines.push(`  ${label}: ${named.join(', ')}${omitted > 0 ? `, … ${omitted} more` : ''}`)
  }
  // The same junction rule the tool reports, so the context never disagrees with it.
  const sessionRoot = junctionRoot(workspace, settings)
  if (sessionRoot !== undefined && sessionRoot !== workspace.project) {
    lines.push(`  Session root ${sessionRoot} covers every directory above.`)
  }
  lines.push('Call jetbrains_workspace for the open editor files, the active file, and its caret.')
  return lines.join('\n')
}

/** Whether `child` lies inside `parent`. */
function isInside(child, parent) {
  const prefix = parent.endsWith('/') ? parent : `${parent}/`
  return child !== parent && child.startsWith(prefix)
}

/** An optional non-empty string config field. */
function optionalString(value, field) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') throw new Error(`jetbrains-workspace: ${field} must be a non-empty string`)
  return value
}

/** An optional string-array config field. */
function optionalStringArray(value, field) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry === '')) {
    throw new Error(`jetbrains-workspace: ${field} must be an array of non-empty strings`)
  }
  return value
}

/** An optional number-array config field. */
function optionalNumberArray(value, field) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(entry => !Number.isInteger(entry) || entry <= 0 || entry > 65_535)) {
    throw new Error(`jetbrains-workspace: ${field} must be an array of TCP port numbers`)
  }
  return value
}

/** An optional positive number config field. */
function optionalPositiveNumber(value, field) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`jetbrains-workspace: ${field} must be a positive number`)
  }
  return value
}

/** An optional positive integer config field. */
function optionalPositiveInteger(value, field) {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value <= 0) throw new Error(`jetbrains-workspace: ${field} must be a positive integer`)
  return value
}
