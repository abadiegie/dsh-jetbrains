# Publishing checklist

What is already in place, and what only you can decide or do.

## In place

- MIT `LICENSE`, `.gitignore` (build output, IDE state), `SECURITY.md`, `CHANGELOG.md`.
- Package identity: plugin id `io.github.abadiegie.dsh-companion`, vendor `abadi gilang`
  (`https://github.com/abadiegie`), DSH bundle `dsh-jetbrains-workspace`.
- A top-level `README.md` that states the requirements and the unofficial status.
- Development checks that skip themselves when their dependency is absent, plus a CI workflow for the
  parts that need neither an IDE nor a running DSH.

## Before you push

1. **Screenshots.** No screenshot is committed on purpose: the ones taken during development show a
   private project. Take fresh ones with a throwaway project and put them in `docs/`, then reference
   them from the READMEs.
2. **Repository name and URLs.** This repository was prepared as `dsh-jetbrains` under
   `github.com/abadiegie`. If you choose another name, update `README.md` links (the package metadata
   carries no repository URL yet).
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
