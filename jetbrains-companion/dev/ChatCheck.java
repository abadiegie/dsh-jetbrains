import dsh.companion.DshClient;
import dsh.companion.DshCredentials;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Standalone check for the DSH Chat panel's authentication path: it mints the same browser-session
 * cookie the panel hands to the embedded browser and loads the DSH index with it, which is exactly
 * what JCEF does on the panel's first navigation. It skips itself when no DSH home or server exists.
 *
 * Run: java -cp build/stage:build/check ChatCheck
 */
public final class ChatCheck {
  private ChatCheck() {}

  /**
   * @param args - unused.
   * @throws Exception when an expectation fails.
   */
  public static void main(String[] args) throws Exception {
    Path home = Path.of(System.getenv().getOrDefault(
      "DSH_HOME", System.getProperty("user.home") + "/.dsh"));
    if (!Files.isRegularFile(home.resolve(DshCredentials.FILE_NAME))) {
      System.out.println("chat check: skipped, no credential document under " + home);
      return;
    }
    List<String> urls = List.of(System.getProperty("dsh.url", "http://127.0.0.1:3080"));
    DshClient client;
    try {
      client = DshClient.locate(urls, home);
    } catch (IOException unreachable) {
      System.out.println("chat check: skipped, " + unreachable.getMessage());
      return;
    }
    DshClient.Cookie cookie = client.browserCookie();
    System.out.println("ok: minted " + cookie.name() + " for authority " + cookie.authority()
      + " (domain " + cookie.host() + ")");

    HttpResponse<String> anonymous = get(client.baseUrl() + "/", null);
    expect(anonymous.statusCode() == 401,
      "the index refuses a request without the cookie (got " + anonymous.statusCode() + ")");

    HttpResponse<String> authenticated = get(client.baseUrl() + "/", cookie.header());
    expect(authenticated.statusCode() == 200,
      "the index accepts the minted cookie (got " + authenticated.statusCode() + ")");
    String body = authenticated.body().toLowerCase();
    expect(body.contains("<html") || body.contains("<!doctype"),
      "the response body is the DSH web client document");

    String tokenized = client.baseUrl() + "/?token=wrong";
    HttpResponse<String> redirected = get(tokenized, cookie.header());
    expect(redirected.statusCode() == 303,
      "a stray token with a valid cookie redirects to the clean URL (got " + redirected.statusCode() + ")");
    expect("./".equals(redirected.headers().firstValue("location").orElse(null)),
      "the redirect target is the directory-relative clean URL");

    HttpResponse<String> anonymousToken = get(tokenized, null);
    expect(anonymousToken.statusCode() == 401,
      "a stray token without the cookie is refused (got " + anonymousToken.statusCode() + ")");

    System.out.println("chat check: the embedded browser's cookie authenticates the DSH index");
  }

  private static HttpResponse<String> get(String url, String cookieHeader) throws IOException, InterruptedException {
    HttpClient http = HttpClient.newBuilder()
      .version(HttpClient.Version.HTTP_1_1)
      .connectTimeout(java.time.Duration.ofSeconds(2))
      .build();
    HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url))
      .timeout(java.time.Duration.ofSeconds(10))
      .GET();
    if (cookieHeader != null) request.header("Cookie", cookieHeader);
    return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
  }

  private static void expect(boolean condition, String what) {
    if (!condition) throw new AssertionError("expected: " + what);
    System.out.println("ok: " + what);
  }
}
