package dsh.companion;

import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.application.ApplicationManager;
import java.awt.Toolkit;
import java.awt.datatransfer.StringSelection;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Copies a compact markdown description of the current IDE workspace — every open project root, the
 * active file with its caret position, and the selected text — so it can be pasted into any DSH
 * session, including one that has no DSH-side plugin installed.
 */
public final class CopyWorkspaceContextAction extends AnAction {
  @Override
  public ActionUpdateThread getActionUpdateThread() {
    return ActionUpdateThread.EDT;
  }

  @Override
  public void actionPerformed(AnActionEvent event) {
    Snapshot snapshot = ApplicationManager.getApplication().getService(CompanionService.class).snapshot();
    String text = describe(snapshot);
    Toolkit.getDefaultToolkit().getSystemClipboard().setContents(new StringSelection(text), null);
    NotificationGroupManager.getInstance()
      .getNotificationGroup("DshCompanion")
      .createNotification("DSH workspace context copied", text, NotificationType.INFORMATION)
      .notify(event.getProject());
  }

  /**
   * @param snapshot - the current workspace snapshot.
   * @return the clipboard text.
   */
  static String describe(Snapshot snapshot) {
    StringBuilder text = new StringBuilder("JetBrains workspace: ")
      .append(snapshot.productName).append(" (").append(snapshot.build).append(")\n");
    Set<String> roots = new LinkedHashSet<>();
    for (Snapshot.ProjectInfo project : snapshot.projects) roots.addAll(project.roots);
    text.append("Roots:\n");
    if (roots.isEmpty()) text.append("- (none)\n");
    for (String root : roots) text.append("- ").append(root).append('\n');
    if (!snapshot.activePath.isEmpty()) {
      text.append("Active file: ").append(snapshot.activePath)
        .append(':').append(snapshot.activeLine).append(':').append(snapshot.activeColumn).append('\n');
    }
    if (!snapshot.selection.isEmpty()) {
      text.append("Selection:\n```text\n").append(snapshot.selection).append("\n```\n");
    }
    return text.toString();
  }
}
