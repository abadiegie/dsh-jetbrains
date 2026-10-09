package dsh.companion;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/**
 * The on-disk handshake between the IDE and a local DSH process: where the bridge listens, the bearer
 * token it requires, the owning process, and the newest workspace snapshot. The IDE rewrites the file
 * atomically on every change, so a reader never observes a partial document; DSH only reads it.
 */
public final class Descriptor {
  /** File name under {@code ~/.dsh}. */
  public static final String FILE_NAME = "jetbrains-companion.json";

  /** System property overriding the descriptor location, used by tests. */
  public static final String PATH_PROPERTY = "dsh.companion.descriptor";

  private Descriptor() {}

  /** @return the descriptor path this process publishes to. */
  public static Path path() {
    String override = System.getProperty(PATH_PROPERTY);
    if (override != null && !override.isEmpty()) return Path.of(override);
    return Path.of(System.getProperty("user.home"), ".dsh", FILE_NAME);
  }

  /**
   * @param port - loopback port of the bridge.
   * @param token - bearer token the bridge requires.
   * @param snapshot - the workspace snapshot to publish.
   * @return the complete descriptor document.
   */
  public static String document(int port, String token, Snapshot snapshot) {
    return Json.object()
      .field("version", Snapshot.VERSION)
      .field("source", Snapshot.SOURCE)
      .field("port", port)
      .field("token", token)
      .field("pid", snapshot.pid)
      .field("product", snapshot.product)
      .field("productName", snapshot.productName)
      .field("build", snapshot.build)
      .field("updatedAt", snapshot.updatedAt)
      .fieldRaw("workspace", snapshot.toJson())
      .build();
  }

  /**
   * Replace the descriptor in one visible step.
   * @param path - descriptor location.
   * @param document - complete descriptor document.
   * @throws IOException when the directory or file cannot be written.
   */
  public static void write(Path path, String document) throws IOException {
    Path directory = path.getParent();
    if (directory != null) Files.createDirectories(directory);
    Path temporary = path.resolveSibling(path.getFileName() + ".tmp");
    Files.writeString(temporary, document, StandardCharsets.UTF_8);
    try {
      Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    } catch (IOException noAtomicMove) {
      Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
    }
  }

  /**
   * Remove the descriptor; a missing file is the expected state after a clean shutdown.
   * @param path - descriptor location.
   */
  public static void delete(Path path) {
    try {
      Files.deleteIfExists(path);
    } catch (IOException ignored) {
      /* a descriptor left behind is rejected by its dead pid */
    }
  }
}
