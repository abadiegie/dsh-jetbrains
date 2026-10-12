# DSH ⇄ JetBrains

Small packages that connect a local [DeepSeek Harness](../../) (DSH) to a JetBrains IDE, so the IDE and
the agent share one workspace instead of two islands.

Two of them are independent halves of one workflow, and each works on its own; the third lets a page be
asked for a session by address.:

| Package | Platform | What it does |
|---|---|---|
| [`jetbrains-companion/`](jetbrains-companion) | IntelliJ Platform plugin (Java, no Gradle) | **DSH Chat** tool window embedding DSH's own web client, one DSH session per IDE window, live workspace publication, and a loopback bridge so DSH can put a file in front of you. |
| [`jetbrains-workspace/`](jetbrains-workspace) | DSH profile bundle (plain JavaScript) | Reads the IDE's workspace — including a module's multiple content roots from its `.iml` — into DSH as a tool, a runtime context line, and a registered workspace. Works with the companion running or from the IDE's own state files after it closed. |
| [`jetbrains-session-link/`](jetbrains-session-link) | DSH client plugin (plain JavaScript) | Lets `#dsh-session=<id>` — or a hash change on an open page — select that session without a reload. Optional: the chat panel falls back to the client's stored selection when it is absent. |

> **Unofficial.** Neither package is made by, endorsed by, or affiliated with JetBrains or DeepSeek.
> IntelliJ, IDEA and JetBrains are trademarks of JetBrains s.r.o.

## What you get

- **Chat inside the IDE.** The `DSH Chat` tool window renders DSH's web client, authenticated with the
  same browser-session cookie DSH gives a browser, and opens the session for the window you are in.
- **One workspace, seen from both sides.** The window's root project and every attached module/VCS
  directory reach the model as a runtime context line and as a `jetbrains_workspace` tool result, with
  each directory labelled by the source that reported it.
- **Round trip.** DSH can read the active file, caret and selection, and open a file in the IDE at a
  line — with the companion's bridge, or with the IDE state files when the IDE is closed.

## What each half gives you

Each half is useful alone, and they do not depend on each other to install. What you get changes:

| Capability | IDE plugin only | DSH bundle only | Both |
|---|---|---|---|
| `DSH Chat` tool window in the IDE (embedded DSH client, cookie auth) | yes | — | yes |
| One DSH session per IDE window, grouped in the DSH sidebar | yes — the panel registers the workspace and creates or attaches the session itself | — | yes |
| The model knows which IDE window is open (runtime context line) | — | yes, from the IDE's state files, or live when the companion runs | yes |
| `jetbrains_workspace` tool: root project, module content roots, active file, caret, selection | — | yes | yes |
| `jetbrains_open_in_ide`: the model opens a file in the IDE | — | no — it needs the companion's bridge | yes |
| Session selected without reloading the page | no — it seeds the client's stored selection and reloads once | — | yes, with `jetbrains-session-link` |

So: install the **IDE plugin** to chat with DSH inside your IDE (it needs a DSH running locally, and
reads DSH's credential document to sign the browser cookie — see [SECURITY.md](SECURITY.md)). Install
the **DSH bundle** to put your IDE workspace in front of the model. Install **both** for the round
trip, where the model can name the file you are editing and open another one for you.

The two halves talk through DSH's own HTTP API and the companion's descriptor
(`<DSH home>/jetbrains-companion.json`, carrying a `version` and a `source` marker), so either half can
be updated on its own: a bundle that finds no live descriptor falls back to the IDE's state files, and a
companion never requires the bundle to be installed.

## Install

**1. The IDE plugin** (needs IntelliJ Platform build 243 or newer, with JCEF):

```sh
cd jetbrains-companion
./build.sh                 # compiles against the installed IDE and copies the jar into it
IDE_HOME=/path/to/idea ./build.sh
```

Then restart the IDE. Settings live under `Settings ▸ Tools ▸ DSH Companion`. Step 1 needs no DSH-side
plugin; installing it alone gives you the chat panel (see the table above).

**2. The DSH bundle** (needs a DSH profile):

```sh
# from a DSH session: install the bundle directory into the current profile
plugin_manager install_bundle /absolute/path/to/jetbrains-workspace
```

Then restart DSH. `jetbrains_workspace` and `jetbrains_open_in_ide` become available to the agent; step
2 needs no IDE plugin, because the bundle reads the IDE's state files when no companion is publishing a
descriptor. For the round trip — the model naming your active file and opening another — install both.

## Documentation

- [`jetbrains-companion/README.md`](jetbrains-companion/README.md) — the chat panel, session scope,
  discovery, settings, verification harnesses, limits.
- [`jetbrains-workspace/README.md`](jetbrains-workspace/README.md) — what it registers, where the data
  comes from, configuration, limits.
- [`jetbrains-session-link/README.md`](jetbrains-session-link/README.md) — the fragment contract, the
  marker a host reads, and what was verified in a browser and inside the IDE panel.
- [`SECURITY.md`](SECURITY.md) — what these plugins read and what they can do on your machine. Read
  this before installing.
- [`.dsh/skills/dsh-jetbrains/SKILL.md`](.dsh/skills/dsh-jetbrains/SKILL.md) — a DeepSeek Harness
  skill for agents editing this repository: the build and check commands, and the traps worth knowing
  first. DSH scans `<project>/.dsh/skills` (and `<project>/.agents/skills`) around the nearest
  repository root, so a clone carries it and it is live for the agent working in that clone.
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md) — the checklist this repository was prepared against.
- [`CHANGELOG.md`](CHANGELOG.md).

## Requirements

- A JetBrains IDE, build 243+ (`IC-243` or newer), with the bundled browser (JCEF).
- A JDK 21 toolchain for the IDE plugin build — the IDE's own JBR is enough.
- Node.js 20+ for the DSH bundle and its development checks.
- DSH from a version that exposes `workspace/create` returning `sessionIds` and `created`,
  `workspace/rename`, `session/create` with either `cwd` or `workspaceId` + `sessionId`, and
  `workspace/archiveSession` — the API surface both halves are written against.

## Development

```sh
# DSH bundle: schema, discovery, roles, workspace registration, runtime context
cd jetbrains-workspace && node dev/check.mjs

# IDE plugin: the IntelliJ-free half, the DSH client, the panel's auth path, address and scope rules
cd jetbrains-companion && ./build.sh
/usr/share/idea/jbr/bin/javac -cp build/stage -d build/check dev/*.java
/usr/share/idea/jbr/bin/java -cp build/stage:build/check Check
```

Every harness skips itself with a message when the DSH home, the server, or the IDE it needs is
absent, so a missing dependency never looks like a failure.

## License

MIT — see [LICENSE](LICENSE).
