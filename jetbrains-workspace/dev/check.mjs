/**
 * Development check for the jetbrains-workspace bundle: registers the plugin against a stub context,
 * validates both tool schemas with the Harness' own validators, runs the tools against this machine's
 * IDE state, exercises the live companion bridge against a fake one, drives the workspace registry
 * through a stub, and prints what the model sees.
 *
 * Run: node dev/check.mjs
 */

import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/plugin.js'

// The Harness' own validators live in a DSH checkout or installation. They are optional: without
// them the check still exercises discovery, roles, the runtime context, and the registry, and says
// that it skipped schema validation instead of failing on an import it cannot resolve.
const HARNESS = process.env.DSH_HARNESS_ROOT ?? '/mnt/media/project/deepseek-harness'
let validateJsonSchemaValue = () => []
let assertSupportedJsonSchema = () => {}
try {
  const validators = await import(`${HARNESS}/packages/core/tools/lib/index.js`)
  validateJsonSchemaValue = validators.validateJsonSchemaValue
  assertSupportedJsonSchema = validators.assertSupportedJsonSchema
} catch {
  console.log(`note: no DSH tool validators under ${HARNESS}; schema validation is skipped`)
  console.log('      set DSH_HARNESS_ROOT to a DSH checkout or installation to enable it')
}

/**
 * A workspace-registry stub with the real one's contract: `create` is idempotent per path, `list`
 * returns entities carrying their session ids, and `delete` removes one.
 * @param seed - pre-existing workspaces.
 * @returns the stub, with the paths it created and deleted.
 */
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

/**
 * Register one plugin instance against a stub context.
 * @param config - the row config.
 * @param seed - pre-existing workspaces the registry starts with.
 * @returns the registered tools, the runtime contexts, and the registry stub.
 */
function mount(config, seed) {
  const tools = []
  const prompts = []
  const warnings = []
  const registry = createRegistry(seed)
  const stub = {
    effect: (callback) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    // The review publisher registers a session listener at apply; `ctx.on` must exist even here.
    on: () => () => {},
    // Services this check does not model (the web route and the desktop opener wait for theirs).
    inject: () => () => {},
    logger: { warn: (message) => { warnings.push(String(message)) }, info: () => {} },
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    get: (name) => {
      if (name === 'systemPrompt') return { context: (entry) => { prompts.push(entry); return () => {} } }
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
  }
  // A temporary review document: this check must never write the real DSH home, which an earlier
  // version of it did.
  apply(stub, { changesPath: join(tmpdir(), `dsh-check-changes-${process.pid}.json`), ...config })
  return { tools, prompts, registry, warnings }
}

/** A companion descriptor whose pid belongs to this process, so the liveness check passes. */
function writeDescriptor(document) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-companion-'))
  const path = join(directory, 'jetbrains-companion.json')
  writeFileSync(path, JSON.stringify(document))
  return path
}

const snapshotWorkspace = {
  version: 1,
  source: 'jetbrains-companion',
  product: 'IC',
  productName: 'IntelliJ IDEA 2026.1.4',
  build: 'IC-261.26222.65',
  pid: process.pid,
  projects: [
    { name: 'bi-app-v2', path: '/mnt/media/project/bi-app-v2', roots: ['/mnt/media/project/bi-app-v2', '/mnt/media/project/bi-backend'] },
  ],
  active: { path: '/mnt/media/project/bi-backend/processing/main.py', line: 321, column: 5, selection: 'def main():' },
  openFiles: ['/mnt/media/project/bi-backend/processing/main.py', '/mnt/media/project/bi-app-v2/README.md'],
  updatedAt: '2026-10-08T17:30:00Z',
}

const bridgePath = writeDescriptor({
  version: 1,
  source: 'jetbrains-companion',
  port: 1,
  token: 'live-token',
  pid: process.pid,
  workspace: snapshotWorkspace,
})

const live = mount({ bridgePath })
const workspaceTool = live.tools.find(tool => tool.name === 'jetbrains_workspace')
const openTool = live.tools.find(tool => tool.name === 'jetbrains_open_in_ide')
if (workspaceTool === undefined || openTool === undefined) throw new Error('plugin registered the wrong tool set')
for (const tool of [workspaceTool, openTool]) {
  assertSupportedJsonSchema(tool.parameters)
  assertSupportedJsonSchema(tool.output.schema)
}
console.log(`registered tools: ${live.tools.map(tool => tool.name).join(', ')}`)

const exec = { signal: AbortSignal.timeout(10_000) }

// 1. The live companion wins over the disk reader, and its editor position reaches the result.
const liveValue = await workspaceTool.execute({}, exec)
checkSchema(workspaceTool, liveValue, 'live snapshot')
if (!liveValue.ide.name.includes('IntelliJ IDEA')) throw new Error('live product name missing')
const liveRoots = liveValue.workspace.roots.map(root => root.path)
if (liveRoots[0] !== '/mnt/media/project/bi-app-v2') throw new Error(`root project is not first: ${liveRoots[0]}`)
if (!liveRoots.includes('/mnt/media/project/bi-backend')) throw new Error('attached project missing from the live snapshot')
if (liveValue.workspace.activeLine !== 321) throw new Error('caret line missing from the live snapshot')
if (liveValue.workspace.selection !== 'def main():') throw new Error('selection missing from the live snapshot')
console.log('\n=== live snapshot (current window) ===')
console.log(workspaceTool.output.render({}, liveValue)[0].text)

// 2. The runtime context names the live workspace.
console.log('\n=== runtime context ===')
console.log(live.prompts[0].text() || '(empty)')

// 3. Open-in-IDE posts to the bridge with the token and reports what it opened.
const requests = []
const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body || '{}') })
    if (request.headers.authorization !== 'Bearer live-token') {
      response.writeHead(403).end('{"ok":false,"error":"forbidden"}')
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, path: JSON.parse(body || '{}').path }))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const bridgedPath = writeDescriptor({
  version: 1,
  source: 'jetbrains-companion',
  port,
  token: 'live-token',
  pid: process.pid,
  workspace: snapshotWorkspace,
})
const bridged = mount({ bridgePath: bridgedPath })
const bridgedOpen = bridged.tools.find(tool => tool.name === 'jetbrains_open_in_ide')
const opened = await bridgedOpen.execute({ path: '/mnt/media/project/bi-app-v2/app/Http/Kernel.php', line: 42, column: 7 }, exec)
checkSchema(bridgedOpen, opened, 'open result')
if (requests.length !== 1) throw new Error(`expected one bridge request, got ${requests.length}`)
if (requests[0].url !== '/open' || requests[0].authorization !== 'Bearer live-token') {
  throw new Error(`unexpected bridge request: ${JSON.stringify(requests[0])}`)
}
if (requests[0].body.line !== 42 || requests[0].body.column !== 7) {
  throw new Error(`caret did not travel: ${JSON.stringify(requests[0].body)}`)
}
console.log(`\nopen-in-IDE: ${bridgedOpen.output.render({}, opened)[0].text}`)
await new Promise(resolve => server.close(resolve))

// 4. With the live bridge disabled the disk reader answers and open-in-IDE refuses clearly.
const offline = mount({ liveBridge: false })
const offlineTool = offline.tools.find(tool => tool.name === 'jetbrains_workspace')
const offlineValue = await offlineTool.execute({}, exec)
checkSchema(offlineTool, offlineValue, 'disk snapshot')
if (offlineValue.ide.configDir.startsWith('live bridge')) {
  throw new Error('the disk path reported the live companion descriptor it did not read')
}
console.log("\n=== disk snapshot (live bridge disabled) ===")
console.log(`${offlineValue.workspace.roots.length} roots from the IDE state files, ide ${offlineValue.ide.key}`)
const refused = await offline.tools
  .find(tool => tool.name === 'jetbrains_open_in_ide')
  .execute({ path: '/tmp/x.txt' }, exec)
  .then(() => undefined, error => error)
if (!(refused instanceof Error) || !refused.message.includes('companion bridge')) {
  throw new Error(`open without a bridge did not refuse clearly: ${refused}`)
}
console.log(`open without a bridge: ${refused.message}`)

// 5. One session per project: the root project is registered, and the sessionless per-project
//    entries an earlier generation created are pruned while one with history is never touched.
await new Promise(resolve => setTimeout(resolve, 200))
const junction = liveValue.workspace.sessionRoot
if (junction !== '/mnt/media/project/bi-app-v2') throw new Error(`session root is not the root project: ${junction}`)
if (live.registry.created.length !== 1 || live.registry.created[0] !== junction) {
  throw new Error(`single mode must register exactly the root project, created: ${live.registry.created}`)
}
if (live.registry.entries.get(junction).title !== 'JetBrains workspace (bi-app-v2)') {
  throw new Error(`unexpected workspace title: ${live.registry.entries.get(junction).title}`)
}
console.log(`\nsingle-session mode: registered ${junction} (the root project)`)

// 5. Deletion of a user's workspace is opt-in and never runs by default: a workspace's `sessionIds`
//    is a filtered projection, so "reports no sessions" is not proof that it holds none.
const seeds = [
  { id: 'seed-backend', path: '/mnt/media/project/bi-backend', sessionIds: [] },
  { id: 'seed-odyssey', path: '/mnt/media/project/odyssey-app', sessionIds: ['session-x'] },
  { id: 'seed-home', path: '/home/gilang', sessionIds: [] },
]
const untouched = mount({ bridgePath }, seeds)
await untouched.tools.find(tool => tool.name === 'jetbrains_workspace').execute({}, exec)
await new Promise(resolve => setTimeout(resolve, 200))
if (untouched.registry.deleted.length !== 0) {
  throw new Error(`the default pruned a user workspace: ${untouched.registry.deleted}`)
}
console.log('\nthe default registers the junction and deletes nothing')

// 5a. Opted in with the default root-project junction, it removes only a sessionless project
//     workspace of the window, and never one that holds a session or belongs to something else.
const seeded = mount({ bridgePath, pruneProjectWorkspaces: true }, seeds)
await seeded.tools.find(tool => tool.name === 'jetbrains_workspace').execute({}, exec)
await new Promise(resolve => setTimeout(resolve, 200))
if (seeded.registry.deleted.join(',') !== '/mnt/media/project/bi-backend') {
  throw new Error(`pruning removed the wrong workspaces: ${seeded.registry.deleted}`)
}
if (!seeded.registry.entries.has('/mnt/media/project/odyssey-app')) {
  throw new Error('a workspace holding a session was pruned')
}
if (!seeded.registry.entries.has('/home/gilang')) throw new Error('an unrelated workspace was pruned')
console.log(`prune opted in with a root-project junction: ${seeded.registry.deleted.join(', ')}`)

// 5a2. A common-parent junction makes every project workspace of the window a candidate, so even
//      with pruning opted in the plugin refuses: one misread there is the user's registration.
const refusedPrune = mount({ bridgePath, pruneProjectWorkspaces: true, junctionRoot: 'common-parent' }, seeds)
await refusedPrune.tools.find(tool => tool.name === 'jetbrains_workspace').execute({}, exec)
await new Promise(resolve => setTimeout(resolve, 200))
if (refusedPrune.registry.deleted.length !== 0) {
  throw new Error(`a common-parent junction pruned a workspace: ${refusedPrune.registry.deleted}`)
}
if (!refusedPrune.registry.entries.has('/mnt/media/project/bi-backend')) {
  throw new Error('a common-parent junction removed a project workspace')
}
console.log('a common-parent junction refuses to prune, even opted in')

// 6. A module's own content roots are attached projects: one module file can name several content
//    roots in unrelated directories, which is exactly what `modules.xml` alone cannot tell us.
const fixture = mkdtempSync(join(tmpdir(), 'dsh-module-roots-'))
const fixtureProject = join(fixture, 'project')
const fixtureConfig = join(fixture, 'IdeaIC2099.9')
mkdirSync(join(fixtureConfig, 'options'), { recursive: true })
mkdirSync(join(fixtureProject, '.idea'), { recursive: true })
for (const name of ['alpha', 'beta']) mkdirSync(join(fixture, name), { recursive: true })
writeFileSync(join(fixtureProject, '.idea', 'modules.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<project version="4"><component name="ProjectModuleManager"><modules>
<module fileurl="file://$PROJECT_DIR$/.idea/window.iml" filepath="$PROJECT_DIR$/.idea/window.iml" />
<module fileurl="file://${join(fixture, 'external', 'plain.iml')}" filepath="${join(fixture, 'external', 'plain.iml')}" />
</modules></component></project>`)
writeFileSync(join(fixtureProject, '.idea', 'window.iml'), `<?xml version="1.0" encoding="UTF-8"?>
<module type="JAVA_MODULE" version="4"><component name="NewModuleRootManager">
<content url="file://$MODULE_DIR$/../alpha" />
<content url="file://$MODULE_DIR$/../beta" />
<content url="file://$MODULE_DIR$" />
</component></module>`)
//    A second module file lives outside the project and declares no content root at all: the module
//    directory is then the implicit root, and it is reported as such rather than as a declared one.
mkdirSync(join(fixture, 'external'), { recursive: true })
writeFileSync(join(fixture, 'external', 'plain.iml'), `<?xml version="1.0" encoding="UTF-8"?>
<module type="JAVA_MODULE" version="4"><component name="NewModuleRootManager" /></module>`)
writeFileSync(join(fixtureConfig, 'options', 'recentProjects.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<application><component name="RecentProjectsManager"><option name="additionalInfo"><map>
<entry key="${fixtureProject}"><value><RecentProjectMetaInfo opened="true">
<option name="activationTimestamp" value="1" />
</RecentProjectMetaInfo></value></entry>
</map></option></component></application>`)
const fixtureInstance = mount({
  probe: false, liveBridge: false, home: fixture, configRoots: [fixture], bridgePath,
})
const fixtureValue = await fixtureInstance.tools.find(tool => tool.name === 'jetbrains_workspace').execute({}, exec)
const fixtureRoots = new Map(fixtureValue.workspace.roots.map(root => [root.path, root.role]))
if (fixtureRoots.get(join(fixture, 'alpha')) !== 'module' || fixtureRoots.get(join(fixture, 'beta')) !== 'module') {
  throw new Error(`module content roots were not read: ${JSON.stringify([...fixtureRoots])}`)
}
if (fixtureRoots.has(join(fixtureProject, '.idea'))) {
  throw new Error('a module content root inside the project was attached as a project of its own')
}
if (fixtureRoots.get(join(fixture, 'external')) !== 'module-dir') {
  throw new Error(`a module without content roots did not fall back to its directory: ${JSON.stringify([...fixtureRoots])}`)
}
console.log('module content roots from the .iml: ' + [...fixtureRoots.keys()].join(', '))
const fixtureContext = fixtureInstance.prompts[0].text()
if (!fixtureContext.includes('module content roots (declared in the module .iml): '
  + join(fixture, 'alpha') + ', ' + join(fixture, 'beta'))) {
  throw new Error('the runtime context does not name the module content roots by source:\n' + fixtureContext)
}
if (!fixtureContext.includes('module directories (no content root declared): ' + join(fixture, 'external'))) {
  throw new Error('the runtime context does not name the module-directory fallback:\n' + fixtureContext)
}
if (fixtureContext.includes('Session root')) {
  throw new Error('a root-project junction claimed a session root wider than the project')
}
console.log('runtime context:\n' + fixtureContext.split('\n').map(line => '  ' + line).join('\n'))

// 6b. The context depends only on attach/detach: a caret move or a tab switch must not move it, or
//     every such change would invalidate the request prefix a provider has cached.
const stableA = writeDescriptor({ ...snapshotWorkspace, activePath: '/tmp/one.py', activeLine: 1, openFiles: ['/tmp/one.py'] })
const stableB = writeDescriptor({ ...snapshotWorkspace, activePath: '/tmp/two.py', activeLine: 90, openFiles: ['/tmp/two.py', '/tmp/three.py'] })
const textA = await mount({ bridgePath: stableA }).prompts[0].text()
const textB = await mount({ bridgePath: stableB }).prompts[0].text()
if (textA !== textB) {
  throw new Error('the runtime context moved with the caret or the open files:\n' + textA + '\n---\n' + textB)
}
console.log('the runtime context is stable across caret and tab changes')



// 5b. The other modes stay available.
const perProject = mount({ workspaceMode: 'per-project' }, [{ id: 'seed-root', path: '/mnt/media/project/bi-app-v2', sessionIds: [] }])
await perProject.tools.find(tool => tool.name === 'jetbrains_workspace').execute({}, exec)
await new Promise(resolve => setTimeout(resolve, 200))
const expectedRoots = liveValue.workspace.roots.filter(root => root.exists).map(root => root.path)
const registered = expectedRoots.filter(path => perProject.registry.entries.has(path))
if (registered.length !== expectedRoots.length) {
  throw new Error(`per-project mode registered ${registered.length} of ${expectedRoots.length} roots`)
}
const off = mount({ workspaceMode: 'off' })
await off.tools.find(tool => tool.name === 'jetbrains_workspace').execute({}, exec)
await new Promise(resolve => setTimeout(resolve, 200))
if (off.registry.created.length !== 0) throw new Error('off mode registered a workspace')
const wide = mount({ junctionRoot: 'common-parent', bridgePath })
const wideValue = await wide.tools.find(tool => tool.name === 'jetbrains_workspace').execute({}, exec)
if (wideValue.workspace.sessionRoot !== '/mnt/media/project') {
  throw new Error(`common-parent junction is wrong: ${wideValue.workspace.sessionRoot}`)
}
const wideContext = wide.prompts[0].text()
if (!wideContext.includes(`Session root ${wideValue.workspace.sessionRoot} covers every directory above.`)) {
  throw new Error('a common-parent junction did not announce its session root:\n' + wideContext)
}
console.log(`per-project: ${perProject.registry.created.length} roots; off: ${off.registry.created.length}; common-parent session root: ${wideValue.workspace.sessionRoot}`)

// 6. A composition without the registry still registers every tool and the context.
const bare = mount({ bridgePath })
if (bare.tools.length !== 2 || bare.prompts.length !== 1) {
  throw new Error('a composition without a workspace registry lost a contribution')
}
console.log('without a workspace registry: both tools and the context registered')

for (const tool of [workspaceTool]) {
  const bad = await tool.execute({ ide: 'NoSuchIDE2020.1' }, exec).then(() => undefined, error => error)
  if (!(bad instanceof Error) || !bad.message.includes('no JetBrains IDE configuration')) {
    throw new Error(`unknown ide key did not fail: ${bad}`)
  }
}
console.log('companion, disk, and workspace-registration paths all check out')

/** Validate one tool result against its own declared schema. */
function checkSchema(tool, value, what) {
  const violations = validateJsonSchemaValue(tool.output.schema, JSON.parse(JSON.stringify(value)), 'value')
  if (violations.length > 0) throw new Error(`${what} violates ${tool.name}.output.schema: ${violations.join('; ')}`)
  console.log(`ok: ${what} matches ${tool.name}.output.schema`)
}
