/**
 * Client half: ask the Host to open a clicked file in the JetBrains IDE.
 *
 * DSH's own click behaviour is the Sidebar file viewer — `ui-chat` opens a file through
 * `ctx.sidebarRight.openResource(address)`, and the shipped locale says as much ("Open the whole file in
 * the sidebar"). That call never reaches the Host, so a Host-side opener cannot redirect it; wrapping the
 * client service is the one place it can be redirected without touching another plugin's DOM.
 *
 * The Host may not answer: an IDE that holds the editor lock, a route that is not registered, a page whose
 * Host went away. The request is therefore bounded, and a request that does not answer in time leaves the
 * click to the Sidebar — a click that opens nothing at all is worse than one that opens the sidebar.
 *
 * The address grammar is the resource model's: `dsh-resource://file/session/<sessionId>/<path>` for a
 * session file, `dsh-resource://file/absolute/<path>` for one outside every session. Everything else — and
 * every failure, including a Host without an IDE bridge (409) or without this route at all (404) — is left
 * to the Sidebar, so a click always opens somewhere.
 */

window.__ModuleLoader__.load({
  id: 'dsh-jetbrains-workspace',
  factory() {
    const OPEN_PATH = '/api/jetbrains.open'
    const FILE_PREFIX = 'dsh-resource://file/'

    /**
     * Decode one component-encoded address segment.
     * @param segment - the raw segment.
     * @returns the decoded segment, or the raw one when it is not valid encoding.
     */
    function decodeSegment(segment) {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    }

    /**
     * Turn a file address into the request the Host route takes.
     * @param url - the resource address the click asked for.
     * @param options - the caller's navigation options; a line travels here, not in the address.
     * @returns the request, or undefined for anything that is not a file address.
     */
    function requestFor(url, options) {
      if (typeof url !== 'string' || !url.startsWith(FILE_PREFIX)) return undefined
      const segments = url.slice(FILE_PREFIX.length).split('/')
      const line = Number.isSafeInteger(options?.params?.line) && options.params.line > 0 ? options.params.line : undefined
      if (segments[0] === 'session') {
        const sessionId = decodeSegment(segments[1] ?? '')
        if (sessionId === '') return undefined
        const path = segments.slice(2).map(decodeSegment).join('/')
        return { sessionId, path, ...line === undefined ? {} : { line } }
      }
      if (segments[0] === 'absolute') {
        // The leading slash was dropped when the address was built; a UNC path keeps an empty first segment.
        const path = `/${segments.slice(1).map(decodeSegment).join('/')}`
        return { path, ...line === undefined ? {} : { line } }
      }
      return undefined
    }

    /**
     * Ask the Host to open one file in the IDE.
     * @param request - the parsed address.
     * @returns whether the IDE took it; false leaves the click to the Sidebar.
     */
    async function askHost(request) {
      try {
        const response = await fetch(OPEN_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          // A hung Host must not swallow the click: past this bound the Sidebar opens instead.
          signal: AbortSignal.timeout(2_500),
        })
        if (response.status === 204) {
          console.info(`dsh-jetbrains-workspace: opened ${request.path} in the IDE`)
          return true
        }
        if (response.status !== 404) {
          const detail = await response.json().catch(() => undefined)
          console.warn(`dsh-jetbrains-workspace: the IDE did not take ${request.path} (${response.status}${detail?.error === undefined ? '' : `: ${detail.error}`}); opening the sidebar instead`)
        }
        return false
      } catch (failure) {
        console.warn(`dsh-jetbrains-workspace: cannot ask the Host for ${request.path}: ${failure?.message ?? failure}`)
        return false
      }
    }

    return {
      // The Sidebar service owns file addresses, so apply waits for it rather than racing it.
      inject: ['sidebarRight'],
      apply(ctx) {
        const sidebar = ctx.sidebarRight
        const original = sidebar?.openResource
        if (typeof original !== 'function') {
          console.warn('dsh-jetbrains-workspace: this page has no sidebarRight.openResource; file clicks keep the sidebar')
          return
        }
        sidebar.openResource = (url, options) => {
          const request = requestFor(url, options)
          if (request === undefined) return original.call(sidebar, url, options)
          // Fire and forget: the caller expects a synchronous service call, and the fallback happens when
          // the Host says no.
          void askHost(request).then(opened => {
            if (!opened) original.call(sidebar, url, options)
          })
          return undefined
        }
        ctx.effect(() => () => {
          sidebar.openResource = original
        })
      },
    }
  },
})
