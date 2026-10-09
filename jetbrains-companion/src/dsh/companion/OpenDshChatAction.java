package dsh.companion;

import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.project.DumbAwareAction;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import org.jetbrains.annotations.NotNull;

/**
 * Opens the DSH chat panel, from the Tools menu or the IDE's Find Action.
 *
 * The action only activates the tool window: the panel owns its own connection, so this stays a
 * presentation action with no network work on the EDT.
 */
public final class OpenDshChatAction extends DumbAwareAction {
  @Override
  public void actionPerformed(@NotNull AnActionEvent event) {
    Project project = event.getProject();
    if (project == null) return;
    ToolWindow window = ToolWindowManager.getInstance(project).getToolWindow(DshChatToolWindowFactory.TOOL_WINDOW_ID);
    if (window != null) window.activate(null, true);
  }

  @Override
  public void update(@NotNull AnActionEvent event) {
    event.getPresentation().setEnabledAndVisible(event.getProject() != null);
  }
}
