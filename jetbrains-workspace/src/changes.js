/**
 * Publish the change review an IDE-side reader can render.
 *
 * The recorder that summarizes one turn's changed files lives in the Host process and announces each
 * turn with a `workspace/changes` session event. Its summary is keyed by that event's sequence and
 * `ctx.workspaceChanges` serves it only while this Host process lives, so a panel in another process
 * cannot ask for "the changes" without being told which sequence to name. This module writes those
 * coordinates, and the summary beside them, into a small document the panel reads — the same shape of
 * hand-off the companion uses when it publishes its descriptor for this plugin to read.
 *
 * @module jetbrains-workspace/changes
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { notifyChanged, readLiveBridge } from './bridge.js'
import { dirname, join } from 'node:path'

/** Document version, so a reader can reject a shape it does not know. */
const VERSION = 1

/** Document source marker, so a reader knows which publisher wrote it. */
const SOURCE = 'jetbrains-workspace'

/** Sessions kept in the document, newest first. */
const SESSION_LIMIT = 8

/** The session event a recorder announces one turn's changed files with. */
const CHANGES_EVENT = 'workspace/changes'

/**
 * Delays between looks for a summary the recorder had not stored when its own event arrived. The recorder
 * appends the event first and computes the summary — a git diff over the turn — immediately after, which on
 * a busy repository takes far longer than one 200 ms retry allowed: with a single retry the publisher
 * silently dropped turns, while `workspaceChanges.summary` answered for the same sequence minutes later.
 */
const SUMMARY_DELAYS = [100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000, 5_000]

/**
 * The document path a deployment publishes to by default.
 * @param home - harness home whose `.dsh` directory holds the document.
 * @returns the absolute path.
 */
export function defaultChangesPath(home = homedir()) {
  return join(home, '.dsh', 'jetbrains-changes.json')
}

/**
 * Read the identity out of a session passed to a listener.
 * @param session - the session the event belongs to.
 * @returns the session id, or undefined when the object is not a session.
 */
function sessionIdOf(session) {
  const id = session?.header?.id ?? session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Publish `workspace/changes` summaries for an IDE-side reader.
 *
 * The document is rewritten only when its coordinates change and each write is atomic (a temporary
 * file renamed over the target), so a reader never sees a half-written document. A write that fails is
 * reported and otherwise ignored: a review is a convenience, not a capability this plugin owes.
 * @param ctx - the plugin context.
 * @param options - `changesPath` (default {@link defaultChangesPath}) and `home`.
 * @returns a disposer that stops listening.
 */
export function publishChanges(ctx, options = {}) {
  const path = options.changesPath ?? defaultChangesPath(options.home ?? homedir())
  // Injectable so a check can exhaust the schedule in milliseconds instead of twenty seconds.
  const summaryDelays = options.summaryDelays ?? SUMMARY_DELAYS
  const bridgeOptions = options.bridgeOptions ?? {}
  const autoOpenDiffs = options.autoOpenDiffs !== false
  const sessions = new Map()
  const warned = new Set()
  // Events whose summary the recorder had not stored yet, keyed by session and sequence. The next session
  // event is the retry clock: it needs no timer helper from the composition, and a turn emits several.
  const unresolved = new Map()
  let published
  // The last event this listener saw and what became of it, published inside the document so a reader can
  // tell "no turn yet" from "a turn this listener could not publish" without the Host's terminal.
  let lastEvent

  /** Write the document when its content changed. */
  const publish = () => {
    const entries = [...sessions.values()]
      .sort((left, right) => right.at - left.at)
      .slice(0, SESSION_LIMIT)
    const signature = `${entries.map(entry => `${entry.sessionId}:${entry.seq}`).join(',')}|${JSON.stringify(lastEvent ?? null)}`
    if (signature === published) return
    published = signature
    const document = {
      version: VERSION,
      source: SOURCE,
      updatedAt: new Date().toISOString(),
      ...lastEvent === undefined ? {} : { lastEvent },
      sessions: entries,
    }
    try {
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.tmp`
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`)
      renameSync(temporary, path)
    } catch (failure) {
      ctx.logger?.warn?.(`jetbrains-workspace: cannot publish changes to ${path}: ${failure?.message ?? failure}`)
    }
  }

  /**
   * Record the summary one announced event names.
   * @param session - the session the event belongs to.
   * @param event - the `workspace/changes` event.
   * @param attempt - 0 for the first look, then one per delay in {@link SUMMARY_DELAYS}.
   */
  const record = (session, event, attempt) => {
    const eventSessionId = sessionIdOf(session)
    lastEvent = {
      sessionId: typeof eventSessionId === 'string' ? eventSessionId : null,
      seq: typeof event?.seq === 'number' ? event.seq : null,
      turn: typeof event?.data?.turn === 'number' ? event.data.turn : null,
      at: new Date().toISOString(),
      attempts: attempt + 1,
      outcome: 'pending',
    }
    publish()
    const id = sessionIdOf(session)
    if (id === undefined) {
      if (!warned.has('session')) {
        warned.add('session')
        ctx.logger?.warn?.('jetbrains-workspace: a change event named no session; nothing is published')
      }
      return
    }
    const recorder = ctx.get('workspaceChanges')
    if (recorder === undefined) {
      if (!warned.has('recorder')) {
        warned.add('recorder')
        ctx.logger?.warn?.('jetbrains-workspace: no change recorder is mounted in this composition; nothing is published')
      }
      return
    }
    const summary = recorder.summary(id, event.seq)
    if (summary === undefined || summary === null) {
      // The recorder appends the event first and stores the summary immediately after, so a listener that
      // runs before that statement sees nothing. Look again on the schedule above; a recorder that never
      // answers leaves the attempt count in the document and warns once per session.
      const delay = summaryDelays[attempt]
      if (delay !== undefined) {
        unresolved.set(`${id}:${event.seq}`, { session, event, attempt: attempt + 1 })
        // A best-effort clock only. The composition's own `ctx.setTimeout` is not `(callback, delay)` — with
        // it preferred, `lastEvent` sat at `attempts: 1, outcome: pending` while the summary was there — so
        // the Host's timer is used and a failure here costs nothing: the next event drains the map anyway.
        try {
          const timer = setTimeout(() => {
            if (!unresolved.delete(`${id}:${event.seq}`)) return
            record(session, event, attempt + 1)
          }, delay)
          if (typeof timer?.unref === 'function') timer.unref()
        } catch {
          // No timer in this scope; the next session event is the clock.
        }
      } else if (!warned.has(id)) {
        warned.add(id)
        lastEvent = { ...lastEvent, outcome: 'unavailable' }
        publish()
        ctx.logger?.warn?.(`jetbrains-workspace: the change recorder has no summary for ${id} at ${event.seq} after ${attempt + 1} looks; that turn is not published`)
      }
      return
    }
    sessions.set(id, {
      sessionId: id,
      // The recorder's own `cwd` is the root the listed paths are relative to, which is what a reader
      // resolves them against; the session header is the fallback.
      cwd: typeof summary.cwd === 'string'
        ? summary.cwd
        : (typeof session?.header?.cwd === 'string' ? session.header.cwd : null),
      seq: event.seq,
      turn: typeof summary.turn === 'number'
        ? summary.turn
        : (typeof event.data?.turn === 'number' ? event.data.turn : null),
      total: summary.total ?? 0,
      added: summary.added ?? 0,
      deleted: summary.deleted ?? 0,
      files: Array.isArray(summary.files)
        ? summary.files.map(file => ({
          path: file.path,
          display: file.display ?? file.path,
          added: file.added ?? 0,
          deleted: file.deleted ?? 0,
        }))
        : [],
      at: Date.now(),
    })
    // The entry is in; say so and stop looking for this event.
    unresolved.delete(`${id}:${event.seq}`)
    lastEvent = { ...lastEvent, outcome: 'published' }
    publish()
    // Tell the IDE, so the diff can open by itself with its keep-or-revert answer. Best effort: a click that
    // still works, or no IDE at all, must not turn a published turn into an error.
    if (autoOpenDiffs) {
      const bridge = readLiveBridge(bridgeOptions)
      if (bridge !== undefined) {
        void notifyChanged(bridge, {
          sessionId: id,
          cwd: typeof summary.cwd === 'string' ? summary.cwd : (session?.header?.cwd ?? null),
          seq: event.seq,
          turn: typeof event?.data?.turn === 'number' ? event.data.turn : null,
          files: (Array.isArray(summary.files) ? summary.files : []).map(file => ({
            path: file?.path,
            display: file?.display,
            added: file?.added,
            deleted: file?.deleted,
          })),
        }).catch(failure => {
          if (!warned.has('notice')) {
            warned.add('notice')
            ctx.logger?.warn?.(`jetbrains-workspace: could not tell the IDE about ${id} at ${event.seq}: ${failure?.message ?? failure}`)
          }
        })
      }
    }
  }

  // A previous Host's review must not survive this one: the recorder keeps nothing across restarts, so
  // coordinates written before it would render as if they described the process now running.
  publish()

  // The shape every shipped listener uses (`ctx.on('session/event', (session, event) => …)`, as in
  // `@deepseek-ai/dsh-compaction` and the SDK server): an extra listener option is not a no-op, and a
  // wrong one silences the feed instead of erroring.
  return ctx.on('session/event', (session, event) => {
    // Look again at what earlier events could not be read; a turn's own next event usually makes the
    // recorder's summary available, which is what no timer here could be trusted to do.
    for (const held of [...unresolved.values()]) {
      unresolved.delete(`${sessionIdOf(held.session)}:${held.event?.seq}`)
      record(held.session, held.event, held.attempt)
    }
    if (event?.type !== CHANGES_EVENT) return
    record(session, event, 0)
  })
}
