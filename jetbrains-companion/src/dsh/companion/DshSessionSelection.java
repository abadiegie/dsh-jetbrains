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

  /** URL fragment parameter a session-link client plugin accepts. */
  static final String LINK_PARAMETER = "dsh-session";

  /**
   * Marker a session-link client plugin sets once it is listening for {@link #LINK_PARAMETER}.
   *
   * A host must not seed the stored selection while the marker is present: that path reloads the page,
   * which restarts the client boot before it has the workspace data the fragment path needs.
   */
  static final String LINK_MARKER = "__dshSessionLink";

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

  /**
   * Ask a session-link client plugin in the page to open the session, with no reload.
   *
   * An installed `dsh-jetbrains-session-link` sets {@link #LINK_MARKER}, reads this fragment, opens
   * the session through the client's workspace service, and clears the parameter again; the client
   * then persists the selection itself, which is what makes {@link #script(String)} a no-op
   * afterwards. With no such plugin the fragment is inert — DSH's own client uses no fragment — and
   * this script touches nothing, so the caller's stored-selection fallback still decides.
   *
   * The `t` member makes every attempt a distinct fragment: assigning the same hash twice fires no
   * `hashchange`, and the plugin reacts to that event.
   * @param sessionId - session the client should show.
   * @param attempt - one-based attempt number, so a repeat can be re-delivered.
   * @return JavaScript evaluating to `current`, `linked`, `unavailable`, or `failed`.
   */
  static String linkScript(String sessionId, int attempt) {
    return "(function(){try{"
      + "var key=" + Json.quote(STORAGE_KEY) + ";"
      + "var id=" + Json.quote(sessionId) + ";"
      + "var raw=window.localStorage.getItem(key);"
      + "if(raw!==null){var cur=JSON.parse(raw);"
      + "if(cur&&cur.sessionId===id&&!cur.subagentAddress){return 'current';}}"
      + "if(window[" + Json.quote(LINK_MARKER) + "]!==true){return 'unavailable';}"
      + "window.location.hash=" + Json.quote(LINK_PARAMETER + "=") + "+encodeURIComponent(id)"
      + "+" + Json.quote("&t=" + attempt) + ";"
      + "return 'linked';"
      + "}catch(e){return 'failed';}})()";
  }

  /**
   * Report what this page knows about the link path, into the page console the panel forwards to the
   * IDE log. Enable it by launching the IDE with {@code DSH_COMPANION_PROBE} set.
   *
   * It answers what a host cannot otherwise see: whether the link plugin is active in this embedded
   * browser (the marker), whether its client module is in this page's boot graph, whether the served
   * HTML referenced it, what the client has selected, and which branch the ask itself would take. The
   * panel forwards warnings and errors only, so the report is a warning.
   * @param sessionId - session the ask would name.
   * @return JavaScript warning with one JSON snapshot.
   */
  static String probeScript(String sessionId) {
    return "(function(){try{"
      + "var boot=(globalThis.__DSH_BOOT__&&globalThis.__DSH_BOOT__.entries)||[];"
      + "var linkEntries=boot.filter(function(entry){"
      + "return entry&&String(entry.id||'').indexOf('session-link')>=0;});"
      + "var scripts=0;var all=document.getElementsByTagName('script');"
      + "for(var i=0;i<all.length;i++){if(String(all[i].src).indexOf('session-link')>=0){scripts++;}}"
      + "var out={marker:window[" + Json.quote(LINK_MARKER) + "]===true,"
      + "href:String(window.location.href),"
      + "stored:String(window.localStorage.getItem(" + Json.quote(STORAGE_KEY) + ")),"
      + "linkEntries:linkEntries,scriptTags:scripts,"
      + "bootKeys:Object.keys(globalThis.__DSH_BOOT__||{})};"
      + "out.ask=" + linkScript(sessionId, 99) + ";"
      + "console.warn('dsh-companion probe ' + JSON.stringify(out));"
      + "return JSON.stringify(out);"
      + "}catch(e){console.warn('dsh-companion probe failed: ' + (e&&e.message));return 'failed';}})()";
  }
}
