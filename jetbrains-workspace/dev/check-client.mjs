/**
 * Development check for the client half: a clicked file address becomes one request to the Host route, and
 * anything else — a non-file address, a Host without the route, a Host without an IDE bridge, a failed
 * request — is left to the Sidebar exactly as before. No browser, no DSH, no network: the page's loader and
 * `fetch` are fakes.
 *
 * Run: node dev/check-client.mjs
 */

import { readFileSync } from 'node:fs'

const failures = []
/**
 * Record one expectation.
 * @param condition - whether it held.
 * @param what - description for the report.
 */
function expect(condition, what) {
  if (condition) {
    console.log(`ok: ${what}`)
    return
  }
  failures.push(what)
  console.log(`FAIL: ${what}`)
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
let registered
const listeners = new Map()
globalThis.window = {
  __ModuleLoader__: { load: (module) => { registered = module } },
}
const requests = []
const warnings = []
const infos = []
let nextStatus = 204
globalThis.fetch = async (url, init) => {
  requests.push({ url, init, body: JSON.parse(init.body) })
  return {
    status: nextStatus,
    json: async () => ({ ok: nextStatus === 204, error: 'no running JetBrains IDE publishes the companion bridge' }),
  }
}
const originalWarn = console.warn
const originalInfo = console.info
console.warn = (message) => { warnings.push(String(message)) }
console.info = (message) => { infos.push(String(message)) }

await import('../client.js')
expect(registered !== undefined, 'the client half registers a module with the page loader')
expect(registered.id === manifest.name, `the registered id is the package name (${manifest.name})`)
expect(manifest.dsh?.client?.platform === 'web', 'the manifest declares a web client')
expect(manifest.exports?.['./client'] === './client.js', 'the manifest exports ./client')

/** A sidebarRight stub recording every address it is asked to show. */
function sidebarStub() {
  return { shown: [], openResource(url, options) { this.shown.push({ url, options }) } }
}

const sidebar = sidebarStub()
const original = sidebar.openResource
const plugin = registered.factory()
const context = {
  sidebarRight: sidebar,
  effect: (register) => { listeners.set('dispose', register()); return () => {} },
}
plugin.apply(context)
expect(sidebar.openResource !== original, 'the sidebar opener is wrapped')
expect(typeof listeners.get('dispose') === 'function', 'the wrap is registered for disposal')

// A session file address becomes one Host request, and the Sidebar does not open it.
sidebar.openResource('dsh-resource://file/session/session-ab/notes/plan.md', { params: { line: 12 } })
await new Promise(resolve => setTimeout(resolve, 20))
expect(requests.length === 1 && requests[0].url === '/api/jetbrains.open', 'a file address asks the Host route')
expect(requests[0].body.sessionId === 'session-ab' && requests[0].body.path === 'notes/plan.md' && requests[0].body.line === 12,
  `the request carries the decoded address and its line: ${JSON.stringify(requests[0]?.body)}`)
expect(sidebar.shown.length === 0, 'an answer of 204 leaves the Sidebar closed')
expect(infos.some(line => line.includes('opened notes/plan.md')), 'the open is reported')

// An absolute address restores the leading slash and needs no session.
sidebar.openResource('dsh-resource://file/absolute/tmp/report%20final.pdf')
await new Promise(resolve => setTimeout(resolve, 20))
expect(requests[1].body.path === '/tmp/report final.pdf' && requests[1].body.sessionId === undefined,
  `an absolute address decodes to an absolute path: ${JSON.stringify(requests[1]?.body)}`)

// Anything the Host declines — no route (404), no IDE bridge (409), a failure, a network error — still opens.
for (const status of [404, 409, 500]) {
  nextStatus = status
  sidebar.openResource('dsh-resource://file/session/session-ab/README.md')
  await new Promise(resolve => setTimeout(resolve, 20))
}
nextStatus = 204
const before = requests.length
globalThis.fetch = async () => { throw new Error('offline') }
sidebar.openResource('dsh-resource://file/session/session-ab/offline.md')
await new Promise(resolve => setTimeout(resolve, 20))
expect(requests.length === before, 'a failing request is not retried')
expect(sidebar.shown.length === 4, `every declined or failed open falls back to the Sidebar: ${JSON.stringify(sidebar.shown.map(entry => entry.url))}`)
expect(sidebar.shown[0].url === 'dsh-resource://file/session/session-ab/README.md', 'the fallback shows the address the click asked for')

// A Host that never answers must not swallow the click either.
globalThis.fetch = async (url, init) => new Promise((resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')))
})
const hungBefore = sidebar.shown.length
const hungStart = Date.now()
sidebar.openResource('dsh-resource://file/session/session-ab/hung.md')
await new Promise(resolve => setTimeout(resolve, 3_000))
expect(sidebar.shown.length === hungBefore + 1 && sidebar.shown[hungBefore].url.endsWith('hung.md'),
  `a request that never answers still opens the Sidebar (${Date.now() - hungStart}ms)`)
expect(warnings.some(line => line.includes('hung.md')), 'the unanswered request is reported')

// Addresses this half does not serve go straight to the Sidebar, without a request.
const requestsBefore = requests.length
sidebar.openResource('dsh-resource://diff/session/session-ab/12')
sidebar.openResource('dsh-resource://browser/https://example.test')
expect(requests.length === requestsBefore, 'a non-file address asks the Host nothing')
expect(sidebar.shown.length === 7, 'a non-file address opens in the Sidebar')

// Disposal restores the service method.
const cleanup = listeners.get('dispose')
if (typeof cleanup === 'function') cleanup()
expect(sidebar.openResource === original, 'disposal restores the original opener')

console.warn = originalWarn
console.info = originalInfo
if (failures.length > 0) {
  console.error(`\n${failures.length} expectation(s) failed`)
  process.exit(1)
}
console.log('\nclient check: a file click goes to the IDE, and every other click keeps the sidebar')
