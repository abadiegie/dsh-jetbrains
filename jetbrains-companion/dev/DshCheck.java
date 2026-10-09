import dsh.companion.DshClient;
import dsh.companion.DshCredentials;
import dsh.companion.JsonParser;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Standalone check for the companion's DSH client: it authenticates against a running DSH with the
 * browser-session cookie DSH itself mints, lists sessions, creates one for a scratch directory,
 * proves it appears, and archives it again. It skips itself when no DSH home or server is present.
 *
 * Run: java -cp build/stage:build/check DshCheck
 */
public final class DshCheck {
  private DshCheck() {}

  /**
   * @param args - unused.
   * @throws Exception when an expectation fails.
   */
  public static void main(String[] args) throws Exception {
    Path home = Path.of(System.getenv().getOrDefault(
      "DSH_HOME", System.getProperty("user.home") + "/.dsh"));
    if (!Files.isRegularFile(home.resolve(DshCredentials.FILE_NAME))) {
      System.out.println("dsh check: skipped, no credential document under " + home);
      return;
    }
    List<String> urls = new ArrayList<>();
    urls.add(System.getProperty("dsh.url", "http://127.0.0.1:3080"));
    DshClient client;
    try {
      client = DshClient.locate(urls, home);
    } catch (IOException unreachable) {
      System.out.println("dsh check: skipped, " + unreachable.getMessage());
      return;
    }
    System.out.println("ok: authenticated against " + client.baseUrl());

    // An address and a home must belong together: this is the case that broke when the IDE's own
    // settings named one harness home while the DSH serving the port ran under another.
    Path foreign = foreignHome();
    List<Path> paired = new ArrayList<>();
    paired.add(foreign);
    paired.add(home);
    DshClient resolved = DshClient.locate(urls, paired);
    expect(resolved.home().equals(home),
      "a foreign home's secret is skipped and " + home + " authenticates " + resolved.baseUrl());
    IOException refused = null;
    try {
      DshClient.locate(urls, List.of(foreign));
    } catch (IOException failure) {
      refused = failure;
    }
    expect(refused != null, "the foreign home alone is refused, so the pairing check is meaningful");
    System.out.println("    refusal: " + refused.getMessage());

    List<DshClient.SessionRow> sessions = client.listSessions();
    System.out.println("ok: session/list returned " + sessions.size() + " rows");
    for (DshClient.SessionRow row : sessions) {
      System.out.println("    " + row.sessionId() + "  " + row.cwd() + "  updated=" + row.updatedAt());
    }

    Path scratch = Files.createDirectories(Path.of(System.getProperty("java.io.tmpdir"), "dsh-companion-session-check"));
    String cwd = scratch.toRealPath().toString();
    List<String> before = sessionIds(client, cwd);
    System.out.println("sessions in the scratch directory before: " + before);

    String created = client.createSession(cwd);
    List<String> after = sessionIds(client, cwd);
    expect(after.contains(created), "session/create made " + created + " visible in session/list");
    expect(!before.contains(created), "the scratch session is new");

    client.call("workspace/archiveSession", "{\"request\":{\"sessionId\":\"" + created + "\"}}");
    System.out.println("ok: archived " + created + " so it leaves the sidebar");

    String reused = client.listSessions().stream()
      .filter(row -> cwd.equals(row.cwd()))
      .map(DshClient.SessionRow::sessionId)
      .findFirst()
      .orElse(null);
    System.out.println("reuse lookup for " + cwd + " resolves to " + reused);

    // A session created inside a workspace is attached immediately, which is how the panel's window
    // session lands in the workspace the user sees instead of waiting for the next registry rebuild.
    DshClient.Workspace createdWorkspace = client.ensureWorkspace(cwd);
    expect(createdWorkspace.id() != null, "workspace/create returned an id");
    expect(client.ensureWorkspace(cwd).id().equals(createdWorkspace.id()),
      "workspace/create is idempotent for the same directory");

    String attached = client.createSessionIn(createdWorkspace.id());
    expect(sessionIds(client, cwd).contains(attached),
      "a session created in a workspace is visible at once");
    expect(client.ensureWorkspace(cwd).accounts(attached),
      "the workspace reports the session it now accounts, which is how an orphan is detected");

    // Re-attaching an existing session is idempotent, and it is what puts a session whose grouping
    // went missing back where its working directory belongs.
    client.attachSession(createdWorkspace.id(), attached);
    expect(client.ensureWorkspace(cwd).accounts(attached), "attaching an accounted session changes nothing");

    client.call("workspace/archiveSession", "{\"request\":{\"sessionId\":\"" + attached + "\"}}");
    System.out.println("ok: archived " + attached + " so it leaves the sidebar");

    // Only a workspace this check created is removed, and only after its path was verified: a
    // registration that existed before belongs to the user.
    if (createdWorkspace.created()) {
      client.call("workspace/delete", "{\"request\":{\"workspaceId\":\"" + createdWorkspace.id() + "\"}}");
      System.out.println("ok: removed the scratch workspace this check created");
    } else {
      System.out.println("note: " + cwd + " already had a workspace; left it registered");
    }
    System.out.println("dsh client check: all expectations held");
  }

  private static List<String> sessionIds(DshClient client, String cwd) throws IOException {
    List<String> ids = new ArrayList<>();
    for (DshClient.SessionRow row : client.listSessions()) {
      if (cwd.equals(row.cwd())) ids.add(row.sessionId());
    }
    return ids;
  }

  /**
   * A harness home whose credential document is well-formed but belongs to no server here — the
   * situation the IDE settings create when they name another harness home.
   * @return the temporary home.
   * @throws IOException when the document cannot be written.
   */
  private static Path foreignHome() throws IOException {
    Path home = Files.createTempDirectory("dsh-foreign-home");
    String secret = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]);
    Files.writeString(home.resolve(DshCredentials.FILE_NAME),
      "client-connection/browser-session:\n  secret: " + secret + "\n");
    return home;
  }

  private static void expect(boolean condition, String what) {
    if (!condition) throw new AssertionError("expected: " + what);
    System.out.println("ok: " + what);
  }
}
