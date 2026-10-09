package dsh.companion;

import java.util.List;

/**
 * Standalone check for the address spellings a person configures: the `DSH URL` setting is typed as
 * `127.0.0.1:3080` or `3080`, and a schemeless value used to be parsed as a URI whose scheme was
 * `127.0.0.1`, which made every call fail as "not an absolute URL".
 *
 * It lives in the plugin's own package so it can drive the discovery helpers directly, and it needs
 * no IDE and no running DSH.
 *
 * Run: java -cp build/stage:build/check dsh.companion.UrlCheck
 */
public final class UrlCheck {
  private UrlCheck() {}

  /**
   * @param args - unused.
   */
  public static void main(String[] args) {
    DshCompanionSettings.State settings = new DshCompanionSettings.State();

    settings.dshUrl = "127.0.0.1:3080";
    expect(List.of("http://127.0.0.1:3080"), candidateUrls(settings), "host:port gains http://");

    settings.dshUrl = "3080";
    expect(List.of("http://127.0.0.1:3080"), candidateUrls(settings), "a bare port means loopback");

    settings.dshUrl = "http://localhost:9000";
    expect(List.of("http://localhost:9000"), candidateUrls(settings), "an absolute URL is kept");

    settings.dshUrl = "https://dsh.example.com/mount";
    expect(List.of("https://dsh.example.com/mount"), candidateUrls(settings), "a path and scheme survive");

    settings.dshUrl = "  myhost.local:4000  ";
    expect(List.of("http://myhost.local:4000"), candidateUrls(settings), "surrounding space is trimmed");

    settings.dshUrl = "";
    List<String> discovered = candidateUrls(settings);
    expect(discovered.get(discovered.size() - 1).equals("http://127.0.0.1:3080"),
      "with no configured address the loopback default comes last");

    System.out.println("url check: " + discovered.size() + " discovered candidate(s): " + discovered);
    System.out.println("url check: every configured spelling normalizes to an absolute URL");
  }

  private static List<String> candidateUrls(DshCompanionSettings.State settings) {
    return DshSessions.candidateUrls(settings);
  }

  private static void expect(List<String> expected, List<String> actual, String what) {
    if (!expected.equals(actual)) {
      throw new AssertionError("expected " + expected + " for " + what + ", got " + actual);
    }
    System.out.println("ok: " + what + " -> " + actual.get(0));
  }

  private static void expect(boolean condition, String what) {
    if (!condition) throw new AssertionError("expected: " + what);
    System.out.println("ok: " + what);
  }
}
