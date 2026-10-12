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
import { OPEN_ROUTE_PATH } from '../src/open-route.js'

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
  const listenerOptions = new Map()
  // A mount that names no sink would publish into the real harness home; keep every mount hermetic.
  const sink = { changesPath: join(mkdtempSync(join(tmpdir(), 'dsh-changes-sink-')), 'jetbrains-changes.json') }
  const warnings = []
  const disposers = []
  const registry = createRegistry(seed)
  const pendingInjects = []
  /** Run one pending inject callback against the services available now. */
  const runInject = (names, callback) => {
    const child = {
      effect: (effectCallback) => {
        const disposer = effectCallback()
        const cleanup = typeof disposer === 'function' ? disposer : () => {}
        disposers.push(cleanup)
        return cleanup
      },
      logger: { warn: (message) => warnings.push(String(message)) },
      get: (name) => services[name],
    }
    for (const name of names) child[name] = services[name]
    const returned = callback(child)
    if (typeof returned === 'function') disposers.push(returned)
  }
  const stub = {
    effect: (callback) => {
      const disposer = callback()
      const cleanup = typeof disposer === 'function' ? disposer : () => {}
      disposers.push(cleanup)
      return cleanup
    },
    // Mirrors Cordis: the callback runs when every named service exists, and waits when one does not.
    inject: (names, callback) => {
      if (names.every(name => services[name] !== undefined)) runInject(names, callback)
      else pendingInjects.push({ names, callback })
      return () => {}
    },
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    on: (name, listener, options) => {
      listeners.set(name, listener)
      listenerOptions.set(name, options)
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
  return {
    tools, prompts, registry, listeners, listenerOptions, warnings, disposers,
    /** Names whose inject callback is still waiting for a service. */
    pending: () => pendingInjects.map(entry => entry.names.join(',')),
    /** Make services appear, as another row mounting later would, and run callbacks that now can. */
    settle: (patch) => {
      Object.assign(services, patch)
      for (let index = pendingInjects.length - 1; index >= 0; index -= 1) {
        const entry = pendingInjects[index]
        if (entry.names.every(name => services[name] !== undefined)) {
          pendingInjects.splice(index, 1)
          runInject(entry.names, entry.callback)
        }
      }
    },
  }
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
// Listening shape matters: an unexpected listener option silences the feed rather than erroring, which
// is how this pass first shipped and published nothing while change events kept arriving.
if (changesPlugin.listenerOptions.get('session/event') !== undefined) {
  throw new Error('the publisher must register its listener the way the shipped listeners do: no options')
}
const recorderless = mount({ probe: false, liveBridge: false, home: fixture, configRoots: [fixture] })
recorderless.listeners.get('session/event')({ header: { id: 'session-x', cwd: '/w' } }, { type: 'workspace/changes', seq: 1, data: { turn: 1 } })
if (!recorderless.warnings.some(warning => warning.includes('no change recorder'))) {
  throw new Error('a composition without a change recorder must say so instead of staying silent')
}

const sessionA = { header: { id: 'session-a', cwd: '/work/a' } }
const announce = (session, seq, turn) => changesPlugin.listeners.get('session/event')(session, {
  type: 'workspace/changes', seq, data: { turn },
})

// An event whose summary the recorder has not stored yet must not publish a broken entry.
announce(sessionA, 42, 3)
await new Promise(resolve => setTimeout(resolve, 320))
if (published().sessions.length !== 0) throw new Error('an unknown summary must not be published')
if (!changesPlugin.warnings.some(warning => warning.includes('has no summary'))) {
  throw new Error('a summary that never arrives must be reported, not silently dropped')
}

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

if (deliver.listenerOptions.get('session/event') !== undefined) {
  throw new Error('the auto-open listener must register without options too')
}
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

// 9. A click in the DSH UI opens the file in the IDE: the host's replaceable default opener
//    (`sessionController.openPath`) is wrapped while a companion bridge is live, and the desktop opener
//    still runs when no IDE answers.
let refuseClick = false
const clicks = []
const clickServer = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    clicks.push({ url: request.url, authorization: request.headers.authorization, body: body === '' ? {} : JSON.parse(body) })
    if (refuseClick) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end('{"ok":false,"error":"refused"}')
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"ok":true}')
  })
})
await new Promise(resolve => clickServer.listen(0, '127.0.0.1', resolve))
const clickDescriptor = writeDescriptor({
  version: 1, source: 'jetbrains-companion', port: clickServer.address().port, token: 'click-token',
  pid: process.pid,
  workspace: {
    product: 'IC', productName: 'IntelliJ IDEA 2099.9', build: 'IC-2099.9',
    projects: [{ name: 'window', path: project, roots: [project] }],
    openFiles: [], updatedAt: new Date().toISOString(),
  },
})

/** A sessionController stub that records every desktop open it is asked for. */
const controller = { opens: [], openPath: async (path) => { controller.opens.push(path) } }
const originalOpenPath = controller.openPath
const clickOptions = { probe: false, home: fixture, configRoots: [fixture] }

// The session controller belongs to another row and may mount after this plugin applies: the wrap must
// wait for it. A static stub hid exactly this, which is how the first version shipped wrapping nothing.
const clicking = mount({ ...clickOptions, bridgePath: clickDescriptor }, undefined, {})
if (clicking.pending().length === 0) throw new Error('the opener wrap must wait for the session controller')
if (clicking.warnings.length !== 0) throw new Error('waiting for a service is not a warning')
clicking.settle({ sessionController: controller })
if (controller.openPath === originalOpenPath) throw new Error('once the controller appears the opener must be wrapped')

await controller.openPath('/work/a.md', AbortSignal.timeout(2_000))
if (clicks.length !== 1 || clicks[0].url !== '/open' || clicks[0].authorization !== 'Bearer click-token') {
  throw new Error(`a desktop open must go to the bridge with its token: ${JSON.stringify(clicks)}`)
}
if (clicks[0].body.path !== '/work/a.md') throw new Error(`the bridge must be asked for the clicked path: ${JSON.stringify(clicks[0].body)}`)
if (controller.opens.length !== 0) throw new Error('an IDE open must replace the desktop opener, not duplicate it')

refuseClick = true
await controller.openPath('/work/b.md', AbortSignal.timeout(2_000))
if (controller.opens.length !== 1 || controller.opens[0] !== '/work/b.md') {
  throw new Error('a refused IDE open must fall back to the desktop opener')
}
refuseClick = false

// Disposal restores the opener, which the next case depends on: mounts wrap whatever is current, so
// leaving this one in place would let its bridge answer for the case that must have none.
clicking.disposers.forEach(dispose => dispose())
if (controller.openPath !== originalOpenPath) throw new Error('disposal must restore the original opener')

// No IDE publishing a bridge: the desktop opener keeps the click.
const native = mount({ ...clickOptions, liveBridge: false }, undefined, { sessionController: controller })
await controller.openPath('/work/c.md', AbortSignal.timeout(2_000))
if (controller.opens.length !== 2 || controller.opens[1] !== '/work/c.md') {
  throw new Error(`without a bridge the desktop opener must still run: ${JSON.stringify(controller.opens)}`)
}
native.disposers.forEach(dispose => dispose())
if (controller.openPath !== originalOpenPath) throw new Error('disposal must restore the opener after the unbridged case')

// The opt-out leaves the opener alone.
const untouchedOpener = mount({ ...clickOptions, liveBridge: false, openInIde: false }, undefined, { sessionController: controller })
if (controller.openPath !== originalOpenPath) throw new Error('openInIde: false must not wrap the opener')
untouchedOpener.disposers.forEach(dispose => dispose())
console.log('a click opens the file in the IDE, falls back to the desktop opener, and is restored on disposal')
// 10. The route the client half asks: it resolves a session-relative path through the Host filesystem and
//     hands the absolute path to the bridge, and it declines — so the Sidebar keeps the click — whenever it
//     cannot serve the request.
const routes = []
const statCalls = []
const routeServices = {
  connection: {
    fetch: {
      register: (definition) => {
        // The shipped routes use this fetch-shaped table; webServer.register takes a Node (req, res) handler
        // and a route registered there never answers.
        if (typeof definition?.fetch !== 'function' || definition?.requestBody !== 'buffered' || !Array.isArray(definition?.methods)) {
          throw new Error(`the open route must be fetch-shaped: ${JSON.stringify(Object.keys(definition ?? {}))}`)
        }
        routes.push(definition)
        return () => {}
      },
    },
  },
  sessions: { list: () => [{ header: { id: 'session-ab', cwd: project } }] },
  workspaceFiles: {
    stat: async (scope, path) => {
      statCalls.push({ scope, path })
      return { absolutePath: join(project, path) }
    },
  },
}
const routed = mount({ ...clickOptions, bridgePath: clickDescriptor }, undefined, routeServices)
const route = routes.find(entry => entry.path === OPEN_ROUTE_PATH)
if (route === undefined) throw new Error(`the open route must be registered at ${OPEN_ROUTE_PATH}`)
if (!route.methods.includes('POST')) throw new Error('the open route serves POST')

/** Call the registered route the way the client half does. */
const callRoute = async (body) => route.fetch(new Request(`http://127.0.0.1:3080${OPEN_ROUTE_PATH}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}))

const served = await callRoute({ sessionId: 'session-ab', path: 'notes/plan.md', line: 12 })
if (served.status !== 204) throw new Error(`an in-workspace file must open in the IDE, got ${served.status}`)
const lastSent = clicks[clicks.length - 1]
if (lastSent.body.path !== join(project, 'notes/plan.md') || lastSent.body.line !== 12) {
  throw new Error(`the bridge must be asked for the resolved absolute path and its line: ${JSON.stringify(lastSent.body)}`)
}
if (statCalls.length !== 1 || statCalls[0].scope.workspaceRoot !== project || statCalls[0].path !== 'notes/plan.md') {
  throw new Error(`the session workspace root must resolve the path: ${JSON.stringify(statCalls)}`)
}

const absolute = await callRoute({ path: '/tmp/report final.pdf' })
if (absolute.status !== 204) throw new Error('an absolute path must open without a session')
if (statCalls.length !== 1) throw new Error('an absolute path must not be resolved against a session')
if (clicks[clicks.length - 1].body.path !== '/tmp/report final.pdf') {
  throw new Error(`an absolute path must travel as written: ${clicks[clicks.length - 1].body.path}`)
}

if ((await callRoute({})).status !== 400) throw new Error('a request without a path must be refused')
refuseClick = true
if ((await callRoute({ path: '/tmp/refused.md' })).status !== 502) throw new Error('an IDE refusal must be reported, not swallowed')
refuseClick = false
routed.disposers.forEach(dispose => dispose())

// Without a bridge the route declines with 409, which is what keeps a click in the Sidebar.
routes.length = 0
const unrouted = mount({ ...clickOptions, liveBridge: false }, undefined, routeServices)
const declining = routes.find(entry => entry.path === OPEN_ROUTE_PATH)
const declined = await declining.fetch(new Request(`http://127.0.0.1:3080${OPEN_ROUTE_PATH}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/tmp/any.md' }),
}))
if (declined.status !== 409) throw new Error(`without a bridge the route must decline with 409, got ${declined.status}`)
unrouted.disposers.forEach(dispose => dispose())
console.log('the open route resolves a session path, opens it in the IDE, and declines when it cannot')

await new Promise(resolve => clickServer.close(resolve))

console.log('\nsynthetic check: discovery, roles, context, stability, and registration all check out')
