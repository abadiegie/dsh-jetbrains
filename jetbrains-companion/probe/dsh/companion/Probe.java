package dsh.companion;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectManager;

/** Compile probe: proves the local IDE jars are a usable compile classpath. */
public final class Probe {
  private Probe() {}

  /**
   * @return a platform fact, or "no-app" outside a running IDE.
   */
  public static String describe() {
    if (ApplicationManager.getApplication() == null) return "no-app";
    Project[] projects = ProjectManager.getInstance().getOpenProjects();
    return "projects=" + projects.length;
  }
}
