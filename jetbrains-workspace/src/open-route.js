/**
 * The route the client half asks to open a file in the IDE.
 *
 * A click on a file in the DSH UI normally opens the Sidebar's own viewer — that is what DSH ships, and the
 * locale says so ("Open the whole file in the sidebar"). The client half redirects those clicks here; this
 * route turns the resource address back into a Host path and hands it to the companion bridge, so the file
 * lands in a JetBrains editor instead. When no IDE publishes a bridge the route answers `409` and the client
 * leaves the click to the Sidebar.
 *
 * It registers on the fetch-shaped route table (`connection.fetch.register`), which is how the shipped
 * `present.open` and `changes.open` routes are served and the only shape whose handler answers with a
 * `Response`. Registering on `webServer.register` instead takes a Node `(req, res)` handler, so this route
 * never answered and every click hung — the failure mode the client half now also bounds with a timeout.
 *
 * @module jetbrains-workspace/open-route
 */

import { openInIde, readLiveBridge } from './bridge.js'

/** Where the client half posts one open request. */
export const OPEN_ROUTE_PATH = '/api/jetbrains.open'

/**
 * Resolve a session-relative path to the absolute Host path the filesystem maps.
 * @param ctx - the plugin context.
 * @param sessionId - the session whose workspace resolves the path.
 * @param path - absolute, or relative to that session's workspace root.
 * @param signal - request lifetime.
 * @returns the absolute path, or undefined when the Host cannot resolve it.
 */
async function resolveHostPath(ctx, sessionId, path, signal) {
  const files = ctx.get('workspaceFiles')
  if (files === undefined) return undefined
  const session = ctx.get('sessions')?.list?.().find(candidate => candidate?.header?.id === sessionId)
  const workspaceRoot = session?.header?.cwd ?? ctx.get('sandboxPolicy')?.workspaceRoot
  const stat = await files.stat({ sessionId, ...workspaceRoot === undefined ? {} : { workspaceRoot } }, path, signal)
  return stat?.absolutePath
}

/**
 * Answer one open request.
 * @param ctx - the plugin context.
 * @param request - the buffered request.
 * @param bridgeOptions - companion descriptor lookup options.
 * @returns the response the client half reads: `204` opened, `409` no IDE, `400`/`404` unusable request.
 */
async function handleOpen(ctx, request, bridgeOptions) {
  const bridge = readLiveBridge(bridgeOptions)
  if (bridge === undefined) {
    // The client treats this as "not ours": the Sidebar keeps the click.
    return Response.json({ ok: false, error: 'no running JetBrains IDE publishes the companion bridge' }, { status: 409 })
  }
  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
  const requested = typeof body?.path === 'string' && body.path !== '' ? body.path : undefined
  if (requested === undefined) return Response.json({ ok: false, error: 'missing path' }, { status: 400 })
  const line = Number.isSafeInteger(body?.line) && body.line > 0 ? body.line : undefined
  let path = requested
  if (sessionId !== undefined && !requested.startsWith('/')) {
    try {
      const resolved = await resolveHostPath(ctx, sessionId, requested, request.signal)
      if (resolved === undefined) return Response.json({ ok: false, error: `cannot resolve ${requested}` }, { status: 404 })
      path = resolved
    } catch (failure) {
      return Response.json({ ok: false, error: `cannot resolve ${requested}: ${failure?.message ?? failure}` }, { status: 404 })
    }
  }
  try {
    await openInIde(bridge, { path, ...line === undefined ? {} : { line } })
  } catch (failure) {
    return Response.json({ ok: false, error: `the IDE refused ${path}: ${failure?.message ?? failure}` }, { status: 502 })
  }
  return new Response(null, { status: 204 })
}

/**
 * Register the open route for the client half.
 * @param ctx - the plugin context.
 * @param options - `bridgeOptions` for the companion descriptor lookup.
 * @returns the disposer `ctx.inject` returned, if any.
 */
export function registerOpenRoute(ctx, options = {}) {
  const bridgeOptions = options.bridgeOptions ?? {}
  return ctx.inject(['connection'], (scope) => {
    const table = scope.connection?.fetch
    if (table === undefined || typeof table.register !== 'function') {
      ctx.logger?.warn?.('jetbrains-workspace: no fetch route table is mounted, so the client half cannot ask for an IDE open')
      return
    }
    // Same lifetime handling as the shipped routes: a handler in flight is aborted when this row unmounts.
    const lifetime = new AbortController()
    const pending = new Set()
    scope.effect(() => async () => {
      lifetime.abort()
      await Promise.allSettled([...pending])
    })
    scope.effect(() => table.register({
      path: OPEN_ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => {
        const task = handleOpen(ctx, new Request(request, {
          signal: AbortSignal.any([request.signal, lifetime.signal]),
        }), bridgeOptions)
        pending.add(task)
        void task.then(() => { pending.delete(task) }, () => { pending.delete(task) })
        return task
      },
    }))
  })
}
