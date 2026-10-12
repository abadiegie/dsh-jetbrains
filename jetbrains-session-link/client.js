/**
 * Client half: let a URL choose the session.
 *
 * The Web client stores its selection itself and offers no address for one, so an embedding host —
 * a JetBrains tool window, a script, a bookmark — had to reach into the client's storage to pick a
 * session. This module accepts a `dsh-session` parameter instead, in the query string or the
 * fragment: on load, and again whenever the fragment changes, it opens that session and then removes
 * the parameter without reloading, so a later reload does not navigate a second time.
 *
 * A fragment change needs no reload, so a host that already holds the page can simply set
 * `location.hash = 'dsh-session=<id>'`, and this module reacts. Nothing is drawn and no slot is
 * registered, so the plugin cannot change how the page looks.
 */

window.__ModuleLoader__.load({
  id: 'dsh-jetbrains-session-link',
  factory() {
    const PARAMETER = 'dsh-session'

    /**
     * The requested session id, preferring the fragment over the query string.
     * @returns the id, or null when the URL does not ask for one.
     */
    function requestedSession() {
      const query = new URLSearchParams(window.location.search).get(PARAMETER)
      const fragment = new URLSearchParams(window.location.hash.replace(/^#/, '')).get(PARAMETER)
      const value = fragment ?? query
      return typeof value === 'string' && value !== '' ? value : null
    }

    /**
     * Remove the parameter from both the query string and the fragment, in place and without a
     * reload, so the address bar and a later reload no longer carry the request.
     */
    function clearRequest() {
      const url = new URL(window.location.href)
      let changed = false
      if (url.searchParams.has(PARAMETER)) {
        url.searchParams.delete(PARAMETER)
        changed = true
      }
      const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
      if (fragment.has(PARAMETER)) {
        fragment.delete(PARAMETER)
        changed = true
        const rest = fragment.toString()
        url.hash = rest === '' ? '' : `#${rest}`
      }
      if (changed) window.history.replaceState(window.history.state, '', url.toString())
    }

    return {
      // The workspace service owns selection, so apply waits for it rather than racing it.
      inject: ['uiWorkspace'],
      apply(ctx) {
        // Marker an embedding host can read before it decides how to ask for a session: with this
        // plugin present the fragment is the reload-free path, and a host should not fall back to
        // seeding the client's stored selection (which reloads and would restart this boot).
        window.__dshSessionLink = true
        /**
         * Open the requested session, if this URL asks for one. A refused open must not fail this
         * plugin's activation, and it must leave the parameter in place so a later hash change or
         * reload can retry it; only a successful open clears it.
         * @param reason - what triggered this attempt, for the log line.
         */
        const openRequested = (reason) => {
          const sessionId = requestedSession()
          if (sessionId === null) return
          try {
            ctx.uiWorkspace.openSession(sessionId)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            console.warn(`dsh-jetbrains-session-link: ${sessionId} was refused on ${reason}: ${detail}`)
            return
          }
          console.info(`dsh-jetbrains-session-link: opened ${sessionId} on ${reason}`)
          clearRequest()
        }
        openRequested('load')
        const onHashChange = () => openRequested('hashchange')
        window.addEventListener('hashchange', onHashChange)
        ctx.effect(() => () => window.removeEventListener('hashchange', onHashChange))
      },
    }
  },
})
