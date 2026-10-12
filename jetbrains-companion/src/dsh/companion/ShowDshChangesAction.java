package dsh.companion;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import org.jetbrains.annotations.NotNull;

/** Shows the changes panel, so the tool window is reachable from the Tools menu too. */
public final class ShowDshChangesAction extends AnAction {
  @Override
  public void actionPerformed(@NotNull AnActionEvent event) {
    Project project = event.getProject();
    if (project == null) return;
    ToolWindow window = ToolWindowManager.getInstance(project).getToolWindow(DshDiffToolWindowFactory.TOOL_WINDOW_ID);
    if (window != null) window.show();
  }
}
