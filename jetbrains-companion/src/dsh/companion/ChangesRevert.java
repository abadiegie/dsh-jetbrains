package dsh.companion;

import java.util.ArrayList;
import java.util.List;

/**
 * Takes a turn's change back by reverse-applying the hunks DSH published.
 *
 * The diff is a patch, so reverting is applying it backwards: each hunk's added lines are replaced by the
 * lines it removed. Hunks are located by their content rather than by line number, and every one of them must
 * be found — a file edited since the turn is refused instead of half-reverted, which is the only safe
 * behaviour for a destructive action.
 */
public final class ChangesRevert {
  private ChangesRevert() {}

  /**
   * Why a revert was refused.
   */
  public static final class Refused extends Exception {
    private static final long serialVersionUID = 1L;

    /**
     * @param message - what could not be found.
     */
    public Refused(String message) {
      super(message);
    }
  }

  /**
   * The text the file had before the turn.
   *
   * @param current - the file's text now.
   * @param diff - the published diff.
   * @return the reverted text, which equals {@code current} when nothing matched.
   * @throws Refused when a hunk cannot be located in the current text.
   */
  public static String reverted(String current, ChangesDiff diff) throws Refused {
    return reverted(current, diff, -1);
  }

  /**
   * The text the file had before one hunk, or before all of them.
   *
   * @param current - the file's text now.
   * @param diff - the published diff.
   * @param onlyBlock - the hunk to revert, or -1 for every hunk.
   * @return the reverted text.
   * @throws Refused when the named hunk, or any hunk, cannot be located.
   */
  public static String reverted(String current, ChangesDiff diff, int onlyBlock) throws Refused {
    List<String> lines = new ArrayList<>(List.of(current.split("\n", -1)));
    // Bottom-up: an earlier hunk's replacement does not shift the lines a later search depends on.
    List<ChangesDiff.Block> blocks = new ArrayList<>(diff.blocks());
    for (int position = blocks.size() - 1; position >= 0; position -= 1) {
      ChangesDiff.Block block = blocks.get(position);
      if (onlyBlock >= 0 && block.index() != onlyBlock) continue;
      int found = locate(lines, block.after());
      if (found < 0) {
        throw new Refused("this file no longer contains hunk " + (block.index() + 1)
          + " as the turn left it; nothing was reverted");
      }
      lines.subList(found, found + block.after().size()).clear();
      lines.addAll(found, block.before());
    }
    return String.join("\n", lines);
  }

  /**
   * Find a block of lines in a file.
   *
   * @param lines - the file's lines.
   * @param block - the lines to find.
   * @return the index the block starts at, or -1.
   */
  private static int locate(List<String> lines, List<String> block) {
    if (block.isEmpty()) return -1;
    for (int start = lines.size() - block.size(); start >= 0; start -= 1) {
      boolean matches = true;
      for (int offset = 0; offset < block.size(); offset += 1) {
        if (!block.get(offset).equals(lines.get(start + offset))) {
          matches = false;
          break;
        }
      }
      if (matches) return start;
    }
    return -1;
  }
}
