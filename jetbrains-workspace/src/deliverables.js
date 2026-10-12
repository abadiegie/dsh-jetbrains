/**
 * Open the files a Session presented in the JetBrains IDE.
 *
 * The `present` tool appends one durable `deliverables/presented` event per delivery, which is the
 * moment an artifact becomes *the* result a human is meant to look at. This module turns that moment
 * into an editor tab, through the same companion bridge the `jetbrains_open_in_ide` tool uses.
 *
 * It is off unless the row sets `autoOpenDeliverables: true`, and it only acts for the session the IDE
 * window owns: a background or automation session presenting a file must not open tabs in an IDE nobody
 * is watching.
 *
 * @module jetbrains-workspace/deliverables
 */

import { openInIde, readLiveBridge } from './bridge.js'

/** The session event the `present` tool appends for each delivery. */
const PRESENTED_EVENT = 'deliverables/presented'

/**
 * The paths one `deliverables/presented` event names, in order.
 * @param event - a session event.
 * @returns the presentable paths, empty for anything this module does not serve.
 */
export function presentedPaths(event) {
  if (event?.type !== PRESENTED_EVENT) return []
  const files = Array.isArray(event.data?.files) ? event.data.files : []
  return files
    .map(file => (typeof file?.path === 'string' && file.path.trim() !== '' ? file.path : undefined))
    .filter(path => path !== undefined)
}

/**
 * Open every presented file through the live companion bridge.
 * @param ctx - the plugin context.
 * @param options - `bridgeOptions` for the descriptor lookup, and `belongs(session)` to decide whether
 *     this IDE window owns that session.
 * @returns a disposer that stops listening.
 */
export function openPresentedDeliverables(ctx, options = {}) {
  const bridgeOptions = options.bridgeOptions ?? {}
  const belongs = typeof options.belongs === 'function' ? options.belongs : () => true

  /**
   * Open one delivery's files. Failures are reported and never thrown: the event feed must not wait on
   * an editor, and a missing IDE is a normal state rather than an error.
   * @param paths - absolute paths to open.
   */
  const open = async (paths) => {
    const bridge = readLiveBridge(bridgeOptions)
    if (bridge === undefined) {
      ctx.logger?.warn?.('jetbrains-workspace: no running JetBrains IDE publishes the companion bridge; presented files stay closed')
      return
    }
    for (const path of paths) {
      try {
        await openInIde(bridge, { path })
      } catch (failure) {
        ctx.logger?.warn?.(`jetbrains-workspace: could not open ${path} in the IDE: ${failure?.message ?? failure}`)
      }
    }
  }

  // Same listener shape as everywhere else in the Harness: an unexpected option can silence the feed.
  return ctx.on('session/event', (session, event) => {
    const paths = presentedPaths(event)
    if (paths.length === 0) return
    if (!belongs(session)) return
    void open(paths)
  })
}
