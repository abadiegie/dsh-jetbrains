/**
 * Portable development check for the jetbrains-workspace bundle.
 *
 * Unlike `dev/check.mjs` — the local acceptance check, which drives the tools against the IDE on this
 * machine — this one needs no IDE, no DSH, and no desktop: every input is synthetic (a fake companion
 * descriptor, a fake IDE configuration directory, a fake project with module files). It is what CI
 * runs, so a change that breaks discovery, roles, the runtime context, or the workspace registry
 * fails on a clean machine.
 *
 * Run: node dev/check-synthetic.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/plugin.js'
import { presentedPaths } from '../src/deliverables.js'

// The Harness' own validators are optional, so this check runs without a DSH installation.
const HARNESS = process.env.DSH_HARNESS_ROOT ?? '/mnt/media/project/deepseek-harness'
let validateJsonSchemaValue = () => []
let assertSupportedJsonSchema = () => {}
try {
  const validators = await import(`${HARNESS}/packages/core/tools/lib/index.js`)
  validateJsonSchemaValue = validators.validateJsonSchemaValue
  assertSupportedJsonSchema = validators.assertSupportedJsonSchema
} catch {
  console.log(`note: no DSH tool validators under ${HARNESS}; schema validation is skipped`)
}

/** A workspace-registry stub with the real one's contract. */
function createRegistry(seed = []) {
  const entries = new Map(seed.map(entry => [entry.path, {
    id: entry.id,
    path: entry.path,
    title: entry.title ?? entry.path,
    sessionIds: entry.sessionIds ?? [],
  }]))
  const created = []
  const deleted = []
  let counter = seed.length
  return {
    created,
    deleted,
    entries,
    async create(path, title) {
      const existing = entries.get(path)
      if (existing !== undefined) return existing
      const entry = { id: `ws-${++counter}`, path, title: title ?? path, sessionIds: [] }
      entries.set(path, entry)
      created.push(path)
      return entry
    },
    list: () => [...entries.values()],
    async delete(id) {
      for (const [path, entry] of entries) {
        if (entry.id !== id) continue
        entries.delete(path)
        deleted.push(path)
        return true
      }
      return false
    },
  }
}

/** Register one plugin instance against a stub context. */
function mount(config, seed, services = {}) {
  const tools = []
  const prompts = []
  const listeners = new Map()
  // A mount that names no sink would publish into the real harness home; keep every mount hermetic.
  const sink = { changesPath: join(mkdtempSync(join(tmpdir(), 'dsh-changes-sink-')), 'jetbrains-changes.json') }
  const warnings = []
  const registry = createRegistry(seed)
  const stub = {
    effect: (callback) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    on: (name, listener) => {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    logger: { warn: (message) => warnings.push(String(message)) },
    get: (name) => {
      if (name === 'systemPrompt') return { context: (entry) => { prompts.push(entry); return () => {} } }
      if (name === 'workspaceRegistry') return registry
      return services[name]
    },
  }
  apply(stub, { ...sink, ...config })
  return { tools, prompts, registry, listeners, warnings }
}

/** A companion descriptor whose pid belongs to this process, so its liveness check passes. */
function writeDescriptor(document) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-synthetic-'))
  const path = join(directory, 'jetbrains-companion.json')
  writeFileSync(path, JSON.stringify(document))
  return path
}

/** Validate one tool result against its own declared schema. */
function checkSchema(tool, value, what) {
  const violations = validateJsonSchemaValue(tool.output.schema, JSON.parse(JSON.stringify(value)), 'value')
  if (violations.length > 0) throw new Error(`${what} violates ${tool.name}.output.schema: ${violations.join('; ')}`)
  console.log(`ok: ${what} matches ${tool.name}.output.schema`)
}

const fixture = mkdtempSync(join(tmpdir(), 'dsh-synthetic-'))
const project = join(fixture, 'project')
const configRoot = join(fixture, 'IdeaIC2099.9')
for (const name of ['alpha', 'beta', 'external']) mkdirSync(join(fixture, name), { recursive: true })
mkdirSync(join(configRoot, 'options'), { recursive: true })
mkdirSync(join(project, '.idea'), { recursive: true })

// A window whose module declares two content roots beside the project, plus an external module file
// that declares none: the first pair must be reported as declared roots, the second as a fallback.
writeFileSync(join(project, '.idea', 'modules.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<project version="4"><component name="ProjectModuleManager"><modules>
<module fileurl="file://$PROJECT_DIR$/.idea/window.iml" filepath="$PROJECT_DIR$/.idea/window.iml" />
<module fileurl="file://${join(fixture, 'external', 'plain.iml')}" filepath="${join(fixture, 'external', 'plain.iml')}" />
</modules></component></project>`)
writeFileSync(join(project, '.idea', 'window.iml'), `<?xml version="1.0" encoding="UTF-8"?>
<module type="JAVA_MODULE" version="4"><component name="NewModuleRootManager">
<content url="file://$MODULE_DIR$/../alpha" />
<content url="file://$MODULE_DIR$/../beta" />
<content url="file://$MODULE_DIR$" />
</component></module>`)
writeFileSync(join(fixture, 'external', 'plain.iml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<module type="JAVA_MODULE" version="4"><component name="NewModuleRootManager" /></module>')
writeFileSync(join(configRoot, 'options', 'recentProjects.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<application><component name="RecentProjectsManager"><option name="additionalInfo"><map>
<entry key="${project}"><value><RecentProjectMetaInfo opened="true">
<option name="activationTimestamp" value="1" />
</RecentProjectMetaInfo></value></entry>
</map></option></component></application>`)

const instance = mount({
  probe: false, liveBridge: false, home: fixture, configRoots: [fixture],
})
const workspaceTool = instance.tools.find(tool => tool.name === 'jetbrains_workspace')
if (instance.tools.length !== 2) throw new Error(`registered the wrong tool set: ${instance.tools.map(t => t.name)}`)
for (const tool of instance.tools) {
  assertSupportedJsonSchema(tool.parameters)
  assertSupportedJsonSchema(tool.output.schema)
}

const value = await workspaceTool.execute({}, {})
checkSchema(workspaceTool, value, 'synthetic snapshot')
const roles = new Map(value.workspace.roots.map(root => [root.path, root.role]))
if (roles.get(join(fixture, 'alpha')) !== 'module' || roles.get(join(fixture, 'beta')) !== 'module') {
  throw new Error(`module content roots were not read from the .iml: ${JSON.stringify([...roles])}`)
}
if (roles.get(join(fixture, 'external')) !== 'module-dir') {
  throw new Error(`a module without content roots did not fall back to its directory: ${JSON.stringify([...roles])}`)
}
if (roles.has(join(project, '.idea'))) throw new Error('a content root inside the project was attached')
console.log('module roots: declared and fallback roles both reported')

const context = instance.prompts[0].text()
if (!context.includes('module content roots (declared in the module .iml): '
  + join(fixture, 'alpha') + ', ' + join(fixture, 'beta'))) {
  throw new Error('the runtime context does not name the module content roots by source:\n' + context)
}
if (!context.includes('module directories (no content root declared): ' + join(fixture, 'external'))) {
  throw new Error('the runtime context does not name the module-directory fallback:\n' + context)
}
console.log('runtime context:\n' + context.split('\n').map(line => '  ' + line).join('\n'))

// The context must not move with the caret or the open files: a provider caches the request prefix.
const snapshot = {
  product: 'IC',
  productName: 'IntelliJ IDEA 2099.9',
  build: 'IC-2099.9',
  projects: [{ name: 'window', path: project, roots: [project, join(fixture, 'alpha')] }],
  active: { path: join(project, 'one.py'), line: 1, column: 1, selection: '' },
  openFiles: [join(project, 'one.py')],
  updatedAt: new Date().toISOString(),
}
/** One synthetic companion descriptor around a workspace snapshot. */
const descriptor = (workspace) => ({
  version: 1,
  source: 'jetbrains-companion',
  port: 1,
  token: 'synthetic-token',
  pid: process.pid,
  workspace,
})
const stableA = writeDescriptor(descriptor(snapshot))
const stableB = writeDescriptor(descriptor({
  ...snapshot,
  active: { path: join(project, 'two.py'), line: 90, column: 3, selection: 'picked' },
  openFiles: [join(project, 'two.py'), join(project, 'three.py')],
}))
const textA = mount({ bridgePath: stableA }).prompts[0].text()
const textB = mount({ bridgePath: stableB }).prompts[0].text()
if (textA !== textB) throw new Error('the runtime context moved with the caret or the open files')
if (textA.includes('Session root')) {
  throw new Error('a root-project junction claimed a session root wider than the project')
}

// A common-parent junction is the one case that announces the session root, because it reaches
// beyond the project.
const wideContext = mount({ bridgePath: stableA, junctionRoot: 'common-parent' }).prompts[0].text()
if (!wideContext.includes(`Session root ${fixture} covers every directory above.`)) {
  throw new Error('a common-parent junction did not announce its session root:\n' + wideContext)
}
console.log('the context is stable across caret and tab changes, and announces the window junction')

// Deleting a user's workspace is opt-in and refused for a common-parent junction.
const seeds = [
  { id: 'seed-backend', path: join(fixture, 'alpha'), sessionIds: [] },
  { id: 'seed-other', path: join(fixture, 'beta'), sessionIds: ['session-x'] },
]
const untouched = mount({ bridgePath: stableA }, seeds)
await untouched.tools.find(tool => tool.name === 'jetbrains_workspace').execute({}, {})
await new Promise(resolve => setTimeout(resolve, 200))
if (untouched.registry.deleted.length !== 0) throw new Error('the default pruned a user workspace')
const refused = mount({ bridgePath: stableA, pruneProjectWorkspaces: true, junctionRoot: 'common-parent' }, seeds)
await refused.tools.find(tool => tool.name === 'jetbrains_workspace').execute({}, {})
await new Promise(resolve => setTimeout(resolve, 200))
if (refused.registry.deleted.length !== 0) throw new Error('a common-parent junction pruned a workspace')
console.log('nothing is deleted by default, and a common-parent junction refuses even when opted in')

// 7. The review document an IDE-side panel reads: coordinates for the change recorder, which lives in
//    this Host process and keeps nothing across restarts.
const changesDirectory = mkdtempSync(join(tmpdir(), 'dsh-changes-'))
const changesPath = join(changesDirectory, 'jetbrains-changes.json')
const summaries = new Map()
const changesPlugin = mount(
  { probe: false, liveBridge: false, home: fixture, configRoots: [fixture], changesPath },
  undefined,
  { workspaceChanges: { summary: (session, seq) => summaries.get(`${session}:${seq}`) } })

/** Read the published document. */
const published = () => JSON.parse(readFileSync(changesPath, 'utf8'))
if (published().sessions.length !== 0) throw new Error('a fresh mount must publish an empty review')
if (published().source !== 'jetbrains-workspace' || published().version !== 1) {
  throw new Error('the document must carry a source marker and a version')
}
if (!changesPlugin.listeners.has('session/event')) throw new Error('the publisher must listen to session events')

const sessionA = { header: { id: 'session-a', cwd: '/work/a' } }
const announce = (session, seq, turn) => changesPlugin.listeners.get('session/event')(session, {
  type: 'workspace/changes', seq, data: { turn },
})

// An event whose summary the recorder has not stored yet must not publish a broken entry.
announce(sessionA, 42, 3)
await new Promise(resolve => setTimeout(resolve, 320))
if (published().sessions.length !== 0) throw new Error('an unknown summary must not be published')

summaries.set('session-a:42', {
  turn: 3, total: 2, added: 12, deleted: 4,
  files: [
    { path: 'src/a.js', display: 'src/a.js', added: 10, deleted: 4 },
    { path: '/tmp/b.md', display: '/tmp/b.md', added: 2, deleted: 0 },
  ],
})
announce(sessionA, 42, 3)
const first = published().sessions
if (first.length !== 1) throw new Error(`one announced turn must publish one session, got ${first.length}`)
if (first[0].seq !== 42 || first[0].turn !== 3 || first[0].cwd !== '/work/a') {
  throw new Error(`the entry must carry the coordinates: ${JSON.stringify(first[0])}`)
}
if (first[0].total !== 2 || first[0].added !== 12 || first[0].deleted !== 4) {
  throw new Error(`the entry must carry the totals: ${JSON.stringify(first[0])}`)
}
if (first[0].files.length !== 2 || first[0].files[1].path !== '/tmp/b.md') {
  throw new Error(`the entry must carry every changed file: ${JSON.stringify(first[0].files)}`)
}

// Another session joins, newest first; a later turn of the same session replaces its entry.
summaries.set('session-b:7', {
  turn: 1, cwd: '/from-summary', total: 1, added: 1, deleted: 0, files: [{ path: 'x', display: 'x' }],
})
announce({ header: { id: 'session-b', cwd: '/work/b' } }, 7, 1)
summaries.set('session-a:43', { turn: 4, total: 1, added: 3, deleted: 1, files: [{ path: 'src/a.js', display: 'src/a.js' }] })
announce(sessionA, 43, 4)
const both = published().sessions
if (both.length !== 2) throw new Error(`two sessions must stay two entries, got ${both.length}`)
if (both[0].sessionId !== 'session-a' || both[0].seq !== 43) {
  throw new Error(`the newest turn must replace its session entry: ${JSON.stringify(both.map(entry => entry.sessionId + ':' + entry.seq))}`)
}
if (both[1].sessionId !== 'session-b') throw new Error('the other session must stay published')
if (both[1].cwd !== '/from-summary') throw new Error('the summary\'s own cwd must win over the session header')

// Events that are not change announcements are ignored, and no temporary file is left behind.
changesPlugin.listeners.get('session/event')(sessionA, { type: 'turn/end', seq: 44, data: { turn: 4 } })
if (published().sessions.length !== 2) throw new Error('a non-change event must not publish')
if (existsSync(`${changesPath}.tmp`)) throw new Error('the write must leave no temporary file behind')
console.log('the review document carries each turn\'s coordinates, replaces a session entry, and stays atomic')

// 8. Presenting a file: with `autoOpenDeliverables` the window's own session opens it through the
//    companion bridge, and nothing else does.
const requests = []
const bridge = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    requests.push({ url: request.url, authorization: request.headers.authorization, body: body === '' ? {} : JSON.parse(body) })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"ok":true}')
  })
})
await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve))
const bridgePort = bridge.address().port
const deliveringDescriptor = writeDescriptor({
  version: 1, source: 'jetbrains-companion', port: bridgePort, token: 'delivery-token', pid: process.pid,
  workspace: {
    product: 'IC', productName: 'IntelliJ IDEA 2099.9', build: 'IC-2099.9',
    projects: [{ name: 'window', path: project, roots: [project] }],
    openFiles: [], updatedAt: new Date().toISOString(),
  },
})

// `presentedPaths` keeps only what it serves.
if (presentedPaths({ type: 'turn/end', data: { files: [{ path: '/a' }] } }).length !== 0) {
  throw new Error('a non-present event must name nothing')
}
if (presentedPaths({ type: 'deliverables/presented', data: { files: [{ path: ' /a ' }, { name: 'no path' }, { path: '' }] } }).length !== 1) {
  throw new Error('only entries with a non-empty path are presentable')
}

const deliver = mount(
  { probe: false, liveBridge: true, home: fixture, configRoots: [fixture], bridgePath: deliveringDescriptor, autoOpenDeliverables: true },
  undefined, {})
const announceDelivery = (session, paths) => deliver.listeners.get('session/event')(session, {
  type: 'deliverables/presented', seq: 90, data: { turn: 2, files: paths.map(path => ({ path })) },
})

announceDelivery({ header: { id: 'session-window', cwd: project } }, ['/tmp/report.pdf', '/tmp/table.xlsx'])
await new Promise(resolve => setTimeout(resolve, 300))
if (requests.length !== 2) throw new Error(`the window's session must open both presented files, got ${requests.length}`)
if (requests[0].url !== '/open' || requests[0].authorization !== 'Bearer delivery-token') {
  throw new Error(`an open must carry the bridge token: ${JSON.stringify(requests[0])}`)
}
if (requests[0].body.path !== '/tmp/report.pdf' || requests[1].body.path !== '/tmp/table.xlsx') {
  throw new Error(`an open must name the presented file: ${JSON.stringify(requests.map(entry => entry.body))}`)
}

// A session this IDE window does not own stays closed, and a composition without the opt-in never opens.
announceDelivery({ header: { id: 'session-elsewhere', cwd: '/tmp' } }, ['/tmp/other.pdf'])
await new Promise(resolve => setTimeout(resolve, 300))
if (requests.length !== 2) throw new Error('a session outside the IDE window must not open tabs')
const silent = mount(
  { probe: false, liveBridge: true, home: fixture, configRoots: [fixture], bridgePath: deliveringDescriptor },
  undefined, {})
silent.listeners.get('session/event')(
  { header: { id: 'session-window', cwd: project } },
  { type: 'deliverables/presented', seq: 91, data: { turn: 3, files: [{ path: '/tmp/quiet.pdf' }] } })
await new Promise(resolve => setTimeout(resolve, 300))
if (requests.length !== 2) throw new Error('auto-open must stay off unless the row asks for it')
await new Promise(resolve => bridge.close(resolve))
console.log('a presented file opens in the IDE for the window session, and only when the row opts in')

console.log('\nsynthetic check: discovery, roles, context, stability, and registration all check out')
