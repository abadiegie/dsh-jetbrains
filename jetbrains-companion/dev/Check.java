import dsh.companion.BridgeServer;
import dsh.companion.Descriptor;
import dsh.companion.Snapshot;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * Standalone check for the companion's IntelliJ-free half: it starts the real bridge with a fake IDE,
 * writes the real descriptor, and exercises every endpoint and the token fence over HTTP.
 *
 * Run: java -cp build/stage:build/check Check
 */
public final class Check {
  private static final List<String> OPENED = new ArrayList<>();

  private Check() {}

  /**
   * @param args - unused.
   * @throws Exception when an expectation fails.
   */
  public static void main(String[] args) throws Exception {
    Snapshot snapshot = new Snapshot();
    snapshot.product = "IC";
    snapshot.productName = "IntelliJ IDEA";
    snapshot.build = "IC-261.26222.65";
    snapshot.pid = ProcessHandle.current().pid();
    snapshot.updatedAt = "2026-10-08T17:00:00Z";
    snapshot.projects.add(new Snapshot.ProjectInfo("bi-app-v2", "/w/bi-app-v2", List.of("/w/bi-app-v2", "/w/bi-backend")));
    snapshot.activePath = "/w/bi-backend/main.py";
    snapshot.activeLine = 12;
    snapshot.activeColumn = 3;
    snapshot.selection = "print(1)";
    snapshot.openFiles.add("/w/bi-app-v2/README.md");

    String token = "test-token";
    try (BridgeServer server = new BridgeServer(new BridgeServer.Ide() {
      @Override
      public String snapshotJson() {
        return snapshot.toJson();
      }

      @Override
      public String open(String path, int line, int column) {
        if (!path.equals("/w/bi-backend/main.py")) return "file not found: " + path;
        OPENED.add(path + ":" + line + ":" + column);
        return null;
      }
      @Override
      public String changed(String body) {
        return null;
      }
    }, token)) {
      Path descriptor = Path.of(System.getProperty("java.io.tmpdir"), "dsh-companion-check.json");
      Files.deleteIfExists(descriptor);
      Descriptor.write(descriptor, Descriptor.document(server.port(), token, snapshot));
      String written = Files.readString(descriptor);
      expect(written.contains("\"port\":" + server.port()), "descriptor carries the port");
      expect(written.contains("\"token\":\"test-token\""), "descriptor carries the token");
      expect(written.contains("/w/bi-backend"), "descriptor carries the workspace roots");
      expect(written.contains("\"selection\":\"print(1)\""), "descriptor carries the selection");

      HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
      String base = "http://127.0.0.1:" + server.port();
      expect(status(client, base + "/health", null) == 200, "health answers without a token");
      expect(status(client, base + "/workspace", null) == 403, "workspace refuses a missing token");
      expect(status(client, base + "/workspace", "wrong") == 403, "workspace refuses a wrong token");

      HttpResponse<String> workspace = send(client, base + "/workspace", "GET", null, token);
      expect(workspace.statusCode() == 200, "workspace answers with the token");
      expect(workspace.body().contains("\"source\":\"jetbrains-companion\""), "snapshot names its source");
      expect(workspace.body().contains("\"active\":"), "snapshot carries the active editor");

      expect(status(client, base + "/open", "GET", "{\"path\":\"/w/bi-backend/main.py\"}", token) == 405,
        "open refuses GET");
      HttpResponse<String> opened = send(client, base + "/open", "POST", "{\"path\":\"/w/bi-backend/main.py\",\"line\":12,\"column\":3}", token);
      expect(opened.statusCode() == 200, "open accepts a valid request: " + opened.body());
      expect(OPENED.equals(List.of("/w/bi-backend/main.py:12:3")), "open forwards path, line, and column: " + OPENED);

      HttpResponse<String> missing = send(client, base + "/open", "POST", "{\"path\":\"/nope\"}", token);
      expect(missing.statusCode() == 400, "open reports an unopenable path");
      expect(missing.body().contains("file not found"), "open keeps the IDE message");

      HttpResponse<String> invalid = send(client, base + "/open", "POST", "{}", token);
      expect(invalid.statusCode() == 400 && invalid.body().contains("missing path"), "open requires a path");

      String huge = "{\"path\":\"" + "x".repeat(70 * 1024) + "\"}";
      expect(status(client, base + "/open", "POST", huge, token) == 413, "open refuses an oversized body");

      Descriptor.delete(descriptor);
      expect(!Files.exists(descriptor), "descriptor is removed on shutdown");
    }
    System.out.println("companion bridge check: all expectations held");
  }

  private static void expect(boolean condition, String what) {
    if (!condition) throw new AssertionError("expected: " + what);
    System.out.println("ok: " + what);
  }

  private static int status(HttpClient client, String url, String token) throws Exception {
    return send(client, url, "GET", null, token).statusCode();
  }

  private static int status(HttpClient client, String url, String method, String body, String token) throws Exception {
    return send(client, url, method, body, token).statusCode();
  }

  private static HttpResponse<String> send(HttpClient client, String url, String method, String body, String token)
    throws Exception {
    HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(5));
    if (token != null) request.header("Authorization", "Bearer " + token);
    request.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
    return client.send(request.build(), HttpResponse.BodyHandlers.ofString());
  }
}
