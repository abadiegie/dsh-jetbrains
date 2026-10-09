package dsh.companion;

import com.intellij.openapi.application.PathManager;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Creates or reuses the DSH session of one IDE project over DSH's own HTTP API.
 *
 * The DSH address and home resolve from, in order: this plugin's settings, the DeepSeek Harness IDE
 * plugin's own settings file (so an installed official plugin needs no second configuration),
 * {@code DSH_HOME}, then {@code ~/.dsh}. A missing or unreachable DSH is a normal outcome, reported
 * to the caller instead of failing the IDE.
 */
final class DshSessions {
  /** Session reuse found, or session creation performed. */
  static final class Outcome {
    final String sessionId;
    final boolean created;
    final String baseUrl;

    Outcome(String sessionId, boolean created, String baseUrl) {
      this.sessionId = sessionId;
      this.created = created;
      this.baseUrl = baseUrl;
    }
  }

  private static final Pattern OPTION = Pattern.compile("<option\\s+name=\"([^\"]+)\"\\s+value=\"([^\"]*)\"\\s*/>");

  /** Settings file the official DeepSeek Harness IDE plugin writes. */
  private static final String OFFICIAL_SETTINGS = "deepseek-harness.xml";

  private DshSessions() {}

  /**
   * Ensure a DSH session exists for one directory: reuse the most recently updated session whose
   * working directory is that directory, else create one inside that directory's own workspace.
   * @param projectPath - absolute session directory.
   * @param settings - persisted user choices.
   * @param label - the project name, used only to name a workspace this call registers.
   * @return the session and whether this call created it.
   * @throws IOException when DSH cannot be reached or refuses the call.
   */
  static Outcome ensure(String projectPath, DshCompanionSettings.State settings, String label) throws IOException {
    return ensure(
      DshClient.locate(candidateUrls(settings), candidateHomes(settings)), projectPath, label);
  }

  /**
   * Ensure a DSH session exists for one directory over an already-authenticated client.
   *
   * The directory is the window junction when the companion runs in window scope, so the same call
   * serves both models. The session is always accounted by that directory's workspace: a session
   * whose workspace went missing would otherwise stay alive yet invisible in the sidebar, while the
   * panel keeps using it.
   * @param client - authenticated DSH client.
   * @param projectPath - absolute session directory.
   * @param label - the project name, used only to name a workspace this call registers.
   * @return the session and whether this call created it.
   * @throws IOException when DSH refuses the call.
   */
  static Outcome ensure(DshClient client, String projectPath, String label) throws IOException {
    String canonical = canonical(projectPath);
    DshClient.Workspace workspace = client.ensureWorkspace(canonical);
    if (workspace.created()) {
      // A workspace this plugin registers carries the name the DSH-side plugin gives the window
      // workspace, so the sidebar reads the same whoever registered it.
      try {
        client.renameWorkspace(workspace.id(), "JetBrains workspace (" + label + ")");
      } catch (IOException refused) {
        /* the default title stands; naming is cosmetic and must never fail the session */
      }
    }
    DshClient.SessionRow existing = client.listSessions().stream()
      .filter(row -> row.cwd() != null && canonical.equals(canonical(row.cwd())))
      .max(Comparator.comparingLong(DshClient.SessionRow::updatedAt))
      .orElse(null);
    if (existing != null) {
      if (!workspace.accounts(existing.sessionId())) {
        try {
          client.attachSession(workspace.id(), existing.sessionId());
        } catch (IOException live) {
          /* a session another writer holds keeps its grouping until it is free */
        }
      }
      return new Outcome(existing.sessionId(), false, client.baseUrl());
    }
    return new Outcome(client.createSessionIn(workspace.id()), true, client.baseUrl());
  }

  /**
   * The base URLs to try, most specific first. A configured address is normalized, because
   * `127.0.0.1:3080` and `3080` are what a human types, while only an absolute URL is something the
   * client can sign a cookie for.
   * @param settings - persisted user choices.
   * @return the candidate URLs, most specific first.
   */
  static List<String> candidateUrls(DshCompanionSettings.State settings) {
    List<String> urls = new ArrayList<>();
    if (!settings.dshUrl.isBlank()) {
      urls.add(normalizeUrl(settings.dshUrl.strip()));
      return urls;
    }
    String port = officialSetting("port");
    if (port != null && port.matches("\\d{2,5}")) urls.add("http://127.0.0.1:" + port);
    String fallback = "http://127.0.0.1:3080";
    if (!urls.contains(fallback)) urls.add(fallback);
    return urls;
  }

  /**
   * Accept the spellings a person writes for a DSH address: a full URL, `host:port`, a bare host, or
   * a bare port meaning loopback.
   * @param value - the configured address.
   * @return an absolute HTTP URL.
   */
  static String normalizeUrl(String value) {
    if (value.matches("\\d{2,5}")) return "http://127.0.0.1:" + value;
    if (value.contains("://")) return value;
    return "http://" + value;
  }

  /**
   * The harness homes to try, most specific first: this plugin's setting, the DeepSeek Harness IDE
   * plugin's own setting, {@code DSH_HOME}, then {@code ~/.dsh}.
   *
   * The order is a preference, not a guarantee: an address and a home must belong together, so the
   * caller pairs every address with every home and keeps the first pair DSH accepts. That is what
   * lets an IDE configured for one home still reach the DSH that actually serves the port.
   * @param settings - persisted user choices.
   * @return the candidate homes, without duplicates.
   */
  static List<Path> candidateHomes(DshCompanionSettings.State settings) {
    List<Path> homes = new ArrayList<>();
    addHome(homes, settings.dshHome);
    addHome(homes, officialSetting("dshHomeOverride"));
    addHome(homes, System.getenv("DSH_HOME"));
    addHome(homes, System.getProperty("user.home") + "/.dsh");
    return homes;
  }

  /** Add one configured home, expanded and de-duplicated, ignoring blanks and duplicates. */
  private static void addHome(List<Path> homes, String value) {
    if (value == null || value.isBlank()) return;
    Path home = expand(value.strip());
    if (!homes.contains(home)) homes.add(home);
  }

  /** @return the first harness home to try, for a human. */
  static Path dshHome(DshCompanionSettings.State settings) {
    return candidateHomes(settings).get(0);
  }

  /** @return the DSH address and homes this plugin would use, for a human. */
  static String describe(DshCompanionSettings.State settings) {
    List<String> homes = new ArrayList<>();
    for (Path home : candidateHomes(settings)) homes.add(home.toString());
    return String.join(", ", candidateUrls(settings)) + " (homes " + String.join(", ", homes) + ")";
  }

  /** One option from the official plugin's settings file, or {@code null}. */
  private static String officialSetting(String name) {
    Path file = Path.of(PathManager.getConfigPath(), "options", OFFICIAL_SETTINGS);
    if (!Files.isRegularFile(file)) return null;
    try {
      Matcher matcher = OPTION.matcher(Files.readString(file, StandardCharsets.UTF_8));
      while (matcher.find()) {
        if (matcher.group(1).equals(name)) return matcher.group(2);
      }
      return null;
    } catch (IOException unreadable) {
      /* an unreadable settings file simply leaves the defaults */
      return null;
    }
  }

  /** Absolute real path, falling back to a normalized absolute path for a missing directory. */
  private static String canonical(String path) {
    try {
      return Path.of(path).toRealPath().toString();
    } catch (IOException missing) {
      return Path.of(path).toAbsolutePath().normalize().toString();
    }
  }

  private static Path expand(String value) {
    String expanded = value
      .replace("$USER_HOME$", System.getProperty("user.home"))
      .replace("${user.home}", System.getProperty("user.home"));
    if (expanded.startsWith("~")) expanded = System.getProperty("user.home") + expanded.substring(1);
    return Path.of(expanded);
  }
}
