---
name: dsh-jetbrains
description: Use when changing this repository's JetBrains integration packages — the DSH Companion IDE plugin (`jetbrains-companion/`, Java, JCEF chat panel, cookie auth, session and bridge plumbing), the `dsh-jetbrains-workspace` DSH bundle (`jetbrains-workspace/`, workspace discovery, runtime context, workspace registration), or the `jetbrains-session-link` DSH client plugin (`jetbrains-session-link/`, the session URL fragment and its marker) — including building, running the development checks, and diagnosing the panel, cookie, session, or workspace behaviour.
---

# Working on the DSH ⇄ JetBrains plugins

Two halves of one workflow in one repository. Read the package README before changing either half;
this file is the short version plus the traps that already cost time here.

| Half | Path | Runs in | Language |
|---|---|---|---|
| DSH Companion | `jetbrains-companion/` | the IDE process | Java, compiled by `build.sh` against the installed IDE |
| dsh-jetbrains-workspace | `jetbrains-workspace/` | the DSH host process | plain JavaScript ESM, no build step |
| jetbrains-session-link | `jetbrains-session-link/` | the browser (a DSH client plugin) | plain JavaScript ESM, no build step |

## Build and verify

```sh
cd jetbrains-workspace && node dev/check-synthetic.mjs   # synthetic inputs; needs no IDE, DSH, or display
cd jetbrains-session-link && node dev/check.mjs          # the client half against a fake browser
cd jetbrains-workspace && node dev/check.mjs             # drives the tools against this machine's IDE
cd jetbrains-companion && ./build.sh                      # compiles and installs the jar into the local IDE
/usr/share/idea/jbr/bin/javac -cp build/stage -d build/check dev/*.java
for c in Check ChatCheck UrlCheck dsh.companion.SelectionCheck dsh.companion.SessionCheck dsh.companion.ScopeCheck; do
  /usr/share/idea/jbr/bin/java -cp build/stage:build/check "$c"
done
DSH_HOME=~/.dsh /usr/share/idea/jbr/bin/java -cp build/stage:build/check DshCheck
```

Every harness skips itself with a message when the DSH home, server, or IDE it needs is absent. The
DshCheck round trip creates and deletes only the workspace it created; do not weaken that guard.
Live diagnosis: the panel forwards its client console to `idea.log` as `dsh-companion: client console
<source>:<line> <message>`, and each session request logs `chat asked the embedded client for session
<id> (push n/3)`.

## Traps

1. **JCEF connects asynchronously.** `setCreateImmediately(true)` creates the browser object, not its
   link to `cef_server`; writing the cookie before that link exists throws `setCookie: connection with
   cef_server wasn't established yet`. Wait and retry (`DshChatPanel.storeCookie`), then load —
   loading first is refused with 401, and the panel must never show DSH's plain-text refusal.
2. **The panel authenticates with a signed cookie, not a session token.** `DshCredentials` reads
   `<DSH home>/.credentials.yaml` → `client-connection/browser-session`, and `DshClient` signs
   `dsh-auth-<sha256 authority>` = `v1.<payload>.<hmac>`. An address and a home must belong together:
   pair every candidate address with every candidate home, and report which pair won.
3. **The web client has no session deep link.** Selection lives in `localStorage['dsh.sessions.current']`
   as `{"sessionId":…}`; seed it and reload. The client clears that record when a restoration attempt
   fails or when the user starts a new session, so re-apply after each served load, with a small bound
   and a reload only when the record differs — an unbounded push loop is the failure mode to avoid.
4. **Sessions and workspaces match by canonical directory.** With `Window session` on, the directory is
   the window junction; otherwise the project's own. `workspace/create` is idempotent by path and
   returns `sessionIds` and `created`; create a session **inside** its workspace, because one created
   with a bare `cwd` is grouped only when the registry next rebuilds its membership.
5. **`$MODULE_DIR$` is not the `.iml` directory.** For a module stored in `.idea`, the platform's
   `PathMacroUtil.getModuleDir` steps up to the project directory; expanding content roots against
   `.idea` names paths that do not exist.
6. **A workspace's `sessionIds` is a filtered projection** — it reads empty while the header index is
   rebuilding, and when a stored path and a canonical `cwd` disagree. Never let it decide a deletion:
   pruning is opt-in, refused for a `common-parent` junction, and a deleted registration is the user's.
7. **The companion descriptor is shared** at `~/.dsh/jetbrains-companion.json`. A headless IDE run
   (`idea.sh inspect`) rewrites it and deletes it on exit, which breaks a running IDE's bridge; pass
   `-Ddsh.companion.descriptor=/tmp/…` for headless testing, and let the running IDE republish.
8. **Code loads at process start.** The IDE plugin reloads only on an IDE restart; the DSH bundle's
   `src/*.js` resolves once per host process, while its patch/config layer reloads live — so a
   config-only change (for example `junctionRoot`) takes effect immediately and a code change does not.
9. **JCEF needs a display.** On a headless box, start the IDE as
   `setsid nohup env DISPLAY=:0 XAUTHORITY=~/.Xauthority /usr/share/idea/bin/idea &`, take screenshots
   with `scrot`, and activate windows with `xdotool windowactivate <id>`; without a display the panel
   can only report its message card.
10. **A subagent shares its parent's directory.** `session/list` marks a delegated child with
    `origin: subagent` (or a `parentSessionId`), and it is usually the newer row, so resolving "the
    session for this directory" without that filter hands the panel a child view — the client records
    it as a subagent address, and the panel then keeps re-asking for a session it already shows.
11. **The panel forwards warnings and errors only.** A plugin's `console.info` (a success line, say)
    never reaches `idea.log`, so "no plugin message" proves nothing; log diagnostics with
    `console.warn`, and use `DSH_COMPANION_PROBE` for the page's own view of its link state.
12. **Change review data is keyed by an event sequence, and lives only in memory.** The Host's change
    recorder announces each turn with a `workspace/changes` session event; only that event's `seq`
    serves `ctx.workspaceChanges.summary/diff`, and DSH's `/api/changes.summary|diff|open` routes answer
    `404 Change summary unavailable.` for anything else (a session's current position is not a change
    event, and `session/page` does not carry these events; `session/follow` needs the stream carrier,
    not a plain POST). The recorder keeps nothing across restarts, so a reopened conversation has no
    review for its earlier turns. `jetbrains-workspace` publishes the coordinates to
    `<home>/.dsh/jetbrains-changes.json` (config `changes`, `changesPath`) for exactly this reason.
    Register the listener in the shape every shipped listener uses — `ctx.on('session/event', (session,
    event) => …)` with **no options**: an unexpected listener option silences the feed instead of
    erroring, and the synthetic check's stub accepts anything, so only a live Host shows it.
13. **A live config change does not re-run `apply` for a plugin without a `Config` schema.**
    `patchReload: live` updates the *composed* config — `dsh --profile <p> --dump-config` shows the new
    value immediately — but this plugin declares no `Config` schema, so a row whose settings were read
    at activation (for example `autoOpenDeliverables`) keeps the value it started with until the Host
    restarts. Verified both ways: the composed config said `true` while the running instance had no
    listener registered, and a `present` opened nothing; after a restart the same `present` opened the
    file. Tell users to restart the Host after changing this plugin's settings.
14. **Presented artifacts announce themselves.** `present` appends `deliverables/presented`
    (`{turn, callId, files:[{path,…}]}`), which is the hook for acting on an artifact; nothing opens a
    file by itself unless `jetbrains-workspace` runs with `autoOpenDeliverables: true`, and then only for
    the session whose `cwd` is the IDE window's junction. An override of that row replaces its whole
    `config`, so every key must be restated.
15. **`domain.local` plugin ids are a smell.** The plugin id is permanent once published; this
    repository uses `io.github.abadiegie.dsh-companion`.

## Where the rest is written

`jetbrains-companion/README.md` and `jetbrains-workspace/README.md` (behaviour, configuration, limits),
`README.md` (install and requirements), `SECURITY.md` (what these plugins read and can do on the
machine), `docs/PUBLISHING.md` (release checklist), `CHANGELOG.md`.
