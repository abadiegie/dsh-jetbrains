package dsh.companion;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Loopback HTTP bridge between a running IDE and a local DSH process. It binds an ephemeral port on
 * the loopback address only, requires a per-run bearer token on every data endpoint, and exposes
 * exactly three operations: liveness, the current workspace snapshot, and opening a file in the IDE.
 * The token travels through {@link Descriptor}, which only the owning user can read.
 */
public final class BridgeServer implements AutoCloseable {
  /** The IDE side the bridge delegates to. */
  public interface Ide {
    /** @return the current snapshot document, already JSON encoded. */
    String snapshotJson();

    /**
     * @param path - absolute file path to open.
     * @param line - one-based line to place the caret on, or 0 for no placement.
     * @param column - one-based column to place the caret on, or 0 for no placement.
     * @return a failure message, or {@code null} when the file was opened.
     */
    String open(String path, int line, int column);
  }

  /** Request bodies larger than this are refused rather than read. */
  private static final int MAX_BODY_BYTES = 64 * 1024;

  private final HttpServer server;
  private final ExecutorService executor;
  private final byte[] token;

  /**
   * @param ide - the IDE operations the bridge serves.
   * @param token - the bearer token every data endpoint requires.
   * @throws IOException when the loopback listener cannot be created.
   */
  public BridgeServer(Ide ide, String token) throws IOException {
    this.token = token.getBytes(StandardCharsets.UTF_8);
    this.executor = Executors.newFixedThreadPool(2, runnable -> {
      Thread thread = new Thread(runnable, "dsh-companion-bridge");
      thread.setDaemon(true);
      return thread;
    });
    this.server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
    this.server.setExecutor(this.executor);
    this.server.createContext("/health", this::handleHealth);
    this.server.createContext("/workspace", exchange -> handleWorkspace(exchange, ide));
    this.server.createContext("/open", exchange -> handleOpen(exchange, ide));
    this.server.start();
  }

  /** @return the bound loopback port. */
  public int port() {
    return server.getAddress().getPort();
  }

  @Override
  public void close() {
    server.stop(0);
    executor.shutdownNow();
  }

  private void handleHealth(HttpExchange exchange) throws IOException {
    // Liveness carries no workspace data, so it answers without the token.
    if (!"GET".equals(exchange.getRequestMethod())) {
      respond(exchange, 405, Json.object().field("ok", false).field("error", "method not allowed").build());
      return;
    }
    respond(exchange, 200, Json.object()
      .field("ok", true)
      .field("source", Snapshot.SOURCE)
      .field("version", Snapshot.VERSION)
      .build());
  }

  private void handleWorkspace(HttpExchange exchange, Ide ide) throws IOException {
    if (!authorized(exchange)) {
      forbidden(exchange);
      return;
    }
    if (!"GET".equals(exchange.getRequestMethod())) {
      respond(exchange, 405, Json.object().field("ok", false).field("error", "method not allowed").build());
      return;
    }
    respond(exchange, 200, ide.snapshotJson());
  }

  private void handleOpen(HttpExchange exchange, Ide ide) throws IOException {
    if (!authorized(exchange)) {
      forbidden(exchange);
      return;
    }
    if (!"POST".equals(exchange.getRequestMethod())) {
      respond(exchange, 405, Json.object().field("ok", false).field("error", "method not allowed").build());
      return;
    }
    String body = readBody(exchange);
    if (body == null) {
      respond(exchange, 413, Json.object().field("ok", false).field("error", "body too large").build());
      return;
    }
    String path = field(body, "path");
    if (path == null || path.isEmpty()) {
      respond(exchange, 400, Json.object().field("ok", false).field("error", "missing path").build());
      return;
    }
    String failure = ide.open(path, integerField(body, "line"), integerField(body, "column"));
    if (failure != null) {
      respond(exchange, 400, Json.object().field("ok", false).field("error", failure).build());
      return;
    }
    respond(exchange, 200, Json.object().field("ok", true).field("path", path).build());
  }

  private boolean authorized(HttpExchange exchange) {
    String header = exchange.getRequestHeaders().getFirst("Authorization");
    if (header == null || !header.startsWith("Bearer ")) return false;
    byte[] presented = header.substring("Bearer ".length()).trim().getBytes(StandardCharsets.UTF_8);
    return MessageDigest.isEqual(presented, token);
  }

  private void forbidden(HttpExchange exchange) throws IOException {
    respond(exchange, 403, Json.object().field("ok", false).field("error", "forbidden").build());
  }

  private static void respond(HttpExchange exchange, int status, String body) throws IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    exchange.getResponseHeaders().set("Cache-Control", "no-store");
    exchange.sendResponseHeaders(status, bytes.length);
    try (OutputStream out = exchange.getResponseBody()) {
      out.write(bytes);
    }
  }

  private static String readBody(HttpExchange exchange) throws IOException {
    try (InputStream in = exchange.getRequestBody()) {
      byte[] bytes = in.readNBytes(MAX_BODY_BYTES + 1);
      if (bytes.length > MAX_BODY_BYTES) return null;
      return new String(bytes, StandardCharsets.UTF_8);
    }
  }

  /**
   * Read one top-level string member from the small request documents this bridge accepts.
   * @param body - the request body.
   * @param key - member name.
   * @return the decoded value, or {@code null} when the member is absent.
   */
  private static String field(String body, String key) {
    String marker = "\"" + key + "\"";
    int at = body.indexOf(marker);
    if (at < 0) return null;
    int colon = body.indexOf(':', at + marker.length());
    if (colon < 0) return null;
    int open = body.indexOf('"', colon + 1);
    if (open < 0) return null;
    StringBuilder value = new StringBuilder();
    for (int index = open + 1; index < body.length(); index++) {
      char current = body.charAt(index);
      if (current == '\\' && index + 1 < body.length()) {
        char escaped = body.charAt(++index);
        value.append(switch (escaped) {
          case 'n' -> '\n';
          case 'r' -> '\r';
          case 't' -> '\t';
          default -> escaped;
        });
        continue;
      }
      if (current == '"') return value.toString();
      value.append(current);
    }
    return null;
  }

  /**
   * @param body - the request body.
   * @param key - member name mapped to a JSON number.
   * @return the value, or 0 when the member is absent or unparsable.
   */
  private static int integerField(String body, String key) {
    String marker = "\"" + key + "\"";
    int at = body.indexOf(marker);
    if (at < 0) return 0;
    int colon = body.indexOf(':', at + marker.length());
    if (colon < 0) return 0;
    int index = colon + 1;
    while (index < body.length() && Character.isWhitespace(body.charAt(index))) index++;
    int start = index;
    while (index < body.length() && Character.isDigit(body.charAt(index))) index++;
    if (index == start) return 0;
    try {
      return Integer.parseInt(body.substring(start, index));
    } catch (NumberFormatException notANumber) {
      return 0;
    }
  }
}
