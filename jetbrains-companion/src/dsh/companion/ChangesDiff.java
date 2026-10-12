package dsh.companion;

import java.util.ArrayList;
import java.util.List;

/**
 * One changed file's diff, as DSH's {@code /api/changes.diff} serves it: the two texts a native diff
 * compares, plus the hunks a revert needs.
 *
 * @param path - the file's path, relative to the turn's workspace root.
 * @param display - the name a reader sees.
 * @param before - whether the file existed before the turn.
 * @param after - whether it exists after it.
 * @param blocks - the hunks, in file order.
 * @param left - the text before the turn, reconstructed from context and removed lines.
 * @param right - the text after it, reconstructed from context and added lines.
 */
public record ChangesDiff(String path, String display, boolean before, boolean after,
                          List<Block> blocks, String left, String right) {

  /**
   * One hunk.
   *
   * @param index - its position in the payload, which a caller reverts by.
   * @param before - the lines it replaces.
   * @param after - the lines it introduces.
   */
  public record Block(int index, List<String> before, List<String> after) {}

  /**
   * Rebuild both texts and the hunks from one payload. Every line carries a unified-diff marker: {@code '-'}
   * is only on the left, {@code '+'} only on the right, a space on both; a line with no marker is content in
   * both, so a payload this code does not understand still shows something rather than losing text.
   *
   * @param parsed - the parsed JSON payload.
   * @return the diff, with empty texts when the payload carried no hunks.
   */
  public static ChangesDiff fromPayload(Object parsed) {
    List<String> left = new ArrayList<>();
    List<String> right = new ArrayList<>();
    List<Block> blocks = new ArrayList<>();
    List<Object> hunks = JsonParser.array(parsed, "hunks");
    for (Object hunk : hunks) {
      List<String> before = new ArrayList<>();
      List<String> after = new ArrayList<>();
      for (Object raw : JsonParser.array(hunk, "lines")) {
        if (!(raw instanceof String line) || line.isEmpty()) {
          left.add("");
          right.add("");
          before.add("");
          after.add("");
          continue;
        }
        char marker = line.charAt(0);
        String text = line.substring(1);
        if (marker == '+') {
          right.add(text);
          after.add(text);
        } else if (marker == '-') {
          left.add(text);
          before.add(text);
        } else if (marker == ' ') {
          left.add(text);
          right.add(text);
          before.add(text);
          after.add(text);
        } else {
          left.add(line);
          right.add(line);
          before.add(line);
          after.add(line);
        }
      }
      blocks.add(new Block(blocks.size(), List.copyOf(before), List.copyOf(after)));
    }
    boolean before = JsonParser.member(parsed, "before") instanceof Boolean flag && flag;
    boolean after = JsonParser.member(parsed, "after") instanceof Boolean flag && flag;
    return new ChangesDiff(
      JsonParser.string(parsed, "path"),
      JsonParser.string(parsed, "display"),
      before,
      after,
      List.copyOf(blocks),
      String.join("\n", left),
      String.join("\n", right));
  }

  /** @return how many hunks the payload carried. */
  public int hunkCount() {
    return blocks.size();
  }

  /** @return whether the turn created this file, which a revert deletes rather than rewrites. */
  public boolean isCreation() {
    return !before;
  }

  /** @return the title of the diff tab this payload deserves. */
  public String title() {
    String name = display == null || display.isEmpty() ? String.valueOf(path) : display;
    if (!before) return name + " (added by this turn)";
    if (!after) return name + " (removed by this turn)";
    return name;
  }
}
