import dsh.companion.ChangesDiff;
import dsh.companion.ChangesRevert;
import dsh.companion.DshChanges;
import dsh.companion.JsonParser;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/** Acceptance check for the review document reader and the diff payload splitter: no IDE, no DSH. */
public final class ChangesCheck {
  private static int failures;

  public static void main(String[] args) throws Exception {
    String payload = "{\"kind\":\"text\",\"path\":\"a/b.md\",\"display\":\"docs/b.md\",\"before\":true,\"after\":true,"
      + "\"hunks\":[{\"oldStart\":1,\"oldLines\":2,\"newStart\":1,\"newLines\":2,"
      + "\"lines\":[\" kept\",\"-gone\",\"+added\",\" \"]}]}";
    ChangesDiff diff = ChangesDiff.fromPayload(JsonParser.parse(payload));
    expect("kept\ngone\n".equals(diff.left()), "the left text keeps context and removed lines: " + quote(diff.left()));
    expect("kept\nadded\n".equals(diff.right()), "the right text keeps context and added lines: " + quote(diff.right()));
    expect(diff.hunkCount() == 1, "the hunk count is reported");
    expect("docs/b.md".equals(diff.title()), "the diff is titled by its display name: " + diff.title());

    ChangesDiff created = ChangesDiff.fromPayload(JsonParser.parse(
      "{\"path\":\"new.txt\",\"before\":false,\"after\":true,\"hunks\":[{\"lines\":[\"+only\"]}]}"));
    expect(created.left().isEmpty() && "only".equals(created.right()), "an added file has an empty left side");
    expect(created.title().endsWith("(added by this turn)"), "an added file says so in its title");
    expect("new.txt".equals(created.display() == null ? created.path() : created.display()),
      "a payload without a display name falls back to the path");

    // Reverting: the patch applied backwards, by content, all-or-nothing.
    String current = "kept\nadded\n";
    expect("kept\ngone\n".equals(ChangesRevert.reverted(current, diff)),
      "a whole-file revert puts the removed lines back");
    expect("kept\ngone\n".equals(ChangesRevert.reverted(current, diff, 0)), "a single hunk reverts alone");
    expect(refusesRevert("kept\n", diff), "a text without the hunk is refused, not silently left alone");
    expect(refusesRevert("something else\n", diff), "a file edited since the turn is refused, not half-reverted");
    expect(created.isCreation() && !diff.isCreation(), "a created file is flagged, so a revert deletes it");

    Path document = Files.createTempFile("jetbrains-changes", ".json");
    Files.writeString(document, "{\"version\":1,\"source\":\"jetbrains-workspace\",\"sessions\":[{\"sessionId\":\"session-x\","
      + "\"cwd\":\"/w\",\"seq\":42,\"turn\":7,\"total\":2,\"added\":12,\"deleted\":4,\"at\":\"now\",\"files\":["
      + "{\"path\":\"a.md\",\"display\":\"a.md\",\"added\":10,\"deleted\":1},"
      + "{\"path\":\"b.md\",\"added\":2,\"deleted\":3}]}]}", StandardCharsets.UTF_8);
    List<DshChanges.Turn> turns = DshChanges.read(document);
    expect(turns.size() == 1, "one published session becomes one turn");
    DshChanges.Turn turn = turns.get(0);
    expect(turn.seq() == 42 && turn.turn() == 7 && turn.added() == 12 && turn.deleted() == 4,
      "the turn keeps its coordinates and totals");
    expect(turn.files().size() == 2 && "b.md".equals(turn.files().get(1).display()),
      "a file without a display name is labelled by its path");
    expect(turn.label().contains("2 files") && turn.label().contains("+12/-4"),
      "the turn's label counts files and lines: " + turn.label());

    Path foreign = Files.createTempFile("not-ours", ".json");
    Files.writeString(foreign, "{\"source\":\"something-else\",\"sessions\":[]}", StandardCharsets.UTF_8);
    expect(refuses(foreign), "a document from another publisher is refused");
    expect(refuses(document.resolveSibling("missing-" + document.getFileName())),
      "a missing document explains what to install");

    System.setProperty(DshChanges.PATH_PROPERTY, document.toString());
    expect(document.equals(DshChanges.path()), "the document location honours its override");
    System.clearProperty(DshChanges.PATH_PROPERTY);

    if (failures > 0) {
      System.err.println("\n" + failures + " expectation(s) failed");
      System.exit(1);
    }
    System.out.println("\nchanges check: the review document and the diff payload both read correctly");
  }

  /** @return whether reverting against that text was refused. */
  private static boolean refusesRevert(String current, ChangesDiff diff) {
    try {
      ChangesRevert.reverted(current, diff);
      return false;
    } catch (Exception expected) {
      return true;
    }
  }

  /** @return whether reading that document was refused. */
  private static boolean refuses(Path document) {
    try {
      DshChanges.read(document);
      return false;
    } catch (Exception expected) {
      return true;
    }
  }

  /** @param condition - whether the expectation held. @param what - what was expected. */
  private static void expect(boolean condition, String what) {
    if (condition) {
      System.out.println("ok: " + what);
      return;
    }
    failures += 1;
    System.out.println("FAIL: " + what);
  }

  /** @param text - any text. @return it quoted for a failure message. */
  private static String quote(String text) {
    return "\"" + text.replace("\n", "\\n") + "\"";
  }
}
