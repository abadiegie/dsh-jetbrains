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

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/plugin.js'

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
function mount(config, seed) {
  const tools = []
  const prompts = []
  const registry = createRegistry(seed)
  const stub = {
    effect: (callback) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    get: (name) => {
      if (name === 'systemPrompt') return { context: (entry) => { prompts.push(entry); return () => {} } }
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
  }
  apply(stub, config)
  return { tools, prompts, registry }
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

console.log('\nsynthetic check: discovery, roles, context, stability, and registration all check out')
