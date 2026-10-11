package dsh.companion;

import java.util.List;

/**
 * Standalone check for which session the panel resolves for a project directory: the newest session of
 * that directory, never a delegated child.
 *
 * A subagent child shares its parent's working directory and is usually the newer row, so a resolver
 * without this filter hands the panel a child view; the client then records that selection as a
 * subagent address instead of the session, and the panel keeps re-asking for a session it already
 * shows. It needs no IDE, no browser, and no DSH.
 *
 * Run: java -cp build/stage:build/check dsh.companion.SessionCheck
 */
public final class SessionCheck {
  private SessionCheck() {}

  /**
   * @param args - unused.
   * @throws Exception when an expectation fails.
   */
  public static void main(String[] args) throws Exception {
    List<DshClient.SessionRow> rows = List.of(
      new DshClient.SessionRow("session-parent", "/p", 100L, false, null, null),
      new DshClient.SessionRow("session-child", "/p", 900L, false, "subagent", "session-parent"),
      new DshClient.SessionRow("session-elsewhere", "/q", 999L, false, null, null));

    expect("subagent".equals(rows.get(1).origin()) && rows.get(1).isSubagent(),
      "a row marked subagent is recognized as a delegated child");
    expect(!rows.get(0).isSubagent(), "a row with no origin and no parent is a session a human opened");
    expect(new DshClient.SessionRow("s", "/p", 1L, false, null, "parent").isSubagent(),
      "a row that names a parent is a delegated child even without the origin field");

    DshClient.SessionRow picked = DshSessions.newestProjectSession(rows, "/p");
    expect(picked != null && "session-parent".equals(picked.sessionId()),
      "the project's session is the newest session of that directory, never a subagent child");
    expect(DshSessions.newestProjectSession(List.of(), "/p") == null,
      "a directory with no session of its own resolves to none");
    expect(DshSessions.newestProjectSession(rows, "/q").sessionId()
        .equals("session-elsewhere"),
      "another directory still resolves to its own newest session");

    System.out.println("session check: the panel resolves a project to its own session, not a subagent child");
  }

  private static void expect(boolean condition, String what) {
    if (!condition) throw new AssertionError("expected: " + what);
    System.out.println("ok: " + what);
  }
}
