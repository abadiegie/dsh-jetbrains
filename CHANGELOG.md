# Changelog

## Unreleased

Repository preparation for public release: MIT license, security model, CI, and package identity
(`io.github.abadiegie.dsh-companion`, `dsh-jetbrains-workspace`).
- Documentation pass after the click work: the root README names the bundle's two halves, the package README
  documents `openInIde`, `openSidebarFilesInIde`, `changes`, and `changesPath`, `SECURITY.md` covers the
  `/api/jetbrains.open` route behind DSH's own authentication, and every `dev/check.mjs` reference to the
  renamed `dev/check-synthetic.mjs` (plus the new `dev/check-client.mjs`) is corrected.
- `dev/check.mjs`, the local acceptance check, mounts the plugin again: it gained the stub members the plugin
  now uses at apply time (`ctx.on` for the review listener, `ctx.inject` for the route and the desktop
  opener) and a temporary review document, so it passes and no longer writes the real
  `<DSH home>/jetbrains-changes.json`.

## jetbrains-companion 0.2.1

- A `DSH Changes` tool window: the turns `dsh-jetbrains-workspace` publishes, one line per turn and file, with
  any file opened as a native side-by-side IntelliJ diff. The list comes from the review document, the diff
  from `GET /api/changes.diff` through the same signed cookie the chat panel uses, and the payload's hunks
  are split into the two texts the platform compares — an added or removed file says so in the tab title.
- `dev/ChangesCheck.java` covers both halves without an IDE: the document reader (coordinates, totals, a
  document from another publisher, a missing one, the location override) and the payload splitter (context,
  added, and removed lines, the hunk count, and a payload with no display name).

## jetbrains-companion 0.2.6

- The chat panel's own toolbar gains a **Changes** toggle, beside Reload, Home and the session actions: it
  shows the changes panel and hides it again, so the diff is one click away from the browser the reader is
  already looking at. The panel had a toolbar all along; this is what belongs in it.

## jetbrains-companion 0.2.5

- The changes panel is reachable from the **Tools** menu (`DSH Changes`), and its tool window moved out of the
  right stripe's secondary group, where it could hide behind the stripe's overflow chevron. Nothing about the
  panel changed; it could be loaded and invisible at once, which is what a reader reported.

## jetbrains-companion 0.2.4

- Revert one hunk at a time: once a file's diff has been opened, its hunks appear as rows under it and the
  panel's Revert action takes back just the selected one. A file the turn created is refused per hunk — its
  whole-file revert deletes it — and nothing about the whole-file path changed.
- Turns published while the IDE was closed are mentioned when it next opens: the companion reads the review
  document at start, compares it against a watermark it keeps in its own settings, and shows one notification
  with a `Show changes` action that opens the panel. History was never lost; being told was what was missing.

## jetbrains-companion 0.2.3

- The diff opens by itself: when a turn publishes its changes, `jetbrains-workspace` posts a notice to the
  companion's bridge (`POST /changed`) and the IDE opens the turn's diff in a native tab and shows a
  notification with **Keep** and **Revert**. `autoOpenDiffs` (default on) turns it off, and a missing bridge
  or a refused notice only logs — a published turn never fails because an IDE could not be told.
- The publisher's diagnostic now flips to `published` (and clears its retry bookkeeping) once an entry is
  stored; before this it stayed at `pending` even for an entry that had been written.

## jetbrains-companion 0.2.2

- `Revert file…` in the `DSH Changes` tool window: a turn's change can be taken back by reverse-applying the
  hunks DSH published. Hunks are located by content, all of them must be found, and a file edited since the
  turn is refused rather than half-reverted; a file the turn created is deleted instead of rewritten.
  `ChangesRevert` also reverts a single hunk, which `dev/ChangesCheck.java` covers along with the refusals,
  so a per-hunk action needs no new logic.

## jetbrains-workspace 0.1.5

- The review publisher looks for a turn's summary on a schedule instead of once: `workspace/changes` carries
  only `{turn}` (`workspaceChanges.summary` holds the files), and the recorder stores that summary after
  appending the event, which on this repository takes longer than the single 200 ms retry allowed — so turns
  were dropped while the same sequence answered minutes later. The delays now run 100 ms → 5 s over about
  twenty seconds, and they are injectable (`summaryDelays`, test-only) so a check can exhaust them at once.
- The retry no longer depends on any timer the composition offers: every session event first looks again at
  the events whose summary was not stored yet, and the Host's own timer is only a best-effort clock. Preferring
  `ctx.setTimeout` kept the broken path — the composition mixes one in, its convention is not
  `(callback, delay)`, and `lastEvent` stayed at `attempts: 1, outcome: pending` with the summary already
  there. A turn emits several events, so the next one is the clock this needs.
- The retry also once used the Host's own timer: the running composition mixes no `ctx.setTimeout` into a
  plugin context, so the scheduled look threw and never ran — the document's `lastEvent` sat at
  `attempts: 1, outcome: pending` while the summary was already there. `ctx.setTimeout` is still preferred
  when a composition provides it.
- The document also records what the listener saw: `lastEvent` carries the session, sequence, turn, attempt
  count, and an outcome of `pending`, `published`, or `unavailable`. A reader can now tell "no turn yet" from
  "a turn the publisher could not read" without the Host's terminal, which is where that warning used to go.

## jetbrains-workspace 0.1.4

- Clicking a file in the DSH UI opens it in the IDE instead of the Sidebar viewer. DSH opens files through
  the client service `sidebarRight.openResource`, which never reaches the Host, so the package now carries a
  client half that wraps it: a `dsh-resource://file/…` address goes to the new Host route
  `POST /api/jetbrains.open`, which resolves a session-relative path and hands it to the companion bridge.
  On by default (`openSidebarFilesInIde: false` disables it by not registering the route); a `409`, a
  `404`, any other failure, or any non-file address keeps the Sidebar behaviour, so a click always opens
  somewhere. The client half needs a page reload the first time it ships, and a Host restart to register
  the route.
- The route registers on `connection.fetch.register`, the fetch-shaped table the shipped `present.open` and
  `changes.open` routes use. The first version used `webServer.register`, whose handler is a Node
  `(req, res)` pair: the route never answered, every click hung, and a click opened nothing at all — neither
  the IDE nor the Sidebar. The client half now also bounds its request (2.5 s) and falls back to the Sidebar,
  and the check rejects a route that is not fetch-shaped instead of accepting whatever it is handed.

## jetbrains-workspace 0.1.3

- Clicking a deliverable or a changed file in the DSH UI opens it in the JetBrains IDE. The plugin replaces
  `sessionController.openPath` — the member the service itself makes replaceable — while a companion bridge
  is live, so both card types land in the IDE without any desktop file-association setup. On by default
  (`openInIde: false` opts out); without a bridge, or when the IDE refuses a path, the original desktop
  opener still runs.
- The click wrap waits for the session controller with `ctx.inject` instead of reading it at apply time:
  that service mounts with another row, and the first version silently wrapped nothing because it read a
  service that did not exist yet.

## jetbrains-workspace 0.1.2

- `autoOpenDeliverables` (default off) opens the files a session presents in the IDE, through the
  companion bridge, at the moment DSH appends its `deliverables/presented` event. Only the session the
  IDE window owns is served, presented files may live anywhere, and a refused or unanswerable bridge is
  logged rather than thrown.
- The change-review publisher and the auto-open listener register the way every shipped listener does:
  no listener options. An extra option silenced the feed rather than erroring, which the synthetic
  check could not see because its stub accepts anything; a composition with no change recorder, and a
  summary that never arrives, now warn instead of failing silently.

## jetbrains-workspace 0.1.1

- Publishes `<home>/.dsh/jetbrains-changes.json`: for every announced turn, the `workspace/changes`
  sequence, the turn number, the totals and each changed file, so an IDE-side panel can render a review
  with DSH's own `/api/changes.summary` and `/api/changes.diff` routes instead of listening to the
  session feed. Writes are atomic, bounded to eight sessions, disabled with `changes: false`, and the
  document is emptied at mount because the recorder keeps nothing across Host restarts.

## jetbrains-session-link 1.0.0

- A `dsh-session` URL parameter (query or fragment) selects that session, and a hash change does the
  same on an already-open page; the parameter is cleared once honoured, and a refused open keeps it for
  a retry instead of failing the plugin's activation.
- Sets `window.__dshSessionLink` while listening, so a host can tell a page that has the plugin from one
  that does not and avoid a reload that would restart the client boot.

## jetbrains-companion 0.2.0

- `DSH Chat` tool window: DSH's web client embedded through JCEF, authenticated with a locally signed
  browser-session cookie, with Reload/Home/Back/Forward/Open-in-Browser and `This Project's Session`.
- `Window session`: one DSH session for the whole IDE window at the shared parent of its roots,
  falling back to each project's own directory; off gives one session per project.
- Sessions are registered **inside** their directory's workspace, so DSH groups them immediately
  instead of waiting for the next registry rebuild; an existing session whose grouping went missing is
  re-attached.
- The embedded client's console warnings and errors, and failed main-frame loads, reach `idea.log`.
- `jetbrains_open_in_ide` opens a file in the running IDE through the companion bridge.

## jetbrains-workspace 0.1.0

- `jetbrains_workspace` and `jetbrains_open_in_ide` tools, the `jetbrains:workspace` runtime context,
  and one registered DSH workspace for the IDE window.
- Discovery from the live companion bridge, or from the IDE's own state files when the IDE is closed.
- A module's content roots are read from the module file itself, with `$MODULE_DIR$` resolved the way
  the platform resolves it (a `.idea` parent steps up to the project directory); a module that
  declares no content root contributes its own directory, reported as `module-dir`.
- The runtime context groups attached directories by the source that reported them and announces the
  session root when it reaches beyond the project.
- Automatic deletion of a workspace registration was removed as a default and is refused for a
  `common-parent` junction.
