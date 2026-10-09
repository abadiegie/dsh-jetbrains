package dsh.companion;

import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;

/**
 * Gives the project its DSH session on demand: it reuses the most recent session whose working
 * directory is this project, and creates one when the project has none.
 */
public final class OpenDshSessionAction extends AnAction {
  @Override
  public ActionUpdateThread getActionUpdateThread() {
    return ActionUpdateThread.EDT;
  }

  @Override
  public void actionPerformed(AnActionEvent event) {
    Project project = event.getProject();
    if (project == null) {
      NotificationGroupManager.getInstance()
        .getNotificationGroup("DshCompanion")
        .createNotification("DSH Companion", "Open a project first.", NotificationType.WARNING)
        .notify(null);
      return;
    }
    ApplicationManager.getApplication().getService(CompanionService.class).syncSession(project, true);
  }
}
