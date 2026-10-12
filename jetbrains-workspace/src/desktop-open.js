/**
 * Route the Host's desktop opens into the JetBrains IDE.
 *
 * A click on a deliverable or changed file in the DSH UI ends in
 * `sessionController.openWorkspacePath` → `this.openPath(path, signal)`, and that member is replaceable:
 * the service assigns it from `SessionControllerInternals`. Replacing that one function is what makes a
 * click land in the IDE — no desktop file-association setup, no route interception, and no change to the
 * shipped handlers, which still verify the path before they call it.
 *
 * When no JetBrains IDE publishes the companion bridge the original opener runs, and so does it when the
 * IDE refuses the path, so a click can never end with nothing happening where it used to open something.
 *
 * @module jetbrains-workspace/desktop-open
 */

import { openInIde, readLiveBridge } from './bridge.js'

/**
 * Replace the Host's default path opener while this plugin is mounted.
 * @param ctx - the plugin context.
 * @param options - `bridgeOptions` for the companion descriptor lookup.
 * @returns a disposer that restores the original opener.
 */
export function openDesktopPathsInIde(ctx, options = {}) {
  const bridgeOptions = options.bridgeOptions ?? {}
  const controller = ctx.get('sessionController')
  if (controller === undefined || typeof controller.openPath !== 'function') {
    ctx.logger?.warn?.('jetbrains-workspace: this composition exposes no sessionController.openPath, so clicks keep the desktop opener')
    return () => {}
  }
  const original = controller.openPath
  controller.openPath = async (path, signal) => {
    const bridge = readLiveBridge(bridgeOptions)
    if (bridge === undefined) return original.call(controller, path, signal)
    try {
      await openInIde(bridge, { path })
      ctx.logger?.info?.(`jetbrains-workspace: a desktop open for ${path} went to the IDE`)
    } catch (failure) {
      ctx.logger?.warn?.(`jetbrains-workspace: the IDE refused ${path} (${failure?.message ?? failure}); falling back to the desktop opener`)
      return original.call(controller, path, signal)
    }
  }
  return () => {
    controller.openPath = original
  }
}
