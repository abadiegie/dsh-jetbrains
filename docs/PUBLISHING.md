# Publishing checklist

What is already in place, and what only you can decide or do.

## In place

- MIT `LICENSE`, `.gitignore` (build output, IDE state), `SECURITY.md`, `CHANGELOG.md`.
- Package identity: plugin id `io.github.abadiegie.dsh-companion`, vendor `abadi gilang`
  (`https://github.com/abadiegie`), DSH bundle `dsh-jetbrains-workspace`.
- A top-level `README.md` that states the requirements, what each package gives you, and the unofficial
  status.
- A third package, `jetbrains-session-link`, with its own `dev/check.mjs`, plus a CI job for it.
- Development checks that skip themselves when their dependency is absent, plus a CI workflow for the
  parts that need neither an IDE nor a running DSH.

## Before you push

1. **Screenshots.** No screenshot is committed on purpose: the ones taken during development show a
   private project. Take fresh ones with a throwaway project and put them in `docs/`, then reference
   them from the READMEs.
2. **Repository name and URLs.** The repository is `github.com/abadiegie/dsh-jetbrains`; the two
   npm-style packages carry `repository`, `homepage`, and `bugs` pointing at it with their own
   `directory`. If the name ever changes, update those fields and the clone line in `README.md` — the
   plugin id and the package names stay as they are.
3. **DSH compatibility.** State the DSH version you tested in the READMEs (the API surface both halves
   need is listed in the top-level README). `plugin_manager` reports the DSH version of a profile.
4. **IDE compatibility.** `plugin.xml` declares `since-build="243"` and a dependency on
   `com.intellij.modules.jcef`. Widen or narrow it only after testing that build.

## Optional, but expected by the ecosystem

- **Gradle build.** `build.sh` compiles against an installed IDE, which is fast and dependency-free but
  unusual; `intellij-platform-gradle-plugin` would let CI build and verify the jar. Keep `build.sh` as
  the zero-download path either way.
- **Java CI.** The Java harnesses need the IntelliJ Platform jars, so CI would have to download an IDE
  distribution first. Until then, `build.sh` + `dev/*.java` is a local acceptance check.
- **Marketplace.** Requires a real `<version>` bump per release, `<change-notes>`, a plugin icon, and a
  signed artifact. The plugin id above is what a Marketplace listing would keep forever.

## Release the two artifacts

They version independently and neither installs the other.

| Artifact | Built by | Where it goes | Notes |
|---|---|---|---|
| `jetbrains-companion` | `jetbrains-companion/build.sh` → `dist/dsh-companion.jar` | GitHub release asset; JetBrains Marketplace once the listing requirements are met | The Marketplace needs a real `<version>` bump per release, `<change-notes>`, a plugin icon, and a signed artifact. Users can also build it from source with no Gradle. |
| `jetbrains-workspace` | nothing to build — plain ESM | the repository directory itself (install with `plugin_manager install_bundle`); npm later if you want | It is not a JetBrains artifact, so the Marketplace cannot carry it. Tag both halves in one release and say which version of each works together. |
| `jetbrains-session-link` | nothing to build — plain ESM with a `dsh.client` half | the repository directory, installed the same way | Optional: without it the panel selects the session through the client's stored record and one reload. Its `dsh.client` half is served from the installed package, so replacing the package needs a DSH restart to load a fresh module generation. |

The contract between them is DSH's own HTTP API plus the companion descriptor
(`<DSH home>/jetbrains-companion.json`, with a `version` and a `source` marker). A mismatch is a clear
refusal — a bundle without a live descriptor reads the IDE state files, and an `open_in_ide` call with no
bridge names the missing companion — so a user can update one half ahead of the other.

`jetbrains-session-link` ships in the same repository and is installed the same way, but nothing requires
it: the panel asks through its fragment and falls back to the stored selection when no such plugin is
listening. Its files are plain ESM, so a release needs no build step — only the tag that names the pair.

## Verification before tagging

```sh
cd jetbrains-workspace && node dev/check.mjs          # schema, discovery, roles, context, registry
cd ../jetbrains-companion && ./build.sh               # compiles against your installed IDE
/usr/share/idea/jbr/bin/javac -cp build/stage -d build/check dev/*.java
for c in Check ChatCheck UrlCheck dsh.companion.SelectionCheck dsh.companion.SessionCheck dsh.companion.ScopeCheck; do
  /usr/share/idea/jbr/bin/java -cp build/stage:build/check "$c"
done
DSH_HOME=<home> /usr/share/idea/jbr/bin/java -cp build/stage:build/check DshCheck
```

`DshCheck` and `ChatCheck` need a running DSH; without one they print why they skipped.
