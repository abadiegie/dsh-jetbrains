package dsh.companion;

import java.util.ArrayList;
import java.util.List;

/**
 * One live view of the IDE workspace: the application identity, every open project with the root
 * directories it contributes, the active editor position and selection, and every file open in an
 * editor. The class is pure data plus its JSON form, so the bridge serves it and the DSH consumer
 * reads it without sharing any IntelliJ API.
 */
public final class Snapshot {
  /** One open project: its display name, base directory, and every root directory it contributes. */
  public static final class ProjectInfo {
    /** Project display name, as the IDE shows it. */
    public final String name;
    /** Absolute base directory, or an empty string for a default project without a base path. */
    public final String path;
    /** Absolute content-root directories, including attached projects' roots. */
    public final List<String> roots;

    /**
     * @param name - project display name.
     * @param path - absolute base directory, or an empty string.
     * @param roots - absolute content-root directories.
     */
    public ProjectInfo(String name, String path, List<String> roots) {
      this.name = name;
      this.path = path;
      this.roots = List.copyOf(roots);
    }
  }

  /** Model name, the value a consumer keys on to recognize this document. */
  public static final String SOURCE = "jetbrains-companion";

  /** Document version; a consumer that does not know a version refuses the document. */
  public static final int VERSION = 1;

  /** Product code, such as {@code IDEA}. */
  public String product = "";
  /** Full application name, such as {@code IntelliJ IDEA 2026.1.4}. */
  public String productName = "";
  /** Build number, such as {@code IC-261.26222.65}. */
  public String build = "";
  /** IDE process id, so a consumer can tell a live document from a stale one. */
  public long pid;
  /** Open projects, in the order the IDE reports them. */
  public final List<ProjectInfo> projects = new ArrayList<>();
  /** Absolute path of the file in the active editor, or an empty string when none is focused. */
  public String activePath = "";
  /** One-based caret line in the active editor. */
  public int activeLine;
  /** One-based caret column in the active editor. */
  public int activeColumn;
  /** Selected text in the active editor, bounded by {@link #MAX_SELECTION_CHARS}. */
  public String selection = "";
  /** Absolute paths of every file open in an editor, in the IDE's open-file order. */
  public final List<String> openFiles = new ArrayList<>();
  /** ISO-8601 instant this snapshot was collected. */
  public String updatedAt = "";

  /** Selected text is truncated to this many characters before it reaches a model request. */
  public static final int MAX_SELECTION_CHARS = 4000;

  /** @return the complete snapshot document. */
  public String toJson() {
    Json projectArray = Json.array();
    for (ProjectInfo project : projects) {
      projectArray.itemRaw(Json.object()
        .field("name", project.name)
        .field("path", project.path)
        .fieldRaw("roots", Json.array().items(project.roots).build())
        .build());
    }
    return Json.object()
      .field("version", VERSION)
      .field("source", SOURCE)
      .field("product", product)
      .field("productName", productName)
      .field("build", build)
      .field("pid", pid)
      .fieldRaw("projects", projectArray.build())
      .fieldRaw("active", Json.object()
        .field("path", activePath)
        .field("line", activeLine)
        .field("column", activeColumn)
        .field("selection", selection)
        .build())
      .fieldRaw("openFiles", Json.array().items(openFiles).build())
      .field("updatedAt", updatedAt)
      .build();
  }

  /**
   * @return a value that changes exactly when some consumer-visible field changes, so the publisher
   *     can skip rewriting an unchanged document.
   */
  public String signature() {
    StringBuilder signature = new StringBuilder(activePath).append('|').append(activeLine)
      .append('|').append(activeColumn).append('|').append(selection).append('|').append(pid);
    for (ProjectInfo project : projects) {
      signature.append('|').append(project.name).append('@').append(project.path);
      for (String root : project.roots) signature.append(',').append(root);
    }
    for (String file : openFiles) signature.append('|').append(file);
    return signature.toString();
  }
}
