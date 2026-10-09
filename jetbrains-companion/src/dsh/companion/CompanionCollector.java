package dsh.companion;

import com.intellij.openapi.application.ApplicationInfo;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.module.Module;
import com.intellij.openapi.module.ModuleManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectManager;
import com.intellij.openapi.roots.ModuleRootManager;
import com.intellij.openapi.roots.ProjectRootManager;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.wm.WindowManager;
import java.awt.Frame;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Reads one {@link Snapshot} from the running IDE. A window holding several attached projects is one
 * {@link Project} per project, and each project contributes its base directory plus every content
 * root of its modules, which is what makes the multi-directory workspace visible to DSH.
 *
 * Every method here runs on the event dispatch thread inside a read action.
 */
final class CompanionCollector {
  private CompanionCollector() {}

  /**
   * @return the current workspace snapshot.
   */
  static Snapshot collect() {
    Snapshot snapshot = new Snapshot();
    ApplicationInfo info = ApplicationInfo.getInstance();
    snapshot.product = info.getBuild().getProductCode();
    snapshot.productName = info.getFullApplicationName();
    snapshot.build = info.getBuild().asString();
    snapshot.pid = ProcessHandle.current().pid();
    snapshot.updatedAt = Instant.now().toString();

    Project[] projects = ProjectManager.getInstance().getOpenProjects();
    Project focused = null;
    for (Project project : projects) {
      if (project.isDefault()) continue;
      Set<String> roots = new LinkedHashSet<>();
      for (VirtualFile root : ProjectRootManager.getInstance(project).getContentRoots()) roots.add(root.getPath());
      for (Module module : ModuleManager.getInstance(project).getModules()) {
        for (VirtualFile root : ModuleRootManager.getInstance(module).getContentRoots()) roots.add(root.getPath());
      }
      String basePath = project.getBasePath();
      snapshot.projects.add(new Snapshot.ProjectInfo(
        project.getName(),
        basePath == null ? "" : basePath,
        new ArrayList<>(roots)));
      if (focused == null && isActiveFrame(project)) focused = project;
    }

    Project active = focused != null ? focused : firstProjectWithEditor(projects);
    if (active == null) return snapshot;
    FileEditorManager editors = FileEditorManager.getInstance(active);
    for (VirtualFile file : editors.getOpenFiles()) snapshot.openFiles.add(file.getPath());
    Editor editor = editors.getSelectedTextEditor();
    if (editor == null) return snapshot;
    VirtualFile file = FileDocumentManager.getInstance().getFile(editor.getDocument());
    if (file != null) snapshot.activePath = file.getPath();
    snapshot.activeLine = editor.getCaretModel().getLogicalPosition().line + 1;
    snapshot.activeColumn = editor.getCaretModel().getLogicalPosition().column + 1;
    String selected = editor.getSelectionModel().getSelectedText();
    if (selected != null) {
      snapshot.selection = selected.length() > Snapshot.MAX_SELECTION_CHARS
        ? selected.substring(0, Snapshot.MAX_SELECTION_CHARS)
        : selected;
    }
    return snapshot;
  }

  private static boolean isActiveFrame(Project project) {
    Frame frame = WindowManager.getInstance().getFrame(project);
    return frame != null && frame.isActive();
  }

  private static Project firstProjectWithEditor(Project[] projects) {
    for (Project project : projects) {
      if (project.isDefault()) continue;
      if (FileEditorManager.getInstance(project).getSelectedTextEditor() != null) return project;
    }
    return null;
  }
}
