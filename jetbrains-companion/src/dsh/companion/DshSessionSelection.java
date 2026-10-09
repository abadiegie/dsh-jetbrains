package dsh.companion;

/**
 * The web client's own active-session record.
 *
 * DSH's web client has no session deep link: on boot it restores the session it displays from the
 * `dsh.sessions.current` localStorage entry, and it writes that entry itself on every navigation.
 * The IDE panel therefore seeds the entry — the client's own persistence contract, not DOM
 * automation, so no selector or markup assumption can break it — and lets the client boot into the
 * session whose working directory is the open project.
 *
 * The entry is per origin, so it belongs to the embedded browser's own profile and is invisible to
 * the user's system browser.
 */
final class DshSessionSelection {
  /** localStorage key the web client persists its current session under. */
  static final String STORAGE_KEY = "dsh.sessions.current";

  private DshSessionSelection() {}

  /**
   * @param sessionId - session the client should show.
   * @return the record exactly as the client persists it; undefined members are absent in its own
   *     writes too, because the value is a plain JSON serialization of the selection.
   */
  static String payload(String sessionId) {
    return "{\"sessionId\":" + Json.quote(sessionId) + "}";
  }

  /**
   * Leave the correct active-session record in place, reloading once when the client was showing
   * another session.
   *
   * The script is idempotent: a second run after the reload finds the record already naming the
   * session and does nothing, so seeding can never reload in a loop even if the client rewrites its
   * selection while restoring.
   * @param sessionId - session the client should show.
   * @return JavaScript evaluating to `current`, `selected`, or `failed`.
   */
  static String script(String sessionId) {
    return "(function(){try{"
      + "var key=" + Json.quote(STORAGE_KEY) + ";"
      + "var id=" + Json.quote(sessionId) + ";"
      + "var raw=window.localStorage.getItem(key);"
      + "if(raw!==null){var cur=JSON.parse(raw);"
      + "if(cur&&cur.sessionId===id&&!cur.subagentAddress){return 'current';}}"
      + "window.localStorage.setItem(key," + Json.quote(payload(sessionId)) + ");"
      + "window.location.reload();"
      + "return 'selected';"
      + "}catch(e){return 'failed';}})()";
  }
}
