package dsh.companion;

import java.util.List;

/**
 * Standalone check for the session-directory resolver: which directory one DSH session runs in for an
 * IDE window, and when the narrower project directory is the safe answer instead.
 *
 * It lives in the plugin's own package so it can drive the resolver directly, and it needs no IDE, no
 * browser, and no DSH — only real directories, because the resolver canonicalizes.
 *
 * Run: java -cp build/stage:build/check dsh.companion.ScopeCheck
 */
public final class ScopeCheck {
  private ScopeCheck() {}

  /**
   * @param args - unused, but the check needs a real tree: it uses {@code /tmp}.
   */
  public static void main(String[] args) {
    // A window with a root project beside attached projects, as the IDE reports it.
    Snapshot window = new Snapshot();
    window.projects.add(new Snapshot.ProjectInfo("bi-app-v2", "/tmp",
      List.of("/tmp", "/usr", "/etc", "/var")));

    expect("/tmp", directory(window, "/tmp", true), "a window whose roots share only / keeps the project");
    expect("/tmp", directory(window, "/tmp", false), "the project scope always keeps the project");

    Snapshot siblings = new Snapshot();
    siblings.projects.add(new Snapshot.ProjectInfo("root", "/tmp/scope-check/root",
      List.of("/tmp/scope-check/root", "/tmp/scope-check/module", "/tmp/scope-check/vcs")));
    expect("/tmp/scope-check", directory(siblings, "/tmp/scope-check/root", true),
      "a window of sibling projects shares their parent");
    expect("/tmp/scope-check/root", directory(siblings, "/tmp/scope-check/root", false),
      "the project scope ignores the window");

    Snapshot single = new Snapshot();
    single.projects.add(new Snapshot.ProjectInfo("solo", "/tmp", List.of("/tmp")));
    expect("/tmp", directory(single, "/tmp", true), "a single-root window keeps its own directory");

    Snapshot other = new Snapshot();
    other.projects.add(new Snapshot.ProjectInfo("elsewhere", "/usr", List.of("/usr", "/var")));
    expect("/tmp", directory(other, "/tmp", true),
      "another window's projects do not widen this one's session");

    expect("/tmp", directory(null, "/tmp", true), "no snapshot yet falls back to the project");
    expect(null, directory(siblings, null, true), "a project without a directory has no session");
    expect("/tmp/scope-check", directory(siblings, "/tmp/scope-check/root/../root", true),
      "a non-canonical project path still matches its own window");

    expect(SessionScope.describes(siblings, "/tmp/scope-check/root"),
      "a snapshot that lists the project is recognized as describing its window");
    expect(!SessionScope.describes(siblings, "/tmp/other"),
      "an unrelated project is not claimed by another window's snapshot");
    expect(!SessionScope.describes(null, "/tmp"), "an uncollected snapshot describes nothing");

    System.out.println("scope check: the window junction is the shared parent, the project is the fallback");
  }

  private static String directory(Snapshot snapshot, String projectPath, boolean windowScope) {
    return SessionScope.directory(snapshot, projectPath, windowScope);
  }

  private static void expect(String expected, String actual, String what) {
    if (expected == null ? actual != null : !expected.equals(actual)) {
      throw new AssertionError("expected " + expected + " for " + what + ", got " + actual);
    }
    System.out.println("ok: " + what);
  }

  private static void expect(boolean condition, String what) {
    if (!condition) throw new AssertionError("expected: " + what);
    System.out.println("ok: " + what);
  }
}
