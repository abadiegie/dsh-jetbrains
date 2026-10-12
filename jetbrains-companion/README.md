# DSH Companion (JetBrains IDE plugin)

A self-contained IntelliJ Platform plugin that links the IDE it runs in to a local DeepSeek Harness
process. **It needs no DSH-side plugin**: it authenticates against DSH's own HTTP API with the
browser-session cookie DSH itself mints, and it creates the sessions.

## The `DSH Changes` tool window

`DSH Changes` lists the turns `dsh-jetbrains-workspace` published — one line per turn, then one per changed
file — and opens any of them as a **native side-by-side IntelliJ diff**.

The list is read from the review document the bundle writes (`<DSH home>/jetbrains-changes.json`): the
session, the change-event sequence, and each file. The diff itself comes from DSH, which holds the recorder,
through `GET /api/changes.diff` with the same signed browser cookie the chat panel authenticates with, and
the payload's hunks are split into the two texts the platform's diff compares. A file the turn created gets
an empty left side and says so in the tab title; a deleted file the same on the right.

It needs the bundle mounted and one turn that changed a file; with nothing published yet the panel says so
instead of showing an empty list. Like every IDE-plugin change, a new build needs an **IDE restart**.

Verified on this machine for release 0.2.1: `build.sh` compiles the two new classes and installs the jar into
the IDE's user-plugin directory, the IDE starts with it without any tool-window error in `idea.log`, the
companion publishes its descriptor from the running IDE, and `dev/ChangesCheck.java` passes with no IDE and
no DSH. What a screenshot cannot confirm from the outside — the panel as drawn on screen — is left to a
reader of the IDE.

## What it does

| Behaviour | Detail |
|---|---|
| Chat inside the IDE | The **DSH Chat** tool window embeds DSH's own web client through JCEF and hands the embedded browser the signed browser-session cookie before its first navigation, so the full DSH chat runs in the IDE with no other plugin and no external browser. It opens on the **window's** session (see `Window session`). `Tools ▸ Open DSH Chat` shows it. |
| One session per project | When a project opens, the plugin reuses the most recent DSH session whose working directory is that project, and creates one when the project has none. `Tools ▸ Open DSH Session for This Project` does the same on demand. |
| Live workspace publication | Rewrites `~/.dsh/jetbrains-companion.json` within half a second of a visible change: every open project and its roots, the active file with caret line/column and selected text, and every open editor tab. |
| DSH → IDE | A loopback bridge with a per-run token serves `GET /health`, `GET /workspace`, and `POST /open`, so a DSH tool can put a file in front of the user at a line. |
| Clipboard and diagnostics | `Copy DSH Workspace Context` (editor, Project view, Tools menus) copies the roots, active file, and selection as markdown. `DSH Companion Status` shows the bridge address, descriptor path, and session target. |

## The chat panel

`DSH Chat` (`anchor=right`) renders the DSH web client itself, so sessions, tool cards, approvals, and
streaming behave exactly as in the browser. The panel:

1. discovers the address and home the same way the session client does (see below);
2. authenticates with `session/list`, so an unreachable DSH is reported before any browser work;
3. resolves the **window's** session — with `Window session` on (the default) that is the shared
   parent of the window's project roots, so one session reaches every project of a multi-project
   window; without a usable shared parent, and with the setting off, it is the project's own
   directory. It reuses the most recent session with that working directory and otherwise creates one
   **inside that directory's workspace**, so DSH groups it where the user sees it immediately instead
   of waiting for the next registry rebuild;
4. mints the same `dsh-auth-*` cookie and puts it in the embedded browser's cookie store, waiting out
   JCEF's asynchronous connection to `cef_server` (creating the browser eagerly creates its object,
   not its connection, and a cookie write before that link exists throws);
5. loads the DSH URL only after that cookie is stored, so DSH never sees an unauthenticated request;
6. asks the embedded client to show that session through the client's **own** persisted selection:
   DSH's web client stores its current session in `localStorage` under `dsh.sessions.current`, so the
   panel seeds that record and reloads once. The script is idempotent — a second run finds the record
   already correct and does nothing — and the panel re-applies it after each served load up to three
   times, because the client clears that record when a restoration attempt fails or when the user
   starts a new session; the bound keeps a client that clears on every boot from reloading forever.
   `This Project's Session` in the toolbar re-resolves the session and grants a fresh budget of
   pushes.

   `This Project's Session` first asks through the URL fragment a **session-link** client plugin
   understands (`jetbrains-session-link/` in this repository), which needs no reload, and falls
   back to the stored selection 1.5 s later — its script is idempotent, so a client the fragment
   already moved is not reloaded. The fragment ask is skipped when the page has no such plugin: the
   plugin sets a marker (`window.__dshSessionLink`) precisely so a host can tell the two cases apart.
   The served-load path keeps using the stored selection, because a page that just booted has a client
   without its workspace data yet and the fragment path is refused there.

Session resolution skips **delegated children**: a subagent shares its parent's working directory and
is usually the newer row, so resolving purely by directory would hand the panel a child view — the
client records that as a subagent address rather than a session, and the panel would keep asking for a
session it already shows.

Launch the IDE with `DSH_COMPANION_PROBE` set to have the panel report the embedded page's link state
(whether a session-link plugin is listening, which branch its ask takes, what the client has selected)
into the IDE log. It reads only, and it is how the JCEF behaviour above was established.

The window junction is computed from the live IDE snapshot, per window: a second IDE window's
projects never widen this one's session. When the panel is created before the publisher's first poll,
one synchronous collection decides the junction instead of quietly falling back to the project.

An HTTP 401/403 on the main frame is surfaced as a message with Retry instead of the server's plain-text
refusal, and a missing JCEF or a refused cookie falls back to the toolbar's `Open in Browser`. A failed
open never leaves the panel on "Connecting…": it reports what broke and offers Retry. DSH not running
is a normal state handled the same way.

Because the seeding uses the client's own persistence contract rather than DOM automation, no markup
or selector assumption can break it; the record lives in the embedded browser's profile, per origin,
and is invisible to the user's system browser.

## How the DSH link is discovered and authenticated

1. **Address**: the plugin's own `DSH URL` setting, else the `port` option of the installed DeepSeek
   Harness IDE plugin (`<IDE config>/options/deepseek-harness.xml`), else `http://127.0.0.1:3080`.
   A configured address is normalized, so `127.0.0.1:3080`, `3080`, and `myhost:4000` all work.
2. **Home**: the plugin's own `DSH home` setting, else that plugin's `dshHomeOverride`, else
   `$DSH_HOME`, else `~/.dsh`. These are *candidates*, not a decision.
3. **Pairing**: an address and a home must belong together — the cookie is signed for an authority
   with the secret of one home, and a DSH running under a different home refuses it. Every address is
   therefore tried with every candidate home, and the first pair DSH accepts wins. This is what lets
   an IDE whose settings name one harness home still reach the DSH that actually serves the port; the
   client's own home is reported so the chat panel signs its browser cookie with the same secret.
4. **Credentials**: `<home>/.credentials.yaml` holds DSH's `client-connection/browser-session`
   secret. The plugin signs the same cookie DSH gives a browser
   (`dsh-auth-<sha256 authority>` = `v1.<payload>.<hmac>`), so the HTTP API accepts it as the user.
5. **Calls**: `POST /api/<namespace>/<method>` with the Remote envelope
   `{"type":"client-request","rpcId":…,"method":"…","payload":{"args":{…}}}` — `session/list` to find
   the project's newest session, `session/create` with `{"request":{"cwd":…}}` when there is none.
   The client pins HTTP/1.1 because DSH's web server closes unmatched `Upgrade` connections.

A DSH that is not running, or a missing credential document, is reported quietly: the IDE is never
blocked and no session is created.

## Settings

`Settings ▸ Tools ▸ DSH Companion` (persisted at `<IDE config>/options/dsh-companion.xml`):

| Field | Default | Meaning |
|---|---|---|
| Create or reuse a DSH session when a project opens | on | The session behaviour above. |
| Window session | on | One DSH session for the whole IDE window, at the shared parent of its project roots, matching the DSH-side plugin's `junctionRoot: common-parent`. Off gives one session per project directory. Without a usable shared parent (a window whose roots share only `/` or a bare drive root) the project directory is used either way. |
| DSH URL | empty | Overrides address discovery. Accepts a full URL, `host:port`, a bare host, or a bare port. |
| DSH home | empty | Tried first among the harness homes; discovery falls through to the others when its secret does not match the address. |

## Build and install

```sh
./build.sh                       # compiles against /usr/share/idea and copies the jar into the IDE
IDE_HOME=/path/to/idea ./build.sh
```

The installed IntelliJ Platform is the compile classpath — no Gradle and no downloads — and its
bundled JBR supplies `javac`. The plugin is installed into the IDE's user-plugin directory, which the
IDE reads on its next start; **an IDE restart is required after installing or updating it.** The chat
panel then appears as the `DSH Chat` tool window on the right; the plugin compiles against the
platform's own JCEF classes (`intellij.platform.ide.impl.jar` and `intellij.libraries.jcef.jar`),
which the platform install provides under `lib/`.

## Verification

Harnesses runnable without a graphical IDE:

```sh
# 1. The IntelliJ-free half: real bridge, real descriptor, fake IDE.
/usr/share/idea/jbr/bin/javac -cp build/stage -d build/check dev/Check.java dev/DshCheck.java
/usr/share/idea/jbr/bin/java -cp build/stage:build/check Check

# 2. The DSH client against a running DSH (skips itself when none answers). Also proves that an
#    address is still reached when an earlier candidate home's secret does not belong to it.
DSH_HOME=<harness home> /usr/share/idea/jbr/bin/java -cp build/stage:build/check DshCheck

# 3. Address spellings and home candidates, with no DSH and no IDE. The discovery branch that reads
#    the official plugin's settings file goes through the platform's PathManager, so the platform
#    jars belong on the classpath.
PLATFORM=$(find /usr/share/idea/lib -maxdepth 1 -name '*.jar' | paste -sd:)
/usr/share/idea/jbr/bin/javac -cp build/stage -d build/check dev/UrlCheck.java
/usr/share/idea/jbr/bin/java -cp "build/stage:build/check:$PLATFORM" dsh.companion.UrlCheck

# 4. The chat panel's authentication path: the minted cookie against the DSH index (skips itself
#    when no DSH home or server is present). This is the request the embedded browser makes.
/usr/share/idea/jbr/bin/javac -cp build/stage -d build/check dev/ChatCheck.java
DSH_HOME=<harness home> /usr/share/idea/jbr/bin/java -cp build/stage:build/check ChatCheck

# 4b. The active-session record the panel seeds into the client: storage key, payload shape,
#     idempotence, and quote-safety. No IDE, browser, or DSH.
/usr/share/idea/jbr/bin/javac -cp build/stage -d build/check dev/SelectionCheck.java
/usr/share/idea/jbr/bin/java -cp build/stage:build/check dsh.companion.SelectionCheck

# 4c. The session-directory resolver: the window junction, per-window isolation, and every fallback
#     to the narrower project directory. No IDE, browser, or DSH.
/usr/share/idea/jbr/bin/javac -cp build/stage -d build/check dev/ScopeCheck.java
/usr/share/idea/jbr/bin/java -cp build/stage:build/check dsh.companion.ScopeCheck

# 4d. Which session a project resolves to: the newest session of its directory, never a delegated
#     child. No IDE, browser, or DSH.
/usr/share/idea/jbr/bin/javac -cp build/stage -d build/check dev/SessionCheck.java
/usr/share/idea/jbr/bin/java -cp build/stage:build/check dsh.companion.SessionCheck

# 5. The whole plugin inside a real IDE, headless — proves the descriptor loads, the JCEF
#    dependency resolves, and no extension is rejected. Run it with isolated platform paths:
#
#      mkdir -p /tmp/dsh-ide/log
#      cat > /tmp/dsh-ide/idea.vmoptions <<'EOF'
#      -Xmx1024m
#      -Djava.awt.headless=true
#      -Didea.config.path=/tmp/dsh-ide/config
#      -Didea.system.path=/tmp/dsh-ide/system
#      -Didea.log.path=/tmp/dsh-ide/log
#      -Didea.plugins.path=/tmp/dsh-ide/plugins
#      -Ddsh.companion.descriptor=/tmp/dsh-ide/descriptor.json
#      EOF
#
IDEA_VM_OPTIONS=/tmp/dsh-ide/idea.vmoptions \
  /usr/share/idea/bin/idea.sh inspect <project> <inspection-profile> <out>
grep -E 'Loaded custom plugins|dsh-companion' /tmp/dsh-ide/log/idea.log
```

Checks 1–4c are self-contained. Check 5 starts a full IDE with its own `idea.config.path`,
`idea.system.path`, and `idea.plugins.path` (copy the built jar into `<plugins.path>/dsh-companion/lib`)
and reports the project's session outcome in the log. Set `-Ddsh.companion.descriptor=` to a
throwaway path as above: without it the run publishes, and then deletes, the *shared* descriptor of a
running IDE's bridge.

Client-side failures are visible: the panel attaches a JCEF display handler, so the embedded client's
console warnings and errors land in `idea.log` as `dsh-companion: client console <source>:<line>
<message>`, and a failed main-frame load is logged (and shown with Retry) instead of leaving a silently
blank panel. A session request logs its attempt as
`dsh-companion: chat asked the embedded client for session <id> (push 1/3)`.

**Rendering itself needs a display.** Verify it by starting the IDE and opening `DSH Chat`: the DSH web
client should appear with its own session sidebar and composer. A wrong secret or a wrong address
instead shows the panel's message, never DSH's plain-text refusal.

## Limits

- **Installing or updating needs an IDE restart.** The platform loads plugin code at startup only.
- **The chat panel needs a JCEF-capable IDE and a display.** The plugin declares a dependency on
  `com.intellij.modules.jcef`, so it does not load in an IDE without the embedded browser; with one,
  a headless session simply shows the panel's message instead of the client.
- **DSH must be running to create a session or to chat.** Nothing is queued while it is down; the
  project's session is created the next time the project opens or its Tools action runs, and the chat
  panel reconnects through Retry.
- **Sessions are keyed by working directory.** With `Window session` on, every project of one window
  shares the junction session, so opening a second project of the same window reuses it; a project in
  a different window (or a window without a usable shared parent) gets its own. Renaming or moving a
  directory makes a new one, and reuse matches the canonical path, so a directory reached through a
  symlink resolves to the same session.
- **The window junction widens the writable root.** One session at the shared parent can reach every
  attached project, which is the point — and also why `Workspace Write` now covers all of them. Turn
  `Window session` off for one session per project with the narrower boundary.
- **This plugin registers the directory it needs.** Creating the window session also registers (or
  reuses) the workspace at that directory, so the session is grouped where the user sees it. It never
  rewrites an existing workspace's title, and it never deletes one.
- **The descriptor carries the bridge token**, readable by any process of the same user — as is the
  credential document the session API already depends on.
- **The publisher polls at 500 ms** and writes only when a visible field changes.
