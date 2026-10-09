package dsh.companion;

import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.application.ApplicationManager;

/** Reports the bridge address and the descriptor path, so a user can diagnose a missing DSH link. */
public final class ShowCompanionStatusAction extends AnAction {
  @Override
  public ActionUpdateThread getActionUpdateThread() {
    return ActionUpdateThread.EDT;
  }

  @Override
  public void actionPerformed(AnActionEvent event) {
    CompanionService service = ApplicationManager.getApplication().getService(CompanionService.class);
    if (!service.isRunning()) service.start();
    NotificationGroupManager.getInstance()
      .getNotificationGroup("DshCompanion")
      .createNotification("DSH Companion", service.status(), NotificationType.INFORMATION)
      .notify(event.getProject());
  }
}
