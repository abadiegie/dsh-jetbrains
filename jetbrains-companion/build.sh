#!/usr/bin/env bash
# Build the DSH Companion IDE plugin and install it into the locally installed IDE.
#
# The installed IntelliJ Platform is the compile classpath (no Gradle, no downloads), and its
# bundled JBR provides javac. The jar lands in the IDE's user-plugin directory, which the IDE reads
# on its next start.
#
# Environment:
#   IDE_HOME    IntelliJ Platform installation (default /usr/share/idea)
#   PLUGIN_DIR  target plugin directory (default ~/.local/share/JetBrains/IdeaIC2026.1/dsh-companion)
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
IDE_HOME=${IDE_HOME:-/usr/share/idea}
PLUGIN_DIR=${PLUGIN_DIR:-$HOME/.local/share/JetBrains/IdeaIC2026.1/dsh-companion}
JAVAC=$IDE_HOME/jbr/bin/javac
STAGE=$HERE/build/stage
JAR=$HERE/dist/dsh-companion.jar

if [[ ! -x $JAVAC ]]; then
  echo "build: no javac at $JAVAC; set IDE_HOME to an IntelliJ installation" >&2
  exit 1
fi

CLASSPATH=$(find "$IDE_HOME/lib" -maxdepth 1 -name '*.jar' | paste -sd:)
# The platform's ProjectActivity is a Kotlin suspend interface, so the stdlib types it names must be
# on the compile classpath; at runtime the bundled Kotlin plugin supplies them.
KOTLIN_STDLIB=$IDE_HOME/plugins/Kotlin/kotlinc/lib/kotlin-stdlib.jar
if [[ -f $KOTLIN_STDLIB ]]; then
  CLASSPATH="$CLASSPATH:$KOTLIN_STDLIB"
fi
rm -rf "$STAGE"
mkdir -p "$STAGE/META-INF" "$(dirname "$JAR")"

echo "build: compiling against $IDE_HOME"
# shellcheck disable=SC2046 # word splitting is how javac receives the source list
"$JAVAC" -nowarn --release 21 -cp "$CLASSPATH" -d "$STAGE" $(find "$HERE/src" -name '*.java')
cp "$HERE/plugin.xml" "$STAGE/META-INF/plugin.xml"
[ -f "$HERE/META-INF/pluginIcon.svg" ] && cp "$HERE/META-INF/pluginIcon.svg" "$STAGE/META-INF/pluginIcon.svg"

echo "build: packaging $JAR"
(cd "$STAGE" && jar --create --file "$JAR" .)

echo "build: installing into $PLUGIN_DIR/lib"
mkdir -p "$PLUGIN_DIR/lib"
# Install by rename, never by rewriting the file the IDE may be reading: `cp` overwrites the same inode, so
# a running IDE that loads a class lazily afterwards reads a mixture of two builds. A rename swaps the
# directory entry and leaves the inode a running IDE holds untouched, which is what keeps it loadable.
cp "$JAR" "$PLUGIN_DIR/lib/.dsh-companion.jar.new"
mv -f "$PLUGIN_DIR/lib/.dsh-companion.jar.new" "$PLUGIN_DIR/lib/dsh-companion.jar"

echo "build: done — restart the IDE to load $PLUGIN_DIR"

# A Marketplace upload and an "Install Plugin from Disk" both take this ZIP: the archive root is the
# plugin root and holds exactly lib/, which is the layout the validator demands.
VERSION=$(sed -n 's/.*<version>\(.*\)<\/version>.*/\1/p' "$HERE/plugin.xml" | head -1)
DIST="$HERE/dist/dsh-companion-$VERSION.zip"
ZIP_ROOT="$HERE/dist/zip"
rm -rf "$ZIP_ROOT"
mkdir -p "$ZIP_ROOT/lib"
cp "$JAR" "$ZIP_ROOT/lib/"
# `--no-manifest` matters: without it the jar tool writes META-INF/MANIFEST.MF at the archive root, and a
# Marketplace upload is rejected for a root holding more than lib/ ("must not contain multiple files").
(cd "$ZIP_ROOT" && jar --create --no-manifest --file "$DIST" lib)
rm -rf "$ZIP_ROOT"
echo "build: distribution $DIST ($(du -h "$DIST" | cut -f1))"
