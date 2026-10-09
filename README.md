# DSH ⇄ JetBrains

Two small plugins that connect a local [DeepSeek Harness](../../) (DSH) to a JetBrains IDE, so the
IDE and the agent share one workspace instead of two islands.

They are independent halves of one workflow, and each works on its own:

| Package | Platform | What it does |
|---|---|---|
| [`jetbrains-companion/`](jetbrains-companion) | IntelliJ Platform plugin (Java, no Gradle) | **DSH Chat** tool window embedding DSH's own web client, one DSH session per IDE window, live workspace publication, and a loopback bridge so DSH can put a file in front of you. |
| [`jetbrains-workspace/`](jetbrains-workspace) | DSH profile bundle (plain JavaScript) | Reads the IDE's workspace — including a module's multiple content roots from its `.iml` — into DSH as a tool, a runtime context line, and a registered workspace. Works with the companion running or from the IDE's own state files after it closed. |

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

## Install

**1. The IDE plugin** (needs IntelliJ Platform build 243 or newer, with JCEF):

```sh
cd jetbrains-companion
./build.sh                 # compiles against the installed IDE and copies the jar into it
IDE_HOME=/path/to/idea ./build.sh
```

Then restart the IDE. Settings live under `Settings ▸ Tools ▸ DSH Companion`.

**2. The DSH bundle** (needs a DSH profile):

```sh
# from a DSH session: install the bundle directory into the current profile
plugin_manager install_bundle /absolute/path/to/jetbrains-workspace
```

Then restart DSH. `jetbrains_workspace` and `jetbrains_open_in_ide` become available to the agent.

## Documentation

- [`jetbrains-companion/README.md`](jetbrains-companion/README.md) — the chat panel, session scope,
  discovery, settings, verification harnesses, limits.
- [`jetbrains-workspace/README.md`](jetbrains-workspace/README.md) — what it registers, where the data
  comes from, configuration, limits.
- [`SECURITY.md`](SECURITY.md) — what these plugins read and what they can do on your machine. Read
  this before installing.
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
