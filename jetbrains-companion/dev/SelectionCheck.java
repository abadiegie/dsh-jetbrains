package dsh.companion;

/**
 * Standalone check for the active-session record the chat panel seeds into the embedded client: the
 * storage key and payload must match what DSH's web client persists, and the script must be
 * idempotent and quote-safe.
 *
 * It lives in the plugin's own package so it can drive the helper directly, and it needs no IDE, no
 * browser, and no DSH.
 *
 * Run: java -cp build/stage:build/check dsh.companion.SelectionCheck
 */
public final class SelectionCheck {
  private SelectionCheck() {}

  /**
   * @param args - unused.
   * @throws Exception when an expectation fails.
   */
  public static void main(String[] args) throws Exception {
    expect("dsh.sessions.current".equals(DshSessionSelection.STORAGE_KEY),
      "the storage key is the one the web client persists its selection under");

    String payload = DshSessionSelection.payload("session-abc");
    Object parsed = JsonParser.parse(payload);
    expect("session-abc".equals(JsonParser.string(parsed, "sessionId")),
      "the payload is a JSON record naming the session");
    expect(JsonParser.member(parsed, "subagentAddress") == null,
      "the payload carries no subagent address, so the client opens the session itself");

    String script = DshSessionSelection.script("session-abc");
    expect(script.contains("localStorage.getItem") && script.contains("localStorage.setItem"),
      "the script reads before it writes, so it can stay idempotent");
    expect(script.contains("location.reload"), "the script reloads the client once when it must change");
    expect(script.contains("subagentAddress"), "a subagent view is not mistaken for the session");
    expect(script.contains("'current'") && script.contains("'selected'") && script.contains("'failed'"),
      "the script reports which of the three outcomes happened");

    String hostile = DshSessionSelection.script("a\"; window.alert(1); //");
    expect(hostile.contains("a\\\"; window.alert(1); //"), "a quote in the id cannot break out of the string");
    expect(!hostile.contains("\"a\";"), "the hostile id stays inside its JSON literal");

    System.out.println("selection check: the panel seeds the web client's own active-session record");
  }

  private static void expect(boolean condition, String what) {
    if (!condition) throw new AssertionError("expected: " + what);
    System.out.println("ok: " + what);
  }
}
