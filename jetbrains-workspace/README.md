# JetBrains IDE integration (local DSH plugin)

Package `dsh-jetbrains-workspace`: a DSH host plugin that reads the JetBrains IDE workspace open on
this machine — the root project directory, every project attached to the same window (each in its own
filesystem location), and the files open in the editor — and registers those directories as DSH
workspaces.

It exists for the common JetBrains layout where one window holds several projects that do **not**
share a parent project directory — the window's root project, plus attached projects registered as
modules or VCS roots.

## What it registers

| Contribution | Name | Purpose |
|---|---|---|
| Tool | `jetbrains_workspace` | Returns the workspace roots, editor tabs, the active file with its caret position and selection, as structured data. |
| Tool | `jetbrains_open_in_ide` | Opens a file in the running IDE, focused, with the caret on a line. |
| Runtime context | `jetbrains:workspace` | The window's project, its attached directories **grouped by the source that reported them** (`module content roots (declared in the module .iml)`, `module directories (no content root declared)`, `VCS roots outside the root project`, `IDE workspace roots`, `directories of open files`), and the session root when it reaches beyond the project — so the model knows which directories exist before it calls the tool. Set `context: false` to disable. |
| DSH workspace | the root project of each window | Registers one durable DSH workspace per JetBrains project, at that project's own directory, so sessions grouped there are the project's own. `junctionRoot: common-parent` widens it to a directory that reaches every root (the window workspace); `workspaceMode: per-project` registers one workspace per directory; `off` disables registration. Nothing is deleted automatically. |

Two sources feed the first two contributions. The **live bridge** of the companion IDE plugin
([../jetbrains-companion](../jetbrains-companion)) publishes the open projects, the active editor
position, the selection, and the open tabs within half a second of a change, and answers the
open-in-IDE calls. Without it, the plugin reads the IDE's **own state files**, which need no
cooperation from the IDE and keep working after the IDE exits.

## Installation

The bundle is installed into a profile with `plugin_manager` `install_bundle` and the absolute
package directory as the target. The shipped patch inserts one row:

```yaml
- insert:
    - id: jetbrains-workspace
      name: 'dsh-jetbrains-workspace'
      config:
        context: true
```

### Reloading after an edit

A live profile re-runs a bundle's plugin when the bundle is toggled, but it does not re-import
changed JavaScript: the Loader resolves a package specifier once, so edits to `src/` take effect on
the next DSH restart. To load an edit without restarting, install the package under a changed
`name` in `package.json` (a new specifier resolves to a new module URL) and remove the old bundle.

## Opening a presented file in the IDE

`present` is how a model declares an artifact — a report, a spreadsheet, a rendered page — as the thing
to look at. DSH appends a durable `deliverables/presented` session event at that moment, and this plugin
can turn it into an editor tab through the companion bridge, which is the same loop the
`jetbrains_open_in_ide` tool uses.

It is **off unless the row asks for it** (`autoOpenDeliverables: true`): an editor that opens tabs by
itself is a surprise, and `jetbrains_open_in_ide` already lets a model ask explicitly. When it is on, only
the session this IDE window owns is served — the one whose working directory is the window's junction —
so a background or automation session presenting a file cannot open tabs in an IDE nobody is watching.
Presented files may live anywhere, so the check is on the session, not on the path. A delivery with no
running companion, or one the bridge refuses, is logged and otherwise ignored: the event feed never waits
on an editor.

To turn it on for one profile without changing this repository's default, install a small bundle that
restates the row with the extra key:

```yaml
# dsh-jetbrains-deliverables/cordis.patch.yml
- id: jetbrains-workspace
  name: 'dsh-jetbrains-workspace'
  config:
    autoOpenDeliverables: true
    context: true
    workspaceMode: single
    registerWorkspaces: false
    junctionRoot: common-parent
    pruneProjectWorkspaces: false
```

An override replaces the whole `config`, so every key the deployment relies on has to be restated — the
values above are the ones this repository ships.

## The change review document

The Host's change recorder summarizes a turn's changed files, but it keeps them in memory and announces
each turn with a `workspace/changes` session event whose sequence is the only key that serves the
summary and the per-file comparison. A panel in another process cannot listen to that feed, so this
plugin publishes what it needs into

```
<home>/.dsh/jetbrains-changes.json        # home defaults to the user home, as everywhere else here
```

A reader treats it as read-only and refreshes it when it changes:

```json
{
  "version": 1,
  "source": "jetbrains-workspace",
  "updatedAt": "2026-10-12T09:00:00.000Z",
  "sessions": [
    {
      "sessionId": "session-…", "cwd": "/work/project", "seq": 4850, "turn": 33,
      "total": 1, "added": 35, "deleted": 0, "at": 1760000000000,
      "files": [{ "path": "docs/A.md", "display": "docs/A.md", "added": 35, "deleted": 0 }]
    }
  ]
}
```

`seq` is the coordinate a DSH client needs for the rest of the review, which needs no plugin support —
three authenticated routes already serve it, with the same cookie the IDE plugin signs for its own API
calls:

```sh
curl -H "Cookie: $COOKIE" "http://127.0.0.1:3080/api/changes.summary?sessionId=…&seq=4850"
curl -H "Cookie: $COOKIE" "http://127.0.0.1:3080/api/changes.diff?sessionId=…&seq=4850&index=0"
```

The summary route answers `404 Change summary unavailable.` for a sequence that is not a change event,
so a reader must use the published `seq` rather than a session's current position. The recorder keeps
nothing across restarts: a Host that restarts publishes an empty document and has no comparison for
turns recorded before it, and this plugin writes that empty document at mount for exactly that reason.
Each write is atomic (a temporary file renamed over the target), and a failed write is reported and
otherwise ignored.

## Configuration

Every field is optional and is validated when the plugin activates.

| Field | Default | Meaning |
|---|---|---|
| `home` | current user's home | Home directory used for `$USER_HOME$` and the default config roots. |
| `configRoots` | platform default | JetBrains configuration directories to scan. The defaults are `~/Library/Application Support/JetBrains` (macOS), `%APPDATA%\JetBrains` (Windows), `$XDG_CONFIG_HOME/JetBrains` or `~/.config/JetBrains` (Linux), plus `~/.config/JetBrains` on every platform. |
| `serverPorts` | `[63342, 63343, 63344, 63345]` | Ports probed for the IDE built-in web server, in the order several running IDEs take them. |
| `probeTimeoutMs` | `700` | Per-port deadline for that identity probe. |
| `probe` | `true` | Set `false` to read only local state files and skip the HTTP probe. |
| `openFileLimit` | `25` | Maximum editor files listed by the tool; the omitted remainder is reported as a count. |
| `context` | `true` | Register the runtime-context line. |
| `contextOrder` | `130` | Placement of that context (the Harness' own runtime contexts use 110–120). |
| `contextRootLimit` | `12` | Maximum attached project directories named in the context line. |
| `cacheTtlMs` | `3000` | How long the context reuses one synchronous report before re-reading the IDE state. |
| `liveBridge` | `true` | Prefer the companion IDE plugin's live snapshot over the IDE state files. Set `false` to read only the state files. |
| `bridgePath` | `~/.dsh/jetbrains-companion.json` | Companion descriptor to read. |
| `workspaceMode` | `single` | `single` registers one workspace for the window, `per-project` registers one per detected directory, `off` registers none. |
| `junctionRoot` | `root-project` | Which directory `single` mode registers: the root project (one session per project, matching the IDE companion), or `common-parent` to widen the boundary so `workspace-write` reaches attached projects. |
| `pruneProjectWorkspaces` | `false` | Opt-in deletion, in `single` mode with a `root-project` junction only: remove a workspace whose directory is a project of this window and which reports no session. It is refused outright for a `common-parent` junction and off by default, because a workspace's `sessionIds` is a *filtered* projection — it reads empty while the session header index is rebuilding, and while a stored workspace path and a session's canonical `cwd` disagree. Deleting a durable registration stays a human action. `registerWorkspaces` remains accepted as the earlier boolean spelling. |

## Where the data comes from

| Fact | Source |
|---|---|
| Live open projects, active file, caret, selection, tabs | the companion IDE plugin's descriptor `~/.dsh/jetbrains-companion.json`, accepted only while its recorded process is alive |
| Which projects this IDE has open | `<config>/options/recentProjects.xml` — entries marked `opened="true"`, falling back to `lastOpenedProject` |
| Whether the IDE is running | `<config>/.lock` (owning process id) and the built-in web server's `GET /api/about` identity |
| Editor tabs and active file | `<config>/workspace/<projectWorkspaceId>.xml`, else `<project>/.idea/workspace.xml` |
| Attached projects | the **content roots each module file declares** — `.idea/modules.xml` only names the module files, and their `<content url=…>` entries are the roots, reported with role `module`; `$MODULE_DIR$` follows the platform's own rule (`PathMacroUtil.getModuleDir`), which steps up from a `.idea` parent to the project directory. A module file that declares no content root contributes its own directory instead, reported as `module-dir`. Plus `.idea/vcs.xml` mappings whose path escapes `$PROJECT_DIR$`, and external open files resolved to their nearest project directory |
| Project roots the IDE itself declares | the `ProjectRoots` component of the per-project workspace state |

Reported paths are canonical (`realpath`) where the filesystem can resolve them, so a consumer can
use them directly even when the IDE reaches the project through a symlink.

## Limits

- **One session per project, one directory per session.** DSH bounds a session's writes by its
  working directory. The companion IDE plugin creates that session at the project's own directory,
  and this plugin registers the matching workspace, so a project opened in the IDE is a session of
  its own. Attached projects then sit outside the writable root: reach them with an approved
  escalation, a full-access session, or `junctionRoot: common-parent`, which registers the shared
  parent of the window instead.
- **Registration is durable; deletion is yours.** A registered directory stays in the sidebar after
  the IDE closes it, and this plugin never deletes one on its own: pruning is opt-in, and refused for a
  `common-parent` junction, where every project workspace of the window would be a candidate. A
  workspace's reported session list is a filtered projection, so it can read empty while its sessions
  exist — never let that decide a deletion.
- **Live mode needs the companion IDE plugin.** Without it the plugin still reads the IDE state
  files, which cover the same roots but lag the window and cannot see a selection or open a file.
- **The runtime context stays stable.** It names the workspace directories and their sources, which
  change only when a project is attached or detached, so a tab switch does not invalidate the request
  prefix; `dev/check.mjs` asserts that a caret move and a tab switch leave the text byte-identical.
  The active file, caret, and selection arrive through the tool instead.
- **The IDE must be on this machine.** State files under `~/.config/JetBrains` describe a local
  install; a remote-development or Dev Container IDE writes its state on the remote host.
- **Several IDEs can be installed.** The plugin selects the running IDE with an open project, else
  the most recently used configuration. Pass `ide: "IdeaIC2026.1"` to the tool to read a specific
  configuration, or `allIdes: true` to list them.
- **The editor tab list is a snapshot.** The IDE rewrites the workspace state file on focus and tab
  changes, so an entry can lag the window by a moment.
- **Attached projects are inferred.** JetBrains has no single file naming a multi-project window's
  members; the plugin unions the module, VCS-root, workspace-root, and open-file evidence, so it
  lists the smallest set of project directories those sources agree on.

## Development check

`node dev/check.mjs` registers the plugin against a stub context, validates both schemas with the
Harness' own validators (`packages/core/tools/lib`), executes the tool against this machine's IDE
state, asserts that every detected project directory is handed to a stub workspace registry, and
prints the rendered result and the runtime-context line.
