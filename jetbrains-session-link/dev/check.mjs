/**
 * Development check for the session-link client half.
 *
 * It loads `client.js` against a fake browser — the module loader, `location`, and `history` — and
 * drives the paths that matter: a parameter in the query string, a fragment set on an already-open
 * page, no parameter at all, a refusal, and the marker an embedding host reads. No browser, no DSH, no
 * network: this is what CI runs.
 *
 * Run: node dev/check.mjs
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

/**
 * A `window` whose `location` stays in step with `history.replaceState`, like a real browser.
 * @param href - the initial address.
 * @returns the fake window plus a helper to change the fragment.
 */
function fakeWindow(href) {
  const url = new URL(href)
  const listeners = new Map()
  const sync = () => ({ href: url.toString(), search: url.search, hash: url.hash })
  const window = {
    location: sync(),
    history: {
      state: null,
      replaceState: (_state, _title, next) => {
        const replacement = new URL(next)
        url.search = replacement.search
        url.hash = replacement.hash
        Object.assign(window.location, sync())
      },
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    __ModuleLoader__: { load: (module) => { registered = module } },
  }
  return {
    window,
    listeners,
    /** Set the fragment as an embedding panel would. */
    setHash(value) {
      url.hash = value
      Object.assign(window.location, sync())
    },
  }
}

let registered
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const first = fakeWindow('http://127.0.0.1:3080/?dsh-session=session-abc#tab=1')
globalThis.window = first.window
await import('../client.js')

expect(registered !== undefined, 'the client half registers a module with the page loader')
expect(registered.id === manifest.name,
  `the registered id is the package name (${manifest.name}), which is what client-modules serves`)
expect(manifest.dsh?.client?.platform === 'web', 'the manifest declares a web client')
expect(manifest.exports?.['./client'] === './client.js', 'the manifest exports ./client')

const plugin = registered.factory()
const opened = []
const warnings = []
const originalWarn = console.warn
console.warn = (message) => { warnings.push(String(message)) }
const context = {
  uiWorkspace: { openSession: (id) => opened.push(id) },
  effect: (register) => { register(); return () => {} },
}
plugin.apply(context)
console.warn = originalWarn

expect(first.window.__dshSessionLink === true, 'the marker an embedding host reads is set')
expect(JSON.stringify(opened) === '["session-abc"]', 'a query parameter opens that session on load')
expect(first.window.location.href === 'http://127.0.0.1:3080/#tab=1',
  'the parameter is removed from the address, and other members survive')
expect(typeof first.listeners.get('hashchange') === 'function', 'a hashchange listener is registered')

first.setHash('#dsh-session=session-def')
first.listeners.get('hashchange')()
expect(opened[1] === 'session-def', 'a fragment set on a live page opens the new session')
expect(first.window.location.href === 'http://127.0.0.1:3080/', 'that parameter is removed too')

first.setHash('#other=1')
first.listeners.get('hashchange')()
expect(opened.length === 2, 'a fragment without the parameter does nothing')

// A refused open must not fail activation, and must leave the request for a later retry.
const second = fakeWindow('http://127.0.0.1:3080/#dsh-session=session-refused')
globalThis.window = second.window
const refusing = registered.factory()
let threw = false
try {
  refusing.apply({
    uiWorkspace: { openSession: () => { throw new Error('sessions.retain: unknown session') } },
    effect: (register) => { register(); return () => {} },
  })
} catch {
  threw = true
}
expect(!threw, 'a refused open does not throw out of apply')
expect(second.window.location.href.endsWith('dsh-session=session-refused'),
  'a refused open keeps the parameter so a later hash change or reload can retry')

if (failures.length > 0) {
  console.error(`\n${failures.length} expectation(s) failed`)
  process.exit(1)
}
console.log('\nsession link check: the client half opens a requested session and cleans up after itself')
