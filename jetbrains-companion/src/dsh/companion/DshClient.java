package dsh.companion;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Client for the DSH HTTP API.
 *
 * DSH authenticates browser requests with a cookie signed by the secret in its credential document,
 * so this client mints that cookie itself and then speaks the {@code /api} Remote protocol directly:
 * one JSON envelope per call, `{"type":"client-request","rpcId":…,"method":"<namespace>/<method>",
 * "payload":{"args":{…}}}`. Nothing here needs a DSH-side plugin.
 */
public final class DshClient {
  /** One DSH session row, reduced to the fields session reuse needs. */
  public record SessionRow(String sessionId, String cwd, long updatedAt, boolean blank) {}

  /**
   * One signed browser-session cookie, in both forms a consumer needs: the HTTP header form
   * ({@code name=value}) and the fields a browser cookie store takes.
   *
   * @param name - the authority-bound cookie name DSH expects.
   * @param value - the signed cookie value.
   * @param authority - `host:port` the value is signed for.
   * @param host - the URL host alone, which is the cookie store's domain.
   * @param expiresAt - epoch milliseconds the cookie stops being valid.
   */
  public record Cookie(String name, String value, String authority, String host, long expiresAt) {
    /** @return the `Cookie` header value for this cookie. */
    public String header() {
      return name + "=" + value;
    }
  }

  private static final Duration TIMEOUT = Duration.ofSeconds(10);
  private static final long COOKIE_LIFETIME_MILLIS = 24L * 60 * 60 * 1000;

  // HTTP/1.1 pinned: the default h2c upgrade probe is an Upgrade request, and the DSH web server
  // closes unmatched upgrade connections without answering.
  private final HttpClient http = HttpClient.newBuilder()
    .version(HttpClient.Version.HTTP_1_1)
    .connectTimeout(Duration.ofSeconds(2))
    .build();
  private final String baseUrl;
  private final String cookieHeader;
  private final byte[] secret;
  private final Path dshHome;

  private DshClient(String baseUrl, String cookieHeader, byte[] secret, Path dshHome) {
    this.baseUrl = baseUrl;
    this.cookieHeader = cookieHeader;
    this.secret = secret;
    this.dshHome = dshHome;
  }

  /**
   * Authenticate against the first address that accepts one of the candidate homes' secrets.
   *
   * An address and a harness home must belong together: the credential document signs the cookie for
   * the authority it was minted for, so the secret of one home is refused by a DSH running under
   * another. Trying every (address, home) pair is what lets an IDE whose settings name one home still
   * reach the DSH actually serving the port.
   *
   * @param candidates - base URLs to try, in order.
   * @param homes - harness homes holding a credential document, in order.
   * @return the authenticated client.
   * @throws IOException when no pair answers, naming the last failure.
   */
  public static DshClient locate(List<String> candidates, List<Path> homes) throws IOException {
    if (candidates.isEmpty()) throw new IOException("no DSH address configured");
    if (homes.isEmpty()) throw new IOException("no DSH home configured");
    IOException lastFailure = null;
    for (String candidate : candidates) {
      String baseUrl = stripTrailingSlash(candidate);
      for (Path home : homes) {
        try {
          byte[] secret = DshCredentials.browserSessionSecret(home);
          Cookie cookie = mintCookie(baseUrl, secret);
          DshClient client = new DshClient(baseUrl, cookie.header(), secret, home);
          client.listSessions();
          return client;
        } catch (IOException failure) {
          lastFailure = failure;
        } catch (IllegalArgumentException invalid) {
          lastFailure = new IOException("not a URL: " + candidate, invalid);
        }
      }
    }
    throw new IOException(
      "no DSH server answered at " + String.join(", ", candidates)
        + " with credentials from " + join(homes), lastFailure);
  }

  /**
   * Authenticate against one harness home.
   * @param candidates - base URLs to try, in order.
   * @param home - the harness home holding the credential document.
   * @return the authenticated client.
   * @throws IOException when no candidate answers, naming the last failure.
   */
  public static DshClient locate(List<String> candidates, Path home) throws IOException {
    return locate(candidates, List.of(home));
  }

  /** @return the base URL this client speaks to. */
  public String baseUrl() {
    return baseUrl;
  }

  /** @return the harness home whose credential document this client authenticated with. */
  public Path home() {
    return dshHome;
  }

  /**
   * Mint the browser-session cookie for this client's own address and home, so an embedded browser
   * signs in exactly as this client did.
   * @return the cookie, valid for its full lifetime.
   * @throws IOException when the signature cannot be computed.
   */
  public Cookie browserCookie() throws IOException {
    return mintCookie(baseUrl, secret);
  }

  /**
   * Read every visible session row.
   * @return the rows, oldest first as DSH returns them.
   * @throws IOException when the call fails or DSH answers a failure envelope.
   */
  public List<SessionRow> listSessions() throws IOException {
    Object value = call("session/list", "{\"_request\":{}}");
    List<SessionRow> rows = new ArrayList<>();
    for (Object item : JsonParser.array(value, "items")) {
      String sessionId = JsonParser.string(item, "sessionId");
      if (sessionId == null) continue;
      Object updatedAt = JsonParser.member(item, "updatedAt");
      Object blank = JsonParser.member(item, "blank");
      rows.add(new SessionRow(
        sessionId,
        JsonParser.string(item, "cwd"),
        updatedAt instanceof Long number ? number : 0L,
        blank instanceof Boolean flag && flag));
    }
    return rows;
  }

  /**
   * Create one session in a directory.
   * @param cwd - absolute session working directory.
   * @return the new session id.
   * @throws IOException when the call fails or DSH answers a failure envelope.
   */
  public String createSession(String cwd) throws IOException {
    Object value = call("session/create", "{\"request\":{\"cwd\":" + Json.quote(cwd) + "}}");
    String sessionId = JsonParser.string(value, "sessionId");
    if (sessionId == null) throw new IOException("session/create returned no session id");
    return sessionId;
  }

  /**
   * Register a directory as a DSH workspace, idempotently, and return its identity.
   *
   * A session created with a bare `cwd` is attached to no workspace: DSH only groups it when the
   * registry next rebuilds its membership. Creating the session inside its own workspace makes it
   * appear where it belongs immediately — and a workspace that already exists at that path is
   * returned unchanged, title and session list included, so this never rewrites one the user or the
   * DSH-side plugin registered.
   * @param path - absolute directory to register.
   * @return the workspace, with the sessions it currently accounts.
   * @throws IOException when the call fails or DSH answers a failure envelope.
   */
  public Workspace ensureWorkspace(String path) throws IOException {
    Object value = call("workspace/create", "{\"request\":{\"path\":" + Json.quote(path) + "}}");
    Object workspace = JsonParser.member(value, "workspace");
    String workspaceId = JsonParser.string(workspace, "workspaceId");
    if (workspaceId == null) throw new IOException("workspace/create returned no workspace id");
    List<String> sessionIds = new ArrayList<>();
    for (Object item : JsonParser.array(workspace, "sessionIds")) {
      if (item instanceof String id) sessionIds.add(id);
    }
    return new Workspace(
      workspaceId,
      JsonParser.string(workspace, "title"),
      sessionIds,
      Boolean.TRUE.equals(JsonParser.member(value, "created")));
  }

  /**
   * Retitle one workspace.
   * @param workspaceId - workspace to rename.
   * @param title - the new title.
   * @throws IOException when the call fails or DSH answers a failure envelope.
   */
  public void renameWorkspace(String workspaceId, String title) throws IOException {
    call("workspace/rename", "{\"request\":{\"workspaceId\":" + Json.quote(workspaceId)
      + ",\"title\":" + Json.quote(title) + "}}");
  }

  /**
   * Attach an existing session to a workspace, so a session whose grouping went missing shows up
   * again where its working directory belongs.
   *
   * DSH answers this by starting the session, so a refusal — a session another writer holds is the
   * usual one — means "leave it as it is", never a reason to create a second session.
   * @param workspaceId - the workspace to attach to.
   * @param sessionId - the existing session.
   * @throws IOException when the call fails or DSH answers a failure envelope.
   */
  public void attachSession(String workspaceId, String sessionId) throws IOException {
    call("session/create", "{\"request\":{\"workspaceId\":" + Json.quote(workspaceId)
      + ",\"sessionId\":" + Json.quote(sessionId) + "}}");
  }

  /**
   * Create a new session inside a registered workspace; DSH uses the workspace's own directory.
   * @param workspaceId - the workspace to create in.
   * @return the new session id.
   * @throws IOException when the call fails or DSH answers a failure envelope.
   */
  public String createSessionIn(String workspaceId) throws IOException {
    Object value = call("session/create", "{\"request\":{\"workspaceId\":" + Json.quote(workspaceId) + "}}");
    String sessionId = JsonParser.string(value, "sessionId");
    if (sessionId == null) throw new IOException("session/create returned no session id");
    return sessionId;
  }

  /**
   * One registered workspace as `workspace/create` reports it.
   *
   * @param id - workspace identity.
   * @param title - its current title.
   * @param sessionIds - the sessions it accounts for, in registry order.
   * @param created - true when this call registered the directory, false when it already existed.
   */
  public record Workspace(String id, String title, List<String> sessionIds, boolean created) {
    /** @return whether this workspace accounts the given session. */
    public boolean accounts(String sessionId) {
      return sessionIds.contains(sessionId);
    }
  }

  /**
   * Call one Remote endpoint; public so a development check can drive other namespaces.
   * @param endpoint - `namespace/method`.
   * @param argsJson - the `args` object, already encoded.
   * @return the response's success value.
   * @throws IOException when the transport fails or DSH answers a failure envelope.
   */
  public Object call(String endpoint, String argsJson) throws IOException {
    String body = "{\"type\":\"client-request\",\"rpcId\":\"" + UUID.randomUUID()
      + "\",\"method\":" + Json.quote(endpoint) + ",\"payload\":{\"args\":" + argsJson + "}}";
    HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/api/" + endpoint))
      .timeout(TIMEOUT)
      .header("Content-Type", "application/json")
      .header("Cookie", cookieHeader)
      .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
      .build();
    HttpResponse<String> response;
    try {
      response = http.send(request, HttpResponse.BodyHandlers.ofString());
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      throw new IOException("interrupted while calling " + endpoint, interrupted);
    }
    if (response.statusCode() == 401 || response.statusCode() == 403) {
      throw new IOException("DSH rejected the request (" + response.statusCode()
        + "); the credential document does not match this DSH home");
    }
    if (response.statusCode() != 200) {
      throw new IOException("DSH answered " + response.statusCode() + " for " + endpoint);
    }
    Object envelope = JsonParser.parse(response.body());
    Object result = JsonParser.member(envelope, "result");
    Object ok = JsonParser.member(result, "ok");
    if (!Boolean.TRUE.equals(ok)) {
      Object error = JsonParser.member(result, "error");
      String message = JsonParser.string(error, "message");
      throw new IOException(message == null ? endpoint + " failed" : message);
    }
    return JsonParser.member(result, "value");
  }

  /**
   * Mint the browser-session cookie for one DSH address. A process running as the same user can read
   * the same credential document DSH signs its own cookies with, so anything that can hold a cookie
   * — an HTTP header or an embedded browser — speaks to DSH exactly as the user's browser does.
   * @param baseUrl - absolute DSH base URL, such as {@code http://127.0.0.1:3080}.
   * @param dshHome - harness home holding the credential document.
   * @return the cookie, valid for its full lifetime.
   * @throws IOException when the credential document is unreadable or the address is not absolute.
   */
  public static Cookie mintCookie(String baseUrl, Path dshHome) throws IOException {
    return mintCookie(baseUrl, DshCredentials.browserSessionSecret(dshHome));
  }

  /**
   * Mint the browser-session cookie with an already-loaded signing secret.
   * @param baseUrl - absolute DSH base URL.
   * @param secret - the `client-connection/browser-session` signing secret.
   * @return the cookie.
   * @throws IOException when the address is not absolute or the signature cannot be computed.
   */
  public static Cookie mintCookie(String baseUrl, byte[] secret) throws IOException {
    URI uri;
    try {
      uri = URI.create(stripTrailingSlash(baseUrl));
    } catch (IllegalArgumentException invalid) {
      throw new IOException("not a URL: " + baseUrl, invalid);
    }
    String authority = uri.getAuthority();
    if (authority == null) throw new IOException("not an absolute URL: " + baseUrl);
    String host = uri.getHost();
    long issuedAt = System.currentTimeMillis();
    long expiresAt = issuedAt + COOKIE_LIFETIME_MILLIS;
    String payload = "{\"version\":1,\"authority\":" + Json.quote(authority)
      + ",\"issuedAt\":" + issuedAt + ",\"expiresAt\":" + expiresAt + "}";
    String body = base64Url(payload.getBytes(StandardCharsets.UTF_8));
    String name = "dsh-auth-" + base64Url(sha256(authority.getBytes(StandardCharsets.UTF_8)));
    return new Cookie(
      name,
      "v1." + body + "." + base64Url(hmacSha256(secret, body)),
      authority,
      host == null || host.isEmpty() ? authority : host,
      expiresAt);
  }

  private static byte[] sha256(byte[] input) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(input);
    } catch (Exception unsupported) {
      throw new IllegalStateException("SHA-256 is unavailable", unsupported);
    }
  }

  private static byte[] hmacSha256(byte[] secret, String message) throws IOException {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret, "HmacSHA256"));
      return mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
    } catch (Exception unavailable) {
      throw new IOException("HmacSHA256 is unavailable", unavailable);
    }
  }

  /** Base64url without padding, the encoding DSH's cookie codec uses. */
  private static String base64Url(byte[] bytes) {
    return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  private static String stripTrailingSlash(String url) {
    return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
  }

  /** Render candidate homes for a failure message. */
  private static String join(List<Path> homes) {
    StringBuilder text = new StringBuilder();
    for (Path home : homes) {
      if (text.length() > 0) text.append(", ");
      text.append(home);
    }
    return text.toString();
  }

  /** Debug helper: a stable digest of this client's identity without exposing the cookie. */
  String describe() {
    return baseUrl + " (" + HexFormat.of().formatHex(sha256(cookieHeader.getBytes(StandardCharsets.UTF_8)), 0, 4) + ")";
  }
}
