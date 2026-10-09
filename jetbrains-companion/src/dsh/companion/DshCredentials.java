package dsh.companion;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;

/**
 * Reads the DSH browser-session signing secret out of the local credential document
 * (`$DSH_HOME/.credentials.yaml`).
 *
 * DSH authenticates every browser request with a cookie signed by that secret. A process running as
 * the same user can read the same file, so it can speak to the DSH HTTP API exactly as the user's
 * browser does — which is what makes this plugin independent of any DSH-side plugin.
 */
public final class DshCredentials {
  /** Credential document file name under the DSH home. */
  public static final String FILE_NAME = ".credentials.yaml";

  /** Credential record DSH stores its cookie-signing secret under. */
  private static final String RECORD = "client-connection/browser-session";

  private DshCredentials() {}

  /**
   * @param dshHome - harness home directory holding the credential document.
   * @return the raw signing secret.
   * @throws IOException when the document or the record is missing, or the secret is not base64url.
   */
  public static byte[] browserSessionSecret(Path dshHome) throws IOException {
    Path file = dshHome.resolve(FILE_NAME);
    if (!Files.isRegularFile(file)) throw new IOException("no credential document at " + file);
    String secret = findSecret(Files.readAllLines(file, StandardCharsets.UTF_8));
    if (secret == null) throw new IOException("no " + RECORD + " record in " + file);
    try {
      return Base64.getUrlDecoder().decode(secret);
    } catch (IllegalArgumentException invalid) {
      throw new IOException("the " + RECORD + " secret in " + file + " is not base64url", invalid);
    }
  }

  /**
   * Read the {@code secret} member of the record block, using the document's own indentation to
   * bound the block.
   * @param lines - credential document lines.
   * @return the secret text, or {@code null} when the record or its secret is absent.
   */
  private static String findSecret(List<String> lines) {
    int recordLine = -1;
    int recordIndent = 0;
    for (int index = 0; index < lines.size(); index++) {
      String line = lines.get(index);
      if (line.isBlank()) continue;
      if (line.strip().equals(RECORD + ":")) {
        recordLine = index;
        recordIndent = indentation(line);
        break;
      }
    }
    if (recordLine < 0) return null;
    for (int index = recordLine + 1; index < lines.size(); index++) {
      String line = lines.get(index);
      if (line.isBlank()) continue;
      if (indentation(line) <= recordIndent) return null;
      String stripped = line.strip();
      if (!stripped.startsWith("secret:")) continue;
      return unquote(stripped.substring("secret:".length()).strip());
    }
    return null;
  }

  private static int indentation(String line) {
    int count = 0;
    while (count < line.length() && line.charAt(count) == ' ') count++;
    return count;
  }

  private static String unquote(String value) {
    if (value.length() >= 2
      && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
      return value.substring(1, value.length() - 1);
    }
    return value;
  }
}
