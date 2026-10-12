package dsh.companion;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * The review document {@code jetbrains-workspace} publishes: one entry per turn that changed files, with
 * the coordinates DSH's own {@code /api/changes.*} routes take.
 *
 * Reading it is how this plugin shows a turn's changed files without asking DSH anything; the diff itself
 * still comes from DSH, which holds the recorder.
 */
public final class DshChanges {
  /** Document name inside the DSH home. */
  public static final String FILE_NAME = "jetbrains-changes.json";

  /** System property overriding the document location, used by tests. */
  public static final String PATH_PROPERTY = "dsh.companion.changes";

  /** The marker the publisher writes; a document without it is not ours. */
  public static final String SOURCE = "jetbrains-workspace";

  private DshChanges() {}

  /**
   * One changed file inside a turn.
   *
   * @param path - path relative to the turn's workspace root.
   * @param display - the name to show.
   * @param added - lines added.
   * @param deleted - lines deleted.
   */
  public record ChangedFile(String path, String display, int added, int deleted) {}

  /**
   * One turn's changes.
   *
   * @param sessionId - the DSH session the turn belongs to.
   * @param cwd - the root the paths are relative to.
   * @param seq - the session event sequence DSH's change routes take as a coordinate.
   * @param turn - the turn number.
   * @param total - how many files changed.
   * @param added - lines added across them.
   * @param deleted - lines deleted across them.
   * @param at - when the publisher wrote the entry.
   * @param files - the changed files.
   */
  public record Turn(String sessionId, String cwd, long seq, int turn, int total, int added, int deleted,
                     String at, List<ChangedFile> files) {
    /** @return one line describing the turn in a list. */
    public String label() {
      return "turn " + turn + " · " + files.size() + (files.size() == 1 ? " file" : " files")
        + " · +" + added + "/-" + deleted;
    }
  }

  /**
   * @return the document path this process reads, honouring the test override.
   */
  public static Path path() {
    String override = System.getProperty(PATH_PROPERTY);
    if (override != null && !override.isEmpty()) return Path.of(override);
    return Path.of(System.getProperty("user.home"), ".dsh", FILE_NAME);
  }

  /**
   * Read the published turns, newest first, as the publisher ordered them.
   *
   * @param document - the document to read.
   * @return the turns, empty when the document names no session yet.
   * @throws IOException when the document cannot be read or is not this publisher's.
   */
  public static List<Turn> read(Path document) throws IOException {
    if (!Files.isRegularFile(document)) {
      throw new IOException("no review document at " + document
        + " (install and mount dsh-jetbrains-workspace, then let one turn change a file)");
    }
    Object parsed = JsonParser.parse(Files.readString(document, StandardCharsets.UTF_8));
    String source = JsonParser.string(parsed, "source");
    if (!SOURCE.equals(source)) throw new IOException(document + " is not a " + SOURCE + " document");
    List<Turn> turns = new ArrayList<>();
    for (Object entry : JsonParser.array(parsed, "sessions")) {
      List<ChangedFile> files = new ArrayList<>();
      for (Object file : JsonParser.array(entry, "files")) {
        String path = JsonParser.string(file, "path");
        if (path == null) continue;
        String display = JsonParser.string(file, "display");
        files.add(new ChangedFile(
          path,
          display == null || display.isEmpty() ? path : display,
          number(JsonParser.member(file, "added")),
          number(JsonParser.member(file, "deleted"))));
      }
      turns.add(new Turn(
        JsonParser.string(entry, "sessionId"),
        JsonParser.string(entry, "cwd"),
        number(JsonParser.member(entry, "seq")),
        number(JsonParser.member(entry, "turn")),
        number(JsonParser.member(entry, "total")),
        number(JsonParser.member(entry, "added")),
        number(JsonParser.member(entry, "deleted")),
        JsonParser.string(entry, "at"),
        files));
    }
    return turns;
  }

  /** @param value - a JSON number or anything else. @return its int value, or 0. */
  private static int number(Object value) {
    return value instanceof Long number ? number.intValue() : 0;
  }
}
