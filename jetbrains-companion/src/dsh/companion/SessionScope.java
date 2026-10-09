package dsh.companion;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * The directory one DSH session runs in for an IDE window.
 *
 * DSH groups sessions by working directory, and its shipped model is one session per project. A
 * JetBrains window can instead hold several projects in unrelated directories — a root project plus
 * attached modules and VCS roots — so the `window` scope gives that window one session, at the shared
 * parent of its roots. That is the same junction the DSH-side plugin registers with
 * `junctionRoot: common-parent`, so the panel and the registered workspace agree on one directory.
 *
 * The narrower project directory stays the fallback whenever a shared parent is not usable: a
 * session's writable boundary is its working directory, and the safe boundary is the narrow one.
 */
final class SessionScope {
  private SessionScope() {}

  /**
   * @param snapshot - the live IDE snapshot, whose projects carry each window's roots.
   * @param projectPath - the project's own base directory.
   * @param windowScope - true for one session per window, false for one per project directory.
   * @return the session's working directory, or {@code null} when the project has no directory.
   */
  static String directory(Snapshot snapshot, String projectPath, boolean windowScope) {
    String project = canonical(projectPath);
    if (project == null) return null;
    if (!windowScope) return project;
    List<String> roots = windowRoots(snapshot, project);
    if (roots.size() < 2) return project;
    String shared = commonParent(roots);
    if (shared == null) return project;
    String junction = canonical(shared);
    // A filesystem root bounds nothing useful, and a parent equal to the project is no widening.
    if (junction == null || junction.equals(project) || Path.of(junction).getParent() == null) return project;
    return junction;
  }

  /**
   * Whether a snapshot describes this project's window at all, which distinguishes "the window has no
   * usable shared parent" from "the publisher has not collected the window yet".
   * @param snapshot - the snapshot to inspect, or {@code null}.
   * @param projectPath - the project's base directory.
   * @return true when some project in the snapshot has this base directory.
   */
  static boolean describes(Snapshot snapshot, String projectPath) {
    String project = canonical(projectPath);
    if (snapshot == null || project == null) return false;
    for (Snapshot.ProjectInfo info : snapshot.projects) {
      if (project.equals(canonical(info.path))) return true;
    }
    return false;
  }

  /**
   * The roots of the project's own window: the snapshot project whose base directory is this one.
   *
   * The snapshot is application-wide, so a second IDE window's projects are present too; taking the
   * matching project is what keeps the junction per window instead of joining unrelated windows.
   * @param snapshot - the live snapshot, or {@code null} before the first collection.
   * @param project - the project's canonical base directory.
   * @return canonical root directories, without duplicates.
   */
  private static List<String> windowRoots(Snapshot snapshot, String project) {
    List<String> roots = new ArrayList<>();
    if (snapshot == null) return roots;
    for (Snapshot.ProjectInfo info : snapshot.projects) {
      if (!project.equals(canonical(info.path))) continue;
      for (String root : info.roots) {
        String resolved = canonical(root);
        if (resolved != null && !roots.contains(resolved)) roots.add(resolved);
      }
      break;
    }
    return roots;
  }

  /**
   * @param paths - absolute directory paths.
   * @return their deepest shared directory, or {@code null} when only a filesystem root is shared.
   */
  private static String commonParent(List<String> paths) {
    Path shared = null;
    for (String path : paths) {
      Path current = Path.of(path);
      if (shared == null) {
        shared = current;
        continue;
      }
      while (shared != null && !current.startsWith(shared)) shared = shared.getParent();
      if (shared == null) return null;
    }
    return shared == null ? null : shared.toString();
  }

  /**
   * @param path - a directory path, or {@code null}.
   * @return its real path, its normalized absolute form when it does not resolve, or {@code null}.
   */
  private static String canonical(String path) {
    if (path == null || path.isEmpty()) return null;
    try {
      return Path.of(path).toRealPath().toString();
    } catch (IOException unresolvable) {
      return Path.of(path).toAbsolutePath().normalize().toString();
    }
  }
}
