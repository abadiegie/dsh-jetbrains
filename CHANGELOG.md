# Changelog

## Unreleased

Repository preparation for public release: MIT license, security model, CI, and package identity
(`io.github.abadiegie.dsh-companion`, `dsh-jetbrains-workspace`).

## jetbrains-workspace 0.1.3

- Clicking a deliverable or a changed file in the DSH UI opens it in the JetBrains IDE. The plugin replaces
  `sessionController.openPath` — the member the service itself makes replaceable — while a companion bridge
  is live, so both card types land in the IDE without any desktop file-association setup. On by default
  (`openInIde: false` opts out); without a bridge, or when the IDE refuses a path, the original desktop
  opener still runs.

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
