/**
 * Host half of the session link plugin: the capability lives in the browser, so the Host side only
 * needs to exist as a Loader row for `client-modules` to serve the client bundle.
 *
 * @module dsh-jetbrains-session-link
 */

export const name = 'jetbrains-session-link'

/** Register nothing: the client half owns the behaviour. */
export function apply() {}
